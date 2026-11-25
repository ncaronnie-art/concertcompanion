import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import ffprobe from "ffprobe-static";
import {displayDimensions} from "./media-orientation.js";
import {hdrToSdrFilter} from "../src/shared/video-color.js";
import {boxIoU,subjectAnalysisRegion,type ManualSubject,type NormalizedBox,type PersonDetection,type VisualAnalysis,type VisualFrame} from "../src/shared/visual-tracking.js";

type Tensor={data:Float32Array;dims:number[];dispose():void};
type Session={inputNames:string[];run(input:Record<string,Tensor>):Promise<Record<string,Tensor>>};
type Ort={env:{logLevel:string;wasm:{numThreads:number;proxy:boolean;wasmPaths:string}};
 Tensor:new(type:"float32",data:Float32Array,dims:number[])=>Tensor;
 InferenceSession:{create(bytes:Uint8Array,options:unknown):Promise<Session>}};
export type PersonModel={detect(bgr:Uint8Array,contentWidth:number,contentHeight:number,signal?:AbortSignal):Promise<PersonDetection[]>};
export class VisualAnalysisUnavailableError extends Error {}
const MODEL_HASH="4b82da9944b88577175ee23a459dce2e26e6e4be573def65b1055dc2d9720186";
const SIZE=416,FRAME_BYTES=SIZE*SIZE*3;
const directory=path.dirname(fileURLToPath(import.meta.url));
let cached:{directory:string;promise:Promise<PersonModel>}|undefined;
const clamp=(n:number,min=0,max=1)=>Math.max(min,Math.min(max,n));

