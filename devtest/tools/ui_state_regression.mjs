/* Actual shipped handlers in a minimal DOM. No Swift, browser or OS share claims. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// Model actual select semantics: assigning a missing option clears the value.
// Read defaults/options from the shipped HTML so fresh-page tests start honestly.
const markup=readFileSync(new URL('../static/index.html',import.meta.url),'utf8');
const controls=new Map();
for(const match of markup.matchAll(/<(select|textarea)\b([^>]*\bid="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g)){
 const [,tag,attrs,id,body]=match;
 controls.set(id,{tag,value:attrs.match(/\bvalue="([^"]*)"/)?.[1]||'',options:[...body.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map(m=>m[1])});
}
for(const match of markup.matchAll(/<input\b([^>]*\bid="([^"]+)"[^>]*)>/g))controls.set(match[2],{tag:'input',value:match[1].match(/\bvalue="([^"]*)"/)?.[1]||'',options:[]});
class Element {
 constructor(id='',tag='div'){this.id=id;this.tag=tag;this.options=[];this.listeners={};this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.style={};this.attrs={};this.classList={toggle(){},remove(){}};this.dataset={};}
 set value(value){const next=String(value);this._value=this.tag==='select'&&!this.options.some(o=>o.value===next)?'':next;} get value(){return this._value;}
 append(...nodes){if(this.tag==='select'){this.options.push(...nodes);if(!this.value)this.value=this.options[0]?.value||'';}}
 replaceChildren(...nodes){if(this.tag==='select'){this.options=nodes;this.value=nodes[0]?.value||'';}}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);} dispatch(type){this['on'+type]?.();for(const fn of this.listeners[type]||[])fn();}
 querySelectorAll(){return [];} setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} removeAttribute(k){delete this.attrs[k];} pause(){} load(){this.loadCount=(this.loadCount||0)+1;} scrollIntoView(){} showModal(){this.open=true;} close(){this.open=false;this.onclose?.();}
}
const elements=new Map(),chip=new Element();chip.dataset={prompt:'15 seconds, cinematic, soft transitions',target:'15'};
const document={getElementById(id){if(!elements.has(id)){const def=controls.get(id),el=new Element(id,def?.tag);if(def){el.options=def.options.map(value=>({value}));el.value=def.tag==='select'?def.options[0]||'':def.value;}elements.set(id,el);}return elements.get(id);},querySelectorAll(){return [chip];},createElement(tag){return new Element('',tag);},addEventListener(){}};
let next,fetcher=async()=>({headers:{get:key=>key==='content-type'?'application/json':null},ok:true,json:async()=>next});
let source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
source=source.replace(/refresh\(\)\.then\(\(\)=>\{if\(state\.busy&&!state\.upload\)operate\(wait\);\}\)\.catch\(error\);\s*$/, '');
source+='\nglobalThis.__ui={refresh,wait,show,pendingSettings,submittedRevision,changed,get:()=>({state,draft,draftRevision,dirty,staleDraft,prepared,observationStopped}),set:(v)=>{state=v.state;draft=v.draft||[];draftRevision=v.draftRevision??v.state?.revision??-1;dirty=!!v.dirty;staleDraft=false;prepared=v.prepared||null;running=false;observationStopped=!!v.observationStopped;if(state){refreshAudioOptions(state,true);if(state.directed){restoreSavedSettings(state.directed.plan.settings);restoreWizard(state.directed.wizard);}}},override:(r,w,u)=>{request=r;wait=w;upload=u;}};';
const context={document,console,fetch:(...a)=>fetcher(...a),setInterval:()=>0,setTimeout,clearTimeout,AbortController,structuredClone,File:class {constructor(parts){this.parts=parts;}},Error,Number,Math,Object,Array,JSON};
vm.runInNewContext(source,context,{filename:'app.js'});
const ui=context.__ui,$=document.getElementById,checks=[];
const settings={targetSeconds:30,mode:'highlight',style:'memory',transitions:'cuts',prompt:''};
const old={csrf:'same',revision:7,ready:false,expiresIn:3600,busy:false,clips:[],limits:{clips:3},directed:{plan:{moments:[],settings,warnings:[],director:''},seconds:30}};
ui.set({state:old,draft:[{id:'local',duration:30}],dirty:true});
next={...old,revision:8,directed:{...old.directed,seconds:45}};
await assert.rejects(ui.refresh(),/newer edit was saved/);
assert.equal(ui.get().state.revision,7);assert.equal(ui.get().draftRevision,7);assert.equal(ui.get().draft[0].duration,30);assert.equal(ui.get().staleDraft,true);
assert.throws(()=>ui.submittedRevision(),/Reload/);
for(const id of ['save','render','plan'])assert.equal($(id).disabled,true);
checks.push('conflict retains base revision and draft; immediately blocks submissions');
let submissions=0;ui.override(async()=>{submissions++;},async()=>{},async()=>{});
await $('save').onclick();assert.equal(submissions,0);checks.push('conflict cannot bypass through operation handler');
ui.set({state:old,draft:[{id:'local'}],dirty:true});next={...old,revision:8,directed:null};
await assert.rejects(ui.refresh(),/newer edit/);assert.equal(ui.get().draft[0].id,'local');checks.push('other-tab clear preserves dirty draft for conflict resolution');
const rendered={...old,revision:9,ready:true,directed:null,feedback:{},receipt:{width:720,height:1280,seconds:45,moments:1,profile:'720p compilation'}};
ui.set({state:rendered,prepared:true});next={...rendered,revision:10};await ui.refresh();assert.equal(ui.get().prepared,null);checks.push('new export revision invalidates prepared share');
ui.set({state:rendered,prepared:true});$('reel').setAttribute('src','old');next={...rendered,csrf:'new',ready:false};await ui.refresh();assert.equal(ui.get().prepared,null);assert.equal($('reel').getAttribute('src'),null);checks.push('new session with same revision clears loaded reel');
const wizardOld={preset:'wizard',aspectRatio:'9:16',audioMode:'selected-moment-original',vibePrompt:'old prompt'};
const wizardState={...old,revision:7,previewReady:true,clips:[{id:'A',name:'A',duration:3,hasAudio:true},{id:'B',name:'B',duration:3,hasAudio:true}],directed:{plan:{settings:{...settings,prompt:'old prompt'},moments:[{id:'m',clipID:'A',start:0,duration:3,approved:true,locked:false,muted:false,focusX:.5,focusY:.5,role:'hook'}],warnings:[],director:''},seconds:3,wizard:wizardOld}};
let plannedPayload;ui.set({state:wizardState,draft:wizardState.directed.plan.moments});$('audioMode').value='single-source';$('audioClipID').value='B';$('aspectRatio').value='16:9';$('prompt').value='new prompt';
ui.override(async(path,body)=>{if(path==='/api/plan')plannedPayload=body;},async()=>{},async()=>{});await $('plan').onclick();
assert.equal(plannedPayload.wizard.audioMode,'single-source');assert.equal(plannedPayload.wizard.audioClipID,'B');assert.equal(plannedPayload.wizard.aspectRatio,'16:9');assert.equal(plannedPayload.wizard.vibePrompt,'new prompt');checks.push('plan snapshots visible wizard choices before operation refresh');
let adjustmentPayload;ui.set({state:wizardState,draft:wizardState.directed.plan.moments});$('audioMode').value='single-source';$('audioClipID').value='B';$('aspectRatio').value='16:9';$('prompt').value='new prompt';$('adjustment').value='make it punchier';
ui.override(async(path,body)=>{if(path==='/api/plan')adjustmentPayload=body;},async()=>{},async()=>{});await $('adjust').onclick();
assert.equal(adjustmentPayload.editRequest,'make it punchier');assert.equal(adjustmentPayload.wizard.audioMode,'single-source');assert.equal(adjustmentPayload.wizard.audioClipID,'B');assert.equal(adjustmentPayload.wizard.aspectRatio,'16:9');assert.equal(adjustmentPayload.wizard.vibePrompt,'new prompt');checks.push('adjust snapshots visible wizard choices before operation refresh');
const firstPlanState={...wizardState,revision:6,directed:null};ui.set({state:firstPlanState,draft:[]});$('audioMode').value='single-source';$('audioClipID').value='B';plannedPayload=null;
ui.override(async(path,body)=>{if(path==='/api/plan')plannedPayload=body;},async()=>{},async()=>{});await $('plan').onclick();assert.equal(plannedPayload.wizard.audioClipID,'B');checks.push('first plan keeps the selected continuous audio source');
next=wizardState;await ui.refresh();assert.equal($('preview').src,'/api/preview?revision=7');next={...wizardState,revision:8,previewReady:true};await ui.refresh();assert.equal($('preview').src,'/api/preview?revision=8');checks.push('new preview revision reloads the assembled player');
ui.set({state:wizardState,draft:wizardState.directed.plan.moments});$('audioMode').value='single-source';$('audioClipID').value='B';$('aspectRatio').value='16:9';$('prompt').value='new prompt';next=wizardState;await ui.refresh();assert.equal($('audioMode').value,'single-source');assert.equal($('audioClipID').value,'B');assert.equal($('aspectRatio').value,'16:9');assert.equal($('prompt').value,'new prompt');checks.push('unrelated show preserves explicit wizard choices');
ui.set({state:{...wizardState,csrf:'session-a',revision:20},draft:wizardState.directed.plan.moments});next={...wizardState,csrf:'session-a',revision:20};await ui.refresh();const previewLoads=$('preview').loadCount||0;next={...wizardState,csrf:'session-b',revision:20};await ui.refresh();assert.equal($('preview').src,'/api/preview?revision=20');assert.ok(($('preview').loadCount||0)>previewLoads);checks.push('same-revision session change reloads the preview player');
ui.set({state:{...wizardState,revision:20},draft:wizardState.directed.plan.moments});$('reviewed').checked=true;next={...wizardState,revision:21,previewReady:true};await ui.refresh();assert.equal($('reviewed').checked,false);assert.equal($('render').disabled,true);checks.push('new revision clears export approval until freshly reviewed');
ui.set({state:wizardState,draft:wizardState.directed.plan.moments});$('reviewed').checked=true;ui.changed();assert.equal($('render').disabled,true);checks.push('dirty edits cannot re-enable export before an updated preview');
let clearRequests=0;ui.set({state:old});next=old;ui.override(async path=>{if(path==='/api/clear')clearRequests++;},async()=>{},async()=>{});
$('clear').onclick();assert.equal($('clearConfirm').open,true);assert.equal(clearRequests,0);
$('clearCancel').onclick();assert.equal($('clearConfirm').open,false);assert.equal(clearRequests,0);
$('clear').onclick();const confirmedClear=$('clearConfirmButton').onclick();$('clearConfirmButton').onclick();await confirmedClear;
assert.equal(clearRequests,1);checks.push('in-app clear dialog only deletes on one explicit confirm');
const pendingRefreshes=[];fetcher=()=>new Promise((resolve,reject)=>pendingRefreshes.push({resolve,reject}));
ui.set({state:{...old,previewReady:false},draft:[],dirty:false,observationStopped:true});$('resumeStatus').hidden=false;
const olderSuccess=ui.refresh(), newerSuccess=ui.refresh();assert.equal(pendingRefreshes.length,2);
const currentPreview={...old,csrf:'fresh-session',revision:11,previewReady:true,busy:true,status:'Preparing preview'};
pendingRefreshes[1].resolve({headers:{get:()=> 'application/json'},ok:true,json:async()=>currentPreview});await newerSuccess;
pendingRefreshes[0].resolve({headers:{get:()=> 'application/json'},ok:true,json:async()=>({...old,csrf:'old-session',revision:8,previewReady:false,busy:false})});await olderSuccess;
assert.equal(ui.get().state.csrf,'fresh-session');assert.equal(ui.get().state.revision,11);assert.equal(ui.get().state.previewReady,true);assert.equal(ui.get().observationStopped,false);assert.equal($('resumeStatus').hidden,true);
checks.push('reverse-order stale success cannot roll back a newer session or preview');
const pendingFailure=[];fetcher=()=>new Promise((resolve,reject)=>pendingFailure.push({resolve,reject}));
const olderFailure=ui.refresh(), newerAfterFailure=ui.refresh();assert.equal(pendingFailure.length,2);
const currentObservation={...currentPreview,csrf:'newest-session',revision:12,status:'Rendering preview'};
pendingFailure[1].resolve({headers:{get:()=> 'application/json'},ok:true,json:async()=>currentObservation});await newerAfterFailure;
pendingFailure[0].reject(Error('late offline response'));const discarded=await olderFailure;
assert.equal(discarded.csrf,'newest-session');assert.equal(ui.get().state.csrf,'newest-session');assert.equal(ui.get().state.revision,12);assert.equal(ui.get().state.previewReady,true);assert.equal(ui.get().observationStopped,false);assert.equal($('resumeStatus').hidden,true);
checks.push('reverse-order stale failure cannot stop or replace current observation');
fetcher=async()=>({headers:{get:key=>key==='content-type'?'application/json':null},ok:true,json:async()=>next});
for(const seconds of [15,30,45,60,90,120,180,300]){chip.onclick();$('length').value=String(seconds);$('length').onchange();assert.equal($('prompt').value,`${seconds} seconds, cinematic, soft transitions`);}
checks.push('all eight generated target directives use exact integer seconds');
ui.set({state:old,draft:[{id:'chorus',duration:45}],dirty:true});$('files').files=[{size:1}];const calls=[];
ui.override(async(path,body)=>{calls.push(path);assert.equal(body.revision,7);assert.equal(body.moments[0].duration,45);},async()=>{calls.push('saved');},async()=>{calls.push('upload');});
next=old;await $('files').onchange();assert.deepEqual(calls,['/api/review','saved','upload']);checks.push('dirty draft saved with base revision before upload');
ui.set({state:old,draft:[{id:'chorus'}],dirty:true});$('files').files=[{size:1}];let uploads=0;
ui.override(async()=>{throw Error('revision conflict');},async()=>{},async()=>{uploads++;});await $('files').onchange();assert.equal(uploads,0);assert.equal(ui.get().dirty,true);checks.push('save conflict prevents upload and retains local draft');
ui.set({state:rendered});let finishBlob;fetcher=async()=>({ok:true,headers:{get:k=>k==='content-type'?'video/mp4':'1'},blob:()=>new Promise(r=>{finishBlob=r;})});
const pending=$('share').onclick();await new Promise(r=>setImmediate(r));assert.equal(typeof finishBlob,'function');ui.set({state:{...rendered,revision:10}});finishBlob('old video');await pending;assert.equal(ui.get().prepared,null);checks.push('in-flight old share cannot repopulate cache after export changes');
// UI integrity regressions: fresh hydration, running responses and interrupted previews.
fetcher=async()=>({headers:{get:()=> 'application/json'},ok:true,json:async()=>next});
const saved={...wizardState,directed:{...wizardState.directed,plan:{...wizardState.directed.plan,settings:{...wizardState.directed.plan.settings,gentleCleanup:false}}},clips:wizardState.clips.map(c=>({...c,duration:90}))};
const continuous={...saved,directed:{...saved.directed,wizard:{...wizardOld,audioMode:'single-source',audioClipID:'B',audioStart:8.5}}};
ui.set({state:null});$('audioClipID').replaceChildren();next=continuous;await ui.refresh();
assert.equal($('audioClipID').value,'B');assert.equal($('audioStart').value,'8.5');assert.equal($('audioMode').value,'single-source');assert.equal(ui.pendingSettings(),false);
checks.push('fresh HTMLSelect-style hydration restores saved source B after creating its options');
const audioOptions=$('audioClipID').options;ui.show();assert.equal($('audioClipID').options,audioOptions);
$('audioClipID').value='A';$('aspectRatio').value='16:9';$('prompt').value='unsent';next=continuous;await ui.refresh();
assert.equal($('audioClipID').value,'A');assert.equal($('aspectRatio').value,'16:9');assert.equal($('prompt').value,'unsent');assert.equal(ui.pendingSettings(),true);
checks.push('show never rebuilds audio options; same-identity refresh preserves pending wizard choices');
ui.set({state:{...saved,directed:null},draftRevision:-1});next={...saved,directed:null};$('audioMode').value='single-source';$('audioClipID').value='B';await ui.refresh();assert.equal($('audioClipID').value,'B');
checks.push('same-identity refresh before first plan preserves the chosen continuous source');
ui.set({state:saved,draft:saved.directed.plan.moments});$('adjustment').value='make it 45 seconds';
next={...saved,revision:8,directed:{...saved.directed,plan:{...saved.directed.plan,settings:{...saved.directed.plan.settings,targetSeconds:45,prompt:'make it 45 seconds'}},wizard:{...wizardOld,vibePrompt:'make it 45 seconds'}}};
ui.override(async()=>{},async()=>{await ui.refresh();assert.equal($('length').value,'45');assert.equal($('prompt').value,'make it 45 seconds');assert.equal($('length').disabled,true);},async()=>{});
await $('adjust').onclick();assert.equal($('length').value,'45');assert.equal($('prompt').value,'make it 45 seconds');assert.equal(ui.pendingSettings(),false);assert.equal($('reviewed').checked,false);
checks.push('successful Adjust hydrates 30-to-45 target and prompt while operation is still running');
ui.set({state:saved,draft:structuredClone(saved.directed.plan.moments)});ui.get().draft[0].duration=5;ui.changed();
const failedPreview={...saved,revision:8,previewReady:false,error:'Synthetic preview interruption',directed:{...saved.directed,plan:{...saved.directed.plan,moments:structuredClone(ui.get().draft)}}};
const retryCalls=[];next=failedPreview;ui.override(async(path,body)=>retryCalls.push({path,body}),ui.wait,async()=>{});
await $('save').onclick();assert.equal(ui.get().dirty,false);assert.equal(ui.get().state.previewReady,false);assert.equal($('save').disabled,false);assert.equal($('render').disabled,true);assert.match($('saveState').textContent,/no current preview/);assert.equal(ui.get().state.clips.length,2);
next={...failedPreview,revision:9,previewReady:true,error:''};await $('save').onclick();
assert.equal(retryCalls.length,2);assert.equal(retryCalls[1].path,'/api/review');assert.equal(retryCalls[1].body.revision,8);assert.equal(retryCalls[1].body.preview,true);assert.equal(retryCalls[1].body.moments[0].duration,5);assert.equal(ui.get().state.previewReady,true);assert.equal($('error').hidden,true);assert.equal($('reviewed').checked,false);assert.equal($('save').disabled,true);assert.equal(ui.get().state.clips.length,2);
checks.push('failed Update preview retains sources and clean saved moments, then retries the current revision');
ui.set({state:saved,draft:structuredClone(saved.directed.plan.moments)});next={...saved,revision:8,previewReady:false,clips:[...saved.clips,{id:'C',name:'C',duration:90,hasAudio:true}]};await ui.refresh();
assert.equal(ui.get().dirty,false);assert.equal($('save').disabled,false);assert.equal(ui.get().draft[0].id,saved.directed.plan.moments[0].id);assert.equal($('audioClipID').options.length,3);
const addedCalls=[];ui.override(async(path,body)=>addedCalls.push({path,body}),ui.wait,async()=>{});next={...next,revision:9,previewReady:true};await $('save').onclick();assert.equal(addedCalls[0].path,'/api/review');assert.equal(addedCalls[0].body.revision,8);assert.equal(ui.get().state.clips.length,3);
checks.push('adding a source leaves a clean saved cut eligible for Update preview without replanning');
const pendingCases=[['mode','trailer','change'],['style','cinematic','change'],['length','45','change'],['transitions','dissolves','change'],['cleanup',true,'change'],['prompt','new brief','input'],['preset','memory','change'],['aspectRatio','16:9','change'],['audioMode','single-source','change']];
for(const [id,value,event] of pendingCases){
 ui.set({state:saved,draft:structuredClone(saved.directed.plan.moments)});$('reviewed').checked=true;ui.show();assert.equal($('render').disabled,false,id+' baseline export');
 if(id==='cleanup')$(id).checked=value;else $(id).value=value;$(id).dispatch(event);
 assert.equal(ui.pendingSettings(),true,id+' pending');assert.equal($('render').disabled,true,id+' export blocked');assert.equal($('reviewed').checked,false,id+' approval cleared');assert.equal($('revertSettings').hidden,false);assert.match($('saveState').textContent,/Output settings changed/);
 let calls=0;ui.override(async()=>{calls++;},async()=>{},async()=>{});await $('render').onclick();await $('save').onclick();assert.equal(calls,0,id+' handler guard');
 $('revertSettings').onclick();assert.equal(ui.pendingSettings(),false,id+' reverted');assert.equal($('reviewed').checked,false);assert.equal($('render').disabled,true);
}
checks.push('all nine output-setting controls disclose pending changes, clear approval and guard direct export/save calls');
for(const [id,value,event] of [['audioClipID','A','change'],['audioStart','9','input']]){
 ui.set({state:continuous,draft:structuredClone(continuous.directed.plan.moments)});$('reviewed').checked=true;$(id).value=value;$(id).dispatch(event);assert.equal(ui.pendingSettings(),true);assert.equal($('render').disabled,true);$('revertSettings').onclick();assert.equal($('audioClipID').value,'B');assert.equal($('audioStart').value,'8.5');assert.equal(ui.pendingSettings(),false);
}
checks.push('continuous source and start changes are pending and can restore saved source B');
ui.set({state:saved,draft:structuredClone(saved.directed.plan.moments)});$('audioClipID').value='B';$('audioStart').value='77';assert.equal(ui.pendingSettings(),false);
ui.set({state:continuous,draft:structuredClone(continuous.directed.plan.moments)});$('audioStart').value='8.500';assert.equal(ui.pendingSettings(),false);
checks.push('normalization ignores inactive audio controls and compares equivalent numeric starts equally');
ui.set({state:saved,draft:structuredClone(saved.directed.plan.moments)});$('audioMode').value='single-source';$('audioClipID').value='B';$('audioStart').value='8.5';$('aspectRatio').value='16:9';$('prompt').value='new brief';$('prompt').dispatch('input');
next={...saved,revision:8,directed:{...saved.directed,plan:{...saved.directed.plan,settings:{...saved.directed.plan.settings,prompt:'new brief'}},wizard:{...wizardOld,aspectRatio:'16:9',audioMode:'single-source',audioClipID:'B',audioStart:8.5,vibePrompt:'new brief'}}};
let appliedPayload;ui.override(async(path,body)=>{assert.equal(path,'/api/plan');appliedPayload=body;},ui.wait,async()=>{});await $('plan').onclick();
assert.equal(appliedPayload.wizard.audioClipID,'B');assert.equal(appliedPayload.wizard.aspectRatio,'16:9');assert.equal(appliedPayload.prompt,'new brief');assert.equal(ui.pendingSettings(),false);assert.equal($('render').disabled,true);assert.equal($('reviewed').checked,false);
checks.push('applying pending settings saves the intended wizard and requires fresh review before export');
const exported=[];$('reviewed').checked=true;$('reviewed').dispatch('change');assert.equal($('render').disabled,false);
ui.override(async(path,body)=>exported.push({path,body}),async()=>{},async()=>{});await $('render').onclick();
assert.equal(exported.length,1);const exportedPayload=exported[0].body;assert.equal(exported[0].path,'/api/render');assert.equal(exportedPayload.revision,8);assert.equal(exportedPayload.reviewed,true);
for(const key of ['mode','style','targetSeconds','transitions','gentleCleanup','prompt'])assert.equal(exportedPayload[key],next.directed.plan.settings[key],key+' export payload');
for(const key of ['preset','aspectRatio','audioMode','audioClipID','audioStart','vibePrompt'])assert.equal(exportedPayload.wizard[key],next.directed.wizard[key],key+' wizard payload');
ui.get().draft[0].duration=9;assert.equal(exportedPayload.moments[0].duration,3);
checks.push('export snapshots every intended setting and wizard choice for the server equality gate');

let polls=0;fetcher=async()=>{if(++polls===1)throw Error('temporary network');return {headers:{get:()=> 'application/json'},ok:true,json:async()=>({...old,busy:false})};};ui.set({state:{...old,busy:true}});await ui.wait();assert.equal(polls,2);checks.push('transient poll failure resumes the same job without a submission');
fetcher=(_url,opts)=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));ui.set({state:{...old,busy:true}});await assert.rejects(ui.refresh(),/timed out/);checks.push('hung state fetch reaches the bounded observation deadline');
let failed=0;fetcher=async()=>{if(failed++<4)throw Error('offline');return {headers:{get:()=> 'application/json'},ok:true,json:async()=>({...old,busy:false})};};ui.set({state:{...old,busy:true}});await ui.wait().catch(()=>{});assert.equal($('resumeStatus').hidden,false);await ui.wait();assert.equal(failed,5);checks.push('exhausted observation resumes without a duplicate upload or job request');
for(const c of checks)console.log('PASS',c);console.log(`PASS ${checks.length} UI regression scenarios`);
