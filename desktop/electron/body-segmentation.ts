import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {createReadStream} from "node:fs";
import {readFile,writeFile,mkdir,mkdtemp,stat,rename} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import ffprobe from "ffprobe-static";
import {displayDimensions} from "./media-orientation.js";
import {analyzeVisualMedia} from "./visual-analysis.js";
import {withTemporaryCleanup} from "./temporary-cleanup.js";
import {hdrToSdrFilter} from "../src/shared/video-color.js";
import {planVisualTracking,subjectAnalysisRegion,type ManualSubject,type NormalizedBox,type TrackingPlan,type VisualAnalysis} from "../src/shared/visual-tracking.js";
import {parseManualSubject,parseTrackingPlan,parseVisualAnalysis} from "../src/shared/visual-settings.js";
import {BodyMaskRunGate,bodyProcessingRegion,pointInRegion,boxInRegion,refineBodyProbability,cleanBodyAlpha,type BodyMask} from "../src/shared/body-mask.js";
import type {MediaAsset} from "../src/shared/render-plan.js";
import {createBodyPointModel,type CandidateSummary} from "./body-point-model.js";

const SIZE=192;
export type BodySegmentationContext={width:number;height:number;subject?:ManualSubject;expected?:NormalizedBox;previous?:Uint8Array;sourceTime?:number};
export type BodyCandidateDecision={sourceTime?:number;candidates:CandidateSummary[];selected?:number;reason?:string};
export type BodySegmentationModel={id:string;sha256:string;processingId?:string;inputSize?:number;preserveAspect?:boolean;runtime?:string;runtimeVersion?:string;getLastDecision?:()=>BodyCandidateDecision|undefined;segment(rgb:Uint8Array,signal?:AbortSignal,context?:BodySegmentationContext):Promise<Float32Array>};
export type BodyMaskProgress={frames:number;fraction:number;sourceTime:number;phase:"analyzing"|"masking"};
export type BodyMaskOptions={start:number;end:number;subject?:ManualSubject;analysis?:VisualAnalysis;tracking?:TrackingPlan;visibleRegion?:NormalizedBox;activeRanges?:{start:number;end:number}[];fps?:number;signal?:AbortSignal;onProgress?:(progress:BodyMaskProgress)=>void;
 /** Backend test hook, never forwarded from renderer/project input. */model?:BodySegmentationModel};
