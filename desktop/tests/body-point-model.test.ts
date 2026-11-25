import test from 'node:test';import assert from 'node:assert/strict';
import {automaticBodyPrompts,chooseBodyCandidate,type CandidateSummary} from '../electron/body-point-model.js';
const candidate=(index:number,score:number,area:number,overrides:Partial<CandidateSummary>={}):CandidateSummary=>({index,score,area,promptsSatisfied:true,complete:true,bodyHeight:.6,continuity:0,...overrides});
test('narrow learned-score band favors complete compact silhouettes, never an index or torso-only mask',()=>{
 assert.equal(chooseBodyCandidate([candidate(0,.961,.0724),candidate(1,.977,.0624),candidate(2,.9603,.0609)]),2);
 assert.equal(chooseBodyCandidate([candidate(9,.961,.0724),candidate(4,.977,.0624),candidate(7,.9603,.0609)]),7);
 assert.equal(chooseBodyCandidate([candidate(0,.977,.0624),candidate(1,.9603,.01,{complete:false}),candidate(2,.9,.02)]),0);
 assert.equal(chooseBodyCandidate([candidate(0,.977,.0624,{promptsSatisfied:false}),candidate(1,.94,.04)]),1);
 assert.equal(chooseBodyCandidate([candidate(0,.8,.06,{complete:false})]),undefined);
});
test('strong temporal discontinuity is rejected in favor of supported identity continuity',()=>{
 assert.equal(chooseBodyCandidate([candidate(0,.97,.062,{continuity:.8}),candidate(1,.96,.06,{continuity:.3})]),0);
});
test('generic body prompts use user point plus current body context and clamp to source bounds',()=>{
 const box={x:.2,y:.2,width:.2,height:.6},subject={x:.31,y:.4},points=automaticBodyPrompts(subject,box);
 assert.deepEqual(points.map(p=>p.label),[1,1,1,0,0]);assert.equal(points[1].x,subject.x);assert.equal(points[1].y,subject.y);
 const moved=automaticBodyPrompts({x:.9,y:.2},box);assert.ok(Math.abs(moved[1].x-.3)<1e-9);assert.ok(moved[1].y>box.y);
 for(const p of automaticBodyPrompts(undefined,{x:0,y:0,width:1,height:1}))assert.ok(p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1);
});
