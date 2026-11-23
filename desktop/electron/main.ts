import { app, BrowserWindow, dialog, ipcMain, protocol, type IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { access, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildAudioLedRenderCommand, buildRenderCommand, renderDimensions, type AudioSelection, type ExportOptions, type MediaAsset, type RenderSelection } from "../src/shared/render-plan.js";
import { buildOverlayAss } from "../src/shared/visual-design.js";
import { previewResponse } from "./preview-stream.js";
import { measureAudio } from "./audio-analysis.js";
import { chooseAudioHighlight, type AudioBin } from "../src/shared/suggestions.js";
import { withTemporaryCleanup } from "./temporary-cleanup.js";
import { commitOutput } from "./output-commit.js";
import { validateRenderedOutput } from "./output-integrity.js";
import { displayDimensions } from "./media-orientation.js";
import { parseProjectSnapshot, type ProjectSnapshot } from "../src/shared/project-file.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.COMPASS_DEV === "1";
const ffmpegBinary = ffmpegPath as unknown as string;
const selectedFiles = new Map<string, string>();
const probedDurations = new Map<string, number>();
const previews = new Map<string, string>();
const drafts = new Map<string, string>();
const draftKeys = new Map<string, string>();
const audioBins = new Map<string, AudioBin[]>();
const pendingAudio = new Map<string, Promise<AudioBin[]>>();
let previewDirectory: string | undefined;
let activeRender: ChildProcess | undefined;
let cancelRender = false;
let smokeCancelPending = true;
const smoke = process.env.COMPASS_SMOKE_TEST === "1";
const smokeStory = smoke && process.env.COMPASS_SMOKE_STORY === "1";
function smokeStage(stage: string) {
  if (smoke && process.env.COMPASS_SMOKE_STAGE_FILE) appendFileSync(process.env.COMPASS_SMOKE_STAGE_FILE, `${new Date().toISOString()} ${stage}\n`);
}
smokeStage("process started");
protocol.registerSchemesAsPrivileged([{ scheme: "compass-media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);

function createWindow() {
  smokeStage("creating window");
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: "#0a0a0e",
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  if (isDev) win.loadURL("http://127.0.0.1:5173");
  else win.loadFile(path.join(here, "../../dist/index.html"));
  if (smoke) {
    win.webContents.on("console-message", (_event, level, message) => { if (level >= 2) console.error(`Renderer: ${message}`); });
    const timer = setTimeout(() => { smokeStage("desktop smoke test timed out"); console.error("Desktop smoke test timed out"); app.exit(1); }, 150000);
    win.webContents.once("did-fail-load", (_event, code, description) => { smokeStage(`page load failed: ${code} ${description}`); console.error(`Page load failed: ${code} ${description}`); clearTimeout(timer); app.exit(1); });
    win.webContents.once("did-finish-load", async () => {
      try {
        smokeStage("page loaded");
        const state = await win.webContents.executeJavaScript(`({title: document.title, bridge: typeof window.concertCompass?.pickVideos, root: !!document.getElementById('root')})`);
        if (state.title !== "Concert Compass" || state.bridge !== "function" || !state.root) throw new Error(JSON.stringify(state));
        await win.webContents.executeJavaScript(`document.querySelector('button.primary').click()`);
        const waitFor = async (expression: string, label: string) => {
          for (let attempt = 0; attempt < 600; attempt++) {
            if (await win.webContents.executeJavaScript(expression)) return;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          const detail = await win.webContents.executeJavaScript(`({
            status: document.querySelector('.status')?.innerText,
            conflict: document.querySelector('.brief-review .conflict')?.innerText,
            firstCutError: document.querySelector('.brief-review .story-error')?.innerText
          })`).catch(() => null);
          throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(detail)}`);
        };
        await waitFor(`document.body.innerText.includes('${smokeStory ? "3" : "2"} selected')`, "import");
        smokeStage("videos imported");
        const freshDefaults = await finishingSmokeState(win);
        if (!freshDefaults.phone || !freshDefaults.high || !freshDefaults.dissolve || !freshDefaults.crossfade ||
          freshDefaults.overlap !== 2 || freshDefaults.enhance !== false || freshDefaults.title !== "" ||
          freshDefaults.labels !== false || !freshDefaults.fill || !freshDefaults.beatSync || !freshDefaults.performance) {
          throw new Error(`Fresh phone finishing defaults were wrong: ${JSON.stringify(freshDefaults)}`);
        }
        smokeStage("fresh phone finishing defaults ready");
        // Preserve the established pixel, title, duration and cancellation checks
        // under their explicit legacy profile. New blends have separate render tests.
        for (const label of ["Portrait 9:13", "Standard · smaller file", "Straight cut", "Direct join"]) {
          await chooseSmokeOption(win, waitFor, label);
        }
        smokeStage("portrait 9:13 legacy profile ready");
        await waitFor(`(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0 && v.readyState >= 2 })()`, "video picture");
        smokeStage("source picture ready");
        const picture = await win.webContents.executeJavaScript(`(() => { try { const v=document.querySelector('video'), c=document.createElement('canvas'); c.width=8; c.height=8; c.getContext('2d').drawImage(v,0,0,8,8); return Array.from(c.getContext('2d').getImageData(0,0,8,8).data).some((n,i)=>i%4!==3 && n>20) } catch(e) { return String(e) } })()`);
        if (typeof picture === "string") throw new Error(`Picture inspection failed: ${picture}`);
        if (!picture) throw new Error("Preview has no visible picture");
        if (smokeStory) {
          await runSoundStorySmoke(win, waitFor);
          smokeStage("story smoke passed");
          console.log("Desktop three-part soundtrack, independent picture, adjustment, project reopen and export passed");
          clearTimeout(timer); app.exit(0); return;
        }
        // Keep the established manual-edit smoke on its original picture-and-sound path.
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Edit sections myself (original sound)').click()`);
        await waitFor(`document.querySelector('.brief-quick-choice input[type=checkbox]')?.checked === false && !document.querySelector('.toolbar-actions button.primary')?.disabled`, "manual editor choice");
        await win.webContents.executeJavaScript(`document.querySelector('video').currentTime = 2`);
        await waitFor(`(() => { const v = document.querySelector('video'); return !v.seeking && Math.abs(v.currentTime - 2) < 0.15 && v.readyState >= 2 })()`, "seeking forward");
        await win.webContents.executeJavaScript(`document.querySelector('video').currentTime = 0.5`);
        await waitFor(`(() => { const v = document.querySelector('video'); return !v.seeking && Math.abs(v.currentTime - 0.5) < 0.15 && v.readyState >= 2 })()`, "seeking backward");
        await win.webContents.executeJavaScript(`document.querySelector('button[aria-label^="Forward five seconds"]').click()`);
        await waitFor(`(() => { const v = document.querySelector('video'); return !v.seeking && v.currentTime > 2.8 })()`, "forward button");
        await win.webContents.executeJavaScript(`document.querySelector('button[aria-label^="Back five seconds"]').click()`);
        await waitFor(`(() => { const v = document.querySelector('video'); return !v.seeking && v.currentTime < 0.2 })()`, "back button");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Suggest a moment').click()`);
        await waitFor(`document.querySelector('.status')?.textContent.includes('Favored a sustained musical phrase') && Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Suggest a moment' && !b.disabled)`, "performance-focused sound suggestion");
        await win.webContents.executeJavaScript(`document.querySelector('video').currentTime = 1`);
        await waitFor(`(() => { const v = document.querySelector('video'); return !v.seeking && Math.abs(v.currentTime - 1) < 0.15 })()`, "mark position");
        await win.webContents.executeJavaScript(`Array.from(document.querySelector('.clips article').querySelectorAll('button')).find(b => b.textContent === 'Set start here').click()`);
        await waitFor(`(() => { const first = document.querySelector('.clips article'); return first.querySelector('.trim-heading input[type=checkbox]').checked && Number(first.querySelector('input[aria-label$=" start"]').value) > 0.8 })()`, "protected manual section");
        smokeStage("protected manual section");
        await win.webContents.executeJavaScript(`document.querySelectorAll('button[aria-label^="Move "]')[2].click()`);
        const firstName = await win.webContents.executeJavaScript(`document.querySelector('.clips article h2').textContent`);
        if (!firstName.includes('compass-second')) throw new Error(`Reorder failed: ${firstName}`);
        await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="Video title (optional)"]'); if (!input) throw new Error('Video title control was missing'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'Live at the show'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await win.webContents.executeJavaScript(`(() => { const input = document.querySelectorAll('.clips article .moment-label input')[0]; if (!input) throw new Error('Moment label control was missing'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'Opening energy'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await win.webContents.executeJavaScript(`(() => { const input = document.querySelectorAll('.clips article .moment-label input')[1]; if (!input) throw new Error('Second moment label control was missing'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'Final roar'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="Show my named moments on video"]'); if (!input) throw new Error('Named moment display control was missing'); if (!input.checked) input.click(); })()`);
        await waitFor(`document.querySelector('input[aria-label="Video title (optional)"]')?.value === 'Live at the show' && document.querySelector('input[aria-label="Show my named moments on video"]')?.checked === true && document.querySelectorAll('.clips article .moment-label input')[1]?.value === 'Final roar'`, "visual finish options");
        smokeStage("visual brief options ready");
        await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('.brief textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(input, 'A four-second energetic recap. Keep my selected section and choose the rest.'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Review my plan').click()`);
        await waitFor(`(() => { const plan = document.querySelector('.brief-review h3'); return plan && plan.textContent.includes('recap') && plan.textContent.includes('energetic') && plan.textContent.includes('your marked sections stay') })()`, "interpreted creative brief");
        smokeStage("brief interpreted");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Make my first cut').click()`);
        await waitFor(`document.body.innerText.includes('First cut ready:')`, "first cut");
        smokeStage("first cut planned");
        await win.webContents.executeJavaScript(`document.querySelector('.clips article .refine-actions button').click()`);
        await waitFor(`document.body.innerText.includes('Other sections stayed the same')`, "first-cut adjustment");
        await win.webContents.executeJavaScript(`document.querySelector('.draft-heading button').click()`);
        await waitFor(`document.body.innerText.includes('Draft preview is ready')`, "assembled draft render");
        await waitFor(`(() => { const v=document.querySelector('.draft-player'); return v && v.videoWidth > 0 && v.readyState >= 1 })()`, "assembled draft picture");
        smokeStage("draft picture ready");
        const draftSize = await win.webContents.executeJavaScript(`(() => { const v=document.querySelector('.draft-player'); return [v.videoWidth,v.videoHeight] })()`);
        if (draftSize[0] !== 360 || draftSize[1] !== 520) throw new Error(`9:13 draft video shape was wrong: ${draftSize}`);
        await win.webContents.executeJavaScript(`document.querySelector('.draft-player').currentTime = 0.4`);
        await waitFor(`(() => { const v=document.querySelector('.draft-player'); return !v.seeking && Math.abs(v.currentTime - 0.4) < 0.15 && v.readyState >= 2 })()`, "portrait draft frame");
        const countDraftWhite = async (time: number, area: "title" | "label") => {
          await win.webContents.executeJavaScript(`document.querySelector('.draft-player').currentTime = ${time}`);
          await waitFor(`(() => { const v=document.querySelector('.draft-player'); return !v.seeking && Math.abs(v.currentTime - ${time}) < 0.16 && v.readyState >= 2 })()`, `${area} in assembled draft`);
          return win.webContents.executeJavaScript(`(() => { const v=document.querySelector('.draft-player'), c=document.createElement('canvas'); c.width=v.videoWidth; c.height=v.videoHeight; const x=c.getContext('2d'); x.drawImage(v,0,0); const d=x.getImageData(0,0,c.width,c.height).data; let white=0; for(let y=Math.floor(c.height*${area === "title" ? 0.09 : 0.55}); y<Math.floor(c.height*${area === "title" ? 0.34 : 0.88}); y++) for(let px=Math.floor(c.width*0.03); px<Math.floor(c.width*0.95); px++) { const i=(y*c.width+px)*4; if(d[i]>210&&d[i+1]>210&&d[i+2]>210) white++; } return white; })()`);
        };
        const labelTime = await win.webContents.executeJavaScript(`(() => {
          const [first, second] = Array.from(document.querySelectorAll('.clips article')).filter((article) => article.querySelector('input[type="checkbox"]')?.checked);
          if (!first || !second) throw new Error('Expected two selected recordings for the named-moment check');
          const range = (article) => Number(article.querySelector('input[aria-label$=" end"]').value) - Number(article.querySelector('input[aria-label$=" start"]').value);
          const firstLength = range(first), total = firstLength + range(second);
          return Math.min(total - 0.25, Math.max(2.8, firstLength + 0.55));
        })()`);
        const titlePixels = await countDraftWhite(0.8, "title");
        const labelPixels = await countDraftWhite(labelTime, "label");
        if (titlePixels < 20 || labelPixels < 20) throw new Error(`Visual title or named moment was absent from assembled draft: ${JSON.stringify({ titlePixels, labelPixels, labelTime })}`);
        smokeStage("visual draft overlay ready");
        await win.webContents.executeJavaScript(`document.querySelector('.draft-player').currentTime = 0.4`);
        await waitFor(`(() => { const v=document.querySelector('.draft-player'); return !v.seeking && Math.abs(v.currentTime - 0.4) < 0.15 && v.readyState >= 2 })()`, "portrait draft frame after overlay check");
        const centerCropEdge = await win.webContents.executeJavaScript(`(() => { const v=document.querySelector('.draft-player'), c=document.createElement('canvas'); c.width=v.videoWidth; c.height=v.videoHeight; const x=c.getContext('2d'); x.drawImage(v,0,0); return Array.from(x.getImageData(5,Math.floor(v.videoHeight/2),1,1).data).slice(0,3) })()`);
        if (centerCropEdge[0] < 60 || centerCropEdge[0] < centerCropEdge[2] * 1.5 || centerCropEdge[0] < centerCropEdge[1] * 1.5) throw new Error(`Default portrait framing did not fill from the center: ${centerCropEdge}`);
        smokeStage("landscape source filled portrait frame");
        const protectedStart = await win.webContents.executeJavaScript(`(() => { const clip = document.querySelectorAll('.clips article')[1]; if (!clip.querySelector('.trim-heading input[type=checkbox]').checked) throw new Error('Marked section was unlocked'); return Number(clip.querySelector('input[aria-label$=" start"]').value) })()`);
        if (protectedStart < 0.8 || protectedStart > 1.2) throw new Error(`Marked section moved: ${protectedStart}`);
        await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('.clips article input[aria-label^="Aim portrait crop for "]'); if (!input) throw new Error('Portrait aim control was missing'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(input,'0'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await waitFor(`document.querySelector('.clips article input[aria-label^="Aim portrait crop for "]')?.value === '0' && !!document.querySelector('.draft-stale')`, "portrait aim change");
        await win.webContents.executeJavaScript(`document.querySelector('.draft-heading button').click()`);
        await waitFor(`document.body.innerText.includes('Draft preview is ready') && !!document.querySelector('.draft-player') && !document.querySelector('.draft-stale')`, "aimed portrait draft");
        await waitFor(`(() => { const v=document.querySelector('.draft-player'); return v.videoWidth === 360 && v.videoHeight === 520 && v.readyState >= 1 })()`, "aimed portrait picture");
        await win.webContents.executeJavaScript(`document.querySelector('.draft-player').currentTime = 0.4`);
        await waitFor(`(() => { const v=document.querySelector('.draft-player'); return !v.seeking && Math.abs(v.currentTime - 0.4) < 0.15 && v.readyState >= 2 })()`, "aimed portrait frame");
        const leftCropEdge = await win.webContents.executeJavaScript(`(() => { const v=document.querySelector('.draft-player'), c=document.createElement('canvas'); c.width=v.videoWidth; c.height=v.videoHeight; const x=c.getContext('2d'); x.drawImage(v,0,0); return Array.from(x.getImageData(5,Math.floor(v.videoHeight/2),1,1).data).slice(0,3) })()`);
        if (leftCropEdge[2] < 60 || leftCropEdge[2] < leftCropEdge[0] * 1.5 || leftCropEdge[2] < leftCropEdge[1] * 1.5) throw new Error(`Portrait aim did not shift the rendered crop left: ${leftCropEdge}`);
        smokeStage("portrait aim changed rendered picture");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Widescreen')).click(); Array.from(document.querySelectorAll('.options label')).find(label => label.textContent.includes('Reduce low rumble')).querySelector('input[type=checkbox]').click()`);
        await waitFor(`!!document.querySelector('.draft-stale')`, "draft invalidation after settings change");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save project').click()`);
        await waitFor(`document.body.innerText.includes('Project saved:')`, "project save");
        await access(process.env.COMPASS_SMOKE_PROJECT!);
        const savedProject = JSON.parse(await readFile(process.env.COMPASS_SMOKE_PROJECT!, "utf8"));
        if (savedProject.clips?.find((clip: { asset: MediaAsset }) => clip.asset.name.includes("compass-second"))?.focus !== 0) throw new Error("Saved project lost portrait aim.");
        if (savedProject.options?.eventTitle !== "Live at the show" || savedProject.options?.showClipLabels !== true ||
          savedProject.clips?.find((clip: { asset: MediaAsset }) => clip.asset.name.includes("compass-second"))?.label !== "Opening energy" ||
          savedProject.clips?.find((clip: { asset: MediaAsset }) => clip.asset.name.includes("compass-synthetic-input"))?.label !== "Final roar") {
          throw new Error("Saved project lost its event title or named moments.");
        }
        smokeStage("project saved");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Open project').click()`);
        await waitFor(`document.body.innerText.includes('Project opened. Your sections and protected moments are ready.')`, "project open");
        const restored = await win.webContents.executeJavaScript(`(() => ({ description: document.querySelector('.brief textarea').value, locked: document.querySelectorAll('.clips article')[1].querySelector('.trim-heading input[type=checkbox]').checked, aspect: document.querySelector('.options button[aria-pressed="true"]').textContent, rumble: Array.from(document.querySelectorAll('.options label')).find(label => label.textContent.includes('Reduce low rumble')).querySelector('input[type=checkbox]').checked, title: document.querySelector('input[aria-label="Video title (optional)"]')?.value, namedMoments: document.querySelector('input[aria-label="Show my named moments on video"]')?.checked, labels: Array.from(document.querySelectorAll('.clips article .moment-label input')).map(input => input.value) }))()`);
        if (!restored.description.includes('energetic recap') || !restored.locked || !restored.aspect.includes('Widescreen') || !restored.rumble || restored.title !== 'Live at the show' || !restored.namedMoments || restored.labels.join() !== 'Opening energy,Final roar') throw new Error(`Project restore failed: ${JSON.stringify(restored)}`);
        smokeStage("visual options survived project reopen");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.options button')).find(b => b.textContent.includes('9:13')).click()`);
        await waitFor(`document.querySelector('.clips article input[aria-label^="Aim portrait crop for "]')?.value === '0'`, "restored portrait aim");
        smokeStage("portrait aim survived project reopen");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.options button')).find(b => b.textContent.includes('Widescreen')).click()`);
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Export MP4')).click()`);
        await waitFor(`(() => { const p = document.querySelector('.status progress'); return p && p.value > 0 && p.value < 1 })()`, "export progress");
        await win.webContents.executeJavaScript(`document.querySelector('.stop').click()`);
        await waitFor(`document.body.innerText.includes('Export stopped. Your selections are still here.')`, "cancellation");
        smokeStage("export cancelled");
        try { await access(process.env.COMPASS_SMOKE_OUTPUT!); throw new Error("Cancelled export exposed an output file"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Export MP4')).click()`);
        await waitFor(`document.body.innerText.includes('Finished MP4:')`, "export");
        smokeStage("export completed");
        if (process.env.COMPASS_SMOKE_CLEANUP_FAIL === "1") await waitFor(`document.body.innerText.includes('video is saved, but a temporary folder could not be removed')`, "cleanup warning");
        await access(process.env.COMPASS_SMOKE_OUTPUT!);
        const exportedTitlePixels = await brightOverlayPixels(process.env.COMPASS_SMOKE_OUTPUT!, 0.8, "crop=1000:200:60:60,format=gray");
        const exportedLabelPixels = await brightOverlayPixels(process.env.COMPASS_SMOKE_OUTPUT!, labelTime, "crop=1100:170:60:490,format=gray");
        if (exportedTitlePixels < 50 || exportedLabelPixels < 50) throw new Error(`Visual title or named moment was absent from exported video: ${JSON.stringify({ exportedTitlePixels, exportedLabelPixels, labelTime })}`);
        smokeStage("visual exported overlay ready");
        const outputProbe = JSON.parse(await run(ffprobe.path, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", process.env.COMPASS_SMOKE_OUTPUT!]));
        if (outputProbe.streams?.[0]?.width !== 1280 || outputProbe.streams?.[0]?.height !== 720) throw new Error("Widescreen output dimensions are incorrect");
        const color = await new Promise<Buffer>((resolve, reject) => {
          const child = spawn(ffmpegBinary, ["-v", "error", "-ss", "0.4", "-i", process.env.COMPASS_SMOKE_OUTPUT!, "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"], { windowsHide: true });
          const chunks: Buffer[] = []; child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk)); child.on("error", reject);
          child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("Could not inspect exported frame")));
        });
        if (color.length < 3 || color[0] < color[1] * 2 || color[0] < color[2] * 2) throw new Error(`Export order was wrong: ${color.toString("hex")}`);
        await win.webContents.executeJavaScript(`document.querySelectorAll('.clips article')[1].querySelector('.trim-heading input[type=checkbox]').click()`);
        await win.webContents.executeJavaScript(`(() => { const guided=document.querySelector('.brief-picture-toggle input'); if (!guided.checked) guided.click(); })()`);
        await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('.brief textarea'), set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(input,'Just this song, keep the performance intact.'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Review my plan').click()`);
        await waitFor(`document.body.innerText.includes('Which recording contains this song?')`, "one-song recording question");
        await win.webContents.executeJavaScript(`document.querySelector('.conflict .choices button').click()`);
        await waitFor(`document.body.innerText.includes('Recording chosen.')`, "one-song choice");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Review my plan').click()`);
        await waitFor(`(() => { const plan=document.querySelector('.brief-review h3'); return plan && plan.textContent.includes('one-recording performance') })()`, "one-song interpretation");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Make my first cut').click()`);
        await waitFor(`document.body.innerText.includes('First cut ready:') && document.body.innerText.includes('1 selected')`, "one-song first cut");
        await waitFor(`Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Export MP4' && !b.disabled) && document.querySelector('.brief-picture-toggle input')?.checked === false`, "intact performance ready for export");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save project').click()`);
        await waitFor(`document.body.innerText.includes('Project saved:')`, "intact project save");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Open project').click()`);
        await waitFor(`document.body.innerText.includes('Project opened.') && Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Export MP4' && !b.disabled)`, "intact project reopen remains exportable");
        smokeStage("intact performance ready after project reopen");
        await runFinishingSettingsSmoke(win, waitFor);
        smokeStage("smoke passed");
        console.log("Desktop creative brief, protected selection, first cut, refinement, project save/open and MP4 export passed"); clearTimeout(timer); app.exit(0);
      } catch (error) { smokeStage(`desktop smoke test failed: ${error instanceof Error ? error.stack : String(error)}`); console.error("Desktop smoke test failed", error); clearTimeout(timer); app.exit(1); }
    });
  }
}

async function finishingSmokeState(win: BrowserWindow) {
  return win.webContents.executeJavaScript(`(() => {
    const pressed = label => Array.from(document.querySelectorAll('.options button')).find(b => b.textContent === label)?.getAttribute('aria-pressed') === 'true';
    const articles = Array.from(document.querySelectorAll('.clips article'));
    return { phone: pressed('Phone 9:16 · default'), high: pressed('Best available · up to 1080p'),
      dissolve: pressed('Dissolve'), slide: pressed('Smooth slide'), cut: pressed('Straight cut'),
      crossfade: pressed('Blend sound'), overlap: Number(document.querySelector('input[aria-label="Sound overlap seconds"]')?.value),
      enhance: document.querySelector('input[aria-label="Gentle picture clarity"]')?.checked,
      beatSync: document.querySelector('input[aria-label="Follow the beat"]')?.checked,
      performance: document.querySelector('input[aria-label="Favor the performance"]')?.checked,
      title: document.querySelector('input[aria-label="Video title (optional)"]')?.value,
      labels: document.querySelector('input[aria-label="Show my named moments on video"]')?.checked,
      fill: articles.length > 0 && articles.every(article => Array.from(article.querySelectorAll('.frame-choice button')).find(b => b.textContent === 'Fill screen')?.getAttribute('aria-pressed') === 'true'),
      exportReady: document.querySelector('.toolbar-actions button.primary')?.disabled === false };
  })()`);
}

async function chooseSmokeOption(win: BrowserWindow, waitFor: (expression: string, label: string) => Promise<void>, label: string) {
  const literal = JSON.stringify(label);
  await win.webContents.executeJavaScript(`(() => { const button = Array.from(document.querySelectorAll('.options button')).find(b => b.textContent === ${literal}); if (!button || button.disabled) throw new Error('Finishing option unavailable: ' + ${literal}); button.click(); })()`);
  await waitFor(`Array.from(document.querySelectorAll('.options button')).some(b => b.textContent === ${literal} && b.getAttribute('aria-pressed') === 'true')`, label);
}

async function runFinishingSettingsSmoke(win: BrowserWindow, waitFor: (expression: string, label: string) => Promise<void>): Promise<void> {
  const before = parseProjectSnapshot(JSON.parse(await readFile(process.env.COMPASS_SMOKE_PROJECT!, "utf8")));
  const viewBefore = await win.webContents.executeJavaScript(`document.querySelector('.workflow .current')?.textContent`);
  for (const label of ["Follow the beat", "Favor the performance"]) {
    const selector = JSON.stringify(`input[aria-label="${label}"]`);
    await win.webContents.executeJavaScript(`document.querySelector(${selector}).click()`);
    await waitFor(`document.querySelector(${selector})?.checked === false`, `disabled ${label}`);
  }
  await waitFor(`document.querySelector('.toolbar-actions button.primary')?.disabled === true`, "changed music preferences require review");
  for (const label of ["Favor the performance", "Follow the beat"]) {
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.brief button')).find(b => b.textContent === 'Undo').click()`);
    const selector = JSON.stringify(`input[aria-label="${label}"]`);
    await waitFor(`document.querySelector(${selector})?.checked === true`, `undo ${label}`);
  }
  await waitFor(`document.querySelector('.toolbar-actions button.primary')?.disabled === false`, "music preference undo restored edit");
  if (await win.webContents.executeJavaScript(`document.querySelector('.workflow .current')?.textContent`) !== viewBefore) {
    throw new Error("Music preference undo did not restore the previous editor step.");
  }
  smokeStage("music preferences undo restored");
  const sections = (project: ProjectSnapshot) => JSON.stringify({
    picture: project.clips.map(c => [c.asset.path, c.start, c.end, c.included, c.locked, c.excludedByUser, c.selectionSource, c.orderLocked, c.framing, c.focus, c.label]),
    sound: project.audioSelections?.map(s => [s.asset.path, s.start, s.end, s.locked]) ?? null,
  });
  await chooseSmokeOption(win, waitFor, "Phone 9:16 · default");
  await chooseSmokeOption(win, waitFor, "Best available · up to 1080p");
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="Gentle picture clarity"]'); if (!input || input.disabled) throw new Error('Picture clarity control unavailable'); if (!input.checked) input.click(); })()`);
  await waitFor(`document.querySelector('input[aria-label="Gentle picture clarity"]')?.checked === true`, "picture clarity choice");
  await chooseSmokeOption(win, waitFor, "Blend sound");
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="Sound overlap seconds"]'); if (!input) throw new Error('Sound overlap control unavailable'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '1.5'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('input[aria-label="Sound overlap seconds"]')?.value === '1.5'`, "sound overlap choice");
  await chooseSmokeOption(win, waitFor, "Smooth slide");
  await win.webContents.executeJavaScript(`(() => { const button = Array.from(document.querySelectorAll('.brief button')).find(b => b.textContent === 'Undo'); if (!button || button.disabled) throw new Error('Finishing undo unavailable'); button.click(); })()`);
  await waitFor(`Array.from(document.querySelectorAll('.options button')).some(b => b.textContent === 'Straight cut' && b.getAttribute('aria-pressed') === 'true')`, "visual-transition undo");
  const undone = await finishingSmokeState(win);
  if (!undone.phone || !undone.high || !undone.cut || !undone.crossfade || undone.overlap !== 1.5 || undone.enhance !== true || !undone.exportReady) {
    throw new Error(`Undo changed unrelated finishing choices or export readiness: ${JSON.stringify(undone)}`);
  }
  smokeStage("finishing controls undo restored");
  await chooseSmokeOption(win, waitFor, "Smooth slide");
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save project').click()`);
  await waitFor(`document.body.innerText.includes('Project saved:')`, "finishing settings save");
  const saved = parseProjectSnapshot(JSON.parse(await readFile(process.env.COMPASS_SMOKE_PROJECT!, "utf8")));
  if (saved.options.aspect !== "vertical" || saved.options.quality !== "high" || saved.options.enhance !== true ||
    saved.options.audioTransition !== "crossfade" || saved.options.audioCrossfadeSeconds !== 1.5 || saved.options.transition !== "smoothslide" ||
    saved.briefInput.transition !== "smoothslide" || saved.options.beatSync !== true ||
    saved.options.highlightFocus !== "performance" || sections(saved) !== sections(before)) {
    throw new Error(`Saved finishing choices changed selections or lost settings: ${JSON.stringify(saved.options)}`);
  }
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Open project').click()`);
  await waitFor(`document.body.innerText.includes('Project opened.') && document.querySelector('.toolbar-actions button.primary')?.disabled === false`, "finishing settings reopen");
  const reopened = await finishingSmokeState(win);
  if (!reopened.phone || !reopened.high || !reopened.slide || !reopened.crossfade || reopened.overlap !== 1.5 ||
    reopened.enhance !== true || !reopened.exportReady || reopened.title !== (saved.options.eventTitle ?? "") ||
    reopened.labels !== (saved.options.showClipLabels ?? false) || !reopened.beatSync || !reopened.performance) {
    throw new Error(`Reopened finishing choices were wrong: ${JSON.stringify(reopened)}`);
  }
  smokeStage("finishing controls survived project reopen");
}

