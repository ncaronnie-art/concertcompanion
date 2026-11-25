import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildBodyOutline, validateBodyOutlineOptions, type BodyOutlineStyle, type BodyOutlineContext } from "../src/shared/body-outline.ts";

const binary = ffmpeg as string, width = 160, height = 288;
const context = { duration:2, namespace:"outlineTest", cues:[{seconds:.7,confidence:.95,strength:1}] };
const video = (format: string) => `color=c=0x18202a:s=${width}x${height}:r=30:d=2,drawbox=x=60:y=75:w=40:h=145:color=0x806e64:t=fill,format=${format}`;
// This is a deliberately synthetic silhouette, not claimed concert/person
// recognition evidence. It has a head, torso, narrow arms and separated legs.
const shape = "gt(lt(pow((X-80)/15,2)+pow((Y-63)/19,2),1)+between(Y,89,169)*lt(abs(X-80),23)+between(Y,95,155)*lt(abs(X-(57-(Y-95)*0.18)),5)+between(Y,95,155)*lt(abs(X-(103+(Y-95)*0.18)),5)+between(Y,170,235)*lt(abs(X-68),7)+between(Y,170,235)*lt(abs(X-92),7),0)";
const mask = (duration=2) => `nullsrc=s=${width}x${height}:r=30:d=${duration},format=gray,geq=lum='255*${shape}'`;
const empty = (duration=2) => `color=c=black:s=${width}x${height}:r=30:d=${duration},format=gray`;

