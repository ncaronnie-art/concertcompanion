import {boxIoU,type ManualSubject,type NormalizedBox} from "./visual-tracking.js";

/** Backend-generated, ephemeral media. Never accept this path from a project
 * file or renderer. Mask PTS0 corresponds to source start; black is no effect. */
export type BodyMask={version:1;encodingVersion?:2;path:string;start:number;end:number;width:number;height:number;sourceWidth:number;sourceHeight:number;
 fps:number;frames:number;coverage:number;modelId:string;modelSha256:string;sourceSHA256:string;processingId?:string;subject?:ManualSubject;analysisRegion?:NormalizedBox;warnings:string[];
 visibleRegion?:NormalizedBox;activeRanges?:{start:number;end:number}[];
 suppressedAccentRanges?:{start:number;end:number;reason:string}[];
 candidateDecisions?:{sourceTime?:number;selected?:number;reason?:string;candidates:{index:number;score:number;area:number;bodyHeight:number;promptsSatisfied:boolean;continuity:number;complete:boolean}[]}[];
 stats?:{acceptedFrames:number;suppressedFrames:number;fadedFrames:number;rawAcceptedFrames?:number;minimumStableFrames?:number;modelMilliseconds:number;elapsedSeconds:number};
 frameQuality?:{time:number;status:"accepted"|"faded"|"suppressed";confidence:number;reason?:string}[]};
export const BODY_MODEL_ID="slimsam-77-uniform-fp32";
/** Encoder identity; the decoder and native runtime are separately pinned. */
export const BODY_MODEL_SHA256="9f8433273a6750b587779baa0cf5508111001bf7e7acfcf585d370139fd366d0";
export type BodyMaskFrame={alpha:Uint8Array;time:number;status:"accepted"|"faded"|"suppressed";confidence:number;reason?:string};
/** Small lookahead removes isolated model flashes without shifting mask PTS.
 * Pending frames are either emitted at their original positions or blackened.
 * The queue never grows beyond minimumFrames, normally6 at30fps. */
export class BodyMaskRunGate{
 private run:BodyMaskFrame[]=[];private stable=false;
 constructor(private minimumFrames:number,private emit:(frame:BodyMaskFrame)=>Promise<void>){if(!Number.isInteger(minimumFrames)||minimumFrames<2||minimumFrames>30)throw Error("Invalid body-mask stability window.");}
 private blank(frame:BodyMaskFrame):BodyMaskFrame{return {...frame,alpha:new Uint8Array(frame.alpha.length),status:"suppressed",confidence:0,reason:"short-unstable-run"};}
 private async discard(){for(const frame of this.run)await this.emit(this.blank(frame));this.run=[];}
 async push(frame:BodyMaskFrame):Promise<void>{
  if(frame.status==="accepted"){
   if(this.stable){await this.emit(frame);return;}
   this.run.push(frame);
   if(this.run.length>=this.minimumFrames){for(const pending of this.run)await this.emit(pending);this.run=[];this.stable=true;}
   return;
  }
  await this.discard();await this.emit(frame.status==="faded"&&!this.stable?this.blank(frame):frame);this.stable=false;
 }
 async finish():Promise<void>{await this.discard();this.stable=false;}
}
const clamp=(v:number,min=0,max=1)=>Math.max(min,Math.min(max,v));
export function bodyProcessingRegion(width:number,height:number,boxes:readonly NormalizedBox[],point?:ManualSubject):NormalizedBox{
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2)throw Error("Choose valid body-mask picture dimensions.");
 if(point&&(![point.x,point.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1)))throw Error("Choose a body-mask subject inside the picture.");
 const valid=boxes.filter(b=>[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>0&&b.height>0&&b.x>=0&&b.y>=0&&b.x+b.width<=1.001&&b.y+b.height<=1.001);
 let x=0,y=0,w=1,h=1;
 if(valid.length){
  const left=Math.min(...valid.map(b=>b.x)),top=Math.min(...valid.map(b=>b.y)),right=Math.max(...valid.map(b=>b.x+b.width)),bottom=Math.max(...valid.map(b=>b.y+b.height));
  const marginX=Math.max(.025,(right-left)*.8),marginY=Math.max(.025,(bottom-top)*.4);
  x=clamp(left-marginX);y=clamp(top-marginY);w=Math.min(1,right+marginX)-x;h=Math.min(1,bottom+marginY)-y;
 }else if(point){x=clamp(point.x-.225,0,.55);y=clamp(point.y-.25,0,.5);w=.45;h=.5;}
 const px=Math.floor(x*width/2)*2,py=Math.floor(y*height/2)*2;
 const pw=Math.max(2,Math.min(Math.floor((width-px)/2)*2,Math.ceil(w*width/2)*2)),ph=Math.max(2,Math.min(Math.floor((height-py)/2)*2,Math.ceil(h*height/2)*2));
 return {x:px/width,y:py/height,width:pw/width,height:ph/height};
}
export function pointInRegion(point:ManualSubject,region:NormalizedBox):ManualSubject{return {x:clamp((point.x-region.x)/region.width),y:clamp((point.y-region.y)/region.height)};}
export function boxInRegion(box:NormalizedBox,region:NormalizedBox):NormalizedBox{
 const x=clamp((box.x-region.x)/region.width),y=clamp((box.y-region.y)/region.height),right=clamp((box.x+box.width-region.x)/region.width),bottom=clamp((box.y+box.height-region.y)/region.height);
 return {x,y,width:Math.max(.001,right-x),height:Math.max(.001,bottom-y)};
}
type Component={pixels:number[];bounds:NormalizedBox;mean:number;overlap:number;containsAnchor:boolean;verticalSpill:number};
export type RefinedBodyMask={alpha:Uint8Array;accepted:boolean;confidence:number;areaFraction:number;bounds?:NormalizedBox;reason?:string};
/** Validate the ACTUAL visible alpha topology after soft-edge processing.
 * Only the anchored learned component survives; detached hardware/islands are
 * discarded. Substantial LOWER-body uncertainty can hide foreground gear and
 * suppresses the frame. Larger upper-body air gaps remain actual negative
 * space (for example between a bent arm and torso), never painted over. */
