import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeNanoDet} from '../electron/visual-analysis.js';
function tensors(){const out:Record<string,{data:Float32Array;dims:number[]}>={};for(const stride of [8,16,32]){const n=(416/stride)**2;out['cls'+stride]={data:new Float32Array(n*80),dims:[1,n,80]};out['reg'+stride]={data:new Float32Array(n*32),dims:[1,n,32]};}return out;}
test('person-class distribution decoder pairs levels by shape and applies NMS',()=>{
 const t=tensors(),row=26*52+26;
 t.cls8.data[row*80]=.9;t.cls8.data[(row+1)*80]=.85;
 for(const r of [row,row+1])for(let edge=0;edge<4;edge++)for(let bin=0;bin<8;bin++)t.reg8.data[r*32+edge*8+bin]=bin===4?20:-20;
 const p=decodeNanoDet(t,416,416);assert.equal(p.length,1);assert.ok(Math.abs(p[0].confidence-.9)<1e-6);
 assert.ok(p[0].x>.4&&p[0].x<.5);assert.ok(p[0].width>.15&&p[0].width<.16);
});
test('other COCO classes do not count as detected people and missing tensor layouts fail',()=>{
 const t=tensors();t.cls8.data[5]=.99;assert.deepEqual(decodeNanoDet(t,416,234),[]);
 delete t.reg16;assert.throws(()=>decodeNanoDet(t,416,234),/Unsupported local person-model outputs/);
});
