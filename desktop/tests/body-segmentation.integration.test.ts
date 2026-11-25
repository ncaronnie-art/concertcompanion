import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rename,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';
import ffmpeg from 'ffmpeg-static';import ffprobe from 'ffprobe-static';
import {loadBodyModel,prepareBodyMask,type BodySegmentationModel} from '../electron/body-segmentation.js';
import type {TrackingPlan,VisualAnalysis} from '../src/shared/visual-tracking.js';
const run=(exe:string,args:string[])=>new Promise<string>((resolve,reject)=>{const p=spawn(exe,args,{windowsHide:true});let output='',error='',processError:Error|undefined;p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>error+=d);p.on('error',e=>{processError=e;});p.on('close',code=>processError?reject(processError):code===0?resolve(output):reject(Error(error)));});
const hash=async(file:string)=>createHash('sha256').update(await readFile(file)).digest('hex');
const plan:TrackingPlan={version:1,subjectLocked:true,coverage:1,suggestedFraming:'fill',notes:[],keyframes:[{time:0,x:0,y:0,width:1,height:1,confidence:.9,status:'tracking',subject:{x:.4,y:.15,width:.2,height:.7}}]};
function mockModel(onCall?:()=>void):BodySegmentationModel{return {id:'synthetic-person-fixture',sha256:'test-only-ellipse-probability',async segment(){onCall?.();const p=new Float32Array(192*192);for(let y=0;y<192;y++)for(let x=0;x<192;x++)if(((x/192-.5)/.14)**2+((y/192-.5)/.31)**2<1)p[y*192+x]=.98;return p;}};}
async function fixture(){const folder=await mkdtemp(path.join(os.tmpdir(),'vibe-body-test-'));assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));const source=path.join(folder,'original synthetic video.mp4');await run(ffmpeg!,['-v','error','-y','-threads','2','-filter_threads','2','-f','lavfi','-i','testsrc2=size=192x108:rate=30:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-threads','2',source]);return {folder,source,asset:{path:source,name:path.basename(source),duration:1,width:192,height:108,hasAudio:true}};}

test('streaming body masks are source-aligned lossless video, preserve originals and reuse exact caches',async()=>{
 const {folder,source,asset}=await fixture();let calls=0;
 try{
  const before=await hash(source),model=mockModel(()=>calls++),options={start:0,end:1,fps:10,subject:{x:.5,y:.5},tracking:plan,model};const progress:number[]=[];
  const mask=await prepareBodyMask(ffmpeg!,asset,{...options,onProgress:p=>progress.push(p.fraction)},path.join(folder,'cache'));
  assert.equal(mask.frames,10);assert.equal(mask.fps,10);assert.equal(mask.coverage,1);assert.equal(mask.sourceWidth,192);assert.equal(mask.sourceHeight,108);assert.equal(progress.at(-1),1);assert.equal(mask.modelId,'synthetic-person-fixture');assert.ok(mask.processingId);
  assert.ok(progress.every((v,i)=>v>=0&&v<=1&&(!i||v>=progress[i-1])));
  const probe=JSON.parse(await run(ffprobe.path,['-v','error','-count_frames','-show_streams','-show_format','-of','json',mask.path]));assert.equal(probe.streams.length,1);assert.equal(probe.streams[0].codec_name,'ffv1');assert.equal(probe.streams[0].pix_fmt,'gray');assert.equal(Number(probe.streams[0].nb_read_frames),10);assert.ok(Math.abs(Number(probe.format.duration)-1)<.05);
  await run(ffmpeg!,['-v','error','-xerror','-threads','2','-i',mask.path,'-f','null','-']);
  const count=calls,cached=await prepareBodyMask(ffmpeg!,asset,options,path.join(folder,'cache'));assert.equal(cached.path,mask.path);assert.equal(calls,count);
  const different=await prepareBodyMask(ffmpeg!,asset,{...options,start:.2,end:.8},path.join(folder,'cache'));assert.notEqual(different.path,mask.path);
  assert.equal(await hash(source),before);assert.deepEqual((await readdir(path.join(folder,'cache'))).filter(p=>p.startsWith('body-work-')),[]);
 }finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
});

