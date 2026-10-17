'use strict';
const $ = id => document.getElementById(id);
let state=null, draft=[], draftRevision=-1, dirty=false, running=false, uploading=false;
let prepared=null, cancelled=false, chunkController=null, editing=null, expiryAt=0;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const labels={completePlayback:'Every moment plays to the end',soundInSync:'Picture and sound stay in sync',savedToPhotos:'Saved to Photos',photosSound:'Replays in Photos with sound',capturesNight:'It captures the night',wouldShare:'I would share this'};
function error(e){const text=e.message||String(e);$('error').textContent=text;$('error').hidden=false;}
function clearError(){$('error').textContent='';$('error').hidden=true;}
function text(tag,value,className){const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;return el;}
function button(label,fn,className=''){const b=text('button',label,className);b.type='button';b.onclick=fn;return b;}
function timecode(value){return `${Math.floor(value/60)}:${(value%60).toFixed(1).padStart(4,'0')}`;}
async function decode(response){
 if(!response.headers.get('content-type')?.includes('application/json'))throw Error('GitHub login expired. Reopen the private forwarded link. Never make the port public.');
 const data=await response.json();if(!response.ok)throw Error(data.error||'The request did not complete.');return data;
}
async function request(path,body={}){
 return decode(await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Compass-CSRF':state.csrf},body:JSON.stringify(body)}));
}
async function refresh(){
 const next=await decode(await fetch('/api/state',{credentials:'same-origin',cache:'no-store'}));
 if(state&&state.csrf!==next.csrf){draft=[];dirty=false;draftRevision=-1;prepared=null;error(Error('This session expired. Deleted media cannot be restored; choose clips for a new test.'));}
 state=next;expiryAt=Date.now()+next.expiresIn*1000;
 if(next.directed&&next.revision!==draftRevision){
  if(dirty&&!running)throw Error('A newer edit was saved in another tab. Reload this page before making changes.');
  draft=structuredClone(next.directed.plan.moments);draftRevision=next.revision;dirty=false;renderMoments();
 }
 if(!next.directed){draft=[];draftRevision=-1;$('moments').replaceChildren();}
 show();return next;
}
function show(){
 if(!state)return;
 const busy=state.busy||running||uploading;
 $('work').hidden=!busy;$('status').textContent=state.status;$('progress').value=state.progress;
 $('files').disabled=busy||state.ready||state.clips.length>=3;
 $('plan').disabled=busy||state.ready||!state.clips.length;$('clear').disabled=busy;
 for(const id of ['prompt','mode','style','length','transitions','cleanup'])$(id).disabled=busy||state.ready;
 document.querySelectorAll('[data-prompt]').forEach(b=>b.disabled=busy);
 $('controls').hidden=state.ready;$('review').hidden=state.ready||!state.directed;$('result').hidden=!state.ready;
 $('step1').classList.toggle('active',!state.directed&&!state.ready);
 $('step2').classList.toggle('active',!!state.directed&&!state.ready);$('step3').classList.toggle('active',state.ready);
 $('render').disabled=busy||!$('reviewed').checked||!draft.some(m=>m.approved);
 $('save').disabled=busy||!dirty;$('feedbackSave').disabled=busy;
 $('saveState').textContent=dirty?'Unsaved changes. Save or render to keep them.':'Edits saved in this session.';
 $('moments').querySelectorAll('button').forEach(b=>b.disabled=busy);
 if(!state.ready)$('clips').replaceChildren(...state.clips.map(c=>{
  const el=document.createElement('div');el.className='source';const img=document.createElement('img');img.alt='';img.src=`/api/poster/${c.id}`;
  const info=document.createElement('div');info.append(text('b',c.name),text('small',`${c.duration.toFixed(1)}s / ${c.hasAudio?'original sound':'silent source'} / ready`));el.append(img,info);return el;
 }));
 if(state.directed&&!state.ready){
  const d=state.directed;$('summary').textContent=`${draft.filter(m=>m.approved).length} moments / ${d.seconds.toFixed(1)} seconds saved`;
  const omitted=d.coverage?.omitted||[];$('coverage').textContent=omitted.length?`Not in the saved edit: ${omitted.join(', ')}. Replace a moment to include that source.`:`All ${state.clips.length} source clips are represented in the saved edit.`;
  $('coverage').classList.toggle('warning',!!omitted.length);
  $('explanation').textContent=[d.plan.director,...d.plan.warnings].join('\n\n');
 }
 if(state.ready){
  if(!$('reel').getAttribute('src'))$('reel').src='/api/reel';
  $('reelTime').textContent=`${state.receipt.seconds.toFixed(1)}s`;
  $('receipt').textContent=`${state.receipt.moments} moments rendered. Complete-file decoding passed. Uploaded source copies deleted. Phone playback and saving still need your test.`;
  for(const k of Object.keys(labels))if(typeof state.feedback[k]==='boolean')$('fb-'+k).value=String(state.feedback[k]);
 }
 if(state.error)error(Error(state.error));
}
function renderMoments(){
 $('moments').replaceChildren();$('story').replaceChildren();
 draft.forEach((m,index)=>{
  const clip=state.clips.find(c=>c.id===m.clipID),el=document.createElement('article');el.className='moment'+(m.approved?'':' off');el.dataset.id=m.id;
  const top=document.createElement('div');top.className='row';top.append(text('span',m.role.toUpperCase(),'role'),text('span',m.locked?'LOCKED':m.approved?'IN YOUR REEL':'REJECTED','state'));
  const body=document.createElement('div');body.className='body';const image=document.createElement('img');image.src=`/api/poster/${m.clipID}`;image.alt='';image.loading='lazy';
  const desc=document.createElement('div');desc.className='description';desc.append(text('h3',clip.name),text('p',`${timecode(m.start)} to ${timecode(m.start+m.duration)} / ${m.duration.toFixed(1)}s`),button('Watch / trim / frame',()=>openEditor(m.id),'edit'));
  body.append(image,desc);const actions=document.createElement('div');actions.className='actions';
  actions.append(button(m.locked?'Unlock':'Lock',()=>{m.locked=!m.locked;changed();renderMoments();}),button(m.approved?'Reject':'Restore',()=>{m.approved=!m.approved;changed();renderMoments();}));
  const up=button('Earlier',()=>move(index,-1));up.setAttribute('aria-label',`Move moment ${index+1} earlier`);
  const down=button('Later',()=>move(index,1));down.setAttribute('aria-label',`Move moment ${index+1} later`);actions.append(up,down);
  el.append(top,body,text('p',m.reason,'reason'),actions);$('moments').append(el);
  if(m.approved)$('story').append(text('span',m.role.toUpperCase()));
 });
}
function changed(){dirty=true;$('reviewed').checked=false;show();}
function move(i,d){const j=i+d;if(j<0||j>=draft.length)return;[draft[i],draft[j]]=[draft[j],draft[i]];changed();renderMoments();}
function editorValues(){
 const m=structuredClone(editing);m.clipID=$('editSource').value;m.start=Number($('editStart').value);m.duration=Number($('editDuration').value);
 m.focusX=Number($('focusX').value);m.focusY=Number($('focusY').value);m.muted=$('editMute').checked;m.locked=$('editLock').checked;return m;
}
function updateFrame(){
 $('clipPlayer').muted=$('editMute').checked;
 const m=editorValues();$('clipPlayer').style.objectPosition=`${m.focusX*100}% ${m.focusY*100}%`;
 for(const id of ['editSource','editStart','editDuration','focusX','focusY'])$(id).disabled=$('editLock').checked;
}
function openEditor(id){
 editing=structuredClone(draft.find(m=>m.id===id));$('editorError').textContent='';
 $('editSource').replaceChildren(...state.clips.map(c=>{const o=text('option',c.name);o.value=c.id;return o;}));
 $('editSource').value=editing.clipID;$('editStart').value=editing.start.toFixed(3);$('editDuration').value=editing.duration.toFixed(3);
 $('focusX').value=editing.focusX;$('focusY').value=editing.focusY;$('editMute').checked=editing.muted;$('editLock').checked=editing.locked;
 $('clipPlayer').src=`/api/clip/${editing.clipID}`;$('clipPlayer').onloadedmetadata=()=>{$('clipPlayer').currentTime=Math.min(Number($('editStart').value),$('clipPlayer').duration);};
 updateFrame();$('editor').showModal();
}
$('editSource').onchange=()=>{const c=state.clips.find(c=>c.id===$('editSource').value);$('editStart').value=0;$('editDuration').value=Math.min(Number($('editDuration').value),c.duration).toFixed(3);$('clipPlayer').src=`/api/clip/${c.id}`;};
for(const id of ['focusX','focusY','editLock'])$(id).oninput=updateFrame;
$('editMute').onchange=()=>{$('clipPlayer').muted=$('editMute').checked;};
$('editStart').onchange=()=>{const t=Number($('editStart').value);if(Number.isFinite(t))$('clipPlayer').currentTime=Math.max(0,t);};
$('clipPlayer').ontimeupdate=()=>{if(!editing)return;const a=Number($('editStart').value),b=a+Number($('editDuration').value);if($('clipPlayer').currentTime>b+.05){$('clipPlayer').pause();$('clipPlayer').currentTime=a;}};
$('editor').onclose=()=>{$('clipPlayer').pause();$('clipPlayer').removeAttribute('src');$('clipPlayer').load();editing=null;};
$('keepMoment').onclick=()=>{
 const m=editorValues(),clip=state.clips.find(c=>c.id===m.clipID);
 if(!clip||![m.start,m.duration,m.focusX,m.focusY].every(Number.isFinite)||m.start<0||m.duration<.1||m.start+m.duration>clip.duration+.002){$('editorError').textContent='Keep the trim inside this clip, with a length of at least 0.1 seconds.';return;}
 draft[draft.findIndex(x=>x.id===m.id)]=m;changed();renderMoments();$('editor').close();
};
async function wait(){while((await refresh()).busy)await sleep(850);if(state.error)throw Error(state.error);}
async function operate(fn){if(running)return;running=true;cancelled=false;clearError();show();try{await fn();}catch(e){error(e);}finally{running=false;uploading=false;show();}}
async function sendChunk(id,offset,blob){
 chunkController=new AbortController();const timer=setTimeout(()=>chunkController?.abort(),45000);
 try{return await decode(await fetch(`/api/upload-chunk/${id}`,{method:'PUT',credentials:'same-origin',headers:{'X-Compass-CSRF':state.csrf,'X-Upload-Offset':String(offset)},body:blob,signal:chunkController.signal}));}
 finally{clearTimeout(timer);chunkController=null;}
}
async function upload(file){
 const u=await request('/api/uploads',{size:file.size});let offset=0,failures=0;
 try{
  while(offset<file.size){
   if(cancelled)throw Error('Upload stopped. Completed clips are still here.');
   try{const r=await sendChunk(u.id,offset,file.slice(offset,Math.min(offset+u.chunkBytes,file.size)));offset=r.received;failures=0;}
   catch(e){if(cancelled||++failures>2)throw e;await sleep(800*failures);const s=await refresh();if(!s.upload||s.upload.id!==u.id)throw e;offset=s.upload.received;}
   $('status').textContent=`Uploading ${Math.round(offset/file.size*100)}% in retryable pieces`;$('progress').value=offset/file.size;
  }
  if(cancelled)throw Error('Upload stopped.');
  await request('/api/uploads/finish',{id:u.id});await wait();
 }catch(e){try{await request('/api/cancel');}catch{}throw e;}
}
$('files').onchange=()=>operate(async()=>{
 const files=[...$('files').files];$('files').value='';
 if(files.length+state.clips.length>3)throw Error('Choose up to three clips for this test.');
 if(files.some(f=>f.size>160*1024*1024||f.size===0))throw Error('Each clip must be nonempty and smaller than 160 MB.');
 uploading=true;show();for(const f of files){if(cancelled)break;await upload(f);}await refresh();
});
$('plan').onclick=()=>operate(async()=>{
 await request('/api/plan',{revision:state.revision,mode:$('mode').value,style:$('style').value,targetSeconds:Number($('length').value),transitions:$('transitions').value,gentleCleanup:$('cleanup').checked,prompt:$('prompt').value,previousMoments:state.directed?draft:null});
 await wait();$('reviewed').checked=false;$('review').scrollIntoView({block:'start'});
});
$('save').onclick=()=>operate(async()=>{await request('/api/review',{revision:state.revision,moments:draft});await wait();});
$('reviewed').onchange=show;
$('render').onclick=()=>operate(async()=>{await request('/api/render',{revision:state.revision,reviewed:$('reviewed').checked,moments:draft});await wait();$('result').scrollIntoView({block:'start'});});
$('cancel').onclick=async()=>{cancelled=true;chunkController?.abort();try{await request('/api/cancel');await wait();}catch(e){error(e);}};
$('clear').onclick=()=>{if(!confirm('Delete test copies and the finished reel? Your original Photos videos are unchanged.'))return;operate(async()=>{await request('/api/clear');prepared=null;draftRevision=-1;dirty=false;$('reel').pause();$('reel').removeAttribute('src');$('reel').load();$('share').textContent='Prepare iPhone share';await refresh();});};
for(const b of document.querySelectorAll('[data-prompt]'))b.onclick=()=>{$('prompt').value=b.dataset.prompt;};
$('share').onclick=async()=>{
 try{
  if(!prepared){$('share').disabled=true;const r=await fetch('/api/reel',{credentials:'same-origin'});if(!r.ok||!r.headers.get('content-type')?.startsWith('video/mp4'))throw Error('The reel is unavailable, or private-link login expired.');
   if(Number(r.headers.get('content-length'))>160*1024**2)throw Error('Use Download MP4 for this large reel.');
   prepared=new File([await r.blob()],'Concert-Compass-Test.mp4',{type:'video/mp4'});$('share').textContent='Share video / Save Video';$('shareNote').textContent='Ready. Tap again to open the share sheet. Choose Save Video if available.';return;
  }
  // The second user tap preserves Safari activation instead of awaiting a fetch.
  if(navigator.canShare?.({files:[prepared]}))await navigator.share({files:[prepared],title:'Concert Compass'});
  else $('shareNote').textContent='File sharing is not available in this browser. Use Download MP4 and the browser share menu.';
 }catch(e){if(e.name!=='AbortError')error(e);}finally{$('share').disabled=false;}
};
for(const [key,label] of Object.entries(labels)){
 const row=document.createElement('div');row.className='feedback-row';const l=text('label',label);l.htmlFor='fb-'+key;
 const s=document.createElement('select');s.id='fb-'+key;for(const [v,t] of [['','Not tested'],['true','Yes'],['false','No']]){const o=text('option',t);o.value=v;s.append(o);}row.append(l,s);$('feedbackFields').append(row);
}
$('feedbackSave').onclick=()=>operate(async()=>{const values={};for(const key of Object.keys(labels)){const v=$('fb-'+key).value;if(v!=='')values[key]=v==='true';}await request('/api/feedback',values);await refresh();$('feedbackStatus').textContent='Your answers are saved in this session. Save the receipt before deleting the test.';});
setInterval(()=>{if(expiryAt)$('expiry').textContent=`Session expires in ${Math.max(0,Math.ceil((expiryAt-Date.now())/60000))} min while running`;},15000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!running)refresh().catch(error);});
refresh().then(()=>{if(state.busy&&!state.upload)operate(wait);}).catch(error);