function run(exe:string,args:string[]):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{windowsHide:true});const chunks:Buffer[]=[];let error="";
    child.stdout.on("data",(chunk:Buffer)=>chunks.push(chunk));child.stderr.on("data",d=>error+=d);
    child.on("error",reject);child.on("close",code=>code===0?resolve(Buffer.concat(chunks)):reject(Error(error)));
  });
}
async function render(output:string, style:BodyOutlineStyle, inputMask:string, format:"yuv420p"|"yuv444p"="yuv444p",extra:Partial<BodyOutlineContext>={}) {
  const plan=buildBodyOutline("0:v","1:v","done",width,height,{bodyOutline:style},{...context,...extra,pixelFormat:format});
  await run(binary,["-v","error","-nostdin","-y","-filter_complex_threads","1","-threads","1",
    "-f","lavfi","-i",video(format),"-f","lavfi","-i",inputMask,"-filter_complex",plan.filters.join(";"),
    "-map","[done]","-an","-c:v","libx264","-preset","ultrafast","-crf","0","-pix_fmt",format,"-threads","1",output]);
}
const pixels = (file:string,seconds:number) => run(binary,["-v","error","-threads","1","-ss",String(seconds),"-i",file,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"]);
const point = (buffer:Buffer,x:number,y:number) => [...buffer.subarray((y*width+x)*3,(y*width+x)*3+3)];

test("body tracing requires a true mask and validates all public parameters",()=>{
  assert.throws(()=>validateBodyOutlineOptions({bodyOutline:"box" as BodyOutlineStyle}),/supported/);
  assert.throws(()=>buildBodyOutline("0:v",null,"done",160,288,{bodyOutline:"electric"},context),/real aligned silhouette/);
  assert.throws(()=>buildBodyOutline("0:v;movie=bad","1:v","done",160,288,{},context),/internal/);
  assert.throws(()=>buildBodyOutline("0:a","1:v","done",160,288,{},context),/internal/);
  assert.throws(()=>buildBodyOutline("0:v","0:v","done",160,288,{},context),/separate/);
  assert.throws(()=>buildBodyOutline("0:v","1:v","done",0,288,{},context),/valid body/);
  assert.throws(()=>buildBodyOutline("0:v","1:v","done",160,288,{}, {...context,cues:[{seconds:-1,confidence:1}]}),/valid body/);
  assert.throws(()=>buildBodyOutline("0:v","1:v","done",160,288,{}, {...context,namespace:"x;bad"}),/valid body/);
  assert.throws(()=>buildBodyOutline("0:v","1:v","done",160,288,{}, {...context,accentWindows:[{start:.7,end:.6}]}),/valid body/);
  assert.throws(()=>buildBodyOutline("0:v","1:v","done",160,288,{}, {...context,accentWindows:[{start:0,end:3}]}),/valid body/);
  assert.throws(()=>buildBodyOutline("0:v","1:v","done",160,288,{}, {...context,accentWindows:Array.from({length:17},()=>({start:0,end:1}))}),/valid body/);
});

test("pulses use confident measured cues, are bounded, and never replace silhouettes with boxes",()=>{
  const many=Array.from({length:100},(_,index)=>({seconds:index/10,confidence:.9}));
  const reduced=buildBodyOutline("0:v","1:v","done",160,288,{bodyOutline:"electric"},{duration:10,cues:many});
  const more=buildBodyOutline("0:v","1:v","done",160,288,{bodyOutline:"electric",reducedFlash:false},{duration:10,cues:many});
  assert.ok(reduced.musicalCueCount<more.musicalCueCount);
  assert.ok(reduced.musicalCueCount<=4);
  const uncertain=buildBodyOutline("0:v","1:v","done",160,288,{bodyOutline:"electric"},{duration:2,cues:[{seconds:.7,confidence:.5}]});
  assert.equal(uncertain.musicalCueCount,0);assert.ok(uncertain.warnings.some(w=>w.includes("stays steady")));
  const graph=reduced.filters.join(";");
  assert.match(graph,/blend=all_mode=subtract/);assert.match(graph,/negate/);assert.match(graph,/blend=all_mode=multiply/);assert.match(graph,/cos\(PI/);
  assert.doesNotMatch(graph,/drawbox|edgedetect|drawtext|subtitles|atempo|afade|aresample/);
  assert.match(graph,/eof_action=pass:repeatlast=0:shortest=0/);
  assert.ok(uncertain.filters.join(";").length<graph.length);
});

test("off consumes an attached mask without changing picture or inventing an overlay",()=>{
  const plan=buildBodyOutline("0:v","1:v","done",160,288,{},context);
  assert.deepEqual(plan.filters,["[1:v]nullsink","[0:v]null[done]"]);
  assert.equal(plan.maskRequired,false);assert.equal(plan.musicalCueCount,0);
  const missing=buildBodyOutline("0:v",undefined,"done",160,288,{bodyOutline:"off"},context);
  assert.deepEqual(missing.filters,["[0:v]null[done]"]);
});

test("actual FFmpeg renders distinct contour levels and pulses while keeping the body and background clear",async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),"capsule-body-neon-"));
  try {
    const files=new Map<BodyOutlineStyle,string>();
    for(const style of ["off","subtle","electric"] as const){const output=path.join(folder,style+".mp4");await render(output,style,mask());files.set(style,output);}
    const off=await pixels(files.get("off")!,.7), subtle=await pixels(files.get("subtle")!,.7), electric=await pixels(files.get("electric")!,.7), quiet=await pixels(files.get("electric")!,.2);
    for(const [name,frame] of [["subtle",subtle],["electric",electric]] as const){
      assert.deepEqual(point(frame,80,140),point(off,80,140),`${name}: body interior changed`);
      assert.deepEqual(point(frame,5,5),point(off,5,5),`${name}: colored rectangle in background`);
      assert.deepEqual(point(frame,145,260),point(off,145,260),`${name}: distant background changed`);
    }
    const edge=(frame:Buffer)=>point(frame,103,150).reduce((sum,value)=>sum+value,0);
    assert.ok(edge(subtle)>edge(off)+40,"Subtle outline was not visible on the silhouette");
    assert.ok(edge(electric)>edge(subtle)+30,"Electric did not differ from Subtle");
    assert.ok(edge(electric)>edge(quiet)+50,"Measured musical cue did not produce a visible smooth pulse");
    for(const output of files.values()){
      const probe=JSON.parse((await run(ffprobe.path,["-v","error","-show_streams","-show_format","-of","json",output])).toString());
      assert.equal(probe.streams[0].width,width);assert.equal(probe.streams[0].height,height);assert.equal(probe.streams[0].nb_frames,"60");
      assert.equal(probe.streams[0].pix_fmt,"yuv444p");assert.ok(Math.abs(Number(probe.format.duration)-2)<.04);
      await run(binary,["-v","error","-threads","1","-i",output,"-f","null","-"]);
    }
  } finally {await rm(folder,{recursive:true,force:true});}
});

