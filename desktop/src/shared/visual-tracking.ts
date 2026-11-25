export type NormalizedBox = { x: number; y: number; width: number; height: number };
export type PersonDetection = NormalizedBox & { confidence: number; appearance?: number[]; brightness?: number };
export type VisualFrame = { time: number; people: PersonDetection[]; luma: number; sharpness: number;
  motion: number; overexposed: number; sceneChange?: boolean };
export type VisualAnalysis = { version: 1; width: number; height: number; start: number; end: number;
  sampleFps: number; detector: string; frames: VisualFrame[]; limitations: string[];
  sourceColorTransfer?: string; toneMapped?: boolean; analysisRegion?: NormalizedBox };
export type SmartFraming = "off" | "balanced" | "follow-performer" | "group-performance";
export type ManualSubject = { x: number; y: number; time?: number };
export type TrackingKeyframe = NormalizedBox & { time: number; confidence: number;
  status: "tracking" | "held" | "searching" | "group" | "off"; subject?: NormalizedBox };
export type TrackingPlan = { version: 1; keyframes: TrackingKeyframe[]; subjectLocked: boolean;
  coverage: number; suggestedFraming: "fill" | "fit"; notes: string[] };
/** Native-detail analysis region around a user point. Chroma-aligned pixel
 * edges are normalized back to the full, display-oriented source picture.
 * This is only an analysis window; it does not change the exported crop. */
