import type { BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { parseProjectSnapshot, type ProjectSnapshot } from "../src/shared/project-file.js";

type WaitFor = (expression:string,label:string)=>Promise<void>;

/** UI/config regression for the existing isolated Windows runner. Its fixture
 * contains synthetic videos. This deliberately does not claim a synthetic
 * person-mask preview as evidence of real concert segmentation quality. */
export async function runBodyOutlineSmoke(win:BrowserWindow,waitFor:WaitFor,stage:(message:string)=>void,projectPath:string):Promise<void> {
  // This runs in packaged Electron's main process, exercising its real native
  // addon and bundled encoder/decoder. The neutral fixture proves loading,
  // inference and output shape only; it is not a person-recognition test.
  const {loadBodyModel}=await import("./body-segmentation.js");
  const model=await loadBodyModel();
  assert.equal(model.inputSize,512,"Packaged silhouette input contract changed");
  assert.equal(model.preserveAspect,true,"Packaged silhouette adapter must preserve aspect");
  assert.equal(model.runtime,"onnxruntime-node","The packaged native silhouette runtime was not selected");
  assert.equal(model.runtimeVersion,"1.23.2","The packaged native silhouette runtime version changed");
  const neutral=new Uint8Array(64*64*3).fill(128);
  const probability=await model.segment(neutral,undefined,{width:64,height:64,
    expected:{x:.25,y:.1,width:.5,height:.8},subject:{x:.5,y:.5},sourceTime:0});
  assert.ok(probability instanceof Float32Array,"Native silhouette output must be Float32Array");
  assert.equal(probability.length,64*64,"Native silhouette output dimensions were wrong");
  assert.ok(probability.every(value=>Number.isFinite(value)&&value>=0&&value<=1),"Native silhouette output contained invalid probabilities");
  assert.equal(model.getLastDecision?.()?.candidates.length,3,"Native silhouette encoder/decoder did not produce three candidates");
  stage("packaged native silhouette model ready");
  const evaluate=(expression:string)=>win.webContents.executeJavaScript(expression);
  const matching=(label:string,scope="button")=>`Array.from(document.querySelectorAll(${JSON.stringify(scope)})).find(b=>b.textContent?.trim()===${JSON.stringify(label)})`;
  const pressed=(label:string,scope=".body-outline-choices button")=>`${matching(label,scope)}?.getAttribute('aria-pressed')==='true'`;
  const activate=async(label:string,scope="button")=>evaluate(`(()=>{const b=${matching(label,scope)};if(!b||b.disabled)throw Error(${JSON.stringify(`Unavailable body-outline action: ${label}`)});b.click();})()`);
  const choose=async(label:string)=>{await activate(label,".body-outline-choices button");await waitFor(pressed(label),`performer neon ${label}`);};
  const load=async()=>parseProjectSnapshot(JSON.parse(await readFile(projectPath,"utf8")));
  const userEdit=(project:ProjectSnapshot)=>({clips:project.clips,audioSelections:project.audioSelections,briefInput:project.briefInput,briefDirty:project.briefDirty});
  const before=await load(),expectedEdit=userEdit(before);
  const saved=async(predicate:(project:ProjectSnapshot)=>boolean,label:string,expected=expectedEdit)=>{
    await activate("Save project");
    // Several saves use the same visible success text. Check actual written
    // settings too, so a stale status cannot let the harness read an old file.
    let latest:ProjectSnapshot|undefined;
    for(let attempt=0;attempt<240;attempt++){
      try{latest=await load();if(predicate(latest)){assert.deepEqual(userEdit(latest),expected,`${label} changed user selections, locks, audio, or brief`);return latest;}}catch(error){if(error instanceof assert.AssertionError)throw error;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error(`Timed out waiting for ${label}: ${JSON.stringify(latest?.options)}`);
  };
  await choose("Soft");
  const soft=await saved(project=>project.options.bodyOutline==="subtle","Soft body-outline save");
  await choose("Electric");
  await saved(project=>project.options.bodyOutline==="electric","Electric body-outline save");
  await activate("Undo",".brief button");
  await waitFor(pressed("Soft"),"performer neon undo");
  const undone=await saved(project=>project.options.bodyOutline==="subtle","body-outline undo save");
  assert.deepEqual(undone.options,soft.options,"Undo changed unrelated finishing choices");
  stage("body outline options and undo ready");

  const signatureReady=`${pressed("Electric")} && ${pressed("Full Y2K",".effect-choices button")} && ${pressed("Clean",".visual-studio button")} && ${pressed("Best available · up to 1080p",".options button")} && document.querySelector('.reduced-flash input')?.checked===true`;
  const signature=async()=>{
    await evaluate(`(()=>{const b=document.querySelector('button[aria-label="Apply Vibe Capsule signature"]');if(!b||b.disabled)throw Error('Signature look unavailable');b.click();})()`);
    await waitFor(signatureReady,"signature options applied together");
    return saved(project=>project.options.bodyOutline==="electric"&&project.options.effects==="full-y2k"&&project.options.videoEnhancement==="clean"&&project.options.reducedFlash===true&&project.options.quality==="high"&&project.options.enhance===false,"signature project save");
  };
  const configured=await signature();
  for(const key of ["aspect","reduceRumble","finish","transition","audioTransition","audioCrossfadeSeconds","beatSync","highlightFocus","eventTitle","showClipLabels","smartFraming"] as const) {
    assert.deepEqual(configured.options[key],soft.options[key],`Signature changed unrelated ${key}`);
  }
  await activate("Undo",".brief button");await waitFor(pressed("Soft"),"one-step signature undo");
  const signatureUndone=await saved(project=>JSON.stringify(project.options)===JSON.stringify(soft.options),"one-step signature undo save");
  assert.deepEqual(signatureUndone.options,soft.options);
  const restoredSignature=await signature();
  stage("signature settings preserved sections and audio");
  await activate("Open project");
  await waitFor(`document.querySelector('.status')?.textContent.includes('Project opened.') && ${signatureReady}`,"signature project reopen");
  stage("signature project reopened");

  const skipIndex=restoredSignature.clips.findIndex(clip=>clip.included&&!clip.excludedByUser&&!clip.bodyOutlineDisabled);
  assert.ok(skipIndex>=0,"Body-neon smoke needs an enabled picture for its manual correction");
  const skipInput=`document.querySelectorAll('.clips article')[${skipIndex}]?.querySelector('.skip-performer-neon input')`;
  const toggleSkip=()=>evaluate(`(()=>{const input=${skipInput};if(!input||input.disabled)throw Error('Skip performer neon unavailable');input.click();})()`);
  await toggleSkip();await waitFor(`${skipInput}?.checked===true`,"skip performer neon selected");
  await activate("Undo",".brief button");await waitFor(`${skipInput}?.checked===false`,"skip performer neon undo");
  await saved(project=>!project.clips[skipIndex].bodyOutlineDisabled,"skip performer neon undo save");
  await toggleSkip();await waitFor(`${skipInput}?.checked===true`,"skip performer neon selected again");
  const expectedSkip=userEdit({...restoredSignature,clips:restoredSignature.clips.map((clip,index)=>index===skipIndex?{...clip,bodyOutlineDisabled:true}:clip)});
  await saved(project=>project.clips[skipIndex].bodyOutlineDisabled===true,"skip performer neon save",expectedSkip);
  await activate("Open project");
  await waitFor(`document.querySelector('.status')?.textContent.includes('Project opened.') && ${skipInput}?.checked===true`,"skip performer neon reopen");
  stage("per-recording neon correction saved reopened and undone");

  // Only the runner's temporary synthetic fixture is edited here. Removing the
  // new option models an older saved project without altering any media data.
  const legacy=JSON.parse(JSON.stringify(restoredSignature));delete legacy.options.bodyOutline;
  await writeFile(projectPath,JSON.stringify(legacy,null,2),"utf8");
  await activate("Open project");
  await waitFor(`document.querySelector('.status')?.textContent.includes('Project opened.') && ${pressed("Off")}`,"older project keeps body neon Off");
  const legacySaved=await saved(project=>project.options.bodyOutline==="off","older project body-outline save");
  const expectedOptions={...restoredSignature.options,bodyOutline:"off"};
  assert.deepEqual(legacySaved.options,expectedOptions,"Opening an older project changed existing creative settings");
  stage("legacy project kept body neon off");
}