export function cleanBodyAlpha(input:Uint8Array,width:number,height:number,anchor:ManualSubject,expected?:NormalizedBox):{alpha:Uint8Array;accepted:boolean;reason?:string;removedComponents:number;largestHole:number}{
 const size=width*height,empty=(reason:string,removedComponents=0,largestHole=0)=>({alpha:new Uint8Array(size),accepted:false,reason,removedComponents,largestHole});
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width>2048||height>2048||input.length!==size)throw Error("Invalid final body-alpha dimensions.");
 if(![anchor.x,anchor.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error("Choose a valid final body-alpha anchor.");
 if(expected&&(![expected.x,expected.y,expected.width,expected.height].every(Number.isFinite)||expected.width<=0||expected.height<=0))throw Error("Choose valid final body-alpha context.");
 const visited=new Uint8Array(size),queue=new Int32Array(size),groups:{pixels:number[];anchorDistance:number}[]=[],ax=Math.min(width-1,Math.floor(anchor.x*width)),ay=Math.min(height-1,Math.floor(anchor.y*height));
 for(let seed=0;seed<size;seed++){
  if(visited[seed]||input[seed]<96)continue;let head=0,tail=0,distance=Infinity;const pixels:number[]=[];queue[tail++]=seed;visited[seed]=1;
  while(head<tail){const at=queue[head++],x=at%width,y=Math.floor(at/width);pixels.push(at);distance=Math.min(distance,Math.max(Math.abs(x-ax),Math.abs(y-ay)));
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy,next=ny*width+nx;if((dx||dy)&&nx>=0&&nx<width&&ny>=0&&ny<height&&!visited[next]&&input[next]>=96){visited[next]=1;queue[tail++]=next;}}
  }groups.push({pixels,anchorDistance:distance});if(groups.length>128)return empty("too-many-alpha-components");
 }
 const selected=groups.filter(g=>g.anchorDistance<=3).sort((a,b)=>b.pixels.length-a.pixels.length)[0];if(!selected)return empty("alpha-lost-selected-body",groups.length);
 const alpha=new Uint8Array(size);let bodyTop=height,bodyBottom=0;for(const at of selected.pixels){alpha[at]=input[at];const y=Math.floor(at/width);bodyTop=Math.min(bodyTop,y);bodyBottom=Math.max(bodyBottom,y);}
 const lowerBodyStart=(expected?.y??bodyTop/height)+.65*(expected?.height??(bodyBottom-bodyTop+1)/height);
 const exterior=new Uint8Array(size);let head=0,tail=0;const seed=(at:number)=>{if(!exterior[at]&&alpha[at]<96){exterior[at]=1;queue[tail++]=at;}};
 for(let x=0;x<width;x++){seed(x);seed((height-1)*width+x);}for(let y=0;y<height;y++){seed(y*width);seed(y*width+width-1);}
 while(head<tail){const at=queue[head++],x=at%width,y=Math.floor(at/width);for(const next of [x?at-1:-1,x<width-1?at+1:-1,y?at-width:-1,y<height-1?at+width:-1])if(next>=0)seed(next);}
 let largestHole=0,totalLowerHole=0;const tinyHoles:number[][]=[],holeLimit=Math.max(8,Math.floor(selected.pixels.length*.002));
 for(let start=0;start<size;start++){
  if(exterior[start]||alpha[start]>=96)continue;head=0;tail=0;queue[tail++]=start;exterior[start]=1;const hole:number[]=[];let sumY=0;
  while(head<tail){const at=queue[head++],x=at%width,y=Math.floor(at/width);hole.push(at);sumY+=y;for(const next of [x?at-1:-1,x<width-1?at+1:-1,y?at-width:-1,y<height-1?at+width:-1])if(next>=0&&!exterior[next]&&alpha[next]<96){exterior[next]=1;queue[tail++]=next;}}
  largestHole=Math.max(largestHole,hole.length);
  if(sumY/hole.length/height>=lowerBodyStart){totalLowerHole+=hole.length;if(hole.length>holeLimit||totalLowerHole>Math.max(12,selected.pixels.length*.005))return empty("body-occlusion-uncertainty",groups.length-1,largestHole);}
  if(hole.length<=holeLimit)tinyHoles.push(hole);
 }
 // Fill only tiny model pinholes. Never close an open occluder or extend an
 // exterior edge, and never replace a substantial unknown region with skin.
 for(const hole of tinyHoles)for(const at of hole)alpha[at]=255;
 return {alpha,accepted:true,removedComponents:groups.length-1,largestHole};
}
/** Keep only the learned connected person component around the selected body.
 * Context is a rejection/ranking signal, never a rectangle used as an outline.
 * No geometric crop is applied to manufacture a person boundary. */