export function subjectAnalysisRegion(width:number,height:number,subject?:ManualSubject):NormalizedBox|undefined {
  if(!subject)return undefined;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||
    !Number.isFinite(subject.x)||!Number.isFinite(subject.y)||subject.x<0||subject.x>1||subject.y<0||subject.y>1)throw Error("Choose a subject inside a video with valid picture dimensions.");
  const w=Math.max(2,Math.floor(width*.45/2)*2),h=Math.max(2,Math.floor(height*.5/2)*2);
  const x=Math.max(0,Math.min(Math.floor((width-w)/2)*2,Math.floor((subject.x*width-w/2)/2)*2));
  const y=Math.max(0,Math.min(Math.floor((height-h)/2)*2,Math.floor((subject.y*height-h/2)/2)*2));
  return {x:x/width,y:y/height,width:w/width,height:h/height};
}
const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const cx = (b: NormalizedBox) => b.x + b.width / 2;
const cy = (b: NormalizedBox) => b.y + b.height / 2;
const area = (b: NormalizedBox) => b.width * b.height;
export function boxIoU(a: NormalizedBox, b: NormalizedBox): number {
  const intersection = Math.max(0, Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)) *
    Math.max(0, Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  return intersection / Math.max(1e-9, area(a)+area(b)-intersection);
}
function validPerson(p: PersonDetection) {
  return [p.x,p.y,p.width,p.height,p.confidence].every(Number.isFinite) && p.x >= 0 && p.y >= 0 &&
    p.width > .005 && p.height > .015 && p.x+p.width <= 1.001 && p.y+p.height <= 1.001 && p.confidence >= .25 && p.confidence <= 1;
}
function appearanceDifference(a?: number[], b?: number[]) {
  if (!a?.length || a.length !== b?.length) return 0;
  return a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0) / 2;
}
function stageRank(p: PersonDetection) {
  const bottomForeground = p.y+p.height > .97 && (cy(p) > .67 || p.height > .65);
  const centrality = 1-Math.min(1,Math.abs(cx(p)-.5)*1.5);
  return p.confidence*.55 + centrality*.22 + (p.brightness??.35)*.16 + Math.min(.06,area(p)) -
    (bottomForeground?.45:0) - (p.height>.85?.35:0);
}
function union(boxes: NormalizedBox[]): NormalizedBox {
  const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
  return {x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};
}
function planTrackingFromStart(analysis: VisualAnalysis, options: { mode?: SmartFraming; subject?: ManualSubject; outputAspect?: number } = {}): TrackingPlan {
  const mode=options.mode??"balanced",aspect=options.outputAspect??9/16;
  if(!["off","balanced","follow-performer","group-performance"].includes(mode)||!Number.isFinite(aspect)||aspect<=0||aspect>4 ||
    ![analysis.width,analysis.height,analysis.start,analysis.end].every(Number.isFinite)||analysis.width<=0||analysis.height<=0||analysis.end<analysis.start) throw Error("Choose valid smart framing settings.");
  if(options.subject&&(!Number.isFinite(options.subject.x)||!Number.isFinite(options.subject.y)||options.subject.x<0||options.subject.x>1||options.subject.y<0||options.subject.y>1)) throw Error("Choose a subject inside the picture.");
  const cropWidth=Math.min(1,analysis.height*aspect/analysis.width),cropHeight=Math.min(1,analysis.width/aspect/analysis.height);
  let centerX=options.subject?.x??.5,centerY=options.subject?.y??.5,primary: PersonDetection|undefined;
  let lastSeen=-Infinity,lastTime=analysis.start,visible=0,needsFit=false,missed=false,resetCandidate: PersonDetection|undefined;
  const keyframes: TrackingKeyframe[]=[];
  const frames=[...analysis.frames].sort((a,b)=>a.time-b.time);
  for(const frame of frames){
    if(!Number.isFinite(frame.time)||frame.time<analysis.start-1e-6||frame.time>analysis.end+1e-6)throw Error("Invalid visual-analysis timestamp.");
    const dt=Math.max(.02,Math.min(2,frame.time-lastTime));lastTime=frame.time;
    const people=frame.people.filter(validPerson);
    let match: PersonDetection|undefined,status:TrackingKeyframe["status"]="searching",subject:NormalizedBox|undefined;
    if(mode==="off") { centerX=.5;centerY=.5;status="off"; }
    else {
      if(frame.sceneChange&&!options.subject){primary=undefined;resetCandidate=undefined;}
      if(primary){
        const ranked=people.map(p=>({p,dist:Math.hypot(cx(p)-cx(primary!),cy(p)-cy(primary!)),
          look:appearanceDifference(primary!.appearance,p.appearance),ratio:area(p)/Math.max(.0001,area(primary!))}))
          // A nearby guitarist can have the same light-saturated clothing color.
          // Prefer a held crop to jumping several person-widths between samples.
          .filter(v=>v.dist<Math.min(.16,Math.max(.065,Math.min(primary!.width,v.p.width)*.85+dt*.06))&&v.ratio>.3&&v.ratio<3&&(v.look<.8||boxIoU(primary!,v.p)>.5&&v.ratio>.65&&v.ratio<1.6))
          .map(v=>({...v,rank:boxIoU(primary!,v.p)*1.4-v.dist*1.6-v.look*.7+v.p.confidence*.15})).sort((a,b)=>b.rank-a.rank);
        match=ranked[0]?.p;
      } else if(options.subject){
        const point=options.subject;
        match=people.filter(p=>point.x>=p.x-.025&&point.x<=p.x+p.width+.025&&point.y>=p.y-.025&&point.y<=p.y+p.height+.025)
          .sort((a,b)=>Math.hypot(cx(a)-point.x,cy(a)-point.y)-Math.hypot(cx(b)-point.x,cy(b)-point.y))[0];
      } else {
        const best=[...people].sort((a,b)=>stageRank(b)-stageRank(a))[0];
        if(best&&stageRank(best)>.25){
          if(!frame.sceneChange||resetCandidate&&boxIoU(resetCandidate,best)>.2)match=best;
          else resetCandidate=best;
        }
      }
      if(match){
        const firstAcquisition=!primary;
        // Appearance reference follows slowly so a short occlusion/lighting cue
        // cannot overwrite identity with a large foreground audience member.
        const oldAppearance=primary?.appearance;
        primary={...match,appearance:oldAppearance&&match.appearance?.length===oldAppearance.length?
          oldAppearance.map((v,i)=>v*.9+match!.appearance![i]*.1):match.appearance};
        lastSeen=frame.time;visible++;status="tracking";subject=match;
        let target:NormalizedBox=match;
        if(mode==="group-performance"){
          const cohort=people.filter(p=>Math.abs(cy(p)-cy(match!))<.25&&p.height>match!.height*.45&&p.height<match!.height*1.8&&stageRank(p)>.15);
          if(cohort.length>1){target=union(cohort);status="group";}
        }
        if(target.width*1.12>cropWidth||target.height*1.06>cropHeight)needsFit=true;
        const targetX=cx(target),targetY=cy(target)-target.height*.04;
        const smoothing=dt/(dt+.65),maximum=dt*.16;
        if(firstAcquisition){centerX=targetX;centerY=targetY;}
        else {centerX+=clamp((targetX-centerX)*smoothing,-maximum,maximum);centerY+=clamp((targetY-centerY)*smoothing,-maximum,maximum);}
      }else if(primary){
        const gap=frame.time-lastSeen;missed=true;status=gap<=2?"held":"searching";subject=primary;
        // Never silently acquire another identity after an explicit selection.
        if(gap>5){needsFit=true;if(!options.subject)primary=undefined;}
      }else if(options.subject){/* Preserve the user's point while waiting for a reliable detection. */}
    }
    keyframes.push({time:frame.time,x:clamp(centerX-cropWidth/2,0,1-cropWidth),y:clamp(centerY-cropHeight/2,0,1-cropHeight),
      width:cropWidth,height:cropHeight,confidence:match?.confidence??0,status,...(subject?{subject:{x:subject.x,y:subject.y,width:subject.width,height:subject.height}}:{})});
  }
  const coverage=frames.length?visible/frames.length:0;
  if(!frames.length)keyframes.push({time:analysis.start,x:(1-cropWidth)/2,y:(1-cropHeight)/2,width:cropWidth,height:cropHeight,confidence:0,status:mode==="off"?"off":"searching"});
  const notes=["People are detected locally. Stage context and visual continuity suggest the subject; artist identity is not recognized."];
  if(options.subject)notes.push("Your selected subject is preserved; uncertain frames hold the framing instead of switching people.");
  if(missed)notes.push("Some sampled frames lost the subject; short gaps hold the prior framing. Review occluded or fast-moving moments.");
  if(needsFit&&mode!=="off")notes.push("A wider composition is recommended where tracking or group framing cannot safely fit the portrait crop.");
  return {version:1,keyframes,subjectLocked:!!options.subject,coverage,suggestedFraming:mode!=="off"&&(needsFit||coverage<.5)?"fit":"fill",notes};
}
/** New point choices are anchored to the frame the user actually selected.
 * Follow the same subject both ways from that frame; old projects keep their
 * existing forward-only behavior. This does not identify an artist. */
