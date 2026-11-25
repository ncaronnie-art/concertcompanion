import test from "node:test";
import assert from "node:assert/strict";
import {access,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import {withRenderGraphFile} from "../electron/render-graph-file.js";
import {buildRenderCommand,type MediaAsset,type RenderSelection} from "../src/shared/render-plan.js";

// Settle only at close: an AbortError/error event alone does not prove Windows
// has released a subprocess's file handles.
async function execute(exe:string,args:string[]):Promise<string>{
 return new Promise((resolve,reject)=>{
  const p=spawn(exe,args,{windowsHide:true});let output="",error="",processError:Error|undefined;
  p.stdout.on("data",d=>output+=d);p.stderr.on("data",d=>error+=d);p.on("error",e=>{processError=e;});
  p.on("close",code=>processError?reject(processError):code===0?resolve(output):reject(Error(error)));
 });
}
function limitThreads(args:string[]):string[]{
 const limited=["-filter_threads","2","-filter_complex_threads","2"];
 for(const arg of args){if(arg==="-i")limited.push("-threads","2");limited.push(arg);}
 limited.splice(limited.length-1,0,"-threads","2");return limited;
}
test("UTF8 graph files preserve every other argument and exist for the entire callback",async()=>{
 const original=["-i","recording with spaces.mov","-filter_complex","[0:v]null[out] \n café ∙ neon","-map","[out]","finished.mp4"];
 const copy=[...original];let file="",directory="";
 const result=await withRenderGraphFile(original,async args=>{
  const i=args.indexOf("-filter_complex_script");assert.equal(i,2);file=args[i+1];directory=path.dirname(file);
  assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.equal(path.extname(file),".ffscript");
  assert.equal(await readFile(file,"utf8"),original[3]);
  const expected=[...original];expected[2]="-filter_complex_script";expected[3]=file;assert.deepEqual(args,expected);
  await Promise.resolve();await access(file);return {output:"finished.mp4"};
 });
 assert.deepEqual(result,{output:"finished.mp4"});assert.deepEqual(original,copy);
 await assert.rejects(access(file),{code:"ENOENT"});await assert.rejects(access(directory),{code:"ENOENT"});
});

test("callback failures keep the original error and remove the temporary graph",async()=>{
 const failure=new Error("FFmpeg could not render this recording");let file="";
 await assert.rejects(withRenderGraphFile(["-filter_complex","null"],async args=>{file=args[1];await access(file);throw failure;}),error=>error===failure);
 await assert.rejects(access(file),{code:"ENOENT"});await assert.rejects(access(path.dirname(file)),{code:"ENOENT"});
});

test("multiple graphs get separate files; no-graph commands remain intact and malformed graphs fail early",async()=>{
 let files:string[]=[];
 await withRenderGraphFile(["-filter_complex","null[first]","-map","[first]","-filter_complex","null[second]"],async args=>{
  files=[args[1],args[5]];assert.notEqual(files[0],files[1]);
  assert.deepEqual(await Promise.all(files.map(file=>readFile(file,"utf8"))),["null[first]","null[second]"]);
 });
 for(const file of files)await assert.rejects(access(file),{code:"ENOENT"});
 const args=["-i","source.mp4","-c","copy","out.mp4"];
 assert.equal(await withRenderGraphFile(args,async actual=>{assert.deepEqual(actual,args);assert.notEqual(actual,args);return 42;}),42);
 let called=false;await assert.rejects(withRenderGraphFile(["-filter_complex"],async()=>{called=true;}),/graph is missing/);assert.equal(called,false);
});

test("a real eighteen-shot Y2K export larger than the Windows command-line limit renders through a graph file",{timeout:120_000},async()=>{
 const temporaryRoot=path.resolve(tmpdir()),folder=await mkdtemp(path.join(temporaryRoot,"vibe-long-graph-test-"));
 assert.equal(path.dirname(path.resolve(folder)),temporaryRoot);
 const source=path.join(folder,"synthetic recording.mp4"),output=path.join(folder,"eighteen shot neon reel.mp4");
 try{
  await execute(ffmpeg!,limitThreads(["-v","error","-y","-f","lavfi","-i","testsrc2=size=180x320:rate=30:duration=18","-f","lavfi","-i","sine=frequency=440:duration=18","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",source]));
  const asset:MediaAsset={path:source,name:"synthetic recording.mp4",duration:18,audioDuration:18,width:180,height:320,hasAudio:true};
  const shots:RenderSelection[]=Array.from({length:18},(_,i)=>({asset,start:i,end:i+1,locked:true,selectionSource:"manual",visualCues:[{seconds:i+.2,confidence:.95,strength:.8}]}));
  const plan=buildRenderCommand(shots,output,{aspect:"vertical",quality:"high",reduceRumble:true,transition:"cut",effects:"full-y2k",videoEnhancement:"clean",reducedFlash:true});
  const graph=plan.args[plan.args.indexOf("-filter_complex")+1];assert.ok(graph.length>32767,`Test must exceed Windows' limit; graph was${graph.length} characters.`);
  const original=[...plan.args];let graphFile="";
  await withRenderGraphFile(plan.args,async args=>{
   graphFile=args[args.indexOf("-filter_complex_script")+1];assert.equal(await readFile(graphFile,"utf8"),graph);
   assert.ok(args.join(" ").length<32767);assert.ok(!args.includes("-filter_complex"));
   await execute(ffmpeg!,limitThreads(args));await access(graphFile);
  });
  assert.deepEqual(plan.args,original);await assert.rejects(access(graphFile),{code:"ENOENT"});
  await execute(ffmpeg!,limitThreads(["-v","error","-xerror","-i",output,"-f","null","-"]));
  const probe=JSON.parse(await execute(ffprobe.path,["-v","error","-count_frames","-show_streams","-show_format","-of","json",output]));
  const video=probe.streams.find((s:any)=>s.codec_type==="video"),audio=probe.streams.find((s:any)=>s.codec_type==="audio");
  assert.equal(video.width,180);assert.equal(video.height,320);assert.equal(video.r_frame_rate,"30/1");assert.equal(Number(video.nb_read_frames),540);
  assert.equal(video.codec_name,"h264");assert.equal(audio.codec_name,"aac");assert.equal(audio.channels,2);assert.ok(Math.abs(Number(probe.format.duration)-18)<.05);
 }finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
});
