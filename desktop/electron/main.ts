import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildRenderCommand, type ExportOptions, type MediaAsset, type RenderSelection } from "../src/shared/render-plan.js";
import { previewResponse } from "./preview-stream.js";
import { measureAudio } from "./audio-analysis.js";
import { chooseAudioHighlight } from "../src/shared/suggestions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.COMPASS_DEV === "1";
const ffmpegBinary = ffmpegPath as unknown as string;
const selectedFiles = new Map<string, string>();
const previews = new Map<string, string>();
let previewDirectory: string | undefined;
let activeRender: ChildProcess | undefined;
let cancelRender = false;
let smokeCancelPending = true;
const smoke = process.env.COMPASS_SMOKE_TEST === "1";
protocol.registerSchemesAsPrivileged([{ scheme: "compass-media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);

function createWindow() {
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
    const timer = setTimeout(() => { console.error("Desktop smoke test timed out"); app.exit(1); }, 90000);
    win.webContents.once("did-fail-load", (_event, code, description) => { console.error(`Page load failed: ${code} ${description}`); clearTimeout(timer); app.exit(1); });
    win.webContents.once("did-finish-load", async () => {
      try {
        const state = await win.webContents.executeJavaScript(`({title: document.title, bridge: typeof window.concertCompass?.pickVideos, root: !!document.getElementById('root')})`);
        if (state.title !== "Concert Compass" || state.bridge !== "function" || !state.root) throw new Error(JSON.stringify(state));
        await win.webContents.executeJavaScript(`document.querySelector('button.primary').click()`);
        const waitFor = async (expression: string, label: string) => {
          for (let attempt = 0; attempt < 300; attempt++) {
            if (await win.webContents.executeJavaScript(expression)) return;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          throw new Error(`Timed out waiting for ${label}`);
        };
        await waitFor(`document.body.innerText.includes('2 selected')`, "import");
        await waitFor(`(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0 && v.readyState >= 2 })()`, "video picture");
        const picture = await win.webContents.executeJavaScript(`(() => { try { const v=document.querySelector('video'), c=document.createElement('canvas'); c.width=8; c.height=8; c.getContext('2d').drawImage(v,0,0,8,8); return Array.from(c.getContext('2d').getImageData(0,0,8,8).data).some((n,i)=>i%4!==3 && n>20) } catch(e) { return String(e) } })()`);
        if (typeof picture === "string") throw new Error(`Picture inspection failed: ${picture}`);
        if (!picture) throw new Error("Preview has no visible picture");
        await win.webContents.executeJavaScript(`document.querySelector('video').currentTime = 2`);
        await waitFor(`(() => { const v = document.querySelector('video'); return !v.seeking && Math.abs(v.currentTime - 2) < 0.15 && v.readyState >= 2 })()`, "seeking forward");
        await win.webContents.executeJavaScript(`document.querySelector('video').currentTime = 0.5`);
        await waitFor(`(() => { const v = document.querySelector('video'); return !v.seeking && Math.abs(v.currentTime - 0.5) < 0.15 && v.readyState >= 2 })()`, "seeking backward");
        await win.webContents.executeJavaScript(`document.querySelector('button[aria-label^="Forward five seconds"]').click()`);
        await waitFor(`(() => { const v = document.querySelector('video'); return !v.seeking && v.currentTime > 2.8 })()`, "forward button");
        await win.webContents.executeJavaScript(`document.querySelector('button[aria-label^="Back five seconds"]').click()`);
        await waitFor(`(() => { const v = document.querySelector('video'); return !v.seeking && v.currentTime < 0.2 })()`, "back button");
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Suggest a moment').click()`);
        await waitFor(`document.body.innerText.includes('Suggested for stronger sound energy')`, "sound-based suggestion");
        await win.webContents.executeJavaScript(`document.querySelectorAll('button[aria-label^="Move "]')[2].click()`);
        const firstName = await win.webContents.executeJavaScript(`document.querySelector('.clips article h2').textContent`);
        if (!firstName.includes('compass-second')) throw new Error(`Reorder failed: ${firstName}`);
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Widescreen')).click(); document.querySelector('.options input[type=checkbox]').click()`);
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Export MP4')).click()`);
        await waitFor(`(() => { const p = document.querySelector('.status progress'); return p && p.value > 0 && p.value < 1 })()`, "export progress");
        await win.webContents.executeJavaScript(`document.querySelector('.stop').click()`);
        await waitFor(`document.body.innerText.includes('Export stopped. Your selections are still here.')`, "cancellation");
        try { await access(process.env.COMPASS_SMOKE_OUTPUT!); throw new Error("Cancelled export exposed an output file"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Export MP4')).click()`);
        await waitFor(`document.body.innerText.includes('Finished MP4:')`, "export");
        await access(process.env.COMPASS_SMOKE_OUTPUT!);
        const outputProbe = JSON.parse(await run(ffprobe.path, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", process.env.COMPASS_SMOKE_OUTPUT!]));
        if (outputProbe.streams?.[0]?.width !== 1280 || outputProbe.streams?.[0]?.height !== 720) throw new Error("Widescreen output dimensions are incorrect");
        const color = await new Promise<Buffer>((resolve, reject) => {
          const child = spawn(ffmpegBinary, ["-v", "error", "-ss", "0.4", "-i", process.env.COMPASS_SMOKE_OUTPUT!, "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"], { windowsHide: true });
          const chunks: Buffer[] = []; child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk)); child.on("error", reject);
          child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("Could not inspect exported frame")));
        });
        if (color.length < 3 || color[0] < color[1] * 2 || color[0] < color[2] * 2) throw new Error(`Export order was wrong: ${color.toString("hex")}`);
        console.log("Desktop window, import, selection and MP4 export passed"); clearTimeout(timer); app.exit(0);
      } catch (error) { console.error("Desktop smoke test failed", error); clearTimeout(timer); app.exit(1); }
    });
  }
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

ipcMain.handle("media:pick", async () => {
  const result = smoke ? { canceled: false, filePaths: [process.env.COMPASS_SMOKE_INPUT!, process.env.COMPASS_SMOKE_SECOND!] } : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], filters: [{ name: "Video", extensions: ["mov", "mp4", "m4v", "avi", "mkv"] }] });
  if (result.canceled) return [];
  return result.filePaths.map((filePath) => {
    const id = randomUUID();
    selectedFiles.set(id, filePath);
    return { path: filePath, id };
  });
});

ipcMain.handle("media:preview", async (_event, id: string) => {
  const source = selectedFiles.get(id);
  if (!source) throw new Error("Choose the video in the file picker first.");
  previewDirectory ??= await mkdtemp(path.join(tmpdir(), "concert-compass-preview-"));
  const output = path.join(previewDirectory, `${id}.webm`);
  try {
    await run(ffmpegBinary, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2", "-r", "24", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "5", "-b:v", "1200k", "-c:a", "libopus", "-b:a", "96k", output]);
    previews.set(id, output);
    return `compass-media://preview/${id}`;
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  }
});

ipcMain.handle("media:probe", async (_event, filePath: string): Promise<MediaAsset> => {
  if (![...selectedFiles.values()].includes(filePath)) throw new Error("Choose the video in the file picker first.");
  const raw = await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", filePath]);
  const data = JSON.parse(raw);
  const streams = data.streams ?? [];
  const video = streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  return { path: filePath, name: path.basename(filePath), duration: Number(data.format?.duration ?? 0), width: video?.width ?? 0, height: video?.height ?? 0, hasAudio: streams.some((stream: { codec_type: string }) => stream.codec_type === "audio") };
});

ipcMain.handle("media:suggest", async (_event, asset: MediaAsset) => {
  if (![...selectedFiles.values()].includes(asset.path)) throw new Error("Choose the video in the file picker first.");
  if (!asset.hasAudio) return chooseAudioHighlight(asset, []);
  const bins = await measureAudio(ffmpegBinary, asset.path);
  return chooseAudioHighlight(asset, bins);
});

ipcMain.handle("media:render", async (event, selections: RenderSelection[], options: ExportOptions) => {
  if (activeRender) throw new Error("A video is already being exported.");
  if (!Array.isArray(selections) || selections.some((selection) => ![...selectedFiles.values()].includes(selection.asset.path))) throw new Error("Choose the videos in the file picker first.");
  const destination = smoke ? { canceled: false, filePath: process.env.COMPASS_SMOKE_OUTPUT! } : await dialog.showSaveDialog({ defaultPath: "Concert Compass Reel.mp4", filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
  if (destination.canceled || !destination.filePath) return { cancelled: true };
  const output = path.resolve(destination.filePath);
  for (const sourcePath of selectedFiles.values()) {
    if (path.resolve(sourcePath).toLowerCase() === output.toLowerCase()) throw new Error("Choose a different name from your original video.");
    try {
      const [source, target] = await Promise.all([stat(sourcePath), stat(output)]);
      if (source.dev === target.dev && source.ino === target.ino) throw new Error("Choose a different name from your original video.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const tempDir = await mkdtemp(path.join(path.dirname(output), ".compass-"));
  const temporaryOutput = path.join(tempDir, `${randomUUID()}.mp4`);
  try {
  const { args, totalSeconds } = buildRenderCommand(selections, temporaryOutput, options);
  if (smoke && smokeCancelPending) { args.splice(2, 0, "-re"); smokeCancelPending = false; }
  cancelRender = false;
  await new Promise<void>((resolve, reject) => {
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
    child.on("error", reject);
    child.on("close", (code) => { activeRender = undefined; code === 0 && !cancelRender ? resolve() : reject(new Error(cancelRender ? "Export stopped. Your selections are still here." : stderr || `FFmpeg stopped (${code}).`)); });
  });
  const probe = JSON.parse(await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", temporaryOutput]));
  if (!probe.streams?.some((stream: {codec_type: string; codec_name: string}) => stream.codec_type === "video" && stream.codec_name === "h264") || !probe.streams?.some((stream: {codec_type: string; codec_name: string}) => stream.codec_type === "audio" && stream.codec_name === "aac") || Math.abs(Number(probe.format?.duration) - totalSeconds) > Math.max(0.25, totalSeconds * 0.01)) throw new Error("The exported video did not pass its checks. Please try again.");
  await rename(temporaryOutput, output);
  event.sender.send("media:progress", 1);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
  return { cancelled: false, output };
});

ipcMain.handle("media:cancel-render", () => {
  if (!activeRender) return false;
  cancelRender = true;
  return activeRender.kill();
});

app.whenReady().then(() => {
  protocol.handle("compass-media", async (request) => {
    const url = new URL(request.url);
    const file = url.hostname === "preview" ? previews.get(url.pathname.slice(1)) : undefined;
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