export class BodyMaskUnavailableError extends Error{}
const directory=path.dirname(fileURLToPath(import.meta.url)),hash=(v:Uint8Array|string)=>createHash("sha256").update(v).digest("hex");
let cachedModel:{directory:string;promise:Promise<BodySegmentationModel>}|undefined;
const pending=new Map<string,Promise<BodyMask>>();
async function sourceHash(file:string,signal?:AbortSignal){const h=createHash("sha256");for await(const chunk of createReadStream(file)){signal?.throwIfAborted();h.update(chunk);}return h.digest("hex");}
async function resourceDirectory(){
 for(const relative of ["../../resources/body-segmentation","../resources/body-segmentation"]){const candidate=path.resolve(directory,relative);try{await stat(path.join(candidate,"provenance.json"));return candidate;}catch{/* next layout */}}
 throw new BodyMaskUnavailableError("The local body-outline model is unavailable. Your video can still export without body outlines.");
}
export async function loadBodyModel(location?:string):Promise<BodySegmentationModel>{
 const folder=location??await resourceDirectory();if(cachedModel?.directory===folder)return cachedModel.promise;
 const promise=createBodyPointModel(folder);cachedModel={directory:folder,promise};
 try{return await promise;}catch(error){if(cachedModel?.promise===promise)cachedModel=undefined;throw new BodyMaskUnavailableError("The local body-outline model is unavailable or damaged. Your video can still export without body outlines.",{cause:error});}
}
function lifecycle(child:ChildProcessWithoutNullStreams){
 let error="",processError:Error|undefined;child.stderr.on("data",d=>error=(error+d).slice(-5000));
 const closed=new Promise<void>(resolve=>child.once("close",()=>resolve()));
 const done=new Promise<void>((resolve,reject)=>{child.once("error",e=>{processError=e;reject(e);});child.once("close",code=>processError?reject(processError):code===0?resolve():reject(Error(error||"Body-mask processing could not finish.")));});void done.catch(()=>undefined);
 return {done,closed};
}
async function probe(source:string,signal?:AbortSignal){
 const child=spawn(ffprobe.path,["-v","error","-show_streams","-show_format","-of","json",source],{windowsHide:true,signal});let data="";child.stdout.on("data",d=>data+=d);const state=lifecycle(child);
 try{await state.done;signal?.throwIfAborted();const p=JSON.parse(data),video=p.streams.find((s:{codec_type:string})=>s.codec_type==="video");if(!video)throw Error("This recording has no video for body outlines.");return {...displayDimensions(video),duration:Number(p.format.duration),colorTransfer:video.color_transfer??"unknown"};}
 finally{await state.closed;}
}
function boxAt(plan:TrackingPlan|undefined,time:number):NormalizedBox|undefined{
 const keys=plan?.keyframes??[];const before=[...keys].reverse().find(k=>k.time<=time&&k.subject),after=keys.find(k=>k.time>=time&&k.subject);
 if(before?.subject&&after?.subject&&after.time>before.time&&after.time-before.time<=2){const f=(time-before.time)/(after.time-before.time),a=before.subject,b=after.subject;return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,width:a.width+(b.width-a.width)*f,height:a.height+(b.height-a.height)*f};}
 return before?.subject??(after&&after.time-time<1?after.subject:undefined);
}
async function writeFrame(child:ChildProcessWithoutNullStreams,data:Uint8Array){
 await new Promise<void>((resolve,reject)=>{child.stdin.write(data,error=>error?reject(error):resolve());});
}
async function suppressUnsafeAccents(binary:string,input:string,output:string,ranges:{first:number;last:number}[],signal?:AbortSignal){
 const enabled=ranges.map(r=>`between(n,${r.first},${r.last})`).join("+");
 const child=spawn(binary,["-v","error","-nostdin","-threads","2","-filter_threads","2","-i",input,"-map","0:v:0","-an","-vf",`format=gray,lut=y=0:enable='${enabled}'`,"-fps_mode","passthrough","-c:v","ffv1","-level","3","-pix_fmt","gray","-map_metadata","-1","-threads","2",output],{windowsHide:true,signal}),state=lifecycle(child);child.stdout.resume();
 try{await state.done;signal?.throwIfAborted();}finally{if(child.exitCode===null)child.kill();await state.closed;await Promise.allSettled([state.done]);}
}
/** Generate a learned, selected-person alpha video only. This function never
 * decodes, filters, remixes or writes any audio stream. */
