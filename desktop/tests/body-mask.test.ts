import test from 'node:test';import assert from 'node:assert/strict';
import {BodyMaskRunGate,bodyProcessingRegion,refineBodyProbability,cleanBodyAlpha,type BodyMaskFrame} from '../src/shared/body-mask.js';
const W=96,H=96;
function ellipse(cx=.45,cy=.5,rx=.13,ry=.32){const p=new Float32Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(((x/W-cx)/rx)**2+((y/H-cy)/ry)**2<=1)p[y*W+x]=.98;return p;}
const expected={x:.3,y:.16,width:.3,height:.68};
test('learned selected component wins over a larger neighboring person and cannot jump to them',()=>{
 const p=ellipse(),other=ellipse(.84,.5,.12,.4);for(let i=0;i<p.length;i++)p[i]=Math.max(p[i],other[i]);
 const first=refineBodyProbability(p,W,H,{anchor:{x:.45,y:.5},expected});assert.equal(first.accepted,true);assert.ok(first.bounds!.x<.5);assert.equal(first.alpha[48*W+81],0);
 const next=refineBodyProbability(other,W,H,{anchor:{x:.45,y:.5},expected,previous:first.alpha,lastBounds:first.bounds});assert.equal(next.accepted,false);assert.equal(next.alpha.some(v=>v>0),false);
});
test('a component bounding box enclosing the manual point does not count as person support',()=>{
 const p=ellipse(.5,.5,.3,.35);for(let y=10;y<86;y++)for(let x=25;x<75;x++)p[y*W+x]=0;
 const result=refineBodyProbability(p,W,H,{anchor:{x:.5,y:.5}});assert.equal(result.accepted,false);
});
test('enclosed model holes are filled for external tracing without extending the exterior shape',()=>{
 const p=ellipse(),hole=48*W+43;p[hole]=0;
 const r=refineBodyProbability(p,W,H,{anchor:{x:.45,y:.5},expected});assert.equal(r.accepted,true);assert.ok(r.alpha[hole]>127);assert.equal(r.alpha[0],0);assert.equal(r.alpha[48*W+80],0);
});

test('final visible alpha drops detached hardware and rejects substantial enclosed occlusion',()=>{
 const alpha=Uint8Array.from(ellipse(),v=>Math.round(v*255));for(let y=8;y<13;y++)for(let x=74;x<80;x++)alpha[y*W+x]=230;
 const clean=cleanBodyAlpha(alpha,W,H,{x:.45,y:.5});assert.equal(clean.accepted,true);assert.equal(clean.removedComponents,1);assert.equal(clean.alpha[10*W+76],0);assert.ok(clean.alpha[48*W+43]>200);
 for(let y=67;y<74;y++)for(let x=41;x<46;x++)alpha[y*W+x]=0;
 const occluded=cleanBodyAlpha(alpha,W,H,{x:.45,y:.4});assert.equal(occluded.accepted,false);assert.equal(occluded.reason,'body-occlusion-uncertainty');assert.equal(occluded.alpha.some(v=>v>0),false);
});

test('an upper bent-arm opening stays negative space rather than suppressing or filling the performer',()=>{
 const alpha=Uint8Array.from(ellipse(),v=>Math.round(v*255));for(let y=30;y<37;y++)for(let x=41;x<46;x++)alpha[y*W+x]=0;
 const result=cleanBodyAlpha(alpha,W,H,{x:.45,y:.5},expected);assert.equal(result.accepted,true);assert.equal(result.alpha[33*W+43],0);assert.ok(result.alpha[48*W+43]>200);
});

test('a prior filled matte cannot erase current lower-body uncertainty or close a real upper-arm air gap',()=>{
 const clear=ellipse(),prior=refineBodyProbability(clear,W,H,{anchor:{x:.45,y:.5},expected});assert.equal(prior.accepted,true);
 const lower=clear.slice();for(let y=67;y<74;y++)for(let x=41;x<46;x++)lower[y*W+x]=.59;
 for(const previous of [undefined,prior.alpha]){const r=refineBodyProbability(lower,W,H,{anchor:{x:.45,y:.5},expected,previous,lastBounds:prior.bounds});assert.equal(r.accepted,false);assert.equal(r.reason,'body-occlusion-uncertainty');assert.equal(r.alpha.some(v=>v>0),false);}
 const upper=clear.slice();for(let y=30;y<37;y++)for(let x=41;x<46;x++)upper[y*W+x]=.59;
 const r=refineBodyProbability(upper,W,H,{anchor:{x:.45,y:.5},expected,previous:prior.alpha,lastBounds:prior.bounds});assert.equal(r.accepted,true);assert.equal(r.alpha[33*W+43],0);assert.ok(r.alpha[48*W+43]>200);
});
test('platform spill and incomplete lower-body masks are rejected whole, never trimmed to a rectangle',()=>{
 const p=ellipse(.45,.67,.14,.29),r=refineBodyProbability(p,W,H,{anchor:{x:.45,y:.5},expected:{x:.3,y:.1,width:.3,height:.5}});
 assert.equal(r.accepted,false);assert.equal(r.reason,'body-context-leak');assert.equal(r.alpha.some(v=>v>0),false);
 const pants=refineBodyProbability(ellipse(.45,.72,.1,.1),W,H,{anchor:{x:.45,y:.72},expected});assert.equal(pants.accepted,false);
});
test('invalid masks fail, blank masks suppress, and native body regions stay inside the source',()=>{
 assert.equal(refineBodyProbability(new Float32Array(W*H),W,H,{anchor:{x:.5,y:.5}}).accepted,false);
 const bad=ellipse();bad[0]=NaN;assert.throws(()=>refineBodyProbability(bad,W,H,{anchor:{x:.5,y:.5}}),/probability/);
 assert.throws(()=>refineBodyProbability(ellipse(),W,H,{anchor:{x:Infinity,y:.5}}),/subject context/);
 for(const point of [{x:0,y:0},{x:1,y:1},{x:.5,y:.5}]){const r=bodyProcessingRegion(1920,1080,[],point);assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=1.000001&&r.y+r.height<=1.000001);}
 assert.throws(()=>bodyProcessingRegion(1920,1080,[],{x:2,y:.5}),/subject/);
});

test('stable-run lookahead removes one/two-frame islands without shifting genuine onset or frame count',async()=>{
 const emitted:BodyMaskFrame[]=[],gate=new BodyMaskRunGate(6,async frame=>{emitted.push(frame);});
 const pattern=['accepted','accepted','suppressed',...Array(8).fill('accepted'),'faded','suppressed','accepted','suppressed',...Array(4).fill('accepted')] as BodyMaskFrame['status'][];
 for(const [index,status] of pattern.entries())await gate.push({alpha:new Uint8Array([status==='suppressed'?0:220]),time:index/30,status,confidence:status==='accepted'?.95:0});
 await gate.finish();assert.equal(emitted.length,pattern.length);assert.deepEqual(emitted.map(f=>f.time),pattern.map((_,i)=>i/30));
 assert.deepEqual(emitted.slice(0,3).map(f=>f.alpha[0]),[0,0,0]);
 assert.equal(emitted[3].time,.1);assert.equal(emitted[3].alpha[0],220);assert.equal(emitted.slice(3,11).every(f=>f.status==='accepted'),true);
 assert.equal(emitted[11].status,'faded');assert.equal(emitted.slice(13).every(f=>f.alpha[0]===0),true);
});
