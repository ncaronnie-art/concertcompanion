import {readFile} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {availableParallelism} from "node:os";
import {BODY_MODEL_ID,BODY_MODEL_SHA256} from "../src/shared/body-mask.js";
import type {ManualSubject,NormalizedBox} from "../src/shared/visual-tracking.js";
import type {BodySegmentationModel,BodySegmentationContext,BodyCandidateDecision} from "./body-segmentation.js";
import {BODY_NATIVE_FILES} from "./body-native-files.js";
const DECODER_SHA="f4514391764fbd56e08e119060d874ecd7d52994bfb1968af159e12d4943b5bb",ENCODER=1024;
const clamp=(v:number,min=0,max=1)=>Math.max(min,Math.min(max,v));
type Tensor={data:Float32Array;dims:number[];dispose():void};
type Session={run(input:Record<string,Tensor>):Promise<Record<string,Tensor>>};
type Ort={env:{logLevel:string};Tensor:new(type:"float32"|"int64",data:Float32Array|BigInt64Array,dims:number[])=>Tensor;InferenceSession:{create(bytes:Uint8Array,options:unknown):Promise<Session>}};
export type BodyPoint={x:number;y:number;label:0|1;name:string};
/** These are context-derived prompts, never a rectangle used as a mask. */
export function automaticBodyPrompts(subject:ManualSubject|undefined,box:NormalizedBox):BodyPoint[]{
 const positive=(name:string,x:number,y:number):BodyPoint=>({name,x:clamp(x),y:clamp(y),label:1});
 const negative=(name:string,x:number,y:number):BodyPoint=>({name,x:clamp(x),y:clamp(y),label:0});
 const selected=subject&&subject.x>=box.x-box.width*.15&&subject.x<=box.x+box.width*1.15&&subject.y>=box.y&&subject.y<=box.y+box.height?subject:{x:box.x+box.width*.5,y:box.y+box.height*.45};
 return [positive("body-box-head",box.x+box.width*.5,box.y+box.height*.1),positive("selected-body-point",selected.x,selected.y),positive("body-box-lower",box.x+box.width*.5,box.y+box.height*.82),
 negative("outside-body-left",box.x-box.width*.15,box.y+box.height*.5),negative("outside-body-floor",box.x+box.width*.5,box.y+box.height*1.08)];
}
export type CandidateSummary={index:number;score:number;area:number;bodyHeight:number;promptsSatisfied:boolean;continuity:number;complete:boolean};
/** Predicted IoU alone can favor a stage-light bulge. Within a narrow learned
 * score band, prefer the smallest COMPLETE supported silhouette, with strong
 * temporal overlap. A tiny torso-only mask cannot win this policy. */