async function runSoundStorySmoke(win: BrowserWindow, waitFor: (expression: string, label: string) => Promise<void>): Promise<void> {
  const defaults = await win.webContents.executeJavaScript(`(() => ({
    separatePicture: document.querySelector('.brief-quick-choice input[type=checkbox]')?.checked,
    sound: document.querySelector('input[aria-label="Number of sound moments"]')?.value,
    picture: document.querySelector('input[aria-label="Number of videos to show"]')?.value,
    exportReady: !document.querySelector('.toolbar-actions button.primary')?.disabled,
    guidedMessage: document.querySelector('.toolbar .pending-badge')?.textContent
  }))()`);
  if (defaults.separatePicture !== true || defaults.sound !== "3" || defaults.picture !== "3" ||
    defaults.exportReady || !defaults.guidedMessage?.includes("Make a first cut")) {
    throw new Error(`Guided soundtrack defaults were wrong after importing three videos: ${JSON.stringify(defaults)}`);
  }
  smokeStage("story guided defaults ready");
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="Video title (optional)"]'); if (!input) throw new Error('Sound-led video title control was missing'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'Three-part night'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('input[aria-label="Video title (optional)"]')?.value === 'Three-part night'`, "sound-led event title");
  const description = "Make a six-second recap with three sound moments. Reduce low rumble, aim for a stronger ending, and show footage from several videos over that soundtrack.";
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('.brief textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(input, ${JSON.stringify(description)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Review my plan').click()`);
  await waitFor(`(() => { const plan = document.querySelector('.brief-review .story-plan'); return plan && plan.innerText.includes('Low-rumble reduction will be on.') })()`, "sound-led brief");
  const review = await win.webContents.executeJavaScript(`(() => ({ labels: Array.from(document.querySelectorAll('.brief-review .story-plan strong')).map(x => x.textContent), summary: document.querySelector('.brief-review h3').textContent, conflict: !!document.querySelector('.brief-review .conflict'), ready: !Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Make my first cut').disabled }))()`);
  if (review.labels.join() !== "Soundtrack,Picture" || !review.summary.includes("3 audio moments") ||
    !review.summary.includes("strongest measured ending") || !review.summary.includes("picture from 3 recordings") ||
    review.conflict || !review.ready) throw new Error(`Plain-language sound-led brief was wrong: ${JSON.stringify(review)}`);
  smokeStage("story plain-language brief reviewed");

  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.brief-review button')).find(b => b.textContent === 'Adjust').click()`);
  await waitFor(`document.querySelector('.brief-quick-choice input[type=checkbox]')?.checked === true`, "separate soundtrack quick choice");
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="Number of sound moments"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '2'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('input[aria-label="Number of sound moments"]')?.value === '2'`, "temporary sound moment count");
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="Number of sound moments"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '3'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('input[aria-label="Number of sound moments"]')?.value === '3'`, "explicit sound moment count");
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="Number of videos to show"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '2'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('input[aria-label="Number of videos to show"]')?.value === '2'`, "explicit picture video count");
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Review my plan').click()`);
  await waitFor(`(() => { const plan = document.querySelector('.brief-review .story-plan'); return plan && plan.innerText.includes('Low-rumble reduction will be on.') })()`, "explicit sound-led brief");
  const overrideReview = await win.webContents.executeJavaScript(`(() => ({ labels: Array.from(document.querySelectorAll('.brief-review .story-plan strong')).map(x => x.textContent), summary: document.querySelector('.brief-review h3').textContent, ready: !Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Make my first cut').disabled }))()`);
  if (overrideReview.labels.join() !== "Soundtrack,Picture" || !overrideReview.summary.includes("3 audio moments") ||
    !overrideReview.summary.includes("strongest measured ending") || !overrideReview.summary.includes("picture from 2 recordings") || !overrideReview.ready) {
    throw new Error(`Explicit soundtrack and picture counts were not applied: ${JSON.stringify(overrideReview)}`);
  }
  smokeStage("story brief reviewed");

  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Make my first cut').click()`);
  await waitFor(`document.body.innerText.includes('First cut ready:') && document.querySelectorAll('.soundtrack-list li').length === 3`, "three-part first cut");
  const firstCut = await win.webContents.executeJavaScript(`(() => ({ toolbar: document.querySelector('.toolbar b').textContent, moments: Array.from(document.querySelectorAll('.soundtrack-list li small')).map(x => x.textContent), lowRumble: document.querySelector('.soundtrack-note').textContent }))()`);
  const pictureCount = Number(/^([0-9]+) videos to show/.exec(firstCut.toolbar)?.[1]);
  if (pictureCount !== 2 || !firstCut.toolbar.includes("3 sound moments") ||
    !firstCut.lowRumble.includes("Very low rumble will be reduced")) throw new Error(`Sound-led first cut was wrong: ${JSON.stringify(firstCut)}`);
  smokeStage("story first cut planned");

  await win.webContents.executeJavaScript(`document.querySelector('.draft-heading button').click()`);
  await waitFor(`document.body.innerText.includes('Draft preview is ready')`, "sound-led draft render");
  await waitFor(`(() => { const v=document.querySelector('.draft-player'); return v && v.videoWidth === 360 && v.videoHeight === 520 && v.readyState >= 1 })()`, "sound-led 9:13 draft picture");
  smokeStage("story draft picture ready");

  await win.webContents.executeJavaScript(`document.querySelector('.soundtrack-list li .sound-actions button:nth-child(2)').click()`);
  await waitFor(`document.body.innerText.includes('Chose another sound moment')`, "sound moment replacement");
  const adjusted = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.soundtrack-list li small')).map(x => x.textContent)`);
  if (adjusted.length !== 3 || adjusted[0] === firstCut.moments[0] ||
    adjusted[0].split('·').at(-1) !== firstCut.moments[0].split('·').at(-1) ||
    adjusted[1] !== firstCut.moments[1] || adjusted[2] !== firstCut.moments[2]) {
    throw new Error(`Sound refinement changed the wrong moments: ${JSON.stringify({ before: firstCut.moments, after: adjusted })}`);
  }
  smokeStage("story sound adjusted");
  await win.webContents.executeJavaScript(`document.querySelector('.draft-heading button').click()`);
  await waitFor(`document.body.innerText.includes('Draft preview is ready')`, "adjusted sound-led draft render");
  await waitFor(`(() => { const v=document.querySelector('.draft-player'); return v && v.videoWidth === 360 && v.videoHeight === 520 && v.readyState >= 1 })()`, "adjusted sound-led 9:13 draft picture");
  smokeStage("story adjusted draft picture ready");

  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save project').click()`);
  await waitFor(`document.body.innerText.includes('Project saved:')`, "sound-led project save");
  const saved = JSON.parse(await readFile(process.env.COMPASS_SMOKE_PROJECT!, "utf8"));
  if (saved.version !== 2 || saved.audioSelections?.length !== 3 || saved.options?.aspect !== "portrait913" || saved.options?.reduceRumble !== true ||
    saved.options?.eventTitle !== "Three-part night" || saved.options?.showClipLabels !== false ||
    saved.briefInput?.separatePicture !== true || saved.briefInput?.soundMomentCount !== 3 ||
    saved.briefInput?.pictureSourceCount !== 2 || !saved.briefInput?.description.includes("three sound moments")) {
    throw new Error("Saved project lost the explicit soundtrack or picture counts, brief, or sound moments.");
  }
  smokeStage("story project saved");
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Open project').click()`);
  await waitFor(`document.body.innerText.includes('Project opened') && document.querySelector('.toolbar b')?.textContent.includes('3 sound moments') && document.querySelectorAll('.soundtrack-list li').length === 3 && !!document.querySelector('.draft-heading button')`, "sound-led project reopen");
  const restored = await win.webContents.executeJavaScript(`(() => ({ description: document.querySelector('.brief textarea').value, soundCount: document.querySelector('input[aria-label="Number of sound moments"]')?.value, pictureCount: document.querySelector('input[aria-label="Number of videos to show"]')?.value, toolbar: document.querySelector('.toolbar b').textContent, soundMoments: document.querySelectorAll('.soundtrack-list li').length, previewAction: document.querySelector('.draft-heading button')?.textContent, staleDraft: !!document.querySelector('.draft-player'), exportReady: !document.querySelector('.toolbar-actions button.primary').disabled, title: document.querySelector('input[aria-label="Video title (optional)"]')?.value, labelsEnabled: document.querySelector('input[aria-label="Show my named moments on video"]')?.checked }))()`);
  if (!restored.description.includes("three sound moments") || restored.soundCount !== "3" || restored.pictureCount !== "2" ||
    !restored.toolbar.includes("3 sound moments") || restored.soundMoments !== 3 || restored.previewAction !== "Watch first cut" || restored.staleDraft || !restored.exportReady || restored.title !== "Three-part night" || restored.labelsEnabled) {
    throw new Error(`Reopened project lost its soundtrack: ${JSON.stringify(restored)}`);
  }
  smokeStage("story project reopened");

  // The legacy smoke deliberately slows its first export to exercise cancellation.
  smokeCancelPending = false;
  await win.webContents.executeJavaScript(`document.querySelector('.toolbar-actions button.primary').click()`);
  await waitFor(`document.body.innerText.includes('Finished MP4:')`, "sound-led MP4 export");
  await access(process.env.COMPASS_SMOKE_OUTPUT!);
  const probe = JSON.parse(await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,duration", "-of", "json", process.env.COMPASS_SMOKE_OUTPUT!]));
  const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === "audio");
  if (video?.codec_name !== "h264" || video.width !== 720 || video.height !== 1040 || audio?.codec_name !== "aac" ||
    Math.abs(Number(probe.format?.duration) - 6) > 0.25 || Number(audio.duration) < 5.85) {
    throw new Error(`Sound-led MP4 did not have six seconds of picture and sound: ${JSON.stringify(probe)}`);
  }
  await run(ffmpegBinary, ["-v", "error", "-i", process.env.COMPASS_SMOKE_OUTPUT!, "-f", "null", "-"]);
  const titlePixels = await brightOverlayPixels(process.env.COMPASS_SMOKE_OUTPUT!, 0.8, "crop=640:230:40:90,format=gray");
  if (titlePixels < 50) throw new Error(`Sound-led video title was absent from the exported picture: ${titlePixels}`);
  smokeStage("story title exported");
  smokeStage("story export completed");
}