test('cancellation waits for both decoder and encoder close before cleanup or immediate source rename',async()=>{
 const {folder,source,asset}=await fixture(),controller=new AbortController();
 try{
  await assert.rejects(prepareBodyMask(ffmpeg!,asset,{start:0,end:1,fps:10,subject:{x:.5,y:.5},tracking:plan,model:mockModel(),signal:controller.signal,onProgress:p=>{if(p.frames===1)controller.abort();}},path.join(folder,'cache')),error=>error instanceof Error&&error.name==='AbortError');
  const moved=path.join(folder,'source immediately recovered.mp4');await rename(source,moved);await rename(moved,source);
  assert.deepEqual((await readdir(path.join(folder,'cache'))).filter(p=>p.startsWith('body-work-')||p.endsWith('.mkv')),[]);
 }finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
});

test('the encoded stable-run mask rejects short islands at their original timestamps and keeps a genuine onset',async()=>{
 const {folder,asset}=await fixture();let index=0;
 try{
  const base=mockModel(),model:BodySegmentationModel={...base,async segment(rgb,signal){const i=index++;return i<2||i>=5&&i<=12||i===17?base.segment(rgb,signal):new Float32Array(192*192);}};
  const mask=await prepareBodyMask(ffmpeg!,asset,{start:0,end:1,fps:30,subject:{x:.5,y:.5},tracking:plan,model},path.join(folder,'stable-cache'));
  const centers=await new Promise<Buffer>((resolve,reject)=>{const p=spawn(ffmpeg!,['-v','error','-threads','2','-filter_threads','2','-i',mask.path,'-vf','crop=1:1:96:54','-pix_fmt','gray','-f','rawvideo','pipe:1'],{windowsHide:true}),chunks:Buffer[]=[];let error='';p.stdout.on('data',d=>chunks.push(d));p.stderr.on('data',d=>error+=d);p.on('error',reject);p.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error(error)));});
  assert.equal(mask.frames,30);assert.equal(centers.length,30);assert.equal(mask.stats!.rawAcceptedFrames,11);assert.equal(mask.stats!.acceptedFrames,8);assert.equal(mask.stats!.minimumStableFrames,6);
  assert.equal(centers.subarray(0,5).some(v=>v>0),false);assert.ok(centers[5]>127);assert.ok(centers[12]>127);assert.equal(centers[17],0);
  assert.equal(mask.frameQuality!.find(f=>f.status==='accepted')!.time,5/30);
  assert.equal(mask.coverage,(mask.stats!.acceptedFrames+mask.stats!.fadedFrames)/30);
 }finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
});

test('invalid processing ranges fail before media/model work',async()=>{
 const asset={path:'missing',name:'missing',duration:10000,width:192,height:108,hasAudio:false};
 await assert.rejects(prepareBodyMask(ffmpeg!,asset,{start:0,end:1000,fps:30},'unused'),/18000/);
 await assert.rejects(prepareBodyMask(ffmpeg!,asset,{start:0,end:1,fps:NaN},'unused'),/valid body-outline/);
 await assert.rejects(prepareBodyMask(ffmpeg!,asset,{start:0,end:1,subject:{x:1.1,y:.5}},'unused'),/subject/);
});

test('the pinned real point model runs with CPU native resources and unavailable resources stay explicit',async()=>{
 const model=await loadBodyModel(),blank=new Uint8Array(192*192*3);blank.fill(128);const output=await model.segment(blank,undefined,{width:192,height:192,subject:{x:.5,y:.5},expected:{x:.25,y:.1,width:.5,height:.8}});
 assert.equal(model.runtime,'onnxruntime-node');assert.equal(model.runtimeVersion,'1.23.2');assert.equal(model.preserveAspect,true);
 assert.equal(output.length,192*192);assert.ok([...output].every(v=>Number.isFinite(v)&&v>=0&&v<=1));
 await assert.rejects(model.segment(new Uint8Array(3)),/Invalid body-mask model input/);
 const folder=await mkdtemp(path.join(os.tmpdir(),'vibe-missing-body-'));assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));
 try{await assert.rejects(loadBodyModel(folder),/unavailable or damaged/);}finally{await rm(folder,{recursive:true,force:true});}
});

