import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const revision='5850ab45f587c112167512ffef949107115e26a0';
export const BODY_MODEL={id:'slimsam-77-uniform-fp32',sha256:'9f8433273a6750b587779baa0cf5508111001bf7e7acfcf585d370139fd366d0',name:'SlimSAM77 point-prompted person masks',license:'Apache-2.0',revision,
 upstream:'https://github.com/czg1225/SlimSAM',conversion:'https://huggingface.co/Xenova/slimsam-77-uniform',
 files:[{name:'vision_encoder.onnx',sha256:'9f8433273a6750b587779baa0cf5508111001bf7e7acfcf585d370139fd366d0',bytes:23276014},
 {name:'prompt_encoder_mask_decoder.onnx',sha256:'f4514391764fbd56e08e119060d874ecd7d52994bfb1968af159e12d4943b5bb',bytes:16557892}]};
export const NATIVE_RUNTIME={version:'1.23.2',license:'MIT',platform:'win32-x64',packages:[
 {name:'onnxruntime-node',integrity:'sha512-OBTsG0W8ddBVOeVVVychpVBS87A9YV5sa2hJ6lc025T97Le+J4v++PwSC4XFs1C62SWyNdof0Mh4KvnZgtt4aw=='},
 {name:'onnxruntime-common',integrity:'sha512-5LFsC9Dukzp2WV6kNHYLNzp8sT6V02IubLCbzw2Xd6X5GOlr65gAX6xiJwyi2URJol/s71gaQLC5F2C25AAR2w=='}]};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const NOTICE_HASHES={'SlimSAM-Apache-2.0.txt':'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4','ONNX-Runtime-MIT.txt':'2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c','ONNX-Runtime-ThirdPartyNotices.txt':'e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc'};
async function cached(name,url,valid){
 const file=path.join(desktop,'.model-cache',name);let bytes;
 try{bytes=await readFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!bytes||!valid(bytes)){
  const response=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('Could not prepare local body model ('+response.status+').');
  bytes=Buffer.from(await response.arrayBuffer());if(!valid(bytes))throw Error('Body-model download checksum mismatch.');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
 }return bytes;
}
/** Extract only pinned regular files on an explicit allowlist. No npm
 * installer, scripts, links, GPU downloads or external path is executed. */