export async function prepareBodyMask(binary:string,asset:MediaAsset,options:BodyMaskOptions,cacheDirectory:string):Promise<BodyMask>{
 options.signal?.throwIfAborted();const fps=options.fps??30,subject=parseManualSubject(options.subject);
 if(![options.start,options.end,fps].every(Number.isFinite)||options.start<0||options.end<=options.start||options.end>asset.duration+.05||fps<10||fps>30||Math.ceil((options.end-options.start)*fps)>18000)throw Error("Choose a valid body-outline range (up to18000 mask frames at10–30fps).");
 const visibleRegion=options.visibleRegion;
 if(visibleRegion&&(![visibleRegion.x,visibleRegion.y,visibleRegion.width,visibleRegion.height].every(Number.isFinite)||visibleRegion.x<0||visibleRegion.y<0||visibleRegion.width<=0||visibleRegion.height<=0||visibleRegion.x+visibleRegion.width>1.000001||visibleRegion.y+visibleRegion.height>1.000001))throw Error("Choose a valid visible body-outline composition.");
 const activeRanges=options.activeRanges;
 if(activeRanges&&(!Array.isArray(activeRanges)||activeRanges.length>16||activeRanges.some(r=>![r.start,r.end].every(Number.isFinite)||r.start<options.start-1e-6||r.end>options.end+1e-6||r.end<=r.start)))throw Error("Choose valid source-time body-outline accents.");
 const inComposition=(box:NormalizedBox)=>!visibleRegion||(box.x+box.width/2>=visibleRegion.x&&box.x+box.width/2<=visibleRegion.x+visibleRegion.width&&box.y+box.height/2>=visibleRegion.y&&box.y+box.height/2<=visibleRegion.y+visibleRegion.height);
 const eligible=(p:NormalizedBox)=>inComposition(p)&&(subject||p.height>=.12)&&!(p.y+p.height>.97&&(p.height>.5||p.y+p.height/2>.75&&p.height>.35));
 const root=path.resolve(cacheDirectory);if(!root||path.resolve(asset.path).toLowerCase()===root.toLowerCase())throw Error("Choose a separate local body-outline workspace.");
 await mkdir(root,{recursive:true});const metadata=await probe(asset.path,options.signal);
 if(metadata.width!==asset.width||metadata.height!==asset.height||options.end>metadata.duration+.05)throw Error("The body-outline source changed. Re-import this recording.");
 let analysis=parseVisualAnalysis(options.analysis),tracking=parseTrackingPlan(options.tracking);
 const warnings:string[]=[];
 if(subject&&analysis){
  const selectedRegion=subjectAnalysisRegion(metadata.width,metadata.height,subject)!,previousRegion=analysis.analysisRegion;
  if(!previousRegion||(["x","y","width","height"] as const).some(key=>Math.abs(previousRegion[key]-selectedRegion[key])>1e-6)){
   options.onProgress?.({phase:"analyzing",frames:0,fraction:0,sourceTime:options.start});
   analysis=await analyzeVisualMedia(binary,asset.path,{start:options.start,end:options.end,fps:2,subject,signal:options.signal});tracking=undefined;
   warnings.push("Your selected subject was rechecked in local picture detail before drawing an outline.");
  }
 }
 if(!analysis&&!tracking){
  options.onProgress?.({phase:"analyzing",frames:0,fraction:0,sourceTime:options.start});
  analysis=await analyzeVisualMedia(binary,asset.path,{start:options.start,end:options.end,fps:2,subject,signal:options.signal});
 }
 // The approved picture composition is authoritative. An off-crop drummer or
 // foreground person cannot become the effect subject simply by scoring well.
 if(analysis&&visibleRegion){analysis={...analysis,frames:analysis.frames.map(frame=>({...frame,people:frame.people.filter(eligible)}))};tracking=undefined;
  if(!subject&&!analysis.frames.some(frame=>frame.people.length)){
   // A small stage performer may be missed by whole-frame analysis. Retry
   // native detail once inside the approved picture; this hint is never a
   // persisted manual subject lock and does not move the actual picture crop.
   const hint={x:visibleRegion.x+visibleRegion.width/2,y:Math.max(visibleRegion.y,Math.min(visibleRegion.y+visibleRegion.height,.6))};
   const retry=await analyzeVisualMedia(binary,asset.path,{start:options.start,end:options.end,fps:2,subject:hint,signal:options.signal});
   analysis={...retry,frames:retry.frames.map(frame=>({...frame,people:frame.people.filter(eligible)}))};warnings.push("Automatic body targeting used native detail inside the existing picture composition; it does not recognize the artist.");
  }
 }
 if(analysis&&(!tracking||subject&&!tracking.subjectLocked))tracking=planVisualTracking(analysis,{mode:"follow-performer",subject});
 const bodyBoxes=tracking?.keyframes.filter(k=>k.time>=options.start-.6&&k.time<=options.end+.6&&k.status==="tracking"&&k.confidence>=.28&&k.subject&&inComposition(k.subject)).map(k=>k.subject!)??[];
 const region=bodyProcessingRegion(metadata.width,metadata.height,bodyBoxes,subject),sourceSHA256=await sourceHash(asset.path,options.signal),model=options.model??await loadBodyModel();
 const size=model.inputSize??SIZE;
 if(!Number.isInteger(size)||size<64||size>512)throw Error("Unsupported body-mask model input size.");
 const nativeW=Math.round(region.width*metadata.width),nativeH=Math.round(region.height*metadata.height),guidanceScale=Math.min(1,size/Math.max(nativeW,nativeH));
 // HLG/PQ display conversion includes subsampled YUV; keep both guidance
 // sides chroma-aligned. This rounds by at most one analysis pixel and never
 // changes the source picture or its actual render composition.
 const inputWidth=model.preserveAspect?Math.max(2,Math.round(nativeW*guidanceScale/2)*2):size,inputHeight=model.preserveAspect?Math.max(2,Math.round(nativeH*guidanceScale/2)*2):size,pixels=inputWidth*inputHeight,rgbBytes=pixels*3;
 const processingId=hash("exterior-body-mask-v8-current-evidence-before-temporal\n"+refineBodyProbability.toString()+cleanBodyAlpha.toString()+bodyProcessingRegion.toString()+BodyMaskRunGate.toString()+suppressUnsafeAccents.toString());
 const key=hash(JSON.stringify({version:2,processingId,modelProcessor:model.processingId,sourceSHA256,start:options.start,end:options.end,fps,subject,region,tracking,visibleRegion,activeRanges,model:model.sha256,inputWidth,inputHeight,color:hdrToSdrFilter(metadata.colorTransfer)}));
 const cacheFile=path.join(root,`body-${key}.json`),existing=pending.get(root+key);if(existing)return existing;
 const operation=(async()=>{
  try{
   const saved=JSON.parse(await readFile(cacheFile,"utf8")) as BodyMask;
   if(saved.version===1&&saved.encodingVersion===2&&saved.processingId===processingId&&saved.sourceSHA256===sourceSHA256&&saved.modelSha256===model.sha256&&saved.start===options.start&&saved.end===options.end&&saved.fps===fps&&path.dirname(path.resolve(saved.path))===root&&(await stat(saved.path)).size>100)return saved;
  }catch{/* cache miss or interrupted prior generation */}
  const scratch=await mkdtemp(path.join(root,"body-work-"));if(path.dirname(path.resolve(scratch))!==root)throw Error("Invalid local body-outline workspace.");
  const result=await withTemporaryCleanup(scratch,async()=>{
   const began=Date.now(),output=path.join(root,`body-${key}-${randomUUID()}.mkv`),temporary=path.join(scratch,"alpha.mkv"),framesExpected=Math.ceil((options.end-options.start)*fps-1e-8);
   const scale=Math.min(1,768/Math.max(metadata.width,metadata.height)),width=Math.max(2,Math.round(metadata.width*scale/2)*2),height=Math.max(2,Math.round(metadata.height*scale/2)*2);
   const x=Math.round(region.x*metadata.width),y=Math.round(region.y*metadata.height),w=Math.round(region.width*metadata.width),h=Math.round(region.height*metadata.height);
   const mx=Math.floor(region.x*width),my=Math.floor(region.y*height),mw=Math.max(1,Math.min(width-mx,Math.round(region.width*width))),mh=Math.max(1,Math.min(height-my,Math.round(region.height*height)));
   const toneMap=hdrToSdrFilter(metadata.colorTransfer).replace(/,$/,""),decodeFilter=`fps=${fps},crop=${w}:${h}:${x}:${y},scale=${inputWidth}:${inputHeight}:flags=lanczos`+(toneMap?","+toneMap:"");
   const decoder=spawn(binary,["-v","error","-nostdin","-threads","2","-filter_threads","2","-ss",String(options.start),"-t",String(options.end-options.start),"-i",asset.path,"-map","0:v:0","-an","-vf",decodeFilter,"-pix_fmt","rgb24","-f","rawvideo","pipe:1"],{windowsHide:true,signal:options.signal});
   const encoder=spawn(binary,["-v","error","-nostdin","-threads","2","-filter_threads","2","-f","rawvideo","-pixel_format","gray","-video_size",`${inputWidth}x${inputHeight}`,"-framerate",String(fps),"-i","pipe:0","-an","-vf",`scale=${mw}:${mh}:flags=bilinear,pad=${width}:${height}:${mx}:${my}:color=black,lut=y='if(lte(val,16),0,val)',setsar=1`,"-c:v","ffv1","-level","3","-pix_fmt","gray","-map_metadata","-1","-threads","2",temporary],{windowsHide:true,signal:options.signal});
   const decoded=lifecycle(decoder),encoded=lifecycle(encoder);let stdinError:Error|undefined;encoder.stdin.on("error",e=>{stdinError=e;});encoder.stdout.resume();
   let buffer=Buffer.alloc(0),frames=0,rawAcceptedFrames=0,acceptedFrames=0,fadedFrames=0,modelMilliseconds=0,previous:Uint8Array|undefined,lastBounds:NormalizedBox|undefined;
   const candidateDecisions:BodyCandidateDecision[]=[];
   const frameQuality:NonNullable<BodyMask["frameQuality"]>=[];
   const minimumStableFrames=Math.max(2,Math.ceil(fps*.2)),gate=new BodyMaskRunGate(minimumStableFrames,async frame=>{
    await writeFrame(encoder,frame.alpha);
    if(frame.status==="accepted")acceptedFrames++;else if(frame.status==="faded")fadedFrames++;
    frameQuality.push({time:frame.time,status:frame.status,confidence:frame.confidence,...(frame.reason?{reason:frame.reason}:{})});
   });
   const canTarget=bodyBoxes.length>0;
   if(!canTarget)warnings.push("No reliable selected body was found; the body outline was suppressed instead of selecting an audience member.");
   try{
    for await(const chunk of decoder.stdout){
     options.signal?.throwIfAborted();buffer=Buffer.concat([buffer,chunk as Buffer]);
     while(buffer.length>=rgbBytes){
      const rgb=buffer.subarray(0,rgbBytes);buffer=buffer.subarray(rgbBytes);if(frames>=framesExpected)continue;
      options.signal?.throwIfAborted();if(stdinError)throw stdinError;
      const time=options.start+frames/fps,expected=boxAt(tracking,time),localExpected=expected&&inComposition(expected)?boxInRegion(expected,region):undefined,active=!activeRanges||activeRanges.some(r=>time>=r.start-1e-7&&time<r.end-1e-7);
      if(!active||!canTarget||!localExpected){previous=undefined;lastBounds=undefined;await gate.push({alpha:new Uint8Array(pixels),time,status:"suppressed",confidence:0,reason:!active?"outside-creative-accent":"no-reliable-visible-body"});frames++;options.onProgress?.({phase:"masking",frames,fraction:Math.min(1,frames/framesExpected),sourceTime:time});continue;}
      const anchor=localExpected?{x:localExpected.x+localExpected.width/2,y:localExpected.y+localExpected.height*.45}:pointInRegion(subject??{x:.5,y:.5},region);
      const beganModel=Date.now(),probability=await model.segment(rgb,options.signal,{width:inputWidth,height:inputHeight,subject:subject?pointInRegion(subject,region):undefined,expected:localExpected,previous,sourceTime:time});modelMilliseconds+=Date.now()-beganModel;
      const decision=model.getLastDecision?.();if(decision)candidateDecisions.push(decision);
      const refined=refineBodyProbability(probability,inputWidth,inputHeight,{anchor,expected:localExpected,previous,lastBounds});
      let alpha=refined.alpha,status:"accepted"|"faded"|"suppressed"="suppressed",reason=refined.reason;
      if(refined.accepted){rawAcceptedFrames++;status="accepted";lastBounds=refined.bounds;}
      previous=alpha;await gate.push({alpha,time,status,confidence:refined.accepted?refined.confidence:0,...(reason?{reason}:{})});frames++;
      options.onProgress?.({phase:"masking",frames,fraction:Math.min(1,frames/framesExpected),sourceTime:time});
     }
    }
    await decoded.done;options.signal?.throwIfAborted();if(buffer.length)throw Error("Incomplete decoded body-mask frame.");
    if(framesExpected-frames>1)throw Error("The recording ended before its body-outline range.");
    while(frames<framesExpected){await gate.push({alpha:new Uint8Array(pixels),time:options.start+frames/fps,status:"suppressed",confidence:0,reason:"source-boundary-rounding"});frames++;warnings.push("One boundary mask frame was suppressed to cover source frame-rate rounding.");}
    await gate.finish();encoder.stdin.end();await encoded.done;options.signal?.throwIfAborted();
   }finally{
    if(decoder.exitCode===null)decoder.kill();if(encoder.exitCode===null)encoder.kill();
    await Promise.all([decoded.closed,encoded.closed]);await Promise.allSettled([decoded.done,encoded.done]);
   }
   const strongReasons=new Set(["body-occlusion-uncertainty","body-context-leak","analysis-region-edge-leak","rectangular-background-component"]);
   const suppressedAccentRanges=(activeRanges??[]).flatMap(range=>{
    const first=Math.max(0,Math.ceil((range.start-options.start)*fps-1e-6)),last=Math.min(frames-1,Math.ceil((range.end-options.start)*fps-1e-6)-1);
    const trigger=frameQuality.slice(first,last+1).find(frame=>frame.reason&&strongReasons.has(frame.reason));
    return trigger?[{...range,reason:trigger.reason!,first,last}]:[];
   });
   if(suppressedAccentRanges.length){
    const safe=path.join(scratch,"safe-accents.mkv");await suppressUnsafeAccents(binary,temporary,safe,suppressedAccentRanges,options.signal);
    for(const range of suppressedAccentRanges)for(let index=range.first;index<=range.last;index++){
     const frame=frameQuality[index];frame.status="suppressed";frame.confidence=0;if(!frame.reason||!strongReasons.has(frame.reason))frame.reason="unsafe-accent-window";
    }
    acceptedFrames=frameQuality.filter(f=>f.status==="accepted").length;fadedFrames=frameQuality.filter(f=>f.status==="faded").length;
    warnings.push("An entire short outline accent was suppressed because a frame had a substantial obstruction or unreliable body boundary.");await rename(safe,output);
   }else await rename(temporary,output);
   const value:BodyMask={version:1,encodingVersion:2,path:output,start:options.start,end:options.end,width,height,sourceWidth:metadata.width,sourceHeight:metadata.height,fps,frames,coverage:(acceptedFrames+fadedFrames)/frames,modelId:model.id,modelSha256:model.sha256,sourceSHA256,processingId,subject,analysisRegion:region,visibleRegion,activeRanges,candidateDecisions,suppressedAccentRanges:suppressedAccentRanges.map(({start,end,reason})=>({start,end,reason})),
    warnings:[...new Set([...warnings,"Learned person segmentation plus selected-component continuity does not recognize artist identity.","Bright stage lights, projected people, clothing and obstructions can confuse the mask; uncertain frames are faded or suppressed.","Only tiny enclosed pinholes are filled. Larger upper-body air gaps remain transparent; substantial lower-body uncertainty suppresses the outline."])],
    stats:{acceptedFrames,suppressedFrames:frames-acceptedFrames-fadedFrames,fadedFrames,rawAcceptedFrames,minimumStableFrames,modelMilliseconds,elapsedSeconds:(Date.now()-began)/1000},frameQuality};
   await writeFile(cacheFile,JSON.stringify(value));return value;
  });
  if(result.cleanupWarning)result.value.warnings.push("Some generated temporary mask files could not be removed yet.");return result.value;
 })();pending.set(root+key,operation);try{return await operation;}finally{pending.delete(root+key);}
}