test('selective source-time accents infer only genuine active frames and preserve black outside exact PTS',async()=>{
 const {folder,asset}=await fixture();let calls=0;
 try{
  const mask=await prepareBodyMask(ffmpeg!,asset,{start:0,end:1,fps:30,tracking:plan,model:mockModel(()=>calls++),activeRanges:[{start:4/30,end:12/30}]},path.join(folder,'selective-cache'));
  assert.equal(calls,8);assert.equal(mask.frames,30);assert.equal(mask.stats!.acceptedFrames,8);assert.equal(mask.stats!.fadedFrames,0);
  assert.deepEqual(mask.frameQuality!.filter(f=>f.status==='accepted').map(f=>f.time),Array.from({length:8},(_,i)=>(i+4)/30));
  assert.equal(mask.frameQuality![3].reason,'outside-creative-accent');assert.equal(mask.frameQuality![12].reason,'outside-creative-accent');
  const invisible=await prepareBodyMask(ffmpeg!,asset,{start:0,end:1,fps:10,tracking:plan,visibleRegion:{x:0,y:0,width:.2,height:1},model:mockModel(()=>calls++)},path.join(folder,'outside-cache'));
  assert.equal(calls,8);assert.equal(invisible.coverage,0);assert.equal(invisible.stats!.acceptedFrames,0);
  await assert.rejects(prepareBodyMask(ffmpeg!,asset,{start:0,end:1,activeRanges:[{start:.8,end:1.2}],model:mockModel()},path.join(folder,'bad-cache')),/source-time/);
 }finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
});

test('aspect-preserving models receive native proportional RGB and matching body context',async()=>{
 const {folder,asset}=await fixture();const shapes:number[][]=[];
 try{
  const model:BodySegmentationModel={id:'aspect-test',sha256:'aspect-test',inputSize:256,preserveAspect:true,async segment(rgb,_signal,context){assert.ok(context?.expected);shapes.push([context!.width,context!.height]);assert.equal(rgb.length,context!.width*context!.height*3);return new Float32Array(context!.width*context!.height);}};
  const result=await prepareBodyMask(ffmpeg!,asset,{start:0,end:1,fps:10,tracking:plan,model},path.join(folder,'aspect-cache'));
  assert.equal(result.frames,10);assert.equal(shapes.length,10);assert.ok(shapes.every(([w,h])=>w!==h&&w<=192&&h<=108));
 }finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
});

test('HLG conversion accepts proportionally scaled odd-sided guidance and emits literal zero masks',async()=>{
 const {folder,asset,source}=await fixture();
 try{
  const hdr=path.join(folder,'tagged HLG.mp4');await run(ffmpeg!,['-v','error','-threads','2','-i',source,'-c','copy','-color_trc','arib-std-b67','-color_primaries','bt2020','-colorspace','bt2020nc',hdr]);
  let calls=0;const model:BodySegmentationModel={id:'hdr-even-grid-test',sha256:'hdr-even-grid-test',inputSize:64,preserveAspect:true,async segment(rgb,_signal,context){assert.ok(context);assert.equal(context!.width%2,0);assert.equal(context!.height%2,0);assert.equal(rgb.length,context!.width*context!.height*3);calls++;return new Float32Array(context!.width*context!.height);}};
  const mask=await prepareBodyMask(ffmpeg!,{...asset,path:hdr,name:'tagged HLG.mp4'},{start:0,end:1,fps:10,tracking:plan,model},path.join(folder,'hdr-cache'));assert.equal(calls,10);assert.equal(mask.encodingVersion,2);
  const raw=await new Promise<Buffer>((resolve,reject)=>{const child=spawn(ffmpeg!,['-v','error','-xerror','-threads','2','-i',mask.path,'-pix_fmt','gray','-f','rawvideo','pipe:1'],{windowsHide:true}),chunks:Buffer[]=[];child.stdout.on('data',d=>chunks.push(d));child.on('error',reject);child.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error('Mask decode failed')));});
  assert.equal(raw.length,mask.width*mask.height*10);assert.equal(raw.some(v=>v!==0),false);
 }finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
});

