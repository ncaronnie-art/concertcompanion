import test from "node:test";
import assert from "node:assert/strict";
import { planBodyTraceActivity } from "../src/shared/body-outline-timing.js";
import type { RenderSelection } from "../src/shared/render-plan.js";
const shot = (index: number): RenderSelection => ({ asset: { path: `source-${index}.mov`, name: `source-${index}.mov`, duration: 60, width: 1920, height: 1080, hasAudio: true },
  start: 10, end: 20, locked: true, subject: { x: .5, y: .5 }, visualCues: [{ seconds: 14, confidence: .9, strength: .8 }, { seconds: 18, confidence: .4 }] });
test("Electric budgets genuine source-time bursts across a reel without changing its protected timeline", () => {
  const shots = Array.from({ length: 8 }, (_, index) => shot(index)), before = JSON.stringify(shots);
  const plan = planBodyTraceActivity(shots);
  assert.equal(plan.timing, "music"); assert.ok(plan.accents >= 4 && plan.accents <= 6);
  for (const ranges of plan.ranges.values()) for (const range of ranges) {
    assert.ok(Math.abs(range.start - 13.84) < 1e-6); assert.ok(Math.abs(range.end - 14.64) < 1e-6);
  }
  assert.equal(JSON.stringify(shots), before);
});
test("uncertain timing uses disclosed editorial accents with bounded processing, including long compilations", () => {
  const shots = Array.from({ length: 40 }, (_, index) => ({ ...shot(index), visualCues: [{ seconds: 14, confidence: .4 }] }));
  const plan = planBodyTraceActivity(shots);
  assert.equal(plan.timing, "editorial"); assert.ok(plan.accents <= 8);
  assert.ok([...plan.ranges.values()].flat().every(range => range.start >= 10 && range.end <= 20 && range.end - range.start <= .801));
  assert.equal(planBodyTraceActivity([{ ...shot(0), start: 10, end: 10.2 }]).accents, 0);
});
test("sparse musical cues leave space for explicitly editorial visual accents",()=>{
 const shots=Array.from({length:8},(_,index)=>({...shot(index),visualCues:index===3?shot(index).visualCues:[]}));
 const plan=planBodyTraceActivity(shots);
 assert.equal(plan.timing,"mixed");assert.ok(plan.accents>=4&&plan.accents<=6);
 assert.ok(plan.ranges.has(3),"the confident musical cue keeps priority");
});
test("visible performer evidence overrides a strong audio cue aimed at an off-screen person",()=>{
 const analysis=(x:number)=>({version:1 as const,width:1920,height:1080,start:10,end:20,sampleFps:2,detector:"synthetic verified boxes",limitations:[],frames:[
   {time:14,people:[{x,y:.4,width:.08,height:.4,confidence:.85}],luma:.4,motion:.1,sharpness:.5,overexposed:0},
   {time:15,people:[{x,y:.4,width:.08,height:.4,confidence:.85}],luma:.4,motion:.1,sharpness:.5,overexposed:0}]});
 const hidden={...shot(0),framing:"fill" as const,focus:.19,subject:undefined,visualCues:[{seconds:14,confidence:.99}],visualAnalysis:analysis(.6)};
 const visible={...shot(1),framing:"fill" as const,focus:.19,subject:undefined,visualCues:[],visualAnalysis:analysis(.25)};
 const before=JSON.stringify([hidden,visible]),plan=planBodyTraceActivity([hidden,visible]);
 assert.equal(plan.ranges.has(0),false);assert.equal(plan.ranges.has(1),true);assert.equal(plan.timing,"editorial");
 assert.equal(JSON.stringify([hidden,visible]),before);
});
test("the chosen performer takes priority over a stronger cue featuring someone else",()=>{
 const source={...shot(0),subject:undefined,visualCues:[{seconds:14,confidence:.99},{seconds:18,confidence:.75}],visualAnalysis:{version:1 as const,width:1920,height:1080,start:10,end:20,sampleFps:2,detector:"synthetic boxes",limitations:[],frames:[
  {time:14,people:[{x:.2,y:.3,width:.08,height:.4,confidence:.99}],luma:.4,motion:.1,sharpness:.5,overexposed:0},
  {time:18,people:[{x:.66,y:.3,width:.08,height:.4,confidence:.6}],luma:.4,motion:.1,sharpness:.5,overexposed:0}]}};
 const options={aspect:"landscape" as const,reduceRumble:false};
 assert.ok(Math.abs(planBodyTraceActivity([source],options).ranges.get(0)![0].start-13.84)<.001);
 assert.ok(Math.abs(planBodyTraceActivity([{...source,subject:{x:.7,y:.5}}],options).ranges.get(0)![0].start-17.84)<.001);
});
