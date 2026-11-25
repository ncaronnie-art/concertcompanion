import type {ManualSubject,NormalizedBox,PersonDetection,TrackingKeyframe,TrackingPlan,VisualAnalysis,VisualFrame} from "./visual-tracking.js";

// Project files are untrusted input. Copy only supported data and reject values
// that could expand memory/expressions or put crops outside the source picture.
const MAX_FRAMES=7200,MAX_PEOPLE=100,MAX_SOURCE_SECONDS=7*24*60*60;
type RecordValue=Record<string,unknown>;
function object(value:unknown,label:string):RecordValue {
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error(`${label} must be an object.`);
 return value as RecordValue;
}
function number(value:unknown,label:string,min:number,max:number,integer=false):number {
 if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isInteger(value))throw Error(`${label} must be ${integer?"a whole number":"a number"} between ${min} and ${max}.`);
 return value;
}
function boolean(value:unknown,label:string):boolean {
 if(typeof value!=="boolean")throw Error(`${label} must be true or false.`);
 return value;
}
function text(value:unknown,label:string,max:number):string {
 if(typeof value!=="string"||value.length>max||value.includes("\0"))throw Error(`${label} must be text of at most ${max} characters.`);
 return value;
}
function array(value:unknown,label:string,max:number):unknown[] {
 if(!Array.isArray(value)||value.length>max)throw Error(`${label} must contain at most ${max} entries.`);
 return value;
}
function texts(value:unknown,label:string):string[] {return array(value,label,32).map((v,i)=>text(v,`${label} ${i+1}`,500));}
function box(value:unknown,label:string):NormalizedBox {
 const o=object(value,label),x=number(o.x,`${label} left`,0,1),y=number(o.y,`${label} top`,0,1);
 const width=number(o.width,`${label} width`,Number.EPSILON,1),height=number(o.height,`${label} height`,Number.EPSILON,1);
 if(x+width>1.000001||y+height>1.000001)throw Error(`${label} extends outside the picture.`);
 return {x,y,width,height};
}
function person(value:unknown,label:string):PersonDetection {
 const o=object(value,label),p:PersonDetection={...box(o,label),confidence:number(o.confidence,`${label} confidence`,0,1)};
 if(o.appearance!==undefined)p.appearance=array(o.appearance,`${label} appearance`,64).map(v=>number(v,`${label} appearance value`,0,1));
 if(o.brightness!==undefined)p.brightness=number(o.brightness,`${label} brightness`,0,1);
 return p;
}
/** Source-picture point selected by the user, not an artist identity. */
export function parseManualSubject(value:unknown):ManualSubject|undefined {
 if(value===undefined)return undefined;
 const o=object(value,"Selected subject");
 return {x:number(o.x,"Selected subject horizontal position",0,1),y:number(o.y,"Selected subject vertical position",0,1),
  ...(o.time===undefined?{}:{time:number(o.time,"Selected performer moment",0,MAX_SOURCE_SECONDS)})};
}
export function parseVisualAnalysis(value:unknown):VisualAnalysis|undefined {
 if(value===undefined)return undefined;
 const o=object(value,"Visual analysis");
 if(o.version!==1)throw Error("Unsupported visual-analysis version.");
 const start=number(o.start,"Visual-analysis start",0,MAX_SOURCE_SECONDS),end=number(o.end,"Visual-analysis end",0,MAX_SOURCE_SECONDS);
 if(end<=start)throw Error("Visual-analysis end must follow its start.");
 let previous=-Infinity;
 const frames:VisualFrame[]=array(o.frames,"Visual-analysis frames",MAX_FRAMES).map((value,i)=>{
  const label=`Visual frame ${i+1}`,f=object(value,label),time=number(f.time,`${label} time`,start,end);
  if(time<=previous)throw Error("Visual-analysis frame times must increase.");previous=time;
  const frame:VisualFrame={time,people:array(f.people,`${label} people`,MAX_PEOPLE).map((p,j)=>person(p,`${label} person ${j+1}`)),
   luma:number(f.luma,`${label} brightness`,0,1),sharpness:number(f.sharpness,`${label} sharpness`,0,4),
   motion:number(f.motion,`${label} movement`,0,1),overexposed:number(f.overexposed,`${label} overexposure`,0,1)};
  if(f.sceneChange!==undefined)frame.sceneChange=boolean(f.sceneChange,`${label} scene change`);
  return frame;
 });
 const result:VisualAnalysis={version:1,width:number(o.width,"Visual-analysis width",1,32768,true),height:number(o.height,"Visual-analysis height",1,32768,true),
  start,end,sampleFps:number(o.sampleFps,"Visual-analysis sample rate",.25,4),detector:text(o.detector,"Visual-analysis detector",200),frames,limitations:texts(o.limitations,"Visual-analysis limitations")};
 if(o.sourceColorTransfer!==undefined)result.sourceColorTransfer=text(o.sourceColorTransfer,"Source color transfer",80);
 if(o.toneMapped!==undefined)result.toneMapped=boolean(o.toneMapped,"Tone-mapped samples");
 if(o.analysisRegion!==undefined)result.analysisRegion=box(o.analysisRegion,"Native analysis region");
 return result;
}
export function parseTrackingPlan(value:unknown):TrackingPlan|undefined {
 if(value===undefined)return undefined;
 const o=object(value,"Tracking plan");
 if(o.version!==1)throw Error("Unsupported tracking-plan version.");
 if(o.suggestedFraming!=="fill"&&o.suggestedFraming!=="fit")throw Error("Tracking framing must be fill or fit.");
 let previous=-Infinity;
 const keyframes:TrackingKeyframe[]=array(o.keyframes,"Tracking frames",MAX_FRAMES).map((value,i)=>{
  const label=`Tracking frame ${i+1}`,f=object(value,label),time=number(f.time,`${label} time`,0,MAX_SOURCE_SECONDS);
  if(time<=previous)throw Error("Tracking frame times must increase.");previous=time;
  if(f.status!=="tracking"&&f.status!=="held"&&f.status!=="searching"&&f.status!=="group"&&f.status!=="off")throw Error(`${label} has an unsupported tracking status.`);
  const frame:TrackingKeyframe={...box(f,label),time,confidence:number(f.confidence,`${label} confidence`,0,1),status:f.status};
  if(f.subject!==undefined)frame.subject=box(f.subject,`${label} subject`);
  return frame;
 });
 return {version:1,keyframes,subjectLocked:boolean(o.subjectLocked,"Selected-subject lock"),coverage:number(o.coverage,"Tracking coverage",0,1),suggestedFraming:o.suggestedFraming,notes:texts(o.notes,"Tracking notes")};
}