export function planVisualTracking(analysis: VisualAnalysis, options: { mode?: SmartFraming; subject?: ManualSubject; outputAspect?: number } = {}): TrackingPlan {
 const time=options.subject?.time;
 if(time!==undefined&&(!Number.isFinite(time)||time<0))throw Error("Choose a valid performer moment.");
 if(time===undefined||time<analysis.start||time>analysis.end||!analysis.frames.length||options.mode==="off")return planTrackingFromStart(analysis,options);
 const subject={x:options.subject!.x,y:options.subject!.y},frames=[...analysis.frames].sort((a,b)=>a.time-b.time);
 const anchor=[...frames].sort((a,b)=>Math.abs(a.time-time)-Math.abs(b.time-time))[0],at=anchor.time;
 const forward=planTrackingFromStart({...analysis,start:at,frames:frames.filter(f=>f.time>=at)},{...options,subject});
 const reverseFrames=frames.filter(f=>f.time<=at).reverse().map(f=>({...f,time:2*at-f.time}));
 const backward=planTrackingFromStart({...analysis,start:at,end:2*at-analysis.start,frames:reverseFrames},{...options,subject});
 const keyframes=[...backward.keyframes.map(k=>({...k,time:2*at-k.time})).filter(k=>k.time<at),...forward.keyframes].sort((a,b)=>a.time-b.time);
 const coverage=keyframes.filter(k=>k.status==="tracking"||k.status==="group").length/keyframes.length;
 return {version:1,keyframes,subjectLocked:true,coverage,suggestedFraming:forward.suggestedFraming==="fit"||backward.suggestedFraming==="fit"?"fit":"fill",
  notes:[...new Set([...forward.notes,...backward.notes,"Your performer choice is anchored to the selected source moment."])]};
}
export function scoreVisualSegment(analysis: VisualAnalysis, start: number, end: number): number {
  const frames=analysis.frames.filter(f=>f.time>=start&&f.time<=end);if(!frames.length)return 0;
  return frames.reduce((sum,f)=>sum+Math.min(1,f.sharpness*6)*.25 + (f.people.some(p=>stageRank(p)>.35)?.35:0) +
    clamp(1-f.motion*3)*.2 + clamp(1-Math.abs(f.luma-.4)*1.5)*.1 + clamp(1-f.overexposed*3)*.1,0)/frames.length;
}
