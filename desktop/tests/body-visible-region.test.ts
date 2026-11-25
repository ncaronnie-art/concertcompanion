import test from "node:test";
import assert from "node:assert/strict";
import {renderVisibleRegion,type RenderSelection} from "../src/shared/render-plan.js";
const shot:RenderSelection={asset:{path:"source.mov",name:"source.mov",duration:10,width:1920,height:1080,hasAudio:true},start:2,end:5,framing:"fill",focus:.19};
const options={aspect:"vertical" as const,reduceRumble:false};
test("body target region follows the established manual crop instead of an off-screen person",()=>{
 const region=renderVisibleRegion(shot,options);
 assert.ok(Math.abs(region.width-.31640625)<1e-9);assert.equal(region.height,1);
 const visible=(x:number)=>x>=region.x&&x<=region.x+region.width;
 assert.equal(visible(.29),true,"performer in selected crop must remain eligible");
 assert.equal(visible(.57),false,"off-screen drummer must not become the body target");
 assert.equal(shot.focus,.19);assert.equal(shot.subject,undefined,"a composition hint never becomes an explicit user lock");
 assert.deepEqual(renderVisibleRegion({...shot,framing:"fit"},options),{x:0,y:0,width:1,height:1});
});
test("body target region respects tracked fit, disabled tracking and legacy portrait shape",()=>{
 const tracking={version:1 as const,subjectLocked:true,coverage:1,suggestedFraming:"fit" as const,notes:[],keyframes:[{time:2,x:.4,y:0,width:.316,height:1,confidence:.9,status:"tracking" as const}]};
 assert.deepEqual(renderVisibleRegion({...shot,tracking},{...options,smartFraming:"balanced"}),{x:0,y:0,width:1,height:1});
 assert.deepEqual(renderVisibleRegion({...shot,tracking},{...options,smartFraming:"off"}),renderVisibleRegion(shot,options));
 const region=renderVisibleRegion({...shot,asset:{...shot.asset,width:1080,height:1920}},{...options,aspect:"portrait913"});
 assert.equal(region.width,1);assert.ok(Math.abs(region.height-.8125)<1e-9);assert.ok(Math.abs(region.y-.09375)<1e-9);
});