function selectedTarFiles(gz,pkg,inventory){
 const tar=gunzipSync(gz),allowed=new Set(inventory.filter(f=>f.path.startsWith(pkg+'/')).map(f=>f.path)),found=new Map();
 for(let offset=0;offset+512<=tar.length;){
  const h=tar.subarray(offset,offset+512);if(h.every(v=>v===0))break;
  const text=(s,n)=>h.toString('utf8',s,s+n).replace(/\0.*$/s,'');const name=text(0,100),prefix=text(345,155),size=parseInt(text(124,12).trim()||'0',8),type=text(156,1);
  if(!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length)throw Error('Invalid pinned runtime archive.');
  const relative=(prefix?prefix+'/':'')+name,key=relative.startsWith('package/')?pkg+'/'+relative.slice(8):'';
  if(allowed.has(key)){if(type!==''&&type!=='0')throw Error('Unexpected native runtime archive entry.');if(found.has(key))throw Error('Duplicate native runtime file.');found.set(key,tar.subarray(offset+512,offset+512+size));}
  offset+=512+Math.ceil(size/512)*512;
 }if(found.size!==allowed.size)throw Error('Incomplete native CPU runtime archive.');return found;
}
export async function verifyBodyResources(directory=path.join(desktop,'resources/body-segmentation')){
 const p=JSON.parse(await readFile(path.join(directory,'provenance.json'),'utf8'));
 if(p.version!==2||p.model.id!==BODY_MODEL.id||p.runtime.version!==NATIVE_RUNTIME.version||p.runtime.platform!==NATIVE_RUNTIME.platform)throw Error('Unexpected body-mask model version.');
 for(const f of BODY_MODEL.files)if(hash(await readFile(path.join(directory,f.name)))!==f.sha256)throw Error('Body-mask model integrity check failed.');
 const inventory=JSON.parse((await readFile(path.join(desktop,'tools/body-model-notices/native-runtime-files.json'),'utf8')).replace(/^\uFEFF/,''));
 for(const f of inventory)if(hash(await readFile(path.join(directory,'runtime/node_modules',f.path)))!==f.sha256)throw Error('Native body-mask runtime integrity check failed.');
 for(const [file,sha] of Object.entries(p.notices??{}))if(NOTICE_HASHES[file]!==sha||hash(await readFile(path.join(directory,file)))!==sha)throw Error('Body-mask license notice integrity check failed.');
 if(Object.keys(p.notices??{}).length!==3)throw Error('Missing body-mask license notices.');return p;
}
export async function prepareBodyModel(){
 const directory=path.join(desktop,'resources/body-segmentation');
 try{await verifyBodyResources(directory);console.log('Local native body-mask resources verified.');return;}catch{/* prepare pinned resources */}
 await mkdir(directory,{recursive:true});const files={};
 for(const f of BODY_MODEL.files){const bytes=await cached('slimsam/'+f.name,'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/'+revision+'/onnx/'+f.name+'?download=true',b=>b.length===f.bytes&&hash(b)===f.sha256);await writeFile(path.join(directory,f.name),bytes);files[f.name]=f.sha256;}
 const inventory=JSON.parse((await readFile(path.join(desktop,'tools/body-model-notices/native-runtime-files.json'),'utf8')).replace(/^\uFEFF/,''));
 for(const pkg of NATIVE_RUNTIME.packages){
  const url='https://registry.npmjs.org/'+pkg.name+'/-/'+pkg.name+'-'+NATIVE_RUNTIME.version+'.tgz',bytes=await cached('body-native/'+pkg.name+'-'+NATIVE_RUNTIME.version+'.tgz',url,b=>'sha512-'+createHash('sha512').update(b).digest('base64')===pkg.integrity);
  for(const [name,data] of selectedTarFiles(bytes,pkg.name,inventory)){
   const expected=inventory.find(f=>f.path===name);if(data.length!==expected.bytes||hash(data)!==expected.sha256)throw Error('Native CPU runtime file checksum mismatch.');
   const destination=path.resolve(directory,'runtime/node_modules',name),root=path.resolve(directory,'runtime/node_modules')+path.sep;if(!destination.startsWith(root))throw Error('Unsafe native runtime archive path.');
   await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,data);files['runtime/node_modules/'+name]=expected.sha256;
  }
 }
 const notices={};for(const name of ['SlimSAM-Apache-2.0.txt','ONNX-Runtime-MIT.txt','ONNX-Runtime-ThirdPartyNotices.txt']){const bytes=Buffer.from((await readFile(path.join(desktop,'tools/body-model-notices',name),'utf8')).replace(/\r\n/g,'\n'),'utf8');await writeFile(path.join(directory,name),bytes);notices[name]=hash(bytes);files[name]=notices[name];}
 if(notices['SlimSAM-Apache-2.0.txt']!=='c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4')throw Error('SlimSAM license checksum mismatch.');
 if(notices['ONNX-Runtime-MIT.txt']!=='2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'||notices['ONNX-Runtime-ThirdPartyNotices.txt']!=='e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc')throw Error('Official runtime license notice checksum mismatch.');
 await writeFile(path.join(directory,'provenance.json'),JSON.stringify({version:2,model:BODY_MODEL,runtime:NATIVE_RUNTIME,
  input:{maxGuidanceSide:512,encoderSize:1024,preserveAspect:true,padding:'Normalized zero on right and bottom',mean:[.485,.456,.406],std:[.229,.224,.225]},
  output:'Point-prompted learned probability masks. Prompts are derived from selected subject and verified body context, never artist recognition. Uncertain or occluded frames are suppressed.',
  noticeSource:{url:'https://files.pythonhosted.org/packages/3a/db/1b4a62e23183a0c3fe441782462c0ede9a2a65c6bbffb9582fab7c7a0d38/onnxruntime-1.23.2-cp311-cp311-win_amd64.whl',sha256:'902c756d8b633ce0dedd889b7c08459433fbcf35e9c38d1c03ddc020f0648c6e',entries:['onnxruntime/LICENSE','onnxruntime/ThirdPartyNotices.txt'],normalization:'CRLF converted to LF; license text otherwise unchanged. Wheel is neither installed nor bundled.'},
  notices,files},null,2));await verifyBodyResources(directory);console.log('Local Apache-2.0 SlimSAM and MIT native CPU runtime prepared; no media uploaded.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepareBodyModel();

