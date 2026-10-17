'use strict';
const $=id=>document.getElementById(id);
let state=null,reviewSignature='',uploading=false,prepared=null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function error(e){$('error').textContent=e.message||String(e);}
async function request(path,body){
 const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Compass-CSRF':state.csrf},body:JSON.stringify(body||{})});
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error('GitHub login expired. Reopen the private forwarded link; do not make the port public.');
 const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed.');return data;
}
function field(type,value){const i=document.createElement('input');i.type=type;if(type==='checkbox')i.checked=value;else{i.value=value;i.step='0.01';i.min='0';}return i;}
function showReview(){
 const plan=state.directed.plan, signature=JSON.stringify(plan);
 if(signature===reviewSignature)return;reviewSignature=signature;
 $('moments').replaceChildren();$('reviewed').checked=false;
 for(const m of plan.moments){
  const clip=state.clips.find(c=>c.id===m.clipID),row=document.createElement('article');row.dataset.id=m.id;
  const title=document.createElement('h3');title.textContent=`${m.role.toUpperCase()} / ${clip?.name||'Clip'}`;row.append(title);
  const video=document.createElement('video');video.controls=true;video.playsInline=true;video.preload='none';video.src=`/api/clip/${encodeURIComponent(m.clipID)}#t=${m.start},${m.start+m.duration}`;row.append(video);
  const grid=document.createElement('div');grid.className='grid';
  for(const [key,label] of [['start','Start (seconds)'],['duration','Length (seconds)']]){const l=document.createElement('label');l.textContent=label;const input=field('number',Number(m[key].toFixed(3)));input.dataset.key=key;l.append(input);grid.append(l);}row.append(grid);
  for(const [key,label] of [['approved','Include this moment'],['locked','Lock when regenerating']]){const l=document.createElement('label');l.className='check';const input=field('checkbox',m[key]);input.dataset.key=key;l.append(input,document.createTextNode(label));row.append(l);}
  const move=document.createElement('button');move.className='secondary';move.textContent='Move earlier';move.onclick=()=>{const p=row.previousElementSibling;if(p){p.before(row);$('reviewed').checked=false;}};row.append(move);
  row.addEventListener('change',()=>{$('reviewed').checked=false;});$('moments').append(row);
 }
 $('explanation').textContent=[plan.director,...plan.warnings].join('\n\n');
}
function show(){
 const busy=state.busy||uploading;
 $('status').textContent=state.status;$('progress').value=state.progress;$('cancel').hidden=!busy;
 if(state.error)$('error').textContent=state.error;
 $('files').disabled=busy||state.ready||state.clips.length>=3;
 $('plan').disabled=busy||state.ready||!state.clips.length;$('clear').disabled=busy;
 $('render').disabled=busy||!$('reviewed').checked;$('controls').hidden=state.ready;
 $('review').hidden=state.ready||!state.directed;$('result').hidden=!state.ready;
 $('clips').replaceChildren(...state.clips.map(c=>{const p=document.createElement('p');p.textContent=`${c.name} / ${c.duration.toFixed(1)} seconds / ${c.hasAudio?'original sound':'silent source'}`;return p;}));
 if(state.directed&&!state.ready)showReview();
 if(state.ready&&!$('reel').getAttribute('src')){$('reel').src='/api/reel';}
}
async function refresh(){
 const r=await fetch('/api/state',{credentials:'same-origin',cache:'no-store'});
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error('Private-link login expired. Reopen it from GitHub.');
 const next=await r.json();if(!r.ok)throw Error(next.error);state=next;show();return state;
}
async function wait(){while((await refresh()).busy)await sleep(1200);if(state.error)throw Error(state.error);}
function upload(file){return new Promise((resolve,reject)=>{
 const x=new XMLHttpRequest();x.open('PUT','/api/upload');x.setRequestHeader('X-Compass-CSRF',state.csrf);x.timeout=180000;
 x.upload.onprogress=e=>{if(e.lengthComputable){$('progress').value=e.loaded/e.total;$('status').textContent='Uploading a clip to your private Codespace...';}};
 x.onload=()=>{try{const d=JSON.parse(x.responseText);if(x.status<300)resolve(d);else reject(Error(d.error));}catch{reject(Error('Upload did not complete. Reopen the authenticated private link and retry.'));}};
 x.onerror=()=>reject(Error('Upload connection failed. No browser recording fallback was used.'));x.ontimeout=()=>reject(Error('Upload timed out. Try a shorter clip.'));x.send(file);
});}
$('files').onchange=async()=>{try{
 const files=[...$('files').files];if(files.length+(state?.clips.length||0)>3)throw Error('Choose at most three clips for this test.');
 if(files.some(f=>f.size>160*1024*1024))throw Error('Each test clip must be under 160 MB.');
 uploading=true;$('error').textContent='';show();for(const f of files){await upload(f);await wait();}
 }catch(e){error(e);}finally{uploading=false;$('files').value='';if(state)show();}};
function reviewPatches(){return [...$('moments').children].map(row=>{const m={id:row.dataset.id};row.querySelectorAll('input').forEach(i=>{m[i.dataset.key]=i.type==='checkbox'?i.checked:Number(i.value);});return m;});}
$('plan').onclick=async()=>{try{$('error').textContent='';await request('/api/plan',{mode:$('mode').value,style:$('style').value,targetSeconds:Number($('length').value),transitions:$('transitions').value,gentleCleanup:$('cleanup').checked,prompt:$('prompt').value,previousMoments:state.directed?reviewPatches():null});await wait();$('review').scrollIntoView();}catch(e){error(e);}};
$('reviewed').onchange=()=>{if(state)show();};
$('render').onclick=async()=>{try{
 const moments=reviewPatches();
 $('error').textContent='';await request('/api/render',{reviewed:$('reviewed').checked,moments});await wait();$('result').scrollIntoView();
 }catch(e){error(e);}};
$('cancel').onclick=async()=>{try{await request('/api/cancel');await wait();}catch(e){error(e);}};
$('clear').onclick=async()=>{if(!confirm('Delete all copies and the finished reel from this test? Your Photos originals are unchanged.'))return;try{await request('/api/clear');prepared=null;reviewSignature='';$('reel').removeAttribute('src');$('error').textContent='';await refresh();}catch(e){error(e);}};
$('share').onclick=async()=>{try{
 if(!prepared){const r=await fetch('/api/reel');if(!r.ok)throw Error('The saved test reel is unavailable.');prepared=new File([await r.blob()],'Concert-Compass-Test.mp4',{type:'video/mp4'});$('share').textContent='Share video / Save Video';$('shareNote').textContent='Ready. Tap the button again to open the iPhone share sheet.';return;}
 // The second tap preserves user activation; fetching before navigator.share can lose it in Safari.
 if(navigator.canShare?.({files:[prepared]}))await navigator.share({files:[prepared],title:'Concert Compass'});
 else{$('shareNote').textContent='File sharing is unavailable here. Use Download MP4, then your browser share menu.';}
 }catch(e){if(e.name!=='AbortError')error(e);}};
refresh().catch(error);
setInterval(()=>{if(state?.busy&&!uploading)refresh().catch(error);},2500);
