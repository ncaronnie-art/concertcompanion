'use strict';
const $ = id => document.getElementById(id);
let state=null, draft=[], draftRevision=-1, dirty=false, staleDraft=false, running=false, uploading=false;
let prepared=null, cancelled=false, chunkController=null, editing=null, expiryAt=0, generatedPromptTarget=null, observationStopped=false, refreshSequence=0, clearPending=false, previewIdentity='';
const explicitSettings=new Set();
// File references only: no media bytes, paths or catalog entries go to storage
// or the server until explicit activation. Reload requires reselecting files.
const catalog=[], CATALOG_LIMIT=500, CATALOG_PAGE=25;
let catalogPage=0, catalogMatches=[], localPreviewURL=null;
let splitEditing=null;
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
function catalogActive(entry){return !!state&&!state.ready&&!!entry.binding&&entry.binding.session===state.csrf&&state.clips.some(c=>c.id===entry.binding.id);}
function catalogIncluded(id){return !!state?.directed&&(state.directed.plan.moments.some(m=>m.approved&&m.clipID===id)||(state.directed.wizard?.audioMode==='single-source'&&state.directed.wizard.audioClipID===id));}
function catalogProblem(entry){
 const maxBytes=state?.limits?.bytesPerClip||750*1024**2, maxSeconds=state?.limits?.secondsPerClip||300;
 if(!entry.file.size)return 'Empty file; cannot activate';
 if(entry.file.size>maxBytes)return `Local only: exceeds ${Math.floor(maxBytes/1024**2)} MiB per active source`;
 if(Number.isFinite(entry.duration)&&(entry.duration<.15||entry.duration>maxSeconds+.04))return `Local only: active sources must be 0.15–${maxSeconds} seconds`;
 return '';
}
function catalogSelected(){return catalog.filter(e=>e.selected&&!e.excluded&&!catalogActive(e));}
function checkCatalogActivation(entries){
 if(!state||state.busy||state.ready||staleDraft)throw Error('Finish or clear the current test before activating sources. Local originals are unchanged.');
 if(!entries.length)throw Error('Select local sources to activate first.');
 const limit=state.limits?.clips||3;
 if(state.clips.length+entries.length>limit)throw Error(`At most ${limit} active sources per test, not unlimited-source compilation.`);
 if(entries.some(e=>e.excluded||catalogActive(e)||catalogProblem(e)))throw Error('An excluded, active, empty, oversized or unsupported-duration source cannot be activated.');
 const used=state.clips.length?state.sourceBytes:0;
 if(!Number.isSafeInteger(used)||used<0)throw Error('Refresh to obtain the current active-source byte count before activation.');
 if(used+entries.reduce((n,e)=>n+e.file.size,0)>(state.limits?.projectBytes||2*1024**3))throw Error('Selected sources exceed the 2 GiB active-project budget. Choose fewer or smaller files.');
}
function addCatalogFiles(files, separate=false){
 let added=0, unsupported=0, overflow=0, matched=0;
 if(!separate)catalogMatches=[];
 for(const file of files){
  if(!/\.(mov|mp4|m4v)$/i.test(file.name)){unsupported++;continue;}
  // Metadata is a reselection hint, NEVER proof of equal media. Keep the
  // existing File reference/exclusion and allow explicit separate indexing.
  const key=JSON.stringify([file.name,file.size,file.lastModified,file.webkitRelativePath||'']);
  if(!separate&&catalog.some(e=>e.key===key)){
   matched++;if(catalogMatches.length<CATALOG_LIMIT)catalogMatches.push(file);continue;
  }
  if(catalog.length>=CATALOG_LIMIT){overflow++;continue;}
  catalog.push({file,key,excluded:false,selected:false,binding:null,duration:null});added++;
 }
 $('catalogNotice').textContent=[`${added} local references added; nothing uploaded.`,
  matched?`${matched} metadata matches kept their existing references and exclusions. Equal metadata is not proof of duplicates; add separately if these are different files.`:'',
  unsupported?`${unsupported} unsupported files not indexed. Use MOV, MP4 or M4V; ZIP extraction is not supported.`:'',
  overflow?`${overflow} not indexed: this tab is limited to ${CATALOG_LIMIT} local references.`:''].filter(Boolean).join(' ');
 renderCatalog();
}
function chooseCatalog(){
 if(!state||state.busy||running||uploading||state.ready||staleDraft)return;
 for(const entry of catalog)entry.selected=false;
 let slots=(state.limits?.clips||3)-state.clips.length;
 let bytes=state.clips.length?state.sourceBytes:0;
 if(!Number.isSafeInteger(bytes)){$('catalogNotice').textContent='Refresh before choosing: active-source byte count is unavailable.';renderCatalog();return;}
 for(const entry of catalog){
  if(slots<=0)break;
  if(entry.excluded||catalogActive(entry)||catalogProblem(entry)||bytes+entry.file.size>(state.limits?.projectBytes||2*1024**3))continue;
  entry.selected=true;slots--;bytes+=entry.file.size;
 }
 $('catalogNotice').textContent=`Selected ${catalogSelected().length} eligible files in import order, not by musical quality. No new files analyzed or uploaded. Activate them, then use Make my first cut to auto-generate a preview.`;
 renderCatalog();
}
function closeLocalPreview(){
 const player=$('localPlayer');player.pause();player.removeAttribute('src');player.load();
 if(localPreviewURL){URL.revokeObjectURL(localPreviewURL);localPreviewURL=null;}
}
function watchCatalog(entry){
 closeLocalPreview();localPreviewURL=URL.createObjectURL(entry.file);
 $('localTitle').textContent=entry.file.name;
 $('localPlaybackNote').textContent='Local playback only; not analyzed or included in an edit. Some camera codecs cannot play in this browser.';
 const player=$('localPlayer');
 player.onloadedmetadata=()=>{if(Number.isFinite(player.duration)){entry.duration=player.duration;if(catalogProblem(entry))entry.selected=false;renderCatalog();}};
 player.onerror=()=>{$('localPlaybackNote').textContent='This browser could not play the local file. Activation can create a compatible preview if the source meets the test limits.';};
 player.src=localPreviewURL;$('localPreview').showModal();
}
function renderCatalog(){
 if(!state)return;
 const busy=state.busy||running||uploading, active=state.ready?[]:state.clips;
 const selected=catalogSelected(), limit=state.limits?.clips||3;
 $('catalogSummary').textContent=`${catalog.length} local indexed · ${catalog.filter(e=>e.excluded).length} excluded · ${active.length} analyzed in this test · ${active.filter(c=>catalogIncluded(c.id)).length} included in saved edit. Maximum ${limit} active sources.`;
 $('chooseCatalog').disabled=busy||state.ready||staleDraft||!catalog.length||active.length>=limit;
 $('activateCatalog').disabled=busy||state.ready||staleDraft||!selected.length;
 $('activateCatalog').textContent=`Activate & analyze ${selected.length} selected`;
 $('catalogMatches').hidden=!catalogMatches.length;$('catalogMatches').disabled=busy;
 catalogPage=Math.max(0,Math.min(catalogPage,Math.ceil(catalog.length/CATALOG_PAGE)-1));
 $('catalogPage').textContent=catalog.length?`Page ${catalogPage+1} of ${Math.ceil(catalog.length/CATALOG_PAGE)}`:'No local files indexed';
 $('catalogBack').disabled=catalogPage===0;$('catalogNext').disabled=(catalogPage+1)*CATALOG_PAGE>=catalog.length;
 $('catalogList').replaceChildren(...catalog.slice(catalogPage*CATALOG_PAGE,(catalogPage+1)*CATALOG_PAGE).map(entry=>{
  const row=text('article','','catalog-entry'), isActive=catalogActive(entry), problem=catalogProblem(entry);
  const label=text('label','','check'), select=document.createElement('input');select.type='checkbox';select.checked=entry.selected;
  select.disabled=busy||state.ready||staleDraft||entry.excluded||isActive||!!problem;
  select.setAttribute('aria-label',`Select ${entry.file.name} for activation`);
  select.onchange=()=>{entry.selected=select.checked;renderCatalog();};
  label.append(select,text('b',entry.file.name));
  const status=isActive?`Analyzed · ${catalogIncluded(entry.binding.id)?'included in saved edit':'not included in saved edit'}`:entry.excluded?'Excluded from rotation · local reference kept':'Local indexed · not analyzed in this test';
  const details=`${(entry.file.size/1024**2).toFixed(1)} MiB · ${Number.isFinite(entry.duration)?entry.duration.toFixed(2)+'s':'duration checked on activation'}${problem?' · '+problem:''}`;
  const actions=text('div','','row'), watch=button('Watch locally',()=>watchCatalog(entry),'quiet');watch.disabled=busy;
  const exclude=button(entry.excluded?'Restore to rotation':'Exclude from rotation',()=>{entry.excluded=!entry.excluded;entry.selected=false;renderCatalog();},'quiet');
  exclude.disabled=busy||isActive;exclude.title=isActive?'Active sources remain in this test. Reject moments in review, or clear the test before choosing another set.':'';
  actions.append(watch,exclude);row.append(label,text('small',status),text('small',details),actions);return row;
 }));
}
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
 if(directed.plan.settings.preserveSections)return `${target} · intact sections ${planned.toFixed(1)}s. Ranges and order stay unchanged; no trimming, looping or stretching to fit the target.`;
 const output=`first cut ${planned.toFixed(1)}s`;
 if(Math.abs(requested-planned)<=.08)return `${target} \u00b7 ${output}. Review the selected moments before rendering.`;
 const gap=planned<requested?'shorter':'longer';
 return `${target} \u00b7 ${output} (${gap} than requested). Nothing is padded, looped, stretched, or invented. To preserve a longer musical section, extend and lock an approved source moment, then save again.`;
}
function savedSettingsLabel(settings){
 const mode=settings.preserveSections?'Intact sections':settings.mode==='trailer'?'Trailer':'Highlight montage';
 const style={cinematic:'Cinematic',hype:'Hype',memory:'Memory',musicVideo:'Music video',surprise:'Surprise me'}[settings.style]||settings.style;
 const transitions=settings.preserveSections&&settings.transitions!=='cuts'?'Soft fades through black':{automatic:'Automatic transitions',cuts:'Cuts only',dissolves:'Dissolves'}[settings.transitions]||settings.transitions;
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
 $('preserveSections').checked=settings.preserveSections===true;
 $('savedSettings').textContent=`Saved edit settings restored: ${savedSettingsLabel(settings)}.`;
}
function selectedSeconds(){
 return $('preserveSections').checked?(state?.directed?draft.filter(m=>m.approved).reduce((sum,m)=>sum+m.duration,0):state.clips.reduce((sum,c)=>sum+c.duration,0)):Number($('length').value);
}
function approveCompilation(targetSeconds){
 const actual=selectedSeconds(), length=Math.max(targetSeconds,actual);
 return length<=60||confirm(`${$('preserveSections').checked?`Your intact sections total ${actual.toFixed(1)}s (requested ${targetSeconds}s).`:`This ${durationLabel(targetSeconds)}.`} The longer output uses a 720p profile and can take longer to render. Keep this private page open. Continue?`);
}
function settingsPayload(){return {mode:$('mode').value,style:$('style').value,targetSeconds:Number($('length').value),transitions:$('transitions').value,gentleCleanup:$('cleanup').checked,preserveSections:$('preserveSections').checked,prompt:$('prompt').value};}
function normalizedSettings(settings){return {mode:settings.mode,style:settings.style,targetSeconds:Number(settings.targetSeconds),transitions:settings.transitions,gentleCleanup:settings.gentleCleanup===true,preserveSections:settings.preserveSections===true,prompt:settings.prompt||''};}
function normalizedWizard(wizard={},prompt=''){
 const value={preset:wizard.preset||'wizard',aspectRatio:wizard.aspectRatio||'9:16',audioMode:wizard.audioMode||'selected-moment-original',vibePrompt:wizard.vibePrompt??prompt};
 // The server ignores source/start when original moment audio is selected.
 if(value.audioMode==='single-source'){value.audioClipID=wizard.audioClipID||'';value.audioStart=Number(wizard.audioStart??0);}
 return value;
}
function pendingSettings(){
 if(!state?.directed)return false;
 const saved=state.directed;
 return JSON.stringify(normalizedSettings(settingsPayload()))!==JSON.stringify(normalizedSettings(saved.plan.settings))||JSON.stringify(normalizedWizard(wizardPayload()))!==JSON.stringify(normalizedWizard(saved.wizard,saved.plan.settings.prompt||''));
}
function refreshAudioOptions(next,restore){
 const selected=restore?next.directed?.wizard?.audioClipID:$('audioClipID').value;
 const audible=next.clips.filter(c=>c.hasAudio);
 $('audioClipID').replaceChildren(...audible.map(c=>{const o=text('option',c.name);o.value=c.id;return o;}));
 if(audible.some(c=>c.id===selected))$('audioClipID').value=selected;
}
function wizardPayload(){return {preset:$('preset').value,aspectRatio:$('aspectRatio').value,audioMode:$('audioMode').value,audioClipID:$('audioClipID').value,audioStart:Number($('audioStart').value),vibePrompt:$('prompt').value};}
function restoreWizard(wizard){
 wizard=normalizedWizard(wizard,$('prompt').value);
 if(wizard.preset&&[...$('preset').options].some(o=>o.value===wizard.preset))$('preset').value=wizard.preset;
 if(wizard.aspectRatio)$('aspectRatio').value=wizard.aspectRatio;
 if(wizard.audioMode)$('audioMode').value=wizard.audioMode;
 if(wizard.audioClipID)$('audioClipID').value=wizard.audioClipID;
 $('audioStart').value=Number.isFinite(wizard.audioStart)?wizard.audioStart:0;
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
async function stateFetch(){
 const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),20000);
 try{return await decode(await fetch('/api/state',{credentials:'same-origin',cache:'no-store',signal:controller.signal}));}
 catch(e){throw Error(e.name==='AbortError'?'Connection check timed out. Your job is still private and can resume observation.':e.message||String(e));}
 finally{clearTimeout(timer);}
}
async function refresh(){
 const sequence=++refreshSequence;let next;
 try{next=await stateFetch();}catch(e){if(sequence!==refreshSequence)return state;throw e;}
 if(sequence!==refreshSequence)return state;
 if(state?.error&&!next.error&&$('error').textContent===state.error)clearError();
 const newSession=!!state&&state.csrf!==next.csrf;
 const newRevision=!!state&&state.revision!==next.revision;
 if((newSession||newRevision)&&$('splitDialog').open)$('splitDialog').close();
 const restore=!state||newSession||newRevision||!!next.directed&&next.revision!==draftRevision;
 if(newSession){discardPreparedMedia();draft=[];dirty=false;staleDraft=false;draftRevision=-1;error(Error('This session expired. Deleted media cannot be restored; choose clips for a new test.'));}
 if(state&&next.revision!==draftRevision&&dirty&&!running){
  staleDraft=true;show();
  throw Error('A newer edit was saved in another tab. Your local changes were not submitted. Reload this page before making changes.');
 }
 if(state&&(newRevision||next.ready!==state.ready))discardPreparedMedia();
 if(newSession||newRevision)$('reviewed').checked=false;
 state=next;expiryAt=Date.now()+next.expiresIn*1000;
 observationStopped=false;$('resumeStatus').hidden=true;
 // A real select rejects values before its options exist. Populate it before
 // hydrating an accepted saved identity, never as a side effect of show().
 refreshAudioOptions(next,restore);
 if(next.directed&&restore){
  if(dirty&&!running)throw Error('A newer edit was saved in another tab. Reload this page before making changes.');
  draft=structuredClone(next.directed.plan.moments);draftRevision=next.revision;dirty=false;restoreSavedSettings(next.directed.plan.settings);restoreWizard(next.directed.wizard);explicitSettings.clear();generatedPromptTarget=null;renderMoments();
 }
 if(!next.directed){draft=[];draftRevision=-1;$('moments').replaceChildren();$('savedSettings').textContent='Your saved edit settings will appear here after you make a first cut.';}
 show();return next;
}
function show(){
 if(!state)return;
 const busy=state.busy||running||uploading, pending=pendingSettings();
 $('work').hidden=!busy;$('status').textContent=state.status;$('progress').value=state.progress;
 $('workNote').textContent=state.statusSeconds>8?`Still ${state.status.toLowerCase()} (${state.statusSeconds}s elapsed). Keep this page open; a connection retry does not restart the job.`:'Keep this page open during uploads and preparation. Completed uploads and saved edits stay in this session.';
 $('files').disabled=busy;
 $('hero').hidden=state.ready;
 renderCatalog();
 $('plan').disabled=busy||staleDraft||state.ready||!state.clips.length;$('clear').disabled=busy;
 for(const id of ['preset','aspectRatio','audioMode','audioClipID','audioStart','prompt','mode','style','length','transitions','cleanup','preserveSections'])$(id).disabled=busy||state.ready;
 const transitionLabels=$('preserveSections').checked?{automatic:'Soft boundary fades',cuts:'Cuts only',dissolves:'Soft boundary fades (no overlap)'}:{automatic:'Automatic',cuts:'Cuts only',dissolves:'Dissolves'};
 for(const option of $('transitions').options)option.textContent=transitionLabels[option.value]||option.textContent;
 document.querySelectorAll('[data-prompt]').forEach(b=>b.disabled=busy);
 $('controls').hidden=state.ready;$('review').hidden=state.ready||!state.directed;$('result').hidden=!state.ready;
 $('step1').classList.toggle('active',!state.directed&&!state.ready);
 $('step2').classList.toggle('active',!!state.directed&&!state.ready);$('step3').classList.toggle('active',state.ready);
 $('render').disabled=busy||staleDraft||dirty||pending||!$('reviewed').checked||!draft.some(m=>m.approved);
 $('render').disabled=$('render').disabled||!state.previewReady;
 $('save').disabled=busy||staleDraft||pending||state.ready||!state.directed||(!dirty&&state.previewReady);$('feedbackSave').disabled=busy;
 $('revertSettings').hidden=!pending;$('revertSettings').disabled=busy||staleDraft;
 $('adjust').disabled=busy||staleDraft;
 $('adjustment').disabled=busy||staleDraft;
 $('plan').textContent=state.directed?'Apply settings and preview':'Make my first cut';
 $('save').textContent='Update preview';
 $('saveState').textContent=pending?'Output settings changed. Choose Apply settings and preview, or restore saved settings before export.':dirty?'Edits changed. Update preview before export.':!state.previewReady?'Saved edit has no current preview. Choose Update preview to retry; your sources are kept.':'Edits saved in this session.';
 $('moments').querySelectorAll('button').forEach(b=>b.disabled=busy);
 $('moments').querySelectorAll('[data-split]').forEach(b=>b.disabled=busy||!!splitProblem(draft.find(m=>m.id===b.dataset.split)));
 $('undoSplit').hidden=!state.canUndoSplit;
 $('undoSplit').disabled=busy||staleDraft||dirty||pending||state.ready||!state.canUndoSplit;
 $('clips').replaceChildren(...(state.ready?[]:state.clips).map(c=>{
  const el=document.createElement('div');el.className='source';const img=document.createElement('img');img.alt='';img.src=`/api/poster/${c.id}`;
  const info=document.createElement('div');info.append(text('b',c.name),text('small',`${c.duration.toFixed(1)}s / ${c.hasAudio?'original sound':'silent source'} / analyzed / ${catalogIncluded(c.id)?'included in saved edit':'not included in saved edit'}`));el.append(img,info);return el;
 }));
 $('audioClipWrap').hidden=$('audioMode').value!=='single-source';$('audioStartWrap').hidden=$('audioMode').value!=='single-source';
 if(state.directed&&!state.ready){
  const d=state.directed;$('summary').textContent=`${draft.filter(m=>m.approved).length} moments / ${d.seconds.toFixed(1)} seconds saved`;
  $('durationTruth').textContent=durationTruth(d);
  $('durationTruth').classList.toggle('warning',Math.abs(Number(d.plan.settings.targetSeconds)-Number(d.seconds))>.08);
  renderEditorialProposal(d.editorialProposal);
  const omitted=d.coverage?.omitted||[];$('coverage').textContent=omitted.length?`Not in the saved edit: ${omitted.join(', ')}. Replace a moment to include that source.`:`All ${state.clips.length} source clips are represented in the saved edit.`;
  $('coverage').classList.toggle('warning',!!omitted.length);
  $('explanation').textContent=[d.plan.director,...d.plan.warnings].join('\n\n');
  const previewCurrent=state.previewReady&&!dirty&&!pending&&draftRevision===state.revision;
  $('preview').hidden=!previewCurrent;$('previewNote').hidden=!previewCurrent;
  const identity=`${state.csrf}:${state.revision}`;
  if(previewCurrent){if(previewIdentity!==identity){$('preview').pause();$('preview').removeAttribute('src');$('preview').load();$('preview').src=`/api/preview?revision=${state.revision}`;previewIdentity=identity;}$('previewNote').textContent='Assembled preview of this exact revision. Adjusting or saving changes requires a new preview before export.';}
  else {$('preview').pause();$('preview').removeAttribute('src');$('preview').load();previewIdentity='';}
 }
 else {renderEditorialProposal(null);$('durationTruth').textContent='';$('durationTruth').classList.remove('warning');}
 if(state.ready){
  if(!$('reel').getAttribute('src'))$('reel').src='/api/reel';
  $('reelDimensions').textContent=`${state.receipt.width} x ${state.receipt.height}`;
  $('reelTime').textContent=durationLabel(Math.round(state.receipt.seconds));
  $('receipt').textContent=`${state.receipt.moments} moments rendered in the ${state.receipt.profile}. ${state.receipt.audioTransition?.description?state.receipt.audioTransition.description+' ':''}Complete-file decoding passed. Uploaded source copies deleted. Download it, put it in iCloud Drive, then test playback on your phone.`;
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
  const split=button('Split range',()=>openSplit(m.id));split.dataset.split=m.id;split.disabled=!!splitProblem(m);split.title=splitProblem(m)||'Split at your chosen point; both halves inherit the current choices.';actions.append(split);
  el.append(top,body,text('p',m.reason,'reason'),actions);$('moments').append(el);
  if(m.approved)$('story').append(text('span',m.role.toUpperCase()));
 });
}
function changed(){dirty=true;$('reviewed').checked=false;show();}
function settingsChanged(){$('reviewed').checked=false;show();}
function move(i,d){const j=i+d;if(j<0||j>=draft.length)return;[draft[i],draft[j]]=[draft[j],draft[i]];changed();renderMoments();}
function splitProblem(moment){
 if(!state?.directed?.plan.settings.preserveSections)return 'Splitting is available in Keep selected sections intact mode.';
 if(staleDraft||dirty||pendingSettings())return 'Apply or restore settings and update your saved edit before splitting.';
 if(state.ready||!moment)return 'Open a saved source range before splitting.';
 if(draft.length>=120)return 'This test supports at most 120 ranges, including rejected ranges.';
 if(moment.duration<.2)return 'A split needs at least 0.1 seconds on each side.';
 return '';
}
function openSplit(id){
 const m=draft.find(m=>m.id===id), problem=splitProblem(m);
 if(running||state?.busy||uploading)return;
 if(problem){error(Error(problem));return;}
 splitEditing={id,revision:submittedRevision(),session:state.csrf,duration:m.duration};
 $('splitRange').textContent=`${state.clips.find(c=>c.id===m.clipID).name}: ${m.start.toFixed(3)}s to ${(m.start+m.duration).toFixed(3)}s. Both halves stay ${m.approved?'included':'rejected'} and ${m.locked?'locked':'unlocked'}.`;
 $('splitOffset').value='';$('splitOffset').max=String(m.duration-.1);$('splitError').textContent='';$('splitDialog').showModal();
}
$('splitDialog').onclose=()=>{splitEditing=null;};
$('splitCancel').onclick=()=>$('splitDialog').close();
$('splitConfirm').onclick=()=>{
 if(!splitEditing||running||state.busy)return;
 const captured={...splitEditing}, offset=Number($('splitOffset').value), problem=splitProblem(draft.find(m=>m.id===captured.id));
 if(problem||captured.session!==state.csrf||captured.revision!==state.revision){$('splitError').textContent=problem||'The saved edit changed. Close this dialog and reopen the current range.';return;}
 if(!Number.isFinite(offset)||offset<.1||offset>captured.duration-.1+1e-12||Math.abs(offset*1000-Math.round(offset*1000))>1e-7){$('splitError').textContent='Enter seconds from the range start, to millisecond precision, leaving at least 0.1s on each side.';return;}
 $('splitDialog').close();
 return operate(async()=>{await request('/api/split',{revision:captured.revision,momentID:captured.id,offset});await wait();});
};
$('undoSplit').onclick=()=>{
 if(!state?.canUndoSplit||dirty||pendingSettings()||state.busy||running)return;
 const revision=snapshotRevision();if(revision===null)return;
 return operate(async()=>{await request('/api/split/undo',{revision});await wait();});
};
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
async function wait(){let failures=0;while(true){try{const next=await refresh();failures=0;if(!next.busy)break;}catch(e){if(++failures>3){observationStopped=true;$('resumeStatus').hidden=false;throw Error('Connection checks stopped. Resume checking status; your job was not submitted again.');}$('status').textContent=`Connection interrupted. Retrying observation (${failures}/3); your job was not submitted again.`;await sleep(1000*failures);continue;}await sleep(850);}if(state.error)throw Error(state.error);}
async function operate(fn){if(staleDraft){error(Error('Reload this page before changing a conflicting edit.'));return;}if(running)return;running=true;cancelled=false;clearError();show();try{await fn();}catch(e){error(e);}finally{running=false;uploading=false;show();}}
function submittedRevision(){if(staleDraft)throw Error('Reload this page before submitting a conflicting edit.');return draftRevision>=0?draftRevision:state.revision;}
function snapshotRevision(){try{return submittedRevision();}catch(e){error(e);return null;}}
async function sendChunk(id,offset,blob){
 chunkController=new AbortController();const timer=setTimeout(()=>chunkController?.abort(),45000);
 try{return await decode(await fetch(`/api/upload-chunk/${id}`,{method:'PUT',credentials:'same-origin',headers:{'X-Compass-CSRF':state.csrf,'X-Upload-Offset':String(offset)},body:blob,signal:chunkController.signal}));}
 finally{clearTimeout(timer);chunkController=null;}
}
async function upload(file,onReserved=()=>{}){
 const session=state.csrf,u=await request('/api/uploads',{size:file.size});let offset=0,failures=0;
 onReserved({session,id:u.id});
 try{
  while(offset<file.size){
   if(cancelled)throw Error('Upload stopped. Completed clips are still here.');
   try{const r=await sendChunk(u.id,offset,file.slice(offset,Math.min(offset+u.chunkBytes,file.size)));offset=r.received;failures=0;}
   catch(e){if(cancelled||++failures>2)throw e;await sleep(800*failures);const s=await refresh();if(!s.upload||s.upload.id!==u.id)throw e;offset=s.upload.received;}
   $('status').textContent=`Uploading ${Math.round(offset/file.size*100)}% in retryable pieces`;$('progress').value=offset/file.size;
  }
  if(cancelled)throw Error('Upload stopped.');
  await request('/api/uploads/finish',{id:u.id});await wait();
  return u.id;
 }catch(e){try{await request('/api/cancel');}catch{}throw e;}
}
$('files').onchange=()=>{const files=[...$('files').files];$('files').value='';if(!state?.busy&&!running&&!uploading)addCatalogFiles(files);};
$('chooseCatalog').onclick=chooseCatalog;
$('catalogMatches').onclick=()=>{const matches=catalogMatches;catalogMatches=[];addCatalogFiles(matches,true);};
$('catalogBack').onclick=()=>{catalogPage--;renderCatalog();};
$('catalogNext').onclick=()=>{catalogPage++;renderCatalog();};
$('localPreview').onclose=closeLocalPreview;
$('activateCatalog').onclick=()=>operate(async()=>{
 const entries=catalogSelected(), session=state.csrf;
 checkCatalogActivation(entries);
 if(pendingSettings())throw Error('Apply or restore pending output settings before activating more sources.');
 // Commit local trims before analysis advances the project revision. A stale
 // revision fails here, before any upload can replace this local draft.
 if(dirty){await request('/api/review',{revision:submittedRevision(),moments:draft});await wait();}
 checkCatalogActivation(entries);
 uploading=true;show();
 for(const entry of entries){
  if(cancelled)break;
  if(state.csrf!==session)throw Error('The test session changed. Local references are kept; select sources again.');
  await upload(entry.file,binding=>{entry.binding=binding;});entry.selected=false;
 }
 await refresh();
});
$('plan').onclick=()=>{
 const revision=snapshotRevision();if(revision===null)return;
 const targetSeconds=Number($('length').value), payload={revision,mode:$('mode').value,style:$('style').value,targetSeconds,transitions:$('transitions').value,gentleCleanup:$('cleanup').checked,preserveSections:$('preserveSections').checked,prompt:$('prompt').value,wizard:wizardPayload(),explicitSettings:[...explicitSettings],previousMoments:state.directed?structuredClone(draft):null};
 const compilationApproved=approveCompilation(targetSeconds);
 if(!compilationApproved)return;
 payload.compilationApproved=compilationApproved;
 return operate(async()=>{await request('/api/plan',payload);await wait();$('reviewed').checked=false;$('review').scrollIntoView({block:'start'});});
};
$('save').onclick=()=>{if(pendingSettings()){error(Error('Apply settings and preview, or restore saved settings before updating this edit.'));return;}const revision=snapshotRevision();if(revision===null)return;const payload={revision,moments:structuredClone(draft),preview:true};if($('preserveSections').checked){payload.compilationApproved=approveCompilation(Number(state.directed.plan.settings.targetSeconds));if(!payload.compilationApproved)return;}return operate(async()=>{await request('/api/review',payload);await wait();$('reviewed').checked=false;});};
$('reviewed').onchange=show;
$('revertSettings').onclick=()=>{
 if(running||state.busy||uploading||staleDraft||!state.directed)return;
 restoreSavedSettings(state.directed.plan.settings);restoreWizard(state.directed.wizard);explicitSettings.clear();generatedPromptTarget=null;settingsChanged();
};
$('render').onclick=()=>{
 const revision=snapshotRevision();if(revision===null)return;
 if(dirty||pendingSettings()||!state.previewReady){error(Error('Apply or restore pending settings and update the preview before export.'));show();return;}
 const payload={revision,reviewed:$('reviewed').checked,moments:structuredClone(draft),...settingsPayload(),wizard:wizardPayload()};
 return operate(async()=>{await request('/api/render',payload);await wait();$('result').scrollIntoView({block:'start'});});
};
$('cancel').onclick=async()=>{cancelled=true;chunkController?.abort();try{await request('/api/cancel');await wait();}catch(e){error(e);}};
$('resumeStatus').onclick=()=>operate(wait);
$('clear').onclick=()=>{if(!running&&!clearPending)$('clearConfirm').showModal();};
$('clearCancel').onclick=()=>{$('clearConfirm').close();};
$('clearConfirmButton').onclick=()=>{
 if(clearPending||running)return;
 clearPending=true;$('clearConfirm').close();
 return operate(async()=>{try{await request('/api/clear');prepared=null;draftRevision=-1;dirty=false;staleDraft=false;$('reel').pause();$('reel').removeAttribute('src');$('reel').load();$('share').textContent='Prepare iPhone share';await refresh();}finally{clearPending=false;}});
};
for(const b of document.querySelectorAll('[data-prompt]'))b.onclick=()=>{
 $('prompt').value=b.dataset.prompt;
 generatedPromptTarget=Number(b.dataset.target)||null;
 if(b.dataset.target)$('length').value=b.dataset.target;
 if(b.dataset.target)explicitSettings.add('targetSeconds');
 settingsChanged();
};
$('prompt').oninput=()=>{generatedPromptTarget=null;settingsChanged();};
const parameterControls={mode:'mode',style:'style',length:'targetSeconds',transitions:'transitions',cleanup:'gentleCleanup',preserveSections:'preserveSections'};
for(const [id,key] of Object.entries(parameterControls))if(typeof $(id).addEventListener==='function')$(id).addEventListener('change',()=>{explicitSettings.add(key);settingsChanged();});
$('preset').onchange=()=>{
 const p=$('preset').value;
 const presets={cinematic:{style:'cinematic',transitions:'dissolves'},'high-energy':{style:'hype',transitions:'cuts'},memory:{style:'memory',transitions:'dissolves'}};
 if(presets[p])Object.entries(presets[p]).forEach(([id,value])=>{$(id).value=value;explicitSettings.add(parameterControls[id]);});
 settingsChanged();
};
$('audioMode').onchange=settingsChanged;
$('audioClipID').onchange=settingsChanged;
$('aspectRatio').onchange=settingsChanged;
$('audioStart').oninput=settingsChanged;
$('length').onchange=()=>{
 if(!generatedPromptTarget){settingsChanged();return;}
 const seconds=Number($('length').value);
 const label=`${seconds} seconds`;
 $('prompt').value=$('prompt').value.replace(/^\s*(?:\d+\s*(?:seconds?|secs?|minutes?|mins?)|\d+\s*min)\s*,?\s*/i,`${label}, `);
 generatedPromptTarget=seconds;settingsChanged();
};
$('adjust').onclick=()=>{
 const editRequest=$('adjustment').value.trim();
 if(!editRequest)throw Error('Describe an adjustment, or render this reviewed first cut.');
 const revision=snapshotRevision();if(revision===null)return;
 const targetSeconds=Number(state.directed.plan.settings.targetSeconds), payload={revision,editRequest,preserveSections:$('preserveSections').checked,wizard:wizardPayload(),previousMoments:structuredClone(draft)};
 const compilationApproved=approveCompilation(targetSeconds);
 if(!compilationApproved)return;
 payload.compilationApproved=compilationApproved;
 return operate(async()=>{await request('/api/plan',payload);await wait();$('adjustment').value='';$('reviewed').checked=false;$('review').scrollIntoView({block:'start'});});
};
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
