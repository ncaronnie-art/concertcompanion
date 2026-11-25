import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { EventEmitter } from "node:events";
import ts from "typescript";

// Exercise the actual main-process callbacks without importing Electron,
// opening a window, touching a project file, or starting FFmpeg. Gates model
// asynchronous graph writes/audio analysis/the mask-to-render handoff.
const source=readFileSync(new URL("../electron/main.ts",import.meta.url),"utf8");
const tree=ts.createSourceFile("main.ts",source,ts.ScriptTarget.Latest,true);
let renderFunction="",quitCallback="";
const callbacks=new Map<string,string>();
function collect(node:ts.Node):void {
  if(ts.isFunctionDeclaration(node)&&node.name?.text==="runPlannedRender")renderFunction=node.getText(tree);
  if(ts.isCallExpression(node)&&node.arguments.length>=2&&ts.isStringLiteral(node.arguments[0])) {
    const call=node.expression.getText(tree),name=node.arguments[0].text;
    if(call==="ipcMain.handle"&&["media:cancel-render","media:preview-cut","media:render"].includes(name))callbacks.set(name,node.arguments[1].getText(tree));
    if(call==="app.on"&&name==="before-quit")quitCallback=node.arguments[1].getText(tree);
  }
  ts.forEachChild(node,collect);
}
collect(tree);
assert(renderFunction&&quitCallback&&callbacks.size===3,"The actual render/cancel/quit entry points must be present");
const code=ts.transpileModule(`${renderFunction}\nconst cancel=${callbacks.get("media:cancel-render")};\nconst preview=${callbacks.get("media:preview-cut")};\nconst render=${callbacks.get("media:render")};\nconst quit=${quitCallback};\n({start:runPlannedRender,cancel,preview,render,quit,state:()=>({preparing:renderPreparing,epoch:renderCancelEpoch,active:!!activeRender})});`,
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;

function gate() {
  let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  return {started,release,wait:async()=>{entered();await waiting;}};
}
class StubChild extends EventEmitter {
  stdout=new EventEmitter();stderr=new EventEmitter();kills=0;
  kill(){this.kills++;queueMicrotask(()=>this.emit("close",null));return true;}
}
type Entry=(...args:any[])=>Promise<any>;
type API={start:Entry;cancel:()=>boolean;preview:Entry;render:Entry;quit:(event:{preventDefault:()=>void})=>void;state:()=>{preparing:boolean;epoch:number;active:boolean}};
const event={sender:{isDestroyed:()=>false,send:()=>{}}};
const selections=[{asset:{path:"synthetic.mp4",name:"synthetic.mp4",duration:2,width:160,height:288,hasAudio:true},start:0,end:2}];
const options={aspect:"vertical",reduceRumble:false,bodyOutline:"electric"};
function harness(settings:{graphGate?:ReturnType<typeof gate>;audioGate?:ReturnType<typeof gate>;overlayGate?:ReturnType<typeof gate>;autoClose?:boolean;graphError?:boolean}={}) {
  const children:StubChild[]=[],calls={masks:0,commits:0,quits:0,graphs:0};
  let heldGraph=false;
  const context:Record<string,unknown>={
    activeRender:undefined,renderPreparing:false,cancelRender:false,renderCancelEpoch:0,activeBodyAnalysis:undefined,activeVisualAnalysis:undefined,
    activeBodyJob:undefined,audioControllers:new Set(),bodyMaskDirectory:undefined,previewDirectory:"mock-preview",cleaning:false,
    draftKeys:new Map(),drafts:new Map(),draftNotes:new Map(),selectedFiles:new Map([["fixture","synthetic.mp4"]]),
    path,tmpdir:()=>"mock-tmp",randomUUID:()=>"fixture-output",ffmpegBinary:"never-executed-ffmpeg",ffprobe:{path:"never-executed-ffprobe"},
    smoke:true,smokeCancelPending:false,process:{env:{COMPASS_SMOKE_OUTPUT:"fixture-output.mp4",COMPASS_SMOKE_CLEANUP_FAIL:"0"}},
    access:async()=>{},mkdtemp:async()=>"mock-export-directory",rm:async()=>{},
    withoutBodyMaskPaths:(items:unknown)=>items,
    addMusicAccents:async(items:unknown)=>{if(settings.audioGate)await settings.audioGate.wait();return items;},
    addPerformerContours:async(_event:unknown,items:unknown)=>{calls.masks++;return {selections:items,note:"Clear moments only"};},
    writeVisualOverlay:async()=>{if(settings.overlayGate)await settings.overlayGate.wait();return undefined;},
    buildRenderCommand:()=>({args:[],totalSeconds:2}),buildAudioLedRenderCommand:()=>({args:[],totalSeconds:2}),
    assertOutputIsNotOriginal:async()=>{},commitOutput:async()=>{calls.commits++;},validateRenderedOutput:()=>{},
    run:async()=>JSON.stringify({format:{duration:2},streams:[]}),
    withTemporaryCleanup:async(_directory:unknown,work:()=>Promise<unknown>)=>({value:await work(),cleanupWarning:false}),
    withRenderGraphFile:async(args:unknown,work:(args:unknown)=>Promise<unknown>)=>{
      calls.graphs++;
      if(settings.graphGate&&!heldGraph){heldGraph=true;await settings.graphGate.wait();}
      if(settings.graphError)throw Error("controlled graph-write failure");
      return work(args);
    },
    spawn:()=>{const child=new StubChild();children.push(child);if(settings.autoClose!==false)queueMicrotask(()=>child.emit("close",0));return child;},
    app:{quit:()=>{calls.quits++;}},
  };
  const api=vm.runInNewContext(code,context) as API;
  return {api,children,calls,context};
}

test("stop during graph-file preparation is acknowledged, starts no child, and allows a fresh render",async()=>{
  const hold=gate(),h=harness({graphGate:hold});
  const first=h.api.start(event,[],2,"Render stopped");
  await hold.started;assert.equal(h.api.state().preparing,true);
  assert.throws(()=>h.api.start(event,[],2,"Other"),/already|still being prepared/);
  assert.equal(h.api.cancel(),true);hold.release();
  await assert.rejects(first,/Render stopped/);
  assert.equal(h.children.length,0);assert.equal(h.api.state().preparing,false);
  await h.api.start(event,[],2,"New render stopped");
  assert.equal(h.children.length,1);assert.equal(h.api.state().preparing,false);
});

test("running-child cancellation waits for close and does not poison a later job",async()=>{
  const h=harness({autoClose:false}),first=h.api.start(event,[],2,"Stopped after launch");
  assert.equal(h.children.length,1);assert.equal(h.api.cancel(),true);
  await assert.rejects(first,/Stopped after launch/);assert.equal(h.children[0].kills,1);assert.equal(h.api.state().active,false);
  const next=h.api.start(event,[],2,"New job");h.children[1].emit("close",0);await next;
  assert.equal(h.api.state().preparing,false);
});

test("actual preview/export request epochs stop a cancelled audio-to-mask handoff",async()=>{
  for(const kind of ["preview","render"] as const){
    const hold=gate(),h=harness({audioGate:hold}),job=h.api[kind](event,selections,options);
    await hold.started;h.api.cancel();hold.release();
    await assert.rejects(job,kind==="preview"?/Preview stopped/:/Export stopped/);
    assert.equal(h.calls.masks,0,`${kind} started masks after cancellation`);assert.equal(h.children.length,0);assert.equal(h.calls.commits,0);
  }
});

test("actual preview/export pass the original epoch across mask-to-render awaits",async()=>{
  for(const kind of ["preview","render"] as const){
    const hold=gate(),h=harness({overlayGate:hold}),job=h.api[kind](event,selections,options);
    await hold.started;assert.equal(h.calls.masks,1);h.api.cancel();hold.release();
    await assert.rejects(job,kind==="preview"?/Preview stopped/:/Export stopped/);
    assert.equal(h.children.length,0,`${kind} launched a render with the new epoch instead of the cancelled request epoch`);
    assert.equal(h.calls.commits,0);assert.equal(h.api.state().preparing,false);
  }
});

test("failed graph preparation clears the preparing latch",async()=>{
  const h=harness({graphError:true});await assert.rejects(h.api.start(event,[],2,"Stopped"),/graph-write failure/);
  assert.equal(h.children.length,0);assert.equal(h.api.state().preparing,false);
});

test("quitting invalidates a graph that has not launched its child",async()=>{
  const hold=gate(),h=harness({graphGate:hold}),job=h.api.start(event,[],2,"Stopped while closing");
  await hold.started;let prevented=false;h.api.quit({preventDefault:()=>{prevented=true;}});hold.release();
  await assert.rejects(job,/Stopped while closing/);assert.equal(h.children.length,0);assert.equal(h.api.state().preparing,false);assert.equal(prevented,true);
});
