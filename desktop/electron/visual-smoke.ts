import type { BrowserWindow } from "electron";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { parseProjectSnapshot, type ProjectSnapshot } from "../src/shared/project-file.js";
const ffmpegBinary = ffmpegPath as unknown as string | null;

type WaitFor = (expression: string, label: string) => Promise<void>;

// Runs only inside the existing isolated Windows smoke runner. It never opens
// an additional window and never changes or uploads an original recording.
export async function runVisualSmoke(win: BrowserWindow, waitFor: WaitFor,
  stage: (message: string) => void, projectPath: string): Promise<void> {
  const evaluate = (expression: string) => win.webContents.executeJavaScript(expression);
  const button = (label: string, scope = "button") =>
    `Array.from(document.querySelectorAll(${JSON.stringify(scope)})).find(b => b.textContent?.trim() === ${JSON.stringify(label)})`;
  const choose = async (label: string, scope = ".visual-studio button") => {
    const selector = button(label, scope);
    await evaluate(`(() => { const b=${selector}; if (!b || b.disabled) throw Error(${JSON.stringify(`Unavailable visual control: ${label}`)}); b.click(); })()`);
    await waitFor(`${selector}?.getAttribute('aria-pressed') === 'true'`, `visual choice ${label}`);
  };
  const activate = async (label: string, scope = "button") => {
    await evaluate(`(() => { const b=${button(label, scope)}; if (!b || b.disabled) throw Error(${JSON.stringify(`Unavailable action: ${label}`)}); b.click(); })()`);
  };
  const load = async () => parseProjectSnapshot(JSON.parse(await readFile(projectPath, "utf8")));
  const sections = (project: ProjectSnapshot) => JSON.stringify({
    picture: project.clips.map(c => [c.asset.path, c.start, c.end, c.included, c.locked,
      c.excludedByUser, c.selectionSource, c.orderLocked, c.framing, c.focus, c.label]),
    sound: project.audioSelections?.map(s => [s.asset.path, s.start, s.end, s.locked]) ?? null,
  });
  const before = await load();
  const pictureIndex = before.clips.findIndex(c => c.included && !c.excludedByUser);
  if (pictureIndex < 0) throw Error("Visual smoke needs the existing selected picture.");
  const expectedSections = sections(before);
  for (const label of ["Original", "Clean", "Enhanced", "Maximum", "Enhanced"]) await choose(label);
  for (const label of ["None", "Subtle glow", "Neon Pop", "Full Y2K"]) await choose(label);
  for (const label of ["Balanced", "Group performance", "Follow performer"]) await choose(label);
  const manualDisabled = await evaluate(`Array.from(document.querySelectorAll('.frame-choice button')).every(b => b.disabled)`);
  if (!manualDisabled) throw Error("Smart framing left a competing manual crop control active.");
  await choose("Off · manual");
  if (!await evaluate(`Array.from(document.querySelectorAll('.frame-choice button')).every(b => !b.disabled)`)) {
    throw Error("Turning smart framing off did not restore manual crop controls.");
  }
  await choose("Follow performer");
  stage("visual direction controls ready");

  await activate("Analyze visuals", ".visual-studio button").catch(async error => {
    if (!await evaluate(`${button("Check new or changed pictures", ".visual-studio button")} !== undefined`)) throw error;
    await activate("Check new or changed pictures", ".visual-studio button");
  });
  await waitFor(`document.querySelector('.status')?.textContent.includes('Visual analysis finished.')`, "local visual analysis");
  stage("packaged local people analysis finished");

  await waitFor(`(() => { const v=document.querySelectorAll('.clips article')[${pictureIndex}]?.querySelector('video'); return v && v.readyState >= 2 && v.videoWidth > 0 })()`, "performer picker source picture");
  const subjectMoment=before.clips[pictureIndex].start+Math.min(.6,(before.clips[pictureIndex].end-before.clips[pictureIndex].start)/2);
  await evaluate(`(() => { const v=document.querySelectorAll('.clips article')[${pictureIndex}]?.querySelector('video'); v.pause();v.currentTime=${subjectMoment}; })()`);
  await waitFor(`(() => { const v=document.querySelectorAll('.clips article')[${pictureIndex}]?.querySelector('video'); return v && !v.seeking && Math.abs(v.currentTime-${subjectMoment}) < .075 && v.readyState >= 2 })()`, "performer accent moment in existing section");
  await evaluate(`(() => { const article=document.querySelectorAll('.clips article')[${pictureIndex}], b=Array.from(article.querySelectorAll('button')).find(b => ['Choose performer','Change performer'].includes(b.textContent.trim())); if (!b || b.disabled) throw Error('Performer choice unavailable'); b.click(); })()`);
  await waitFor(`(() => { const v=document.querySelector('.subject-picking video'); return v && !v.seeking && Math.abs(v.currentTime-${subjectMoment}) < .075 && v.readyState >= 2 })()`, "uncropped performer choice keeps paused moment");
  const picker = await evaluate(`(() => { const frame=document.querySelector('.subject-picking'), v=frame.querySelector('video'), rect=frame.getBoundingClientRect(); return { ratio:rect.width/rect.height, sourceRatio:v.videoWidth/v.videoHeight, objectFit:getComputedStyle(v).objectFit, controls:v.controls }; })()`);
  if (Math.abs(picker.ratio - picker.sourceRatio) > 0.025 || picker.objectFit !== "contain" || picker.controls) {
    throw Error(`Performer picker did not expose the whole original frame: ${JSON.stringify(picker)}`);
  }
  // A real button exposes the same center-point operation to keyboard users;
  // activate it directly here without depending on hidden-window focus.
  await activate("Use center point", ".subject-actions button");
  await waitFor(`document.querySelector('.status')?.textContent.includes('Your performer point is saved') && !document.querySelector('.subject-picking')`, "performer choice saved");
  stage("original-frame performer picker saved");

  await activate("Save project");
  await waitFor(`document.querySelector('.status')?.textContent.includes('Project saved:')`, "visual project save");
  const saved = await load();
  if (sections(saved) !== expectedSections) throw Error("Visual controls or analysis changed an existing section, lock, order, or soundtrack.");
  if (saved.options.effects !== "full-y2k" || saved.options.videoEnhancement !== "enhanced" ||
    saved.options.smartFraming !== "follow-performer" || saved.options.reducedFlash !== true || saved.options.enhance) {
    throw Error(`Visual choices were not saved: ${JSON.stringify(saved.options)}`);
  }
  for (const clip of saved.clips.filter(c => !c.excludedByUser)) {
    if (!clip.visualAnalysis?.frames.length || !clip.visualAnalysis.detector || !clip.tracking?.keyframes.length) {
      throw Error(`Visual analysis or planned framing was absent for ${clip.asset.name}.`);
    }
  }
  const kept = saved.clips[pictureIndex];
  if (kept.subject?.x !== 0.5 || kept.subject.y !== 0.5 || kept.subject.time===undefined || Math.abs(kept.subject.time-subjectMoment)>.075 || !kept.tracking?.subjectLocked) {
    throw Error("Manual performer point and paused accent moment were not retained as a protected subject choice.");
  }
  stage("visual analysis and choices saved without changing sections");
  await activate("Open project");
  await waitFor(`document.querySelector('.status')?.textContent.includes('Project opened.')`, "visual project reopen");
  const restored = await evaluate(`(() => { const pressed=label => Array.from(document.querySelectorAll('.visual-studio button')).some(b => b.textContent.trim()===label && b.getAttribute('aria-pressed')==='true'); return {effects:pressed('Full Y2K'), enhancement:pressed('Enhanced'), framing:pressed('Follow performer'), subject:document.querySelectorAll('.clips article')[${pictureIndex}]?.textContent.includes('Your performer choice'), disabled:Array.from(document.querySelectorAll('.frame-choice button')).every(b=>b.disabled)}; })()`);
  if (!Object.values(restored).every(Boolean)) throw Error(`Reopened visual choices were wrong: ${JSON.stringify(restored)}`);
  stage("visual settings and performer choice reopened");

  // A separate soundtrack reopens directly at the cut. Original-sound projects
  // return to their brief; confirm that existing brief rather than inventing one.
  if (!await evaluate(`!!document.querySelector('.draft-heading button')`)) {
    await activate("Review my plan");
    await waitFor(`${button("Make my first cut")} && !${button("Make my first cut")}?.disabled`, "existing brief ready for visual cut");
    await activate("Make my first cut");
    await waitFor(`document.querySelector('.status')?.textContent.includes('First cut ready:')`, "visual first cut");
  }
  await evaluate(`(() => { const b=document.querySelector('.draft-heading button'); if (!b || b.disabled) throw Error('Visual draft unavailable'); b.click(); })()`);
  await waitFor(`document.querySelector('.status')?.textContent.includes('Draft preview is ready')`, "Y2K assembled preview render");
  await waitFor(`(() => { const v=document.querySelector('.draft-player'); return v && v.readyState>=2 && v.videoWidth>0 && v.videoHeight>0 })()`, "Y2K assembled preview decoded");
  const visiblePicture = await evaluate(`(() => { const v=document.querySelector('.draft-player'),c=document.createElement('canvas');c.width=12;c.height=12;c.getContext('2d').drawImage(v,0,0,12,12); return Array.from(c.getContext('2d').getImageData(0,0,12,12).data).some((n,i)=>i%4!==3&&n>20); })()`);
  if (!visiblePicture) throw Error("Y2K assembled preview had no visible picture.");
  stage("Y2K assembled preview decoded picture ready");
  await activate("Save project");
  await waitFor(`document.querySelector('.status')?.textContent.includes('Project saved:')`, "visual first-cut save");
  const finalProject = await load();
  if (sections(finalProject) !== expectedSections || !finalProject.clips[pictureIndex].subject ||
    finalProject.clips[pictureIndex].subject?.time !== kept.subject.time ||
    finalProject.options.effects !== "full-y2k" || finalProject.options.videoEnhancement !== "enhanced") {
    throw Error("Confirming the existing brief changed sections or discarded visual choices.");
  }

  const output = process.env.COMPASS_SMOKE_OUTPUT;
  if (!output) throw Error("Visual smoke needs the existing smoke output path.");
  const previous = await stat(output).catch(() => null);
  await activate("Export MP4");
  await waitFor(`document.querySelector('.status')?.textContent.includes('Finished MP4:') || !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Export with this sound'&&!b.disabled)`, "Y2K export or sound review");
  if (!await evaluate(`document.querySelector('.status')?.textContent.includes('Finished MP4:')`)) {
    await activate("Export with this sound");
    await waitFor(`document.querySelector('.status')?.textContent.includes('Finished MP4:')`, "reviewed Y2K export");
  }
  const written = await stat(output);
  if (!written.size || previous && written.mtimeMs <= previous.mtimeMs) throw Error("Visual export did not produce a new finished file.");
  if (!ffmpegBinary) throw Error("Bundled FFmpeg was unavailable.");
  const probe = JSON.parse((await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height", "-of", "json", output])).toString("utf8"));
  const video = probe.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = probe.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");
  const seconds = finalProject.clips.filter(c => c.included && !c.excludedByUser).reduce((sum, c) => sum + c.end - c.start, 0);
  if (video?.codec_name !== "h264" || audio?.codec_name !== "aac" || Math.abs(video.width / video.height - 9 / 16) > .002 ||
    Math.abs(Number(probe.format?.duration) - seconds) > .25) throw Error(`Unexpected visual export: ${JSON.stringify(probe)}`);
  await run(ffmpegBinary, ["-v", "error", "-i", output, "-f", "null", "-"]);
  const pixels = await run(ffmpegBinary, ["-v", "error", "-ss", "0.3", "-i", output, "-frames:v", "1", "-vf", "scale=12:12,format=rgb24", "-f", "rawvideo", "pipe:1"]);
  if (!pixels.some(value => value > 20)) throw Error("Y2K export did not decode visible picture.");
  stage("Y2K MP4 export decoded with preserved timeline");
}

async function run(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    const chunks: Buffer[] = []; let errors = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-6000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error(`Visual output check failed (${code}): ${errors}`)));
  });
}
