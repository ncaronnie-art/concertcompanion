import test from "node:test";import assert from "node:assert/strict";
import {planVisualTracking,type VisualAnalysis}from"../src/shared/visual-tracking.js";
import {parseManualSubject}from"../src/shared/visual-settings.js";
import{planBodyTraceActivity}from"../src/shared/body-outline-timing.js";
import{parseProjectSnapshot}from"../src/shared/project-file.js";
const person=(x:number,other=false)=>({x,y:.2,width:.1,height:.5,confidence:.9,appearance:other?[0,1]:[1,0]});
const analysis:VisualAnalysis={version:1,width:1920,height:1080,start:0,end:2,sampleFps:1,detector:"synthetic known people",limitations:[],frames:[
 {time:0,people:[person(.60),person(.72,true)],luma:.4,motion:.1,sharpness:.1,overexposed:0},
 {time:1,people:[person(.68),person(.82,true)],luma:.4,motion:.1,sharpness:.1,overexposed:0},
 {time:2,people:[person(.72),person(.86,true)],luma:.4,motion:.1,sharpness:.1,overexposed:0}]};
test("a paused-frame choice follows the selected subject in both time directions, rather than the person occupying that point earlier",()=>{
 const old=planVisualTracking(analysis,{mode:"follow-performer",subject:{x:.73,y:.4}});
 assert.equal(old.keyframes[0].subject?.x,.72);
 const marked=planVisualTracking(analysis,{mode:"follow-performer",subject:{x:.73,y:.4,time:1}});
 assert.deepEqual(marked.keyframes.map(k=>k.subject?.x),[.60,.68,.72]);
 assert.deepEqual(marked.keyframes.map(k=>k.time),[0,1,2]);assert.equal(marked.coverage,1);assert.equal(marked.subjectLocked,true);
 assert.throws(()=>parseManualSubject({x:.5,y:.5,time:"movie=bad"}),/moment/);
 assert.throws(()=>planVisualTracking(analysis,{subject:{x:.5,y:.5,time:NaN}}),/valid performer moment/);
});
test("the selected moment survives saving and places a bounded editorial accent without changing sound or picture sections",()=>{
 const clip={asset:{path:"synthetic.mov",name:"synthetic.mov",duration:30,width:1920,height:1080,hasAudio:true},start:10,end:20,included:true,selectionSource:"manual",locked:true,excludedByUser:false,subject:{x:.7,y:.5,time:17}};
 const saved=parseProjectSnapshot({version:1,clips:[clip],options:{aspect:"vertical",reduceRumble:true,bodyOutline:"electric"},briefInput:{description:"Keep my section",selectionMode:"use-my-sections"}});
 const reopened=parseProjectSnapshot(JSON.parse(JSON.stringify(saved)));assert.deepEqual(reopened.clips[0].subject,clip.subject);
 const plan=planBodyTraceActivity(reopened.clips,reopened.options),window=plan.ranges.get(0)![0];
 assert.ok(Math.abs(window.start-16.6)<.00001&&Math.abs(window.end-17.4)<.00001);assert.equal(plan.timing,"editorial");
 assert.equal(reopened.clips[0].start,10);assert.equal(reopened.clips[0].end,20);assert.equal(reopened.clips[0].locked,true);
 assert.throws(()=>parseProjectSnapshot({...saved,clips:[{...clip,subject:{x:.5,y:.5,time:31}}]}),/outside/);
 const trimmed=planBodyTraceActivity([{...reopened.clips[0],start:18,end:20}],reopened.options);
 assert.ok([...trimmed.ranges.values()].flat().every(r=>r.start>=18&&r.end<=20),"trimming away the marked time never reintroduces excluded footage");
 const skipped=parseProjectSnapshot({...saved,clips:[{...clip,bodyOutlineDisabled:true}]});
 assert.equal(parseProjectSnapshot(JSON.parse(JSON.stringify(skipped))).clips[0].bodyOutlineDisabled,true);
 assert.equal(planBodyTraceActivity(skipped.clips,skipped.options).ranges.size,0,"manual neon exclusions override an explicit moment");
 assert.deepEqual(skipped.audioSelections,saved.audioSelections);assert.equal(skipped.clips[0].locked,true);
 assert.throws(()=>parseProjectSnapshot({...saved,clips:[{...clip,bodyOutlineDisabled:"false"}]}),/invalid section/);
});