async function brightOverlayPixels(video: string, time: number, filter: string): Promise<number> {
  const pixels = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpegBinary, ["-v", "error", "-ss", String(time), "-i", video, "-frames:v", "1", "-vf", filter, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { windowsHide: true });
    const chunks: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-1200); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error || "Could not inspect visual finish")));
  });
  if (!pixels.length) throw new Error("Visual finish frame was empty.");
  let bright = 0;
  for (const pixel of pixels) if (pixel > 220) bright++;
  return bright;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `Process stopped (${code}).`)));
  });
}

async function assertOutputIsNotOriginal(output: string): Promise<void> {
  for (const sourcePath of selectedFiles.values()) {
    if (path.resolve(sourcePath).toLowerCase() === output.toLowerCase()) throw new Error("Choose a different name from your original video.");
    try {
      const [source, target] = await Promise.all([stat(sourcePath), stat(output)]);
      if (source.dev === target.dev && source.ino === target.ino) throw new Error("Choose a different name from your original video.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function runPlannedRender(event: IpcMainInvokeEvent, args: string[], totalSeconds: number, stoppedMessage: string): Promise<void> {
  if (activeRender) throw new Error("Another video is still being prepared.");
  cancelRender = false;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBinary, args, { windowsHide: true });
    activeRender = child;
    let stderr = "", progressBuffer = "";
    child.stderr.on("data", (data) => (stderr += data));
    child.stdout.on("data", (data) => {
      progressBuffer += data.toString();
      const lines = progressBuffer.split(/\r?\n/); progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_ms=(\d+)/.exec(line);
        if (match) event.sender.send("media:progress", Math.min(0.99, Number(match[1]) / 1_000_000 / totalSeconds));
      }
    });
    child.once("error", (error) => { activeRender = undefined; reject(error); });
    child.once("close", (code) => {
      activeRender = undefined;
      code === 0 && !cancelRender ? resolve() : reject(new Error(cancelRender ? stoppedMessage : stderr || `FFmpeg stopped (${code}).`));
    });
  });
}

