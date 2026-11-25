import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {analyzeVisualMedia,loadPersonModel,visualDecodeFilters} from '../electron/visual-analysis.js';
import {subjectAnalysisRegion} from '../src/shared/visual-tracking.js';
const run=(args:string[])=>new Promise<void>((resolve,reject)=>{const p=spawn(ffmpeg!,args,{windowsHide:true});let error='';p.stderr.on('data',d=>error+=d);p.on('error',reject);p.on('close',c=>c===0?resolve():reject(Error(error)));});
async function fixture(hdr=false){
 const folder=await mkdtemp(path.join(os.tmpdir(),'vibe-visual-test-'));
 assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep));
 const source=path.join(folder,'synthetic visual source.mp4');
 await run(['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=192x108:rate=10','-t','2','-c:v','libx264','-threads','2','-pix_fmt','yuv420p',
 ...(hdr?['-color_primaries','bt2020','-color_trc','arib-std-b67','-colorspace','bt2020nc']:[]),source]);
 return {folder,source};
}
const emptyModel={async detect(){return [];}};
test('visual decoder streams finite display-oriented measurements and preserves its input',async()=>{
 const {folder,source}=await fixture();
 try{
  const before=createHash('sha256').update(await readFile(source)).digest('hex');let calls=0;const progress:number[]=[];
  const a=await analyzeVisualMedia(ffmpeg!,source,{fps:2,start:0,end:2,onProgress:p=>progress.push(p.fraction),model:{async detect(data,w,h){calls++;assert.equal(data.length,416*416*3);assert.equal(w,416);assert.equal(h,234);return [{x:.4,y:.2,width:.1,height:.5,confidence:.8}];}}});
  assert.equal(a.frames.length,4);assert.equal(calls,4);assert.equal(a.width,192);assert.equal(a.height,108);assert.equal(a.toneMapped,false);
  assert.equal(progress.at(-1),1);assert.ok(a.frames.every(f=>[f.luma,f.sharpness,f.motion,f.overexposed].every(Number.isFinite)));
  assert.ok(a.frames.every(f=>f.people[0].appearance!.length===24));
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),before);
 }finally{await rm(folder,{recursive:true,force:true});}
});
test('HLG-tagged synthetic input is tone-mapped before metrics and model samples',async()=>{
 const {folder,source}=await fixture(true);
 try{
  assert.match(visualDecodeFilters('arib-std-b67',416,234,1),/tonemap=hable/);
  assert.doesNotMatch(visualDecodeFilters('bt709',416,234,1),/tonemap/);
  const a=await analyzeVisualMedia(ffmpeg!,source,{start:0,end:1,fps:1,model:emptyModel});
  assert.equal(a.sourceColorTransfer,'arib-std-b67');assert.equal(a.toneMapped,true);assert.equal(a.frames.length,1);
  assert.ok(Number.isFinite(a.frames[0].luma));assert.ok(a.frames[0].luma>0&&a.frames[0].luma<1);
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('selected native region is cropped before resizing and maps detections back to full-source coordinates',async()=>{
 const {folder,source}=await fixture();const subject={x:.6,y:.5},region=subjectAnalysisRegion(192,108,subject)!;
 try{
  const a=await analyzeVisualMedia(ffmpeg!,source,{start:0,end:.5,fps:2,subject,model:{async detect(data,w,h){
   assert.equal(data.length,416*416*3);assert.equal(w,86);assert.equal(h,54);
   return [{x:.25,y:.25,width:.5,height:.5,confidence:.8}];
  }}});
  assert.equal(a.width,192);assert.equal(a.height,108);assert.deepEqual(a.analysisRegion,region);
  const person=a.frames[0].people[0];
  assert.equal(person.x,region.x+region.width*.25);assert.equal(person.y,region.y+region.height*.25);
  assert.equal(person.width,region.width*.5);assert.equal(person.height,region.height*.5);assert.equal(person.appearance!.length,24);
  assert.ok(a.limitations.some(l=>l.includes('metrics use the recorded native subject region')));
  assert.match(visualDecodeFilters('arib-std-b67',416,260,2,{x:354,y:518,width:864,height:540}),/crop=864:540:354:518,scale=416:260/);
  await assert.rejects(analyzeVisualMedia(ffmpeg!,source,{subject:{x:1.1,y:.5},model:emptyModel}),/inside/);
 }finally{await rm(folder,{recursive:true,force:true});}
});
test('display rotation is respected and false caller dimensions are rejected',async()=>{
 const {folder,source}=await fixture();const rotated=path.join(folder,'portrait metadata.mp4');
 try{
  await run(['-v','error','-nostdin','-n','-display_rotation','90','-i',source,'-c','copy',rotated]);
  const a=await analyzeVisualMedia(ffmpeg!,rotated,{start:0,end:1,fps:1,model:{async detect(_data,w,h){assert.equal(w,234);assert.equal(h,416);return [];}}});
  assert.equal(a.width,108);assert.equal(a.height,192);
  await assert.rejects(analyzeVisualMedia(ffmpeg!,rotated,{width:192,height:108,duration:2,model:emptyModel}),/do not match/);
 }finally{await rm(folder,{recursive:true,force:true});}
});
test('cancellation stops an active decoder and rejects without returning incomplete success',async()=>{
 const {folder,source}=await fixture();const controller=new AbortController();let calls=0;
 try{
  await assert.rejects(analyzeVisualMedia(ffmpeg!,source,{start:0,end:2,signal:controller.signal,model:{async detect(){calls++;controller.abort();controller.signal.throwIfAborted();return [];}}}),error=>error instanceof Error&&error.name==='AbortError');
  assert.equal(calls,1);
  // On Windows this fails immediately if cancellation rejected before FFmpeg
  // released its file handle. No retry or sleep is allowed to hide that race.
  const recovered=path.join(folder,'immediately recovered.mp4');
  await rename(source,recovered);await rename(recovered,source);
  await assert.rejects(analyzeVisualMedia(ffmpeg!,source,{signal:controller.signal}),error=>error instanceof Error&&error.name==='AbortError');
 }finally{await rm(folder,{recursive:true,force:true});}
});
test('bad sampling and oversized analyses fail before spawning model work',async()=>{
 await assert.rejects(analyzeVisualMedia(ffmpeg!,'not-a-media-file',{start:0,end:8000,fps:1,model:emptyModel}),/7200/);
 await assert.rejects(analyzeVisualMedia(ffmpeg!,'not-a-media-file',{fps:0,model:emptyModel}),/valid visual analysis range/);
 await assert.rejects(analyzeVisualMedia(ffmpeg!,'not-a-media-file',{width:0,model:emptyModel}),/valid source dimensions/);
});
test('bundled CPU model runs on a blank synthetic frame and reports missing resources honestly',async()=>{
 const model=await loadPersonModel();const blank=new Uint8Array(416*416*3);blank.fill(114);
 assert.deepEqual(await model.detect(blank,416,416),[]);
 await assert.rejects(model.detect(new Uint8Array(4),416,416),/Invalid visual-model input/);
 const folder=await mkdtemp(path.join(os.tmpdir(),'vibe-missing-visual-'));
 try{await assert.rejects(loadPersonModel(folder),/Local people analysis is unavailable/);}
 finally{await rm(folder,{recursive:true,force:true});}
 assert.ok(await loadPersonModel());
});
