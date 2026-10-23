'use strict';
const $ = id => document.getElementById(id);
let state=null, draft=[], draftRevision=-1, dirty=false, staleDraft=false, running=false, uploading=false;
let prepared=null, cancelled=false, chunkController=null, editing=null, expiryAt=0, generatedPromptTarget=null;
const explicitSettings=new Set();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const labels={completePlayback:'Every moment plays to the end',soundInSync:'Picture and sound stay in sync',savedToPhotos:'Saved to Photos',photosSound:'Replays in Photos with sound',capturesNight:'It captures the night',wouldShare:'I would share this'};
function error(e){const text=e.message||String(e);$('error').textContent=text;$('error').hidden=false;}
function clearError(){$('error').textContent='';$('error').hidden=true;}
function discardPreparedMedia(){
 prepared=null;
 const reel=$('reel');reel.pause();reel.removeAttribute('src');reel.load();
 $('share').textContent='Prepare iPhone share';
}
function text(tag,value,className){const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;return el;}
function button(label,fn,className=''){const b=text('button',label,className);b.type='button';b.onclick=fn;return b;}
function timecode(value){return `${Math.floor(value/60)}:${(value%60).toFixed(1).padStart(4,'0')}`;}
function durationLabel(seconds){
 if(seconds===300)return '5 min compilation';
 if(seconds===180)return '3 min compilation';
 if(seconds===120)return '2 min compilation';
 if(seconds===90)return '90 sec compilation';
 return `${seconds} sec`;
}
function durationTruth(directed){
 const requested=Number(directed?.plan?.settings?.targetSeconds);
 const planned=Number(directed?.seconds);
 if(!Number.isFinite(requested)||!Number.isFinite(planned))return '';
 const target=`Requested ${durationLabel(requested)}`;
 const output=`first cut ${planned.toFixed(1)}s`;
 if(Math.abs(requested-planned)<=.08)return `${target} \u00b7 ${output}. Review the selected moments before rendering.`;
 const gap=planned<requested?'shorter':'longer';
 return `${target} \u00b7 ${output} (${gap} than requested). Nothing is padded, looped, stretched, or invented. To preserve a longer musical section, extend and lock an approved source moment, then save again.`;
}
function savedSettingsLabel(settings){
 const mode=settings.mode==='trailer'?'Trailer':'Highlights';
 const style={cinematic:'Cinematic',hype:'Hype',memory:'Memory',musicVideo:'Music video',surprise:'Surprise me'}[settings.style]||settings.style;
 const transitions={automatic:'Automatic transitions',cuts:'Cuts only',dissolves:'Dissolves'}[settings.transitions]||settings.transitions;
 return `${mode} · ${style} · ${durationLabel(settings.targetSeconds)} · ${transitions}${settings.gentleCleanup?' · gentle cleanup':''}`;
}
function restoreSavedSettings(settings){
 if(!settings)return;
 const values={mode:settings.mode,style:settings.style,length:String(settings.targetSeconds),transitions:settings.transitions,prompt:settings.prompt||''};
 for(const [id,value] of Object.entries(values)){
  const control=$(id);
  if(control&&(id==='prompt'||[...control.options].some(option=>option.value===value)))control.value=value;
 }
 $('cleanup').checked=settings.gentleCleanup===true;
 $('savedSettings').textContent=`Saved edit settings restored: ${savedSettingsLabel(settings)}.`;
}
function wizardPayload(){return {preset:$('preset').value,aspectRatio:$('aspectRatio').value,audioMode:$('audioMode').value,audioClipID:$('audioClipID').value,audioStart:0,vibePrompt:$('prompt').value};}
function restoreWizard(wizard){
 if(!wizard)return;
 if(wizard.preset&&[...$('preset').options].some(o=>o.value===wizard.preset))$('preset').value=wizard.preset;
 if(wizard.aspectRatio)$('aspectRatio').value=wizard.aspectRatio;
 if(wizard.audioMode)$('audioMode').value=wizard.audioMode;
 if(wizard.audioClipID)$('audioClipID').value=wizard.audioClipID;
 if(typeof wizard.vibePrompt==='string')$('prompt').value=wizard.vibePrompt;
}
function renderEditorialProposal(proposal){
 const panel=$('editorialProposal'), summary=$('editorialProposalSummary'), detail=$('editorialProposalDetail');
 if(!proposal){panel.hidden=true;summary.textContent='';detail.textContent='';return;}
 const metrics=proposal.metrics||{}, before=metrics.before||{}, after=metrics.after||{};
 const transitions=(proposal.transitions||[]).map(item=>item.kind==='dissolve'?'short dissolve':'clean cut');
 const transitionSummary=transitions.length?[...new Set(transitions)].join(', '):'no boundary changes';
 summary.textContent=`Review-only suggestion: ${after.adjacentSourceRepeats??0} adjacent repeat${after.adjacentSourceRepeats===1?'':'s'} after ordering (${before.adjacentSourceRepeats??0} before); ${transitionSummary}.`;
 detail.textContent=[...(proposal.notes||[]),...(proposal.conflicts||[])].join('\n\n');
 panel.hidden=false;
}
async function decode(response){
 if(!response.headers.get('content-type')?.includes('application/json'))throw Error('GitHub login expired. Reopen the private forwarded link. Never make the port public.');
 const data=await response.json();if(!response.ok)throw Error(data.error||'The request did not complete.');return data;
}
async function request(path,body={}){
 return decode(await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Compass-CSRF':state.csrf},body:JSON.stringify(body)}));
}
async function refresh(){
 const next=await decode(await fetch('/api/state',{credentials:'same-origin',cache:'no-store'}));
 if(state&&state.csrf!==next.csrf){discardPreparedMedia();draft=[];dirty=false;staleDraft=false;draftRevision=-1;error(Error('This session expired. Deleted media cannot be restored; choose clips for a new test.'));}
 if(state&&next.revision!==draftRevision&&dirty&&!running){
  staleDraft=true;show();
  throw Error('A newer edit was saved in another tab. Your local changes were not submitted. Reload this page before making changes.');
 }
 if(state&&(next.revision!==state.revision||next.ready!==state.ready))discardPreparedMedia();
 state=next;expiryAt=Date.now()+next.expiresIn*1000;
 if(next.directed&&next.revision!==draftRevision){
  if(dirty&&!running)throw Error('A newer edit was saved in another tab. Reload this page before making changes.');
  draft=structuredClone(next.directed.plan.moments);draftRevision=next.revision;dirty=false;restoreSavedSettings(next.directed.plan.settings);restoreWizard(next.directed.wizard);renderMoments();
 }
 if(!next.directed){draft=[];draftRevision=-1;$('moments').replaceChildren();$('savedSettings').textContent='Your saved edit settings will appear here after you make a first cut.';}
 show();return next;
}
function show(){
 if(!state)return;
 const busy=state.busy||running||uploading;
 $('work').hidden=!busy;$('status').textContent=state.status;$('progress').value=state.progress;
 const clipLimit=state.limits?.clips||3;
 $('files').disabled=busy||state.ready||state.clips.length>=clipLimit;
 $('plan').disabled=busy||staleDraft||state.ready||!state.clips.length;$('clear').disabled=busy;
 for(const id of ['preset','aspectRatio','audioMode','audioClipID','prompt','mode','style','length','transitions','cleanup'])$(id).disabled=busy||state.ready;
 document.querySelectorAll('[data-prompt]').forEach(b=>b.disabled=busy);
 $('controls').hidden=state.ready;$('review').hidden=state.ready||!state.directed;$('result').hidden=!state.ready;
 $('step1').classList.toggle('active',!state.directed&&!state.ready);
 $('step2').classList.toggle('active',!!state.directed&&!state.ready);$('step3').classList.toggle('active',state.ready);
 $('render').disabled=busy||staleDraft||!$('reviewed').checked||!draft.some(m=>m.approved);
 $('save').disabled=busy||staleDraft||!dirty;$('feedbackSave').disabled=busy;
 $('adjust').disabled=busy||staleDraft;
 $('adjustment').disabled=busy||staleDraft;
 $('saveState').textContent=dirty?'Unsaved changes. Save or render to keep them.':'Edits saved in this session.';
 $('moments').querySelectorAll('button').forEach(b=>b.disabled=busy);
 if(!state.ready)$('clips').replaceChildren(...state.clips.map(c=>{
  const el=document.createElement('div');el.className='source';const img=document.createElement('img');img.alt='';img.src=`/api/poster/${c.id}`;
  const info=document.createElement('div');info.append(text('b',c.name),text('small',`${c.duration.toFixed(1)}s / ${c.hasAudio?'original sound':'silent source'} / ready`));el.append(img,info);return el;
 }));
 const audible=state.clips.filter(c=>c.hasAudio);$('audioClipID').replaceChildren(...audible.map(c=>{const o=text('option',c.name);o.value=c.id;return o;}));
 $('audioClipWrap').hidden=$('audioMode').value!=='single-source';
 if(state.directed&&!state.ready){
  const d=state.directed;$('summary').textContent=`${draft.filter(m=>m.approved).length} moments / ${d.seconds.toFixed(1)} seconds saved`;
  $('durationTruth').textContent=durationTruth(d);
  $('durationTruth').classList.toggle('warning',Math.abs(Number(d.plan.settings.targetSeconds)-Number(d.seconds))>.08);
  if(!$('savedSettings').textContent.startsWith('Saved edit settings restored:'))restoreSavedSettings(d.plan.settings);
  restoreWizard(d.wizard);
  renderEditorialProposal(d.editorialProposal);
  const omitted=d.coverage?.omitted||[];$('coverage').textContent=omitted.length?`Not in the saved edit: ${omitted.join(', ')}. Replace a moment to include that source.`:`All ${state.clips.length} source clips are represented in the saved edit.`;
  $('coverage').classList.toggle('warning',!!omitted.length);
  $('explanation').textContent=[d.plan.director,...d.plan.warnings].join('\n\n');
 }
 else {renderEditorialProposal(null);$('durationTruth').textContent='';$('durationTruth').classList.remove('warning');}
 if(state.ready){
  if(!$('reel').getAttribute('src'))$('reel').src='/api/reel';
  $('reelDimensions').textContent=`${state.receipt.width} x ${state.receipt.height}`;
  $('reelTime').textContent=durationLabel(Math.round(state.receipt.seconds));
  $('receipt').textContent=`${state.receipt.moments} moments rendered in the ${state.receipt.profile}. Complete-file decoding passed. Uploaded source copies deleted. Download it, put it in iCloud Drive, then test playback on your phone.`;
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
async function operate(fn){if(staleDraft){error(Error('Reload this page before changing a conflicting edit.'));return;}if(running)return;running=true;cancelled=false;clearError();show();try{await fn();}catch(e){error(e);}finally{running=false;uploading=false;show();}}
function submittedRevision(){if(staleDraft)throw Error('Reload this page before submitting a conflicting edit.');return draftRevision>=0?draftRevision:state.revision;}
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
 const maxClips=state.limits?.clips||3;
 if(files.length+state.clips.length>maxClips)throw Error(`Choose up to ${maxClips} clips for this test.`);
 const maxBytes=state.limits?.bytesPerClip||750*1024*1024;
 if(files.some(f=>f.size>maxBytes||f.size===0))throw Error(`Each clip must be nonempty and smaller than ${Math.floor(maxBytes/1024/1024)} MB.`);
 // Commit local trims before analysis advances the project revision. A stale
 // revision fails here, before any upload can replace this local draft.
 if(dirty){await request('/api/review',{revision:submittedRevision(),moments:draft});await wait();}
 uploading=true;show();for(const f of files){if(cancelled)break;await upload(f);}await refresh();
});
$('plan').onclick=()=>operate(async()=>{
 const targetSeconds=Number($('length').value);
 const compilationApproved=targetSeconds<=60||confirm(`This ${durationLabel(targetSeconds)} stays vertical at 720 × 1280 and can take longer to render. Keep this private page open, then download the MP4 to iCloud Drive. Continue?`);
 if(!compilationApproved)return;
 await request('/api/plan',{revision:submittedRevision(),mode:$('mode').value,style:$('style').value,targetSeconds,transitions:$('transitions').value,gentleCleanup:$('cleanup').checked,prompt:$('prompt').value,wizard:wizardPayload(),explicitSettings:[...explicitSettings],compilationApproved,previousMoments:state.directed?draft:null});
 await wait();$('reviewed').checked=false;$('review').scrollIntoView({block:'start'});
});
$('save').onclick=()=>operate(async()=>{await request('/api/review',{revision:submittedRevision(),moments:draft});await wait();});
$('reviewed').onchange=show;
$('render').onclick=()=>operate(async()=>{await request('/api/render',{revision:submittedRevision(),reviewed:$('reviewed').checked,moments:draft});await wait();$('result').scrollIntoView({block:'start'});});
$('cancel').onclick=async()=>{cancelled=true;chunkController?.abort();try{await request('/api/cancel');await wait();}catch(e){error(e);}};
$('clear').onclick=()=>{if(!confirm('Delete test copies and the finished reel? Your original Photos videos are unchanged.'))return;operate(async()=>{await request('/api/clear');prepared=null;draftRevision=-1;dirty=false;staleDraft=false;$('reel').pause();$('reel').removeAttribute('src');$('reel').load();$('share').textContent='Prepare iPhone share';await refresh();});};
for(const b of document.querySelectorAll('[data-prompt]'))b.onclick=()=>{
 $('prompt').value=b.dataset.prompt;
 generatedPromptTarget=Number(b.dataset.target)||null;
 if(b.dataset.target)$('length').value=b.dataset.target;
 if(b.dataset.target)explicitSettings.add('targetSeconds');
};
$('prompt').oninput=()=>{generatedPromptTarget=null;};
const parameterControls={mode:'mode',style:'style',length:'targetSeconds',transitions:'transitions',cleanup:'gentleCleanup'};
for(const [id,key] of Object.entries(parameterControls))if(typeof $(id).addEventListener==='function')$(id).addEventListener('change',()=>explicitSettings.add(key));
$('preset').onchange=()=>{
 const p=$('preset').value;
 const presets={cinematic:{style:'cinematic',transitions:'dissolves'},'high-energy':{style:'hype',transitions:'cuts'},memory:{style:'memory',transitions:'dissolves'}};
 if(presets[p])Object.entries(presets[p]).forEach(([id,value])=>{$(id).value=value;explicitSettings.add(parameterControls[id]);});
};
$('audioMode').onchange=()=>{ $('audioClipWrap').hidden=$('audioMode').value!=='single-source'; };
$('length').onchange=()=>{
 if(!generatedPromptTarget)return;
 const seconds=Number($('length').value);
 const label=`${seconds} seconds`;
 $('prompt').value=$('prompt').value.replace(/^\s*(?:\d+\s*(?:seconds?|secs?|minutes?|mins?)|\d+\s*min)\s*,?\s*/i,`${label}, `);
 generatedPromptTarget=seconds;
};
$('adjust').onclick=()=>operate(async()=>{
 const editRequest=$('adjustment').value.trim();
 if(!editRequest)throw Error('Describe an adjustment, or render this reviewed first cut.');
 const targetSeconds=Number(state.directed.plan.settings.targetSeconds);
 const compilationApproved=targetSeconds<=60||confirm(`This ${durationLabel(targetSeconds)} stays vertical at 720 × 1280. Continue?`);
 if(!compilationApproved)return;
 await request('/api/plan',{revision:submittedRevision(),editRequest,wizard:wizardPayload(),compilationApproved,previousMoments:draft});
 await wait();$('adjustment').value='';$('reviewed').checked=false;$('review').scrollIntoView({block:'start'});
});
$('share').onclick=async()=>{
 try{
  if(!prepared){const shareSession=state.csrf,shareRevision=state.revision;$('share').disabled=true;const r=await fetch('/api/reel',{credentials:'same-origin'});if(!r.ok||!r.headers.get('content-type')?.startsWith('video/mp4'))throw Error('The reel is unavailable, or private-link login expired.');
   if(Number(r.headers.get('content-length'))>160*1024**2)throw Error('Use Download MP4 for this large reel.');
   const blob=await r.blob();
   if(!state.ready||state.csrf!==shareSession||state.revision!==shareRevision)throw Error('The reel changed while preparing. Prepare the current reel again.');
   prepared=new File([blob],'Concert-Compass-Test.mp4',{type:'video/mp4'});$('share').textContent='Share video / Save Video';$('shareNote').textContent='Ready. Tap again to open the share sheet. Choose Save Video if available.';return;
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