test('a selected subject rechecks old full-frame body context without mutating the saved picture analysis',async()=>{
 const {folder,asset}=await fixture();let calls=0;
 try{
  // Deliberately stale, apparently confident full-frame body detection. The
  // actual fixture has no person; a local-detail check must supersede it.
  const analysis:VisualAnalysis={version:1,width:192,height:108,start:0,end:1,sampleFps:2,detector:'synthetic stale full-frame detection',limitations:[],frames:[0,.5].map(time=>({time,people:[{x:.4,y:.15,width:.2,height:.7,confidence:.95}],luma:.5,sharpness:.5,motion:0,overexposed:0}))};
  const before=JSON.stringify(analysis),result=await prepareBodyMask(ffmpeg!,asset,{start:0,end:1,fps:10,subject:{x:.5,y:.5},analysis,tracking:plan,model:mockModel(()=>calls++)},path.join(folder,'subject-recheck-cache'));
  assert.equal(JSON.stringify(analysis),before);assert.ok(result.warnings.some(w=>w.includes('selected subject was rechecked')));assert.equal(calls,0);assert.equal(result.coverage,0);
 }finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
});

test('one serious occlusion suppresses its complete FFV1 accent while a second accent and every PTS remain intact',async()=>{
 const {folder,asset}=await fixture();let calls=0;
 try{
  const base=mockModel(),model:BodySegmentationModel={...base,async segment(rgb,signal){const p=await base.segment(rgb,signal),i=calls++;if(i===6)for(let y=112;y<124;y++)for(let x=91;x<101;x++)p[y*192+x]=0;return p;}};
  const mask=await prepareBodyMask(ffmpeg!,asset,{start:0,end:1,fps:30,tracking:plan,model,activeRanges:[{start:0,end:.5},{start:.6,end:.9}]},path.join(folder,'whole-accent-cache'));
  assert.equal(calls,24);assert.equal(mask.frames,30);assert.equal(mask.suppressedAccentRanges?.length,1);assert.equal(mask.suppressedAccentRanges![0].reason,'body-occlusion-uncertainty');
  assert.equal(mask.stats!.acceptedFrames,9);assert.equal(mask.stats!.fadedFrames,0);assert.ok(mask.frameQuality!.slice(0,15).every(f=>f.status==='suppressed'));assert.ok(mask.frameQuality!.slice(18,27).every(f=>f.status==='accepted'));
  const raw=await new Promise<Buffer>((resolve,reject)=>{const c=spawn(ffmpeg!,['-v','error','-xerror','-threads','2','-i',mask.path,'-pix_fmt','gray','-f','rawvideo','pipe:1'],{windowsHide:true}),chunks:Buffer[]=[];c.stdout.on('data',d=>chunks.push(d));c.on('error',reject);c.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error('Mask decode failed')));});
  const frameBytes=mask.width*mask.height;assert.equal(raw.length,30*frameBytes);assert.equal(raw.subarray(0,15*frameBytes).some(v=>v>0),false);for(let i=18;i<27;i++)assert.ok(raw.subarray(i*frameBytes,(i+1)*frameBytes).some(v=>v>127));
  const baseline=await prepareBodyMask(ffmpeg!,asset,{start:0,end:1,fps:30,tracking:plan,model:base,activeRanges:[{start:.6,end:.9}]},path.join(folder,'unchanged-second-accent'));
  const baselineRaw=await new Promise<Buffer>((resolve,reject)=>{const c=spawn(ffmpeg!,['-v','error','-xerror','-threads','2','-i',baseline.path,'-pix_fmt','gray','-f','rawvideo','pipe:1'],{windowsHide:true}),chunks:Buffer[]=[];c.stdout.on('data',d=>chunks.push(d));c.on('error',reject);c.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error('Baseline decode failed')));});
  const secondHash=(data:Buffer)=>createHash('sha256').update(data.subarray(18*frameBytes,27*frameBytes)).digest('hex');assert.equal(secondHash(raw),secondHash(baselineRaw),'The other accent must preserve every decoded alpha pixel.');
  const timestamps=JSON.parse(await run(ffprobe.path,['-v','error','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',mask.path])).frames.map((f:{best_effort_timestamp_time:string})=>Number(f.best_effort_timestamp_time));assert.equal(timestamps.length,30);for(let i=0;i<30;i++)assert.ok(Math.abs(timestamps[i]-i/30)<.001);
 }finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
});