async function resources(){
 for(const relative of ["../../resources/visual-analysis","../resources/visual-analysis"]){const candidate=path.resolve(directory,relative);try{await readFile(path.join(candidate,"provenance.json"));return candidate;}catch{/* next layout */}}
 throw new VisualAnalysisUnavailableError("Local people analysis is unavailable. Keep the original frame or choose a crop manually.");
}
// Distance-distribution decoder reimplemented from the Apache-2.0 OpenCV Zoo
// NanoDet reference. OpenCV source is not executed. Model outputs are paired by
// shape: this pinned model exposes class levels first, then box levels.
export function decodeNanoDet(outputs:Record<string,{data:Float32Array;dims:number[]}>,contentWidth:number,contentHeight:number):PersonDetection[]{
 const values=Object.values(outputs),people:PersonDetection[]=[];
 for(const stride of [8,16,32]){
  const side=SIZE/stride,rows=side*side;
  const cls=values.find(o=>o.dims.at(-1)===80&&o.dims.at(-2)===rows);
  const reg=values.find(o=>o.dims.at(-1)===32&&o.dims.at(-2)===rows);
  if(!cls||!reg)throw new Error("Unsupported local person-model outputs.");
  for(let row=0;row<rows;row++){
   const confidence=cls.data[row*80];if(confidence<.28||confidence>1||!Number.isFinite(confidence))continue;
   const distance=[];
   for(let edge=0;edge<4;edge++){
    const start=row*32+edge*8,maximum=Math.max(...reg.data.subarray(start,start+8));let denominator=0,numerator=0;
    for(let bin=0;bin<8;bin++){const w=Math.exp(reg.data[start+bin]-maximum);denominator+=w;numerator+=w*bin;}
    distance.push(numerator/denominator*stride);
   }
   const anchorX=(row%side)*stride+(stride-1)/2,anchorY=Math.floor(row/side)*stride+(stride-1)/2;
   const x=clamp((anchorX-distance[0])/contentWidth),y=clamp((anchorY-distance[1])/contentHeight);
   const right=clamp((anchorX+distance[2])/contentWidth),bottom=clamp((anchorY+distance[3])/contentHeight);
   if(right-x>.005&&bottom-y>.015)people.push({x,y,width:right-x,height:bottom-y,confidence});
  }
 }
 const kept:PersonDetection[]=[];
 for(const person of people.sort((a,b)=>b.confidence-a.confidence)){
  if(kept.every(p=>boxIoU(p,person)<.55))kept.push(person);if(kept.length===24)break;
 }
 return kept;
}
export async function loadPersonModel(resourceDirectory?:string):Promise<PersonModel>{
 const location=resourceDirectory??await resources();if(cached?.directory===location)return cached.promise;
 const promise=(async()=>{
  const provenance=JSON.parse(await readFile(path.join(location,"provenance.json"),"utf8"));
  const bytes=await readFile(path.join(location,"nanodet.onnx"));
  if(provenance.version!==1||provenance.model.sha256!==MODEL_HASH||createHash("sha256").update(bytes).digest("hex")!==MODEL_HASH)throw Error("Damaged local visual model.");
  const runtime=path.resolve(location,"../audio-events/runtime"),runtimeProvenance=JSON.parse(await readFile(path.resolve(location,"../audio-events/provenance.json"),"utf8"));
  if(runtimeProvenance.runtime.version!=="1.23.2")throw Error("Unsupported visual analysis runtime.");
  for(const name of ["ort.wasm.min.mjs","ort-wasm-simd-threaded.mjs","ort-wasm-simd-threaded.wasm"]){const b=await readFile(path.join(runtime,name));if(createHash("sha256").update(b).digest("hex")!==runtimeProvenance.files["runtime/"+name])throw Error("Visual runtime integrity check failed.");}
  const ort=await import(pathToFileURL(path.join(runtime,"ort.wasm.min.mjs")).href) as Ort;
  ort.env.logLevel="error";ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=pathToFileURL(runtime+path.sep).href;
  const session=await ort.InferenceSession.create(bytes,{executionProviders:["wasm"],logSeverityLevel:3});
  let pending:Promise<unknown>=Promise.resolve();
  return {detect(bgr:Uint8Array,contentWidth:number,contentHeight:number,signal?:AbortSignal){
   const operation=pending.then(async()=>{
    signal?.throwIfAborted();
    if(bgr.length!==FRAME_BYTES||contentWidth<1||contentHeight<1||contentWidth>SIZE||contentHeight>SIZE)throw Error("Invalid visual-model input.");
    const features=new Float32Array(SIZE*SIZE*3),means=[103.53,116.28,123.675],std=[57.375,57.12,58.395];
    for(let pixel=0;pixel<SIZE*SIZE;pixel++)for(let channel=0;channel<3;channel++)features[channel*SIZE*SIZE+pixel]=(bgr[pixel*3+channel]-means[channel])/std[channel];
    const tensor=new ort.Tensor("float32",features,[1,3,SIZE,SIZE]);let output:Record<string,Tensor>|undefined;
    try{output=await session.run({[session.inputNames[0]]:tensor});signal?.throwIfAborted();return decodeNanoDet(output,contentWidth,contentHeight);}
    finally{tensor.dispose();if(output)for(const value of Object.values(output))value.dispose();}
   });pending=operation.catch(()=>undefined);return operation;
  }};
 })();cached={directory:location,promise};
 try{return await promise;}catch(error){if(cached?.promise===promise)cached=undefined;throw new VisualAnalysisUnavailableError("Local people analysis is unavailable. Keep the original frame or choose a crop manually.",{cause:error});}
}
function metrics(bgr:Uint8Array,width:number,height:number,previous?:Uint8Array){
 let total=0,count=0,over=0,edge=0,motion=0;const histogram=new Array<number>(16).fill(0);
 const gray=(offset:number)=>bgr[offset]*.114+bgr[offset+1]*.587+bgr[offset+2]*.299;
 for(let y=2;y<height-2;y+=4)for(let x=2;x<width-2;x+=4){const offset=(y*SIZE+x)*3,g=gray(offset);total+=g;count++;if(g>245)over++;histogram[Math.min(15,Math.floor(g/16))]++;
  edge+=Math.abs(gray(offset-3)+gray(offset+3)+gray(offset-SIZE*3)+gray(offset+SIZE*3)-4*g);
  if(previous)motion+=(Math.abs(bgr[offset]-previous[offset])+Math.abs(bgr[offset+1]-previous[offset+1])+Math.abs(bgr[offset+2]-previous[offset+2]))/3;
 }
 return {luma:total/Math.max(1,count)/255,sharpness:edge/Math.max(1,count)/255,overexposed:over/Math.max(1,count),motion:motion/Math.max(1,count)/255,histogram:histogram.map(v=>v/Math.max(1,count))};
}
function enrichPerson(person:PersonDetection,bgr:Uint8Array,width:number,height:number):PersonDetection{
 const histogram=new Array<number>(24).fill(0);let count=0,brightness=0;
 const x0=Math.max(0,Math.floor(person.x*width)),x1=Math.min(width,Math.ceil((person.x+person.width)*width));
 const y0=Math.max(0,Math.floor((person.y+person.height*.15)*height)),y1=Math.min(height,Math.ceil((person.y+person.height*.8)*height));
 for(let y=y0;y<y1;y+=3)for(let x=x0;x<x1;x+=3){const at=(y*SIZE+x)*3;for(let c=0;c<3;c++)histogram[c*8+Math.min(7,Math.floor(bgr[at+c]/32))]++;count++;brightness+=bgr[at]*.114+bgr[at+1]*.587+bgr[at+2]*.299;}
 return {...person,appearance:histogram.map(n=>n/Math.max(1,count*3)),brightness:brightness/Math.max(1,count)/255};
}
async function probeSource(source:string,signal?:AbortSignal){
 const data=await new Promise<string>((resolve,reject)=>{
  const c=spawn(ffprobe.path,["-v","error","-show_streams","-show_format","-of","json",source],{windowsHide:true,signal});
  let out="",error="",processError:Error|undefined;
  c.stdout.on("data",d=>out+=d);c.stderr.on("data",d=>error+=d);
  // Abort emits `error` before Windows releases the source handle. Settle only
  // after close, preserving the original AbortError instead of racing cleanup.
  c.on("error",e=>{processError=e;});
  c.on("close",code=>processError?reject(processError):code===0?resolve(out):reject(Error(error||"Cannot inspect visual source.")));
 });
 const p=JSON.parse(data),video=p.streams?.find((s:{codec_type:string})=>s.codec_type==="video");if(!video)throw Error("No video to analyze.");
 return {...displayDimensions(video),duration:Number(p.format.duration),colorTransfer:typeof video.color_transfer==="string"?video.color_transfer:"unknown"};
}
/** Compact display-oriented SDR samples keep model/metrics comparable to a
 * tone-mapped preview. Scaling happens before the floating-point HDR pass. */
