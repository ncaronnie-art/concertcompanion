/* Actual shipped handlers in a minimal DOM. No Swift, browser or OS share claims. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Element {
 constructor(){this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.options=[];this.style={};this.attrs={};this.classList={toggle(){},remove(){}};this.dataset={};}
 append(){} replaceChildren(){} querySelectorAll(){return [];} setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} removeAttribute(k){delete this.attrs[k];} pause(){} load(){} scrollIntoView(){} showModal(){} close(){}
}
const elements=new Map(),chip=new Element();chip.dataset={prompt:'15 seconds, cinematic, soft transitions',target:'15'};
const document={getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},querySelectorAll(){return [chip];},createElement(){return new Element();},addEventListener(){}};
let next,fetcher=async()=>({headers:{get:key=>key==='content-type'?'application/json':null},ok:true,json:async()=>next});
let source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
source=source.replace(/refresh\(\)\.then\(\(\)=>\{if\(state\.busy&&!state\.upload\)operate\(wait\);\}\)\.catch\(error\);\s*$/, '');
source+='\nglobalThis.__ui={refresh,wait,submittedRevision,get:()=>({state,draft,draftRevision,dirty,staleDraft,prepared}),set:(v)=>{state=v.state;draft=v.draft||[];draftRevision=v.draftRevision??v.state.revision;dirty=!!v.dirty;staleDraft=false;prepared=v.prepared||null;running=false;},override:(r,w,u)=>{request=r;wait=w;upload=u;}};';
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
for(const seconds of [15,30,45,60,90,120,180,300]){chip.onclick();$('length').value=String(seconds);$('length').onchange();assert.equal($('prompt').value,`${seconds} seconds, cinematic, soft transitions`);}
checks.push('all eight generated target directives use exact integer seconds');
ui.set({state:old,draft:[{id:'chorus',duration:45}],dirty:true});$('files').files=[{size:1}];const calls=[];
ui.override(async(path,body)=>{calls.push(path);assert.equal(body.revision,7);assert.equal(body.moments[0].duration,45);},async()=>{calls.push('saved');},async()=>{calls.push('upload');});
next=old;await $('files').onchange();assert.deepEqual(calls,['/api/review','saved','upload']);checks.push('dirty draft saved with base revision before upload');
ui.set({state:old,draft:[{id:'chorus'}],dirty:true});$('files').files=[{size:1}];let uploads=0;
ui.override(async()=>{throw Error('revision conflict');},async()=>{},async()=>{uploads++;});await $('files').onchange();assert.equal(uploads,0);assert.equal(ui.get().dirty,true);checks.push('save conflict prevents upload and retains local draft');
ui.set({state:rendered});let finishBlob;fetcher=async()=>({ok:true,headers:{get:k=>k==='content-type'?'video/mp4':'1'},blob:()=>new Promise(r=>{finishBlob=r;})});
const pending=$('share').onclick();await new Promise(r=>setImmediate(r));assert.equal(typeof finishBlob,'function');ui.set({state:{...rendered,revision:10}});finishBlob('old video');await pending;assert.equal(ui.get().prepared,null);checks.push('in-flight old share cannot repopulate cache after export changes');
let polls=0;fetcher=async()=>{if(++polls===1)throw Error('temporary network');return {headers:{get:()=> 'application/json'},ok:true,json:async()=>({...old,busy:false})};};ui.set({state:{...old,busy:true}});await ui.wait();assert.equal(polls,2);checks.push('transient poll failure resumes the same job without a submission');
fetcher=(_url,opts)=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));ui.set({state:{...old,busy:true}});await assert.rejects(ui.refresh(),/timed out/);checks.push('hung state fetch reaches the bounded observation deadline');
for(const c of checks)console.log('PASS',c);console.log(`PASS ${checks.length} UI regression scenarios`);