export function chooseBodyCandidate(candidates:CandidateSummary[]):number|undefined{
 const valid=candidates.filter(c=>c.promptsSatisfied&&c.complete&&c.score>=.65&&c.area>.001&&c.area<.65);
 if(!valid.length)return undefined;
 const best=Math.max(...valid.map(c=>c.score));
 return valid.filter(c=>c.score>=best-.03).sort((a,b)=>{
  // A large continuity loss must not be traded for a tiny compactness gain.
  if(a.continuity>.05&&b.continuity>.05&&Math.abs(a.continuity-b.continuity)>.25)return b.continuity-a.continuity;
  return a.area-b.area||b.score-a.score;
 })[0]?.index;
}
function preprocess(rgb:Uint8Array,width:number,height:number){
 const rw=Math.round(width*ENCODER/Math.max(width,height)),rh=Math.round(height*ENCODER/Math.max(width,height)),data=new Float32Array(3*ENCODER*ENCODER),mean=[.485,.456,.406],std=[.229,.224,.225];
 for(let y=0;y<rh;y++){
  const sy=clamp((y+.5)*height/rh-.5,0,height-1),y0=Math.floor(sy),y1=Math.min(height-1,y0+1),fy=sy-y0;
  for(let x=0;x<rw;x++){
   const sx=clamp((x+.5)*width/rw-.5,0,width-1),x0=Math.floor(sx),x1=Math.min(width-1,x0+1),fx=sx-x0;
   for(let c=0;c<3;c++){const value=rgb[(y0*width+x0)*3+c]*(1-fx)*(1-fy)+rgb[(y0*width+x1)*3+c]*fx*(1-fy)+rgb[(y1*width+x0)*3+c]*(1-fx)*fy+rgb[(y1*width+x1)*3+c]*fx*fy;
    data[c*ENCODER*ENCODER+y*ENCODER+x]=(value/255-mean[c])/std[c];
   }
  }
 }return {data,rw,rh};
}
export async function createBodyPointModel(folder:string):Promise<BodySegmentationModel>{
 const sha=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex"),p=JSON.parse(await readFile(path.join(folder,"provenance.json"),"utf8"));
 if(p.version!==2||p.model.id!==BODY_MODEL_ID||p.runtime.version!=="1.23.2"||p.runtime.platform!=="win32-x64")throw Error("Unsupported local body model.");
 if(process.platform!=="win32"||process.arch!=="x64")throw Error("This body-outline runtime currently supports Windows x64.");
 const encoderBytes=await readFile(path.join(folder,"vision_encoder.onnx")),decoderBytes=await readFile(path.join(folder,"prompt_encoder_mask_decoder.onnx"));
 if(sha(encoderBytes)!==BODY_MODEL_SHA256||sha(decoderBytes)!==DECODER_SHA)throw Error("Body-mask model integrity check failed.");
 for(const file of BODY_NATIVE_FILES)if(sha(await readFile(path.join(folder,"runtime/node_modules",file.path)))!==file.sha256)throw Error("Native body-mask runtime integrity check failed.");
 if(!p.notices||Object.keys(p.notices).length!==3)throw Error("Body-model license notices are missing.");
 for(const [name,expected] of Object.entries(p.notices))if(!["SlimSAM-Apache-2.0.txt","ONNX-Runtime-MIT.txt","ONNX-Runtime-ThirdPartyNotices.txt"].includes(name)||sha(await readFile(path.join(folder,name)))!==expected)throw Error("Body-model license notice integrity failed.");
 const require=createRequire(path.join(folder,"runtime/entry.cjs")),ort=require("onnxruntime-node") as Ort;ort.env.logLevel="error";
 const options={executionProviders:["cpu"],intraOpNumThreads:Math.min(4,Math.max(1,availableParallelism())),interOpNumThreads:1,graphOptimizationLevel:"all",executionMode:"sequential",logSeverityLevel:3};
 const encoder=await ort.InferenceSession.create(encoderBytes,options),decoder=await ort.InferenceSession.create(decoderBytes,options);
 let queued:Promise<unknown>=Promise.resolve(),lastDecision:BodyCandidateDecision|undefined;
 return {id:BODY_MODEL_ID,sha256:BODY_MODEL_SHA256,processingId:createHash("sha256").update("slimsam-aspect-bilinear-normalized-pad-v1\n"+createBodyPointModel.toString()+automaticBodyPrompts.toString()+chooseBodyCandidate.toString()+preprocess.toString()).digest("hex"),inputSize:512,preserveAspect:true,runtime:"onnxruntime-node",runtimeVersion:"1.23.2",
 getLastDecision:()=>lastDecision,
 segment(rgb:Uint8Array,signal?:AbortSignal,context?:BodySegmentationContext){
  const operation=queued.then(async()=>{
   signal?.throwIfAborted();const width=context?.width??512,height=context?.height??512;
   if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width>512||height>512||rgb.length!==width*height*3)throw Error("Invalid body-mask model input.");
   lastDecision=undefined;
   if(!context?.expected)return new Float32Array(width*height);
   const box=context.expected,points=automaticBodyPrompts(context.subject,box),prepared=preprocess(rgb,width,height),tensors:Tensor[]=[];
   let encoded:Record<string,Tensor>|undefined,decoded:Record<string,Tensor>|undefined;
   try{
    const input=new ort.Tensor("float32",prepared.data,[1,3,ENCODER,ENCODER]);tensors.push(input);
    encoded=await encoder.run({pixel_values:input});signal?.throwIfAborted();
    const pointTensor=new ort.Tensor("float32",new Float32Array(points.flatMap(p=>[p.x*prepared.rw,p.y*prepared.rh])),[1,1,points.length,2]),labels=new ort.Tensor("int64",new BigInt64Array(points.map(p=>BigInt(p.label))),[1,1,points.length]);tensors.push(pointTensor,labels);
    decoded=await decoder.run({image_embeddings:encoded.image_embeddings,image_positional_embeddings:encoded.image_positional_embeddings,input_points:pointTensor,input_labels:labels});signal?.throwIfAborted();
    const mask=decoded.pred_masks,scores=decoded.iou_scores;if(!mask||!scores||mask.dims.join(",")!=="1,1,3,256,256"||scores.data.length!==3)throw Error("Unsupported point-mask output.");
    const logit=(i:number,x:number,y:number)=>{
     const sx=clamp((x+.5)*prepared.rw/width/ENCODER*256-.5,0,255),sy=clamp((y+.5)*prepared.rh/height/ENCODER*256-.5,0,255),x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(255,x0+1),y1=Math.min(255,y0+1),fx=sx-x0,fy=sy-y0,base=i*256*256;
     return mask.data[base+y0*256+x0]*(1-fx)*(1-fy)+mask.data[base+y0*256+x1]*fx*(1-fy)+mask.data[base+y1*256+x0]*(1-fx)*fy+mask.data[base+y1*256+x1]*fx*fy;
    };
    const probabilities:Float32Array[]=[],summaries:CandidateSummary[]=[];
    for(let i=0;i<3;i++){
     const alpha=new Float32Array(width*height);let area=0,minY=height,maxY=0,overlap=0,union=0;
     for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=y*width+x,value=1/(1+Math.exp(-logit(i,x,y)));if(!Number.isFinite(value))throw Error("Invalid point-mask output.");alpha[at]=value;
      if(value>=.5){area++;minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
      if(context.previous){const old=context.previous[at]>=128,now=value>=.5;if(old&&now)overlap++;if(old||now)union++;}
     }
     const bodyHeight=(maxY-minY+1)/height,promptsSatisfied=points.every(p=>p.label===1?logit(i,p.x*width,p.y*height)>0:logit(i,p.x*width,p.y*height)<0);
     summaries.push({index:i,score:Number(scores.data[i]),area:area/(width*height),bodyHeight,promptsSatisfied,continuity:union?overlap/union:0,complete:bodyHeight>=box.height*.65&&bodyHeight<=box.height*1.4&&minY/height<=box.y+box.height*.2&&(maxY+1)/height>=box.y+box.height*.8});probabilities.push(alpha);
    }
    const selected=chooseBodyCandidate(summaries);lastDecision={sourceTime:context.sourceTime,candidates:summaries,selected,...(selected===undefined?{reason:"No complete prompt-supported silhouette within the score band."}:{})};
    return selected===undefined?new Float32Array(width*height):probabilities[selected];
   }finally{for(const t of tensors)t.dispose();for(const t of Object.values(encoded??{}))t.dispose();for(const t of Object.values(decoded??{}))t.dispose();}
  });queued=operation.catch(()=>undefined);return operation;
 }};
}

