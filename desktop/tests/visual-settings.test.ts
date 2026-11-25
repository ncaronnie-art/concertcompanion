import test from "node:test";
import assert from "node:assert/strict";
import {parseManualSubject,parseTrackingPlan,parseVisualAnalysis} from "../src/shared/visual-settings.js";
import {planVisualTracking,type VisualAnalysis} from "../src/shared/visual-tracking.js";
const analysis=():VisualAnalysis=>({version:1,width:1920,height:1080,start:3,end:4,sampleFps:2,detector:"Local NanoDet",sourceColorTransfer:"arib-std-b67",toneMapped:true,
 frames:[{time:3,people:[{x:.3,y:.25,width:.15,height:.5,confidence:.8,appearance:[.2,.3,.5],brightness:.5}],luma:.3,sharpness:.2,motion:.1,overexposed:.05,sceneChange:false}],limitations:["Person heuristic; not artist recognition."]});
test("supported visual data round-trips without retaining arbitrary properties",()=>{
 const a={...analysis(),analysisRegion:{x:.2,y:.4,width:.45,height:.5}};assert.deepEqual(parseVisualAnalysis({...a,command:"arbitrary"}),a);
 const plan=planVisualTracking(a,{mode:"follow-performer",subject:{x:.4,y:.5}});
 assert.deepEqual(parseTrackingPlan({...plan,command:"arbitrary"}),plan);
 assert.deepEqual(parseManualSubject({x:.4,y:.5,command:"arbitrary"}),{x:.4,y:.5});
 assert.equal(parseVisualAnalysis(undefined),undefined);assert.equal(parseTrackingPlan(undefined),undefined);assert.equal(parseManualSubject(undefined),undefined);
});
test("visual settings reject invalid object types, non-finite values, and out-of-picture boxes",()=>{
 for(const value of [null,[],"x",0])assert.throws(()=>parseManualSubject(value),/object/);
 for(const value of [NaN,Infinity,-.01,1.01,".5"])assert.throws(()=>parseManualSubject({x:value,y:.5}),/position/);
 const a=analysis();a.frames[0].people[0].width=.9;assert.throws(()=>parseVisualAnalysis(a),/outside/);
 const b=analysis();b.frames[0].people[0].height=0;assert.throws(()=>parseVisualAnalysis(b),/height/);
 const c=analysis();c.frames[0].luma=NaN;assert.throws(()=>parseVisualAnalysis(c),/brightness/);
 assert.throws(()=>parseVisualAnalysis({...analysis(),toneMapped:"true"}),/true or false/);
 assert.throws(()=>parseVisualAnalysis({...analysis(),sourceColorTransfer:"x".repeat(81)}),/80 characters/);
 assert.throws(()=>parseVisualAnalysis({...analysis(),detector:"x\0y"}),/text/);
 assert.throws(()=>parseVisualAnalysis({...analysis(),analysisRegion:{x:.9,y:0,width:.4,height:.5}}),/outside/);
});
test("visual settings bound arrays before parsing and reject inconsistent timing",()=>{
 assert.throws(()=>parseVisualAnalysis({...analysis(),frames:Array(7201).fill(null)}),/7200/);
 const a=analysis();a.frames[0].people=Array(101).fill(null);assert.throws(()=>parseVisualAnalysis(a),/100/);
 const b=analysis();b.frames[0].people[0].appearance=Array(65).fill(0);assert.throws(()=>parseVisualAnalysis(b),/64/);
 const c=analysis();c.frames.push({...c.frames[0]});assert.throws(()=>parseVisualAnalysis(c),/increase/);
 const d=analysis();d.frames[0].time=4.1;assert.throws(()=>parseVisualAnalysis(d),/time/);
 assert.throws(()=>parseVisualAnalysis({...analysis(),end:2}),/follow/);
 assert.throws(()=>parseVisualAnalysis({...analysis(),width:1920.1}),/whole number/);
 assert.throws(()=>parseVisualAnalysis({...analysis(),sampleFps:10}),/sample rate/);
});
test("tracking project data cannot inject expressions, invalid statuses, or unbounded trajectories",()=>{
 const plan=()=>planVisualTracking(analysis());
 assert.throws(()=>parseTrackingPlan({...plan(),keyframes:Array(7201).fill(null)}),/7200/);
 const a=plan();a.keyframes[0].time=NaN;assert.throws(()=>parseTrackingPlan(a),/time/);
 const b=plan();b.keyframes.push({...b.keyframes[0]});assert.throws(()=>parseTrackingPlan(b),/increase/);
 const c=plan();c.keyframes[0].subject={x:.9,y:0,width:.5,height:.4};assert.throws(()=>parseTrackingPlan(c),/outside/);
 const d=plan();assert.throws(()=>parseTrackingPlan({...d,keyframes:[{...d.keyframes[0],x:"if(t,0,1)"}]}),/left/);
 assert.throws(()=>parseTrackingPlan({...plan(),coverage:1.1}),/coverage/);
 assert.throws(()=>parseTrackingPlan({...plan(),subjectLocked:1}),/true or false/);
 assert.throws(()=>parseTrackingPlan({...plan(),suggestedFraming:"stretch"}),/fill or fit/);
 assert.throws(()=>parseTrackingPlan({...plan(),keyframes:[{...plan().keyframes[0],status:"identified-artist"}]}),/unsupported tracking status/);
});