test("empty real-mask planes leave every decoded pixel unchanged in420 and444; short masks never freeze",async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),"capsule-body-empty-"));
  try {
    for(const format of ["yuv420p","yuv444p"] as const){
      const baseline=path.join(folder,`off-${format}.mp4`),transparent=path.join(folder,`empty-${format}.mp4`);
      await render(baseline,"off",empty(),format);await render(transparent,"electric",empty(),format);
      assert.deepEqual(await pixels(transparent,.7),await pixels(baseline,.7),`${format}: empty mask changed picture pixels`);
    }
    const short=path.join(folder,"short.mp4");await render(short,"electric",mask(1));
    assert.deepEqual(await pixels(short,1.5),await pixels(path.join(folder,"off-yuv444p.mp4"),1.5),"An ended mask froze the outline into later frames");
    const interrupted=path.join(folder,"interrupted.mp4");
    await render(interrupted,"electric",mask().replace("255*", "255*lt(T,1)*"));
    assert.deepEqual(await pixels(interrupted,31/30),await pixels(path.join(folder,"off-yuv444p.mp4"),31/30),"A delayed echo remained after the current silhouette became uncertain/black");
    const probe=JSON.parse((await run(ffprobe.path,["-v","error","-show_streams","-show_format","-of","json",short])).toString());
    assert.equal(probe.streams[0].nb_frames,"60");assert.ok(Math.abs(Number(probe.format.duration)-2)<.04);
  } finally {await rm(folder,{recursive:true,force:true});}
});

test("contour compositing keeps the base timestamp sequence",async()=>{
  const plan=buildBodyOutline("0:v","1:v","done",width,height,{bodyOutline:"subtle"},{duration:2,pixelFormat:"yuv444p"});
  const output=(await run(binary,["-v","error","-nostdin","-copyts","-filter_complex_threads","1",
    "-f","lavfi","-i",video("yuv444p")+",setpts=PTS+3/TB","-f","lavfi","-i",mask()+",setpts=PTS+3/TB",
    "-filter_complex",plan.filters.join(";"),"-map","[done]","-fps_mode","passthrough","-f","framemd5","-"])).toString();
  const frames=output.split(/\r?\n/).filter(line=>/^0,/.test(line)).map(line=>line.split(",").map(v=>v.trim()));
  assert.equal(frames.length,60);assert.equal(Number(frames[0][2]),90);assert.equal(Number(frames[59][2]),149);
});

test("editorial accent windows softly fade only the effect and never fabricate a musical cue",async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),"capsule-body-windows-"));
  const windows={cues:[],accentWindows:[{start:.3,end:1.5}]};
  const editorial=buildBodyOutline("0:v","1:v","done",width,height,{bodyOutline:"electric"},{...context,...windows});
  assert.equal(editorial.musicalCueCount,0);assert.ok(editorial.warnings.some(w=>w.includes("editorial timing")));
  try{
    const baseline=path.join(folder,"off.mp4"),accent=path.join(folder,"accent.mp4"),echo=path.join(folder,"echo.mp4");
    await render(baseline,"off",mask());await render(accent,"electric",mask(),"yuv444p",windows);
    const off=await pixels(baseline,.6),middle=await pixels(accent,.6),early=await pixels(accent,10/30),late=await pixels(accent,44/30);
    const edge=(frame:Buffer)=>point(frame,103,150).reduce((sum,value)=>sum+value,0);
    assert.ok(edge(middle)>edge(early)+35,"The entrance did not fade toward the visible middle");
    assert.ok(edge(middle)>edge(late)+35,"The exit did not fade away from the visible middle");
    assert.deepEqual(point(middle,80,140),point(off,80,140),"Accent visibility changed the body interior");
    for(const time of [.2,.3,1.5,1.6])assert.deepEqual(await pixels(accent,time),off,`Editorial outline was visible outside or at a window edge ${time}`);
    await render(echo,"electric",mask(),"yuv444p",{accentWindows:[{start:.3,end:1}]});
    assert.deepEqual(await pixels(echo,31/30),off,"Delayed echo leaked past the editorial window while the mask remained present");
    const transparent=path.join(folder,"empty.mp4");await render(transparent,"electric",empty(),"yuv444p",windows);
    assert.deepEqual(await pixels(transparent,.6),off,"A window changed a black-mask frame");
  }finally{await rm(folder,{recursive:true,force:true});}
});