export function refineBodyProbability(probability:Float32Array,width:number,height:number,context:{anchor:ManualSubject;expected?:NormalizedBox;previous?:Uint8Array;lastBounds?:NormalizedBox}):RefinedBodyMask{
 const size=width*height,empty=(reason:string):RefinedBodyMask=>({alpha:new Uint8Array(size),accepted:false,confidence:0,areaFraction:0,reason});
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width>512||height>512||probability.length!==size)throw Error("Invalid body-mask probability dimensions.");
 if(![context.anchor.x,context.anchor.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||context.previous&&context.previous.length!==size)throw Error("Choose a valid body-mask subject context.");
 for(const v of probability)if(!Number.isFinite(v)||v<0||v>1)throw Error("Invalid body-mask probability.");
 const visited=new Uint8Array(size),queue=new Int32Array(size),components:Component[]=[];
 let previousArea=0;if(context.previous)for(const a of context.previous)if(a>=128)previousArea++;
 const anchorX=Math.min(width-1,Math.floor(context.anchor.x*width)),anchorY=Math.min(height-1,Math.floor(context.anchor.y*height));
 for(let seed=0;seed<size;seed++){
  if(visited[seed]||probability[seed]<.62)continue;
  if(components.length>=64)return empty("too-many-components");
  let head=0,tail=0,minX=width,minY=height,maxX=0,maxY=0,total=0,overlap=0,spill=0;queue[tail++]=seed;visited[seed]=1;
  const pixels:number[]=[];
  while(head<tail){
   const at=queue[head++],x=at%width,y=Math.floor(at/width);pixels.push(at);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);total+=probability[at];
   if(context.previous?.[at]&&context.previous[at]>=128)overlap++;
   if(context.expected&&(y/height<context.expected.y-context.expected.height*.25||y/height>context.expected.y+context.expected.height*1.18))spill++;
   for(const next of [x>0?at-1:-1,x<width-1?at+1:-1,y>0?at-width:-1,y<height-1?at+width:-1])if(next>=0&&!visited[next]&&probability[next]>=.62){visited[next]=1;queue[tail++]=next;}
  }
  const bounds={x:minX/width,y:minY/height,width:(maxX-minX+1)/width,height:(maxY-minY+1)/height};
  let containsAnchor=false;
  for(const at of pixels)if(Math.abs(at%width-anchorX)<=3&&Math.abs(Math.floor(at/width)-anchorY)<=3){containsAnchor=true;break;}
  components.push({pixels,bounds,mean:total/pixels.length,overlap:overlap/Math.max(1,Math.min(previousArea,pixels.length)),containsAnchor,verticalSpill:spill/pixels.length});
 }
 const candidates=components.filter(c=>c.pixels.length>=20&&c.pixels.length<size*.75&&c.mean>=.7&&
  (c.containsAnchor||context.expected&&boxIoU(context.expected,c.bounds)>.08||context.lastBounds&&boxIoU(context.lastBounds,c.bounds)>.18))
  .filter(c=>!context.lastBounds||c.overlap>.06||boxIoU(context.lastBounds,c.bounds)>.22)
  .filter(c=>!context.lastBounds||c.bounds.width*c.bounds.height/(context.lastBounds.width*context.lastBounds.height)>=.25&&c.bounds.width*c.bounds.height/(context.lastBounds.width*context.lastBounds.height)<=3&&c.bounds.height/context.lastBounds.height<=2.5)
  .sort((a,b)=>((b.containsAnchor?1:0)+b.overlap*2+(context.expected?boxIoU(b.bounds,context.expected):0))-((a.containsAnchor?1:0)+a.overlap*2+(context.expected?boxIoU(a.bounds,context.expected):0)));
 const selected=candidates[0];if(!selected)return empty("no-confident-selected-person");
 // Reject the whole component if substantial predicted foreground spills past
 // the body context. Never trim a platform leak into an artificial straight hem.
 if(context.expected&&selected.verticalSpill>.18)return empty("body-context-leak");
 if(context.expected&&(selected.bounds.height<context.expected.height*.55||selected.bounds.y>context.expected.y+context.expected.height*.4))return empty("incomplete-body-component");
 const edges=Number(selected.bounds.x===0)+Number(selected.bounds.y===0)+Number(selected.bounds.x+selected.bounds.width>=.999)+Number(selected.bounds.y+selected.bounds.height>=.999);
 if(edges>=2&&selected.bounds.width*selected.bounds.height>.2)return empty("analysis-region-edge-leak");
 const boxPixels=selected.bounds.width*width*selected.bounds.height*height;
 if(selected.pixels.length/boxPixels>.96&&boxPixels>size*.15)return empty("rectangular-background-component");
 const support=new Uint8Array(size);for(const at of selected.pixels){const x=at%width,y=Math.floor(at/width);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height)support[(y+dy)*width+x+dx]=1;}
 const alpha=new Uint8Array(size),currentAlpha=new Uint8Array(size);let area=0;
 for(let i=0;i<size;i++)if(support[i]&&probability[i]>.35){
  const value=clamp((probability[i]-.4)/.5),smooth=value*value*(3-2*value),previous=context.previous?.[i]??0;
  currentAlpha[i]=Math.round(smooth*255*.85);
  alpha[i]=Math.round(clamp(smooth*255*.85+previous*.15,0,255));if(alpha[i]>127)area++;
 }
 // Validate current evidence BEFORE temporal smoothing. A prior bright matte
 // must never conceal a new camera/occluder hole or close an actual arm gap.
 const cleaned=cleanBodyAlpha(currentAlpha,width,height,context.anchor,context.expected);if(!cleaned.accepted)return empty(cleaned.reason!);
 for(let i=0;i<size;i++){
  if(cleaned.alpha[i]<96)alpha[i]=cleaned.alpha[i];
  else if(currentAlpha[i]<96)alpha[i]=cleaned.alpha[i]; // validated tiny pinhole only
 }
 return {alpha,accepted:true,confidence:selected.mean,areaFraction:area/size,bounds:selected.bounds};
}
