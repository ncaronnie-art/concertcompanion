import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareAudioModel,verifyAudioResources} from './prepare-audio-model.mjs';
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source={url:'https://huggingface.co/opencv/object_detection_nanodet/resolve/main/object_detection_nanodet_2022nov.onnx',
 sha256:'4b82da9944b88577175ee23a459dce2e26e6e4be573def65b1055dc2d9720186',bytes:3800954,
 name:'OpenCV Zoo NanoDet-m-plus-1.5x416 (2022nov)',license:'Apache-2.0',
 upstream:'https://github.com/opencv/opencv_zoo/tree/main/models/object_detection_nanodet'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const noticeHash='cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
export async function verifyVisualResources(directory=path.join(desktop,'resources','visual-analysis')){
 const p=JSON.parse(await readFile(path.join(directory,'provenance.json'),'utf8'));
 if(p.version!==1||p.model.sha256!==source.sha256)throw Error('Unexpected local visual model version.');
 if(hash(await readFile(path.join(directory,'nanodet.onnx')))!==source.sha256||hash(await readFile(path.join(directory,'NanoDet-Apache-2.0.txt')))!==noticeHash)throw Error('Local visual model integrity check failed.');
 await verifyAudioResources(path.resolve(directory,'../audio-events'));
 return p;
}
export async function prepareVisualModel(){
 const destination=path.join(desktop,'resources','visual-analysis');
 try{await verifyVisualResources(destination);console.log('Local visual model resources verified.');return;}catch{/* prepare pinned files */}
 const override=process.argv.find(a=>a.startsWith('--model='))?.slice(8);
 const cache=override??path.join(desktop,'.model-cache','visual','nanodet.onnx');
 let bytes;
 try{bytes=await readFile(cache);}catch(error){
  if(override||error.code!=='ENOENT')throw error;
  const response=await fetch(source.url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(`Could not prepare local person detector (${response.status}).`);
  bytes=Buffer.from(await response.arrayBuffer());
  if(hash(bytes)!==source.sha256)throw Error('Visual model download checksum mismatch.');
  await mkdir(path.dirname(cache),{recursive:true});await writeFile(cache,bytes);
 }
 if(hash(bytes)!==source.sha256||bytes.length!==source.bytes)throw Error('Visual model checksum mismatch.');
 const notice=Buffer.from((await readFile(path.join(desktop,'tools','visual-model-notices','NanoDet-Apache-2.0.txt'),'utf8')).replace(/\r\n/g,'\n'),'utf8');
 if(hash(notice)!==noticeHash)throw Error('Visual model license notice checksum mismatch.');
 await prepareAudioModel();
 await mkdir(destination,{recursive:true});await writeFile(path.join(destination,'nanodet.onnx'),bytes);
 await writeFile(path.join(destination,'NanoDet-Apache-2.0.txt'),notice);
 await writeFile(path.join(destination,'provenance.json'),JSON.stringify({version:1,model:source,runtime:{version:'1.23.2',location:'../audio-events/runtime',license:'MIT'},
  attribution:'OpenCV Zoo NanoDet model, original NanoDet by RangiLyu. Person-class decoder reimplemented for local JavaScript from the Apache-2.0 OpenCV reference; no upstream code is executed.',
  input:'Display-oriented BGR letterbox416, top-left114pad; means103.53/116.28/123.675,std57.375/57.12/58.395; NCHWfloat32.',
  output:'COCO person class0, per-level class and distance distributions, strides8/16/32. No artist identity or foreground/background semantics.',
  sources:[source.upstream,'https://github.com/opencv/opencv_zoo/blob/main/models/object_detection_nanodet/nanodet.py','https://onnxruntime.ai/docs/tutorials/web/deploy.html'],
  files:{'nanodet.onnx':source.sha256,'NanoDet-Apache-2.0.txt':noticeHash}},null,2));
 await verifyVisualResources(destination);console.log('Local person detector prepared; no media was uploaded.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepareVisualModel();