export function visualDecodeFilters(colorTransfer:string,width:number,height:number,fps:number,nativeRegion?:NormalizedBox):string {
 if(![width,height,fps].every(Number.isFinite)||width<2||height<2||width>SIZE||height>SIZE||fps<.25||fps>4)throw Error("Invalid visual decode settings.");
 if(nativeRegion&&(![nativeRegion.x,nativeRegion.y,nativeRegion.width,nativeRegion.height].every(Number.isInteger)||nativeRegion.x<0||nativeRegion.y<0||nativeRegion.width<2||nativeRegion.height<2))throw Error("Invalid native visual analysis region.");
 const crop=nativeRegion?`crop=${nativeRegion.width}:${nativeRegion.height}:${nativeRegion.x}:${nativeRegion.y},`:"";
 return `fps=${fps},${crop}scale=${width}:${height}:flags=bilinear,`+hdrToSdrFilter(colorTransfer)+
  `pad=${SIZE}:${SIZE}:0:0:color=0x727272`;
}
export async function analyzeVisualMedia(binary:string,source:string,options:{width?:number;height?:number;duration?:number;start?:number;end?:number;fps?:number;subject?:ManualSubject;signal?:AbortSignal;onProgress?:(value:{time:number;frames:number;fraction:number})=>void;model?:PersonModel}={}):Promise<VisualAnalysis>{
 options.signal?.throwIfAborted();
 for(const name of ["width","height","duration"] as const)if(options[name]!==undefined&&(!Number.isFinite(options[name])||options[name]!<=0))throw Error("Choose valid source dimensions and duration.");
 if(options.start!==undefined&&!Number.isFinite(options.start)||options.end!==undefined&&!Number.isFinite(options.end)||options.fps!==undefined&&(!Number.isFinite(options.fps)||options.fps<.25||options.fps>4))throw Error("Choose a valid visual analysis range.");
 if(options.start!==undefined&&options.end!==undefined&&Math.ceil((options.end-options.start)*(options.fps??2))>7200)throw Error("Visual analysis is limited to7200 sampled frames; use a lower sample rate for long recordings.");
 const metadata=await probeSource(source,options.signal);
 if(options.width!==undefined&&Math.abs(options.width-metadata.width)>.5||options.height!==undefined&&Math.abs(options.height-metadata.height)>.5)throw Error("Source dimensions do not match the displayed video orientation. Re-import this recording.");
 const start=options.start??0,end=options.end??metadata.duration,fps=options.fps??2;
 if(![metadata.width,metadata.height,start,end,fps].every(Number.isFinite)||metadata.width<=0||metadata.height<=0||start<0||end<=start||end>metadata.duration+.05||fps<.25||fps>4||Math.ceil((end-start)*fps)>7200)throw Error("Choose a valid visual analysis range (up to7200 sampled frames). Use a lower sample rate for long recordings.");
 const analysisRegion=subjectAnalysisRegion(metadata.width,metadata.height,options.subject);
 const nativeRegion=analysisRegion?{x:Math.round(analysisRegion.x*metadata.width),y:Math.round(analysisRegion.y*metadata.height),width:Math.round(analysisRegion.width*metadata.width),height:Math.round(analysisRegion.height*metadata.height)}:undefined;
 const nativeWidth=nativeRegion?.width??metadata.width,nativeHeight=nativeRegion?.height??metadata.height;
 const model=options.model??await loadPersonModel();options.signal?.throwIfAborted();
 const ratio=Math.min(analysisRegion?1:Infinity,SIZE/nativeWidth,SIZE/nativeHeight),width=Math.max(2,Math.floor((nativeWidth*ratio+1e-6)/2)*2),height=Math.max(2,Math.floor((nativeHeight*ratio+1e-6)/2)*2);
 const decoder=spawn(binary,["-v","error","-nostdin","-threads","2","-filter_threads","2","-ss",String(start),"-t",String(end-start),"-i",source,"-map","0:v:0","-an","-vf",visualDecodeFilters(metadata.colorTransfer,width,height,fps,nativeRegion),"-pix_fmt","bgr24","-f","rawvideo","pipe:1"],{windowsHide:true,signal:options.signal});
 let error="";decoder.stderr.on("data",d=>error=(error+d).slice(-3000));
 const closed=new Promise<void>(resolve=>{decoder.once("close",()=>resolve());});
 const complete=new Promise<void>((resolve,reject)=>{decoder.on("error",reject);decoder.on("close",code=>code===0?resolve():reject(Error(error||"Visual analysis could not finish.")));});void complete.catch(()=>undefined);
 let buffer=Buffer.alloc(0),previous:Uint8Array|undefined,previousHistogram:number[]|undefined;const frames:VisualFrame[]=[];
 try{
  for await(const data of decoder.stdout){
   options.signal?.throwIfAborted();buffer=Buffer.concat([buffer,data as Buffer]);
   while(buffer.length>=FRAME_BYTES){
    options.signal?.throwIfAborted();const frame=buffer.subarray(0,FRAME_BYTES);buffer=buffer.subarray(FRAME_BYTES);
    const time=Math.min(end,start+frames.length/fps),m=metrics(frame,width,height,previous),detections=await model.detect(frame,width,height,options.signal);
    const histogramDistance=previousHistogram?m.histogram.reduce((n,v,i)=>n+Math.abs(v-previousHistogram![i]),0)/2:0;
    const people=detections.map(p=>enrichPerson(p,frame,width,height)).map(p=>analysisRegion?{...p,x:analysisRegion.x+p.x*analysisRegion.width,y:analysisRegion.y+p.y*analysisRegion.height,width:p.width*analysisRegion.width,height:p.height*analysisRegion.height}:p);
    frames.push({time,people,luma:m.luma,sharpness:m.sharpness,motion:m.motion,overexposed:m.overexposed,
     sceneChange:histogramDistance>.7&&m.motion>.35});
    previous=Uint8Array.from(frame);previousHistogram=m.histogram;
    options.onProgress?.({time,frames:frames.length,fraction:Math.min(1,(time-start+1/fps)/(end-start))});
   }
  }
  await complete;options.signal?.throwIfAborted();if(buffer.length)throw Error("Incomplete decoded visual frame.");
  return {version:1,width:metadata.width,height:metadata.height,start,end,sampleFps:fps,detector:"OpenCV NanoDet416 COCO person; local CPU WASM",frames,
   sourceColorTransfer:metadata.colorTransfer,toneMapped:metadata.colorTransfer==="arib-std-b67"||metadata.colorTransfer==="smpte2084",...(analysisRegion?{analysisRegion}:{}),
   limitations:["People boxes do not establish singer identity or exact body silhouettes.","Small distant performers, screens, smoke and foreground crowds can confuse detection.","Sampled-frame continuity is a tracking heuristic, not face recognition or reliable re-identification after long occlusion.","Review framing and use manual subject selection where automatic stage context is ambiguous.",...(analysisRegion?["Detection and picture-quality metrics use the recorded native subject region; boxes map back to full-source coordinates. The region is fixed, so a subject leaving it can be lost."]:[])]};
 }finally{
  if(decoder.exitCode===null)decoder.kill();
  // complete can reject at the AbortError event, before process/stdio close.
  // Await the independent lifecycle signal so a caller may immediately rename,
  // remove or reopen a cancelled Windows source without an EBUSY race.
  await closed;await complete.catch(()=>undefined);
 }
}