ipcMain.handle("media:pick", async () => {
  const result = smoke ? { canceled: false, filePaths: [process.env.COMPASS_SMOKE_INPUT!, process.env.COMPASS_SMOKE_SECOND!, ...(smokeStory ? [process.env.COMPASS_SMOKE_THIRD!] : [])] } : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], filters: [{ name: "Video", extensions: ["mov", "mp4", "m4v", "avi", "mkv"] }] });
  if (result.canceled) return [];
  return result.filePaths.map((filePath) => {
    const id = randomUUID();
    selectedFiles.set(id, filePath);
    return { path: filePath, id };
  });
});

ipcMain.handle("project:save", async (_event, candidate: unknown) => {
  const snapshot = parseProjectSnapshot(candidate);
  if (snapshot.clips.some((clip) => ![...selectedFiles.values()].includes(clip.asset.path))) {
    throw new Error("Import these recordings before saving the project.");
  }
  const destination = smoke ? { canceled: false, filePath: process.env.COMPASS_SMOKE_PROJECT! } : await dialog.showSaveDialog({
    defaultPath: "Concert Compass Project.compass.json",
    filters: [{ name: "Concert Compass project", extensions: ["json"] }],
  });
  if (destination.canceled || !destination.filePath) return { cancelled: true };
  const output = path.resolve(destination.filePath);
  for (const sourcePath of selectedFiles.values()) {
    if (path.resolve(sourcePath).toLowerCase() === output.toLowerCase()) {
      throw new Error("Choose a project name different from your original video.");
    }
    try {
      const [source, target] = await Promise.all([stat(sourcePath), stat(output)]);
      if (source.dev === target.dev && source.ino === target.ino) {
        throw new Error("Choose a project name different from your original video.");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const temporary = path.join(path.dirname(output), `.compass-project-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { cancelled: false, path: output };
});

ipcMain.handle("project:open", async () => {
  const source = smoke ? { canceled: false, filePaths: [process.env.COMPASS_SMOKE_PROJECT!] } : await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Concert Compass project", extensions: ["json"] }],
  });
  if (source.canceled || !source.filePaths[0]) return null;
  const projectPath = source.filePaths[0];
  if ((await stat(projectPath)).size > 1024 * 1024) throw new Error("This project file is too large to open.");
  let snapshot: ProjectSnapshot;
  try { snapshot = parseProjectSnapshot(JSON.parse(await readFile(projectPath, "utf8"))); }
  catch (error) { throw new Error(`Could not open this project: ${error instanceof Error ? error.message : String(error)}`); }
  const missing: string[] = [];
  for (const clip of snapshot.clips) {
    const filePath = clip.asset.path;
    if (!path.isAbsolute(filePath) || !/[.](mov|mp4|m4v|avi|mkv)$/i.test(filePath)) {
      throw new Error(`The project has an invalid recording path: ${clip.asset.name}.`);
    }
    try { if (!(await stat(filePath)).isFile()) missing.push(clip.asset.name); }
    catch { missing.push(clip.asset.name); }
  }
  if (missing.length) throw new Error(`These recordings could not be found: ${missing.join(", ")}. Reconnect or download them, then open the project again.`);
  const files = snapshot.clips.map((clip) => {
    const id = randomUUID();
    selectedFiles.set(id, clip.asset.path);
    return { path: clip.asset.path, id };
  });
  return { snapshot, files };
});

ipcMain.handle("media:preview", async (_event, id: string) => {
  const source = selectedFiles.get(id);
  if (!source) throw new Error("Choose the video in the file picker first.");
  previewDirectory ??= await mkdtemp(path.join(tmpdir(), "concert-compass-preview-"));
  const output = path.join(previewDirectory, `${id}.mp4`);
  try {
    await runPlannedRender(_event, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source,
      "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-r", "24", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", output],
      probedDurations.get(source) ?? 1, "Preview stopped. Your recordings are safe.");
    previews.set(id, output);
    return `compass-media://preview/${id}`;
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  }
});

ipcMain.handle("media:probe", async (_event, filePath: string): Promise<MediaAsset> => {
  if (![...selectedFiles.values()].includes(filePath)) throw new Error("Choose the video in the file picker first.");
  const raw = await run(ffprobe.path, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath]);
  const data = JSON.parse(raw);
  const streams = data.streams ?? [];
  const video = streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  const audio = streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
  const dimensions = video ? displayDimensions(video) : { width: 0, height: 0 };
  const duration = Number(data.format?.duration ?? 0);
  const audioDuration = Number(audio?.duration);
  const asset = { path: filePath, name: path.basename(filePath), duration,
    width: dimensions.width, height: dimensions.height, hasAudio: !!audio,
    ...(Number.isFinite(audioDuration) && audioDuration > 0 ? { audioDuration: Math.min(duration, audioDuration) } : {}) };
  probedDurations.set(filePath, asset.duration);
  return asset;
});

function analyzeImportedAudio(asset: MediaAsset, reduceRumble = false): Promise<AudioBin[]> {
  if (!asset?.path || ![...selectedFiles.values()].includes(asset.path)) throw new Error("Choose the video in the file picker first.");
  if (typeof reduceRumble !== "boolean") throw new Error("Choose a valid sound setting.");
  if (!asset.hasAudio) return Promise.resolve([]);
  const key = JSON.stringify([asset.path, reduceRumble]);
  const cached = audioBins.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingAudio.get(key);
  if (pending) return pending;
  const analysis = measureAudio(ffmpegBinary, asset.path, reduceRumble).then((bins) => {
    audioBins.set(key, bins);
    return bins;
  }).finally(() => pendingAudio.delete(key));
  pendingAudio.set(key, analysis);
  return analysis;
}

ipcMain.handle("media:analyze-audio", (_event, asset: MediaAsset, reduceRumble?: boolean) => analyzeImportedAudio(asset, reduceRumble));

ipcMain.handle("media:suggest", async (_event, asset: MediaAsset, highlightFocus: "balanced" | "performance" = "balanced") => {
  if (!["balanced", "performance"].includes(highlightFocus)) throw new Error("Choose a valid highlight preference.");
  const bins = await analyzeImportedAudio(asset, false);
  return chooseAudioHighlight(asset, bins, 0.5, highlightFocus);
});

async function writeVisualOverlay(directory: string, name: string, selections: RenderSelection[],
  options: ExportOptions, profile: "draft" | "export", soundLed: boolean): Promise<string | undefined> {
  const { width, height } = renderDimensions(options, profile, selections.map(s => s.asset));
  let offset = 0;
  const labels = selections.flatMap((selection) => {
    const start = offset;
    const duration = selection.end - selection.start;
    offset += duration;
    return !soundLed && options.showClipLabels && selection.label?.trim() ?
      [{ text: selection.label, start, duration }] : [];
  });
  const script = buildOverlayAss({ eventTitle: options.eventTitle, labels, width, height,
    style: options.finish ?? "natural" });
  if (!script) return undefined;
  const file = path.join(directory, name);
  await writeFile(file, script, "utf8");
  return file;
}

ipcMain.handle("media:preview-cut", async (event, selections: RenderSelection[], options: ExportOptions, audioSelections?: AudioSelection[]) => {
  if (activeRender) throw new Error("Another video is still being prepared.");
  const imported = new Set(selectedFiles.values());
  if (!Array.isArray(selections) || selections.some((selection) => !imported.has(selection?.asset?.path)) ||
    (audioSelections !== undefined && (!Array.isArray(audioSelections) || audioSelections.some((selection) => !imported.has(selection?.asset?.path))))) {
    throw new Error("Choose the videos in the file picker first.");
  }
  const key = JSON.stringify({ sections: selections.map((selection) => ({ path: selection.asset.path, start: selection.start,
    end: selection.end, framing: selection.framing, focus: selection.focus, locked: selection.locked, label: selection.label })),
    audio: audioSelections?.map((selection) => ({ path: selection.asset.path, start: selection.start, end: selection.end, locked: selection.locked })) ?? null,
    options });
  const existing = draftKeys.get(key);
  if (existing && drafts.has(existing)) {
    try { await access(drafts.get(existing)!); return { url: `compass-media://draft/${existing}` }; }
    catch { draftKeys.delete(key); drafts.delete(existing); }
  }
  previewDirectory ??= await mkdtemp(path.join(tmpdir(), "concert-compass-preview-"));
  const id = randomUUID();
  const output = path.join(previewDirectory, `draft-${id}.mp4`);
  let overlayFile: string | undefined;
  try {
    overlayFile = await writeVisualOverlay(previewDirectory, `draft-${id}.ass`, selections, options, "draft", audioSelections !== undefined);
    const { args, totalSeconds } = audioSelections === undefined ? buildRenderCommand(selections, output, options, "draft", overlayFile) :
      buildAudioLedRenderCommand(selections, audioSelections, output, options, "draft", overlayFile);
    await runPlannedRender(event, args, totalSeconds, "Preview stopped. Your edit is still here.");
    const probe = JSON.parse(await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,duration", "-of", "json", output]));
    validateRenderedOutput(probe, totalSeconds, "preview");
    drafts.set(id, output); draftKeys.set(key, id);
    event.sender.send("media:progress", 1);
    return { url: `compass-media://draft/${id}` };
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (overlayFile) await rm(overlayFile, { force: true }).catch(() => {});
  }
});

ipcMain.handle("media:render", async (event, selections: RenderSelection[], options: ExportOptions, audioSelections?: AudioSelection[]) => {
  if (activeRender) throw new Error("A video is already being exported.");
  const imported = new Set(selectedFiles.values());
  if (!Array.isArray(selections) || selections.some((selection) => !imported.has(selection?.asset?.path)) ||
    (audioSelections !== undefined && (!Array.isArray(audioSelections) || audioSelections.some((selection) => !imported.has(selection?.asset?.path))))) {
    throw new Error("Choose the videos in the file picker first.");
  }
  const destination = smoke ? { canceled: false, filePath: process.env.COMPASS_SMOKE_OUTPUT! } : await dialog.showSaveDialog({ defaultPath: "Concert Compass Reel.mp4", filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
  if (destination.canceled || !destination.filePath) return { cancelled: true };
  const output = path.resolve(destination.filePath);
  await assertOutputIsNotOriginal(output);
  const tempDir = await mkdtemp(path.join(tmpdir(), "concert-compass-export-"));
  const temporaryOutput = path.join(tempDir, `${randomUUID()}.mp4`);
  const { cleanupWarning } = await withTemporaryCleanup(tempDir, async () => {
  const overlayFile = await writeVisualOverlay(tempDir, "visual-overlays.ass", selections, options, "export", audioSelections !== undefined);
  const { args, totalSeconds } = audioSelections === undefined ? buildRenderCommand(selections, temporaryOutput, options, "export", overlayFile) :
    buildAudioLedRenderCommand(selections, audioSelections, temporaryOutput, options, "export", overlayFile);
  if (smoke && smokeCancelPending) { args.splice(2, 0, "-re"); smokeCancelPending = false; }
  await runPlannedRender(event, args, totalSeconds, "Export stopped. Your selections are still here.");
  const probe = JSON.parse(await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,duration", "-of", "json", temporaryOutput]));
  validateRenderedOutput(probe, totalSeconds, "export");
  await commitOutput(temporaryOutput, output, () => assertOutputIsNotOriginal(output));
  event.sender.send("media:progress", 1);
  }, smoke && process.env.COMPASS_SMOKE_CLEANUP_FAIL === "1" ? async () => { throw new Error("Simulated temporary-folder permission error"); } : undefined);
  return { cancelled: false, output, cleanupWarning };
});

ipcMain.handle("media:cancel-render", () => {
  if (!activeRender) return false;
  cancelRender = true;
  return activeRender.kill();
});

app.whenReady().then(() => {
  smokeStage("electron ready");
  protocol.handle("compass-media", async (request) => {
    const url = new URL(request.url);
    const file = url.hostname === "preview" ? previews.get(url.pathname.slice(1)) :
      url.hostname === "draft" ? drafts.get(url.pathname.slice(1)) : undefined;
    if (!file) return new Response("Not found", { status: 404 });
    return previewResponse(file, request);
  });
  createWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
let cleaning = false;
app.on("before-quit", (event) => {
  if (cleaning || !previewDirectory) return;
  event.preventDefault(); cleaning = true;
  void rm(previewDirectory, { recursive: true, force: true }).catch(() => {}).finally(() => app.quit());
});
