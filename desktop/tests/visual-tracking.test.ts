import test from 'node:test';
import assert from 'node:assert/strict';
import {boxIoU,planVisualTracking,scoreVisualSegment,subjectAnalysisRegion,type PersonDetection,type VisualAnalysis,type VisualFrame} from '../src/shared/visual-tracking.js';
const person=(x=.65,y=.2,width=.1,height=.5,confidence=.9):PersonDetection=>({x,y,width,height,confidence,brightness:.5,appearance:[1,0]});
const frame=(time:number,people:PersonDetection[],extra:Partial<VisualFrame>={}):VisualFrame=>({time,people,luma:.4,sharpness:.12,motion:.03,overexposed:.01,...extra});
const analysis=(frames:VisualFrame[]):VisualAnalysis=>({version:1,width:1920,height:1080,start:0,end:6,sampleFps:2,detector:'test',frames,limitations:[]});

test('native subject region is bounded, chroma-aligned and reproducible for the UI cache',()=>{
 const region=subjectAnalysisRegion(1920,1080,{x:.41,y:.73})!;
 assert.deepEqual(region,{x:354/1920,y:518/1080,width:864/1920,height:540/1080});
 assert.equal(subjectAnalysisRegion(1920,1080),undefined);
 for(const subject of [{x:0,y:0},{x:1,y:1},{x:.25,y:.5}]){
  const r=subjectAnalysisRegion(1920,1080,subject)!;
  assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=1&&r.y+r.height<=1);
  assert.ok(subject.x>=r.x&&subject.x<=r.x+r.width&&subject.y>=r.y&&subject.y<=r.y+r.height);
  for(const pixel of [r.x*1920,r.y*1080,r.width*1920,r.height*1080])assert.ok(Math.abs(pixel/2-Math.round(pixel/2))<1e-8);
 }
 assert.throws(()=>subjectAnalysisRegion(1920,1080,{x:NaN,y:.5}),/inside/);
 assert.throws(()=>subjectAnalysisRegion(0,1080,{x:.5,y:.5}),/dimensions/);
});
test('stage continuity wins over a larger bottom foreground audience member',()=>{
 const performer=person(),crowd={...person(.15,.50,.5,.5,.99),brightness:.05};
 const p=planVisualTracking(analysis([frame(0,[crowd,performer]),frame(.5,[crowd,person(.68)])]),{mode:'follow-performer'});
 assert.equal(p.keyframes[0].subject!.x,performer.x);assert.equal(p.keyframes[1].subject!.x,.68);
 assert.equal(p.coverage,1);assert.equal(p.suggestedFraming,'fill');
});
test('explicit subject beats prominence, survives occlusion and reacquires without choosing a bystander',()=>{
 const a=person(.2),b=person(.7);
 const p=planVisualTracking(analysis([frame(0,[a,b]),frame(.5,[b]),frame(1,[b]),frame(1.5,[person(.23),b])]),{mode:'follow-performer',subject:{x:.25,y:.4}});
 assert.equal(p.subjectLocked,true);assert.equal(p.keyframes[0].subject!.x,.2);
 assert.equal(p.keyframes[1].status,'held');assert.equal(p.keyframes[2].status,'held');
 assert.equal(p.keyframes[1].x,p.keyframes[0].x);assert.equal(p.keyframes[3].subject!.x,.23);
});
test('lighting changes can retain a geometrically stable subject',()=>{
 const first=person(),lit={...person(.655),appearance:[0,1]};
 const p=planVisualTracking(analysis([frame(0,[first]),frame(.5,[lit])]),{subject:{x:.7,y:.4},mode:'follow-performer'});
 assert.equal(p.keyframes[1].status,'tracking');
});
test('smoothed crop remains bounded and caps motion after initial acquisition',()=>{
 const p=planVisualTracking(analysis([frame(0,[person(.1)]),frame(.5,[person(.16)]),frame(1,[person(.22)]),frame(1.5,[person(.28)])]),{mode:'follow-performer'});
 p.keyframes.forEach(k=>{assert.ok(k.x>=0&&k.x+k.width<=1.000001);assert.ok(k.y>=0&&k.y+k.height<=1.000001);});
 assert.ok(p.keyframes[3].x>p.keyframes[0].x);assert.equal(p.coverage,1);
 for(let i=1;i<p.keyframes.length;i++)assert.ok(Math.abs(p.keyframes[i].x-p.keyframes[i-1].x)<=.080001);
});

test('a same-color neighboring guitarist cannot replace a manually selected lead after a large spatial jump',()=>{
 const lead=person(.48,.4,.08,.14),guitarist=person(.26,.53,.11,.17);
 const p=planVisualTracking(analysis([frame(0,[lead]),frame(.5,[guitarist]),frame(1,[{...lead,x:.5},guitarist])]),{subject:{x:.52,y:.47},mode:'follow-performer'});
 assert.equal(p.keyframes[1].status,'held');assert.equal(p.keyframes[1].subject!.x,.48);
 assert.equal(p.keyframes[2].status,'tracking');assert.equal(p.keyframes[2].subject!.x,.5);
});
test('a spread-out group recommends fit rather than clipping people or switching focus',()=>{
 const p=planVisualTracking(analysis([frame(0,[person(.15),person(.65)])]),{mode:'group-performance'});
 assert.equal(p.keyframes[0].status,'group');assert.equal(p.suggestedFraming,'fit');
});
test('long loss preserves manual identity and recommends a wider composition',()=>{
 const p=planVisualTracking(analysis([frame(0,[person(.2)]),frame(1,[]),frame(6,[person(.7)])]),{subject:{x:.25,y:.4},mode:'follow-performer'});
 assert.equal(p.keyframes[2].status,'searching');assert.equal(p.keyframes[2].subject!.x,.2);assert.equal(p.suggestedFraming,'fit');
});
test('off is static, portrait input does not invent zooming, and invalid target is rejected',()=>{
 const a=analysis([frame(0,[person(.1)]),frame(1,[person(.7)])]);
 const off=planVisualTracking(a,{mode:'off'});assert.equal(off.keyframes[0].x,off.keyframes[1].x);
 const portrait=planVisualTracking({...a,width:1080,height:1920});assert.equal(portrait.keyframes[0].width,1);assert.equal(portrait.keyframes[0].height,1);
 assert.throws(()=>planVisualTracking(a,{subject:{x:1.1,y:.2}}),/inside the picture/);
});
test('visual score rewards visible readable performance over dark blurred movement',()=>{
 assert.ok(scoreVisualSegment(analysis([frame(0,[person()])]),0,1)>scoreVisualSegment(analysis([frame(0,[],{luma:.01,sharpness:.001,motion:.5,overexposed:.3})]),0,1));
 assert.ok(Math.abs(boxIoU(person(),person())-1)<1e-12);
});
