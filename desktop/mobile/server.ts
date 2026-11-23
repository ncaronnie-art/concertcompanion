import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buildRenderCommand, buildAudioLedRenderCommand, renderDimensions, type MediaAsset, type RenderSelection, type AudioSelection, type ExportOptions } from "../src/shared/render-plan.js";
import { buildOverlayAss } from "../src/shared/visual-design.js";
import { parseProjectSnapshot, type ProjectSnapshot } from "../src/shared/project-file.js";
import { chooseAudioHighlight, type AudioBin } from "../src/shared/suggestions.js";
import { measureAudio } from "../electron/audio-analysis.js";
import { displayDimensions } from "../electron/media-orientation.js";
import { validateRenderedOutput } from "../electron/output-integrity.js";
import { previewResponse } from "../electron/preview-stream.js";
import { hostedLimits, type CloudServerOptions, type CloudJob } from "./cloud-storage.js";

export type MobileServerOptions = {
  dataDirectory: string; staticDirectory: string; ffmpegBinary: string; ffprobeBinary: string;
  token?: string; host?: string; port?: number; maxUploadBytes?: number;
  remoteOrigin?: string;
  cloud?: CloudServerOptions;
  onStop?: () => void | Promise<void>;
};
type Upload = { id: string; name: string; extension: string; asset?: MediaAsset; bytes?: number };
type SharedFile = { file: string; name?: string; kind: "video" | "project"; bytes?: number; pin?: string };
const idPattern = /^[a-f0-9-]{36}$/;
const extensions = new Set([".mov", ".mp4", ".m4v", ".avi", ".mkv", ".webm"]);
class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }

function loopbackAddress(address: string): boolean {
  return address === "::1" || /^127\./.test(address) || /^::ffff:127\./i.test(address);
}
function configuredRemoteOrigin(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  let origin: URL;
  try { origin = new URL(value); } catch { throw new Error("The protected phone address must be an exact HTTPS origin."); }
  if (origin.protocol !== "https:" || origin.origin !== value || origin.username || origin.password || origin.hostname.includes("*")) {
    throw new Error("The protected phone address must be an exact HTTPS origin without a path, credentials, query, or wildcard.");
  }
  return origin;
}
function sessionCookie(request: IncomingMessage): string {
  const values = (request.headers.cookie ?? "").split(";").map((cookie) => cookie.trim()).filter((cookie) => cookie.startsWith("__Host-vibe-session="));
  return values.length === 1 ? values[0].slice("__Host-vibe-session=".length) : "";
}
function privateHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return isIP(host) === 6 && /^(fc|fd|fe[89ab])/i.test(host);
}
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
async function jsonBody(request: IncomingMessage): Promise<any> {
  if (Number(request.headers["content-length"] ?? 0) > 1024 * 1024) throw new RequestError(413, "That project is too large to open.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const piece of request) {
    const chunk = Buffer.from(piece); size += chunk.length;
    if (size > 1024 * 1024) throw new RequestError(413, "That request is too large.");
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new RequestError(400, "That project or editing request could not be read."); }
}
function sendJson(response: ServerResponse, value: unknown, status = 200) {
  if (!response.headersSent) response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function createMobileServer(config: MobileServerOptions) {
  const remoteOrigin = configuredRemoteOrigin(config.remoteOrigin);
  if (config.cloud && (!remoteOrigin || !config.token || !/^[a-f0-9]{64}$/.test(config.token))) throw new Error("Hosted testing needs an exact HTTPS origin and a private 32-byte access key.");
  const listenHost = config.host ?? "127.0.0.1";
  if (remoteOrigin && !config.cloud && !(listenHost === "localhost" || listenHost === "::1" || (isIP(listenHost) === 4 && loopbackAddress(listenHost)))) {
    throw new Error("Protected phone testing must listen only on this computer (127.0.0.1).");
  }
  const connectionMode = config.cloud ? "hosted-test" : remoteOrigin ? "protected-remote" : "local-network";
  const dataDirectory = path.resolve(config.dataDirectory), staticDirectory = path.resolve(config.staticDirectory);
  const uploadDirectory = path.join(dataDirectory, "recordings"), generatedDirectory = path.join(dataDirectory, "generated");
  await mkdir(uploadDirectory, { recursive: true }); await mkdir(generatedDirectory, { recursive: true });
  const keyPath = path.join(dataDirectory, "access-key");
  let token = config.token;
  if (!token) {
    try { token = (await readFile(keyPath, "utf8")).trim(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!token) { token = randomBytes(32).toString("hex"); await writeFile(keyPath, token, { flag: "wx", mode: 0o600 }); }
  }
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error("The phone access key is invalid.");
  if (remoteOrigin && !/^[a-f0-9]{64}$/.test(token)) throw new Error("Protected phone testing requires a 32-byte phone access key.");
  const accessToken = token;
  const pairingCode = String(randomInt(0, 1000000)).padStart(6, "0");
  let pairingAttempts = 0, pairingWindow = Date.now();
  const uploads = new Map<string, Upload>(), shared = new Map<string, SharedFile>();
  const readSaved = async (name: string): Promise<any> => {
    if (config.cloud) return config.cloud.storage.readJson(name);
    try { return JSON.parse(await readFile(path.join(dataDirectory, name), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const savedWrites = new Map<string, Promise<void>>();
  const writeSaved = (name: string, value: unknown) => {
    const pending = (savedWrites.get(name) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (config.cloud) {
        await config.cloud.storage.writeJson(name, value);
        // Durable storage is authoritative. A failed local cache mirror must not
        // make callers roll back an object whose registry is already committed.
        await atomicJson(path.join(dataDirectory, name), value).catch(() => {});
      } else await atomicJson(path.join(dataDirectory, name), value);
    });
    savedWrites.set(name, pending); return pending;
  };
  {
    const items = await readSaved("recordings.json") ?? [];
    if (!Array.isArray(items)) throw new Error("Invalid saved phone recordings.");
    for (const item of items) if (idPattern.test(item?.id) && extensions.has(item.extension) && typeof item.name === "string") {
      uploads.set(item.id, { id: item.id, name: item.name, extension: item.extension, bytes: item.bytes });
    }
  }
  if (config.cloud) {
    const items = await readSaved("generated.json") ?? [];
    if (!Array.isArray(items)) throw new Error("Invalid saved hosted previews.");
    for (const item of items) if (idPattern.test(item?.id) && (item.kind === "video" || item.kind === "project") && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= hostedLimits.maxOutputBytes) {
      const pin = typeof item.pin === "string" && (["draft", "export", "project"].includes(item.pin) || (item.pin.startsWith("source:") && idPattern.test(item.pin.slice(7)))) ? item.pin : undefined;
      shared.set(item.id, { file: path.join(generatedDirectory, `${item.id}.${item.kind === "video" ? "mp4" : "json"}`), kind: item.kind, name: item.name, bytes: item.bytes, pin });
    }
  }
  const downloading = new Map<string, Promise<void>>();
  const ensureLocal = async (key: string, file: string) => {
    try { await access(file); return; } catch { if (!config.cloud) throw new RequestError(404, "That recording is no longer available."); }
    let pending = downloading.get(key);
    if (!pending) {
      pending = (async () => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          if (!await config.cloud!.storage.downloadFile(key, temporary)) throw new RequestError(404, "That saved file is no longer available. Import the recording again or make a fresh preview.");
          if ((await stat(temporary)).size > Math.max(hostedLimits.maxUploadBytes, hostedLimits.maxOutputBytes)) throw new RequestError(413, "That saved file exceeds this hosted test's limit.");
          await rename(temporary, file);
        } finally { await rm(temporary, { force: true }).catch(() => {}); }
      })();
      downloading.set(key, pending);
    }
    try { await pending; } finally { downloading.delete(key); }
  };
  const sourceFile = (id: string) => {
    const item = typeof id === "string" && uploads.get(id);
    if (!item) throw new RequestError(404, "Choose that recording on your phone first.");
    return { item, file: path.join(uploadDirectory, `${item.id}${item.extension}`) };
  };
  let busy = false, progress = 0, active: ChildProcess | undefined, cancelled = false;
  let currentJobId: string | undefined;
  let startingJob = false;
  const jobs = new Map<string, CloudJob>();
  const backgroundTasks = new Set<Promise<unknown>>();
  if (config.cloud) {
    const saved = await readSaved("jobs.json") ?? [];
    if (Array.isArray(saved)) for (const item of saved) if (idPattern.test(item?.jobId)) {
      jobs.set(item.jobId, item.status === "running" ? { jobId: item.jobId, status: "failed", progress: 0, error: "The test server restarted during this edit. Your saved recordings and project are safe. Try the action again." } : item);
    }
  }
  let analysisController: AbortController | undefined;
  let projectWrite: Promise<void> = Promise.resolve();
  const saveLatest = (snapshot: ProjectSnapshot) => {
    const next = projectWrite.catch(() => {}).then(() => writeSaved("latest-project.json", snapshot));
    projectWrite = next; return next;
  };
  const audioCache = new Map<string, AudioBin[]>(), previewCache = new Map<string, string>(), draftCache = new Map<string, string>();
  const mediaUrl = (id: string) => `/media/${id}${remoteOrigin ? "" : `?key=${encodeURIComponent(accessToken)}`}`;
  const downloadUrl = (id: string) => `${mediaUrl(id)}${remoteOrigin ? "?" : "&"}download=1`;
  const saveShared = async (id: string, resource: SharedFile) => {
    if (config.cloud) {
      resource.bytes = (await stat(resource.file)).size;
      if (resource.bytes > hostedLimits.maxOutputBytes) throw new RequestError(413, "This result is too large for the short hosted test. Try a shorter edit.");
      const next = new Map<string, SharedFile>([...shared].map(([oldId, item]) => [oldId, { ...item, pin: item.pin === resource.pin ? undefined : item.pin }]));
      const activePreviews = new Set(previewCache.values()), evicted: Array<[string, SharedFile]> = [];
      while (next.size >= hostedLimits.maxGeneratedFiles || [...next.values()].reduce((sum, item) => sum + (item.bytes ?? 0), 0) + resource.bytes > hostedLimits.maxGeneratedBytes) {
        const candidate = [...next].find(([oldId, item]) => !item.pin && !activePreviews.has(oldId));
        if (!candidate) throw new RequestError(413, "The hosted test has no room for another result while keeping your current previews and export. Try shorter test videos or a shorter edit.");
        next.delete(candidate[0]); evicted.push(candidate);
      }
      const key = `generated/${path.basename(resource.file)}`;
      next.set(id, resource);
      try {
        await config.cloud.storage.uploadFile(key, resource.file, resource.kind === "video" ? "video/mp4" : "application/json");
        await writeSaved("generated.json", [...next].map(([id, item]) => ({ id, kind: item.kind, name: item.name, bytes: item.bytes, pin: item.pin })));
      } catch (error) { await config.cloud.storage.delete(key).catch(() => {}); throw error; }
      shared.clear(); for (const [savedId, item] of next) shared.set(savedId, item);
      // Current links survive failed writes. Once the new registry is durable,
      // only superseded, unpinned artifacts may be removed on a best-effort basis.
      for (const [oldId, old] of evicted) {
        for (const [cacheKey, value] of previewCache) if (value === oldId) previewCache.delete(cacheKey);
        for (const [cacheKey, value] of draftCache) if (value === oldId) draftCache.delete(cacheKey);
        await config.cloud.storage.delete(`generated/${path.basename(old.file)}`).catch(() => {});
        await rm(old.file, { force: true }).catch(() => {});
      }
    } else shared.set(id, resource);
  };
  const pinShared = async (id: string, pin: string) => {
    if (!config.cloud) return;
    const resource = shared.get(id);
    if (!resource) throw new RequestError(404, "That preview has expired. Make a fresh preview.");
    if (resource.pin === pin) return;
    const next = new Map<string, SharedFile>([...shared].map(([savedId, item]) => [savedId, { ...item, pin: savedId === id ? pin : item.pin === pin ? undefined : item.pin }]));
    await writeSaved("generated.json", [...next].map(([savedId, item]) => ({ id: savedId, kind: item.kind, name: item.name, bytes: item.bytes, pin: item.pin })));
    shared.clear(); for (const [savedId, item] of next) shared.set(savedId, item);
  };
  const workResponse = async (response: ServerResponse, work: () => Promise<unknown>) => {
    if (!config.cloud) return sendJson(response, await work());
    if (busy || currentJobId) throw new RequestError(409, "One edit is already running. Wait for it or stop it first.");
    const jobId = randomUUID(), record: CloudJob = { jobId, status: "running", progress: 0 };
    currentJobId = jobId; cancelled = false; progress = 0; jobs.set(jobId, record);
    while (jobs.size > 32) jobs.delete(jobs.keys().next().value!);
    const persistJobs = () => writeSaved("jobs.json", [...jobs.values()]);
    const task = (async () => {
      try {
        await persistJobs();
        startingJob = true;
        let pending: Promise<unknown>;
        try { pending = work(); } finally { startingJob = false; }
        record.result = await pending; record.status = "completed"; record.progress = 1;
      } catch (error) {
        record.status = cancelled ? "cancelled" : "failed";
        record.error = cancelled ? "Processing stopped. Your saved recordings and selections are safe." : error instanceof Error ? error.message : "This edit could not finish. Try again.";
        if (record.error.includes(dataDirectory)) record.error = "The hosted test could not read or save this file. Try again.";
      } finally {
        currentJobId = undefined;
        try { await persistJobs(); } catch { record.status = "failed"; record.error = "The hosted test could not save this result. Your original recordings are safe. Try again."; delete record.result; }
      }
    })();
    backgroundTasks.add(task); void task.finally(() => backgroundTasks.delete(task));
    config.cloud.keepAlive(task);
    return sendJson(response, { jobId }, 202);
  };
  const run = (binary: string, args: string[], seconds?: number): Promise<string> => new Promise((resolve, reject) => {
    if (cancelled) { reject(new RequestError(409, "Processing stopped. Your selections and recordings are safe.")); return; }
    const boundedArgs = config.cloud && binary === config.ffmpegBinary ? ["-filter_complex_threads", "1", "-filter_threads", "1", ...args.slice(0, -1).flatMap((value) => value === "-i" ? ["-threads", "2", value] : [value]), "-threads", "2", "-fs", String(hostedLimits.maxOutputBytes), args.at(-1)!] : args;
    const child = spawn(binary, boundedArgs, { windowsHide: true }); active = child;
    let timedOut = false;
    const timeout = config.cloud ? setTimeout(() => { timedOut = true; child.kill(); }, binary === config.ffprobeBinary ? 30000 : 10 * 60 * 1000) : undefined;
    let stdout = "", stderr = "", lineBuffer = "";
    child.stdout.on("data", (piece) => {
      const text = piece.toString();
      if (seconds !== undefined) {
        lineBuffer += text; const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop() ?? "";
        for (const line of lines) { const match = /^out_time_ms=(\d+)/.exec(line); if (match) progress = Math.min(.99, Number(match[1]) / 1e6 / seconds); }
      } else { stdout += text; if (stdout.length > 8 * 1024 * 1024) child.kill(); }
    });
    child.stderr.on("data", (piece) => { stderr = (stderr + piece.toString()).slice(-4000); });
    child.on("error", () => { if (timeout) clearTimeout(timeout); if (active === child) active = undefined; reject(new Error("The video tools could not start on the computer.")); });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (active === child) active = undefined;
      if (timedOut) reject(new Error("This recording took too long for the short hosted test. Try a shorter recording."));
      else if (cancelled) reject(new RequestError(409, "Processing stopped. Your selections and recordings are safe."));
      else if (code === 0) resolve(stdout);
      else { console.error(`Video tool failed (${code}): ${stderr}`); reject(new Error("This recording could not be processed. Check it plays normally, or try another recording.")); }
    });
  });
  async function job<T>(work: () => Promise<T>): Promise<T> {
    if (busy || (currentJobId && !startingJob)) throw new RequestError(409, "The computer is still working on a video. Wait for it to finish or stop it first.");
    if (currentJobId && cancelled) throw new RequestError(409, "Processing stopped. Your selections and recordings are safe.");
    busy = true; if (!currentJobId) cancelled = false; progress = 0;
    try {
      const result = await work();
      if (config.cloud && cancelled) throw new RequestError(409, "Processing stopped. Your selections and recordings are safe.");
      progress = 1; return result;
    } finally { busy = false; active = undefined; analysisController = undefined; }
  }
  async function probeAsset(id: string): Promise<MediaAsset> {
    const { item, file } = sourceFile(id);
    await ensureLocal(`recordings/${path.basename(file)}`, file);
    if (item.asset) return item.asset;
    const parsed = JSON.parse(await run(config.ffprobeBinary, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
    const video = parsed.streams?.find((stream: any) => stream.codec_type === "video");
    const size = video ? displayDimensions(video) : { width: 0, height: 0 };
    const duration = Number(parsed.format?.duration);
    if (!size.width || !size.height || !Number.isFinite(duration) || duration < .1 || duration > 86400) throw new RequestError(400, "That file does not contain a usable video under 24 hours.");
    if (config.cloud && (duration > hostedLimits.maxSourceSeconds || Math.max(size.width, size.height) > hostedLimits.maxSourceDimension || size.width * size.height > hostedLimits.maxSourcePixels)) throw new RequestError(400, "For this hosted test, choose videos up to 60 seconds and 1080p (1920 pixels on the longer side, up to 2,073,600 pixels per frame). Longer and 4K recordings still work in the desktop app.");
    item.asset = { path: id, name: item.name, ...size, duration, hasAudio: parsed.streams.some((stream: any) => stream.codec_type === "audio") };
    return item.asset;
  }
  async function mappedSelections(values: any, audio = false): Promise<RenderSelection[]> {
    const maximum = config.cloud ? (audio ? hostedLimits.maxAudioSections : hostedLimits.maxPictureSections) : 500;
    if (!Array.isArray(values) || !values.length || values.length > maximum) throw new RequestError(400, config.cloud ? `This hosted test supports up to ${maximum} ${audio ? "sound" : "picture"} sections per edit.` : "Choose valid sections first.");
    const result: RenderSelection[] = [];
    for (const value of values) {
      const id = value?.asset?.path, asset = await probeAsset(id), { file } = sourceFile(id);
      if (audio && !asset.hasAudio) throw new RequestError(400, "That recording has no soundtrack.");
      if (typeof value.start !== "number" || typeof value.end !== "number" || !Number.isFinite(value.start) || !Number.isFinite(value.end)) throw new RequestError(400, "Choose valid start and end points.");
      result.push({ asset: { ...asset, path: file }, start: value.start, end: value.end,
        locked: value.locked, framing: value.framing, focus: value.focus, label: value.label });
    }
    return result;
  }
  async function validateProject(candidate: unknown) {
    const snapshot = parseProjectSnapshot(candidate);
    for (const clip of snapshot.clips) { const fresh = await probeAsset(clip.asset.path); if (clip.end > fresh.duration + .05) throw new RequestError(400, "A saved section extends beyond its recording."); clip.asset = fresh; }
    for (const sound of snapshot.audioSelections ?? []) {
      sound.asset = await probeAsset(sound.asset.path);
      if (!sound.asset.hasAudio || sound.end > sound.asset.duration + .05) throw new RequestError(400, "A saved sound section is outside its recording.");
    }
    const validated = parseProjectSnapshot(snapshot);
    return { snapshot: validated, files: validated.clips.map((clip) => ({ id: clip.asset.path, path: clip.asset.path, name: clip.asset.name })) };
  }
  function cachedProject(candidate: unknown): ProjectSnapshot | null {
    const snapshot = parseProjectSnapshot(candidate);
    for (const clip of snapshot.clips) { const asset = uploads.get(clip.asset.path)?.asset; if (!asset) return null; clip.asset = asset; }
    for (const sound of snapshot.audioSelections ?? []) { const asset = uploads.get(sound.asset.path)?.asset; if (!asset) return null; sound.asset = asset; }
    return parseProjectSnapshot(snapshot);
  }
  async function rendered(body: any, draft: boolean) {
    return job(async () => {
      const cacheKey = JSON.stringify(body);
      if (draft && draftCache.has(cacheKey)) {
        const id = draftCache.get(cacheKey)!; await pinShared(id, "draft");
        return { url: mediaUrl(id) };
      }
      const selections = await mappedSelections(body.selections);
      const sound = body.audioSelections === undefined ? undefined : await mappedSelections(body.audioSelections, true) as AudioSelection[];
      const options: ExportOptions = body.options;
      const dimensions = renderDimensions(options, draft ? "draft" : "export");
      let offset = 0;
      const labels = selections.flatMap((selection) => { const start = offset, duration = selection.end - selection.start; offset += duration;
        return options.showClipLabels && sound === undefined && selection.label ? [{ text: selection.label, start, duration }] : []; });
      const script = buildOverlayAss({ ...dimensions, style: options.finish ?? "natural", eventTitle: options.eventTitle, labels });
      const id = randomUUID(), output = path.join(generatedDirectory, `${id}.mp4`), overlay = path.join(generatedDirectory, `${id}.ass`);
      try {
        if (script) await writeFile(overlay, script, "utf8");
        const plan = sound === undefined ? buildRenderCommand(selections, output, options, draft ? "draft" : "export", script ? overlay : undefined) :
          buildAudioLedRenderCommand(selections, sound, output, options, draft ? "draft" : "export", script ? overlay : undefined);
        if (config.cloud && plan.totalSeconds > hostedLimits.maxOutputSeconds) throw new RequestError(400, "Keep this hosted test edit at 60 seconds or less. Longer edits still work in the desktop app.");
        await run(config.ffmpegBinary, plan.args, plan.totalSeconds);
        const metadata = JSON.parse(await run(config.ffprobeBinary, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,duration", "-of", "json", output]));
        validateRenderedOutput(metadata, plan.totalSeconds, draft ? "preview" : "export");
        await saveShared(id, { file: output, kind: "video", name: draft ? undefined : "Vibe Capsule.mp4", pin: draft ? "draft" : "export" });
        if (draft) { draftCache.set(cacheKey, id); return { url: mediaUrl(id) }; }
        return { cancelled: false, output: "Your MP4 is ready to save", downloadUrl: downloadUrl(id) };
      } catch (error) { await rm(output, { force: true }).catch(() => {}); throw error; }
      finally { await rm(overlay, { force: true }).catch(() => {}); }
    });
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    try {
      const host = request.headers.host ?? "";
      const remoteRequest = !!remoteOrigin && host === remoteOrigin.host;
      const expectedOrigin = remoteRequest ? remoteOrigin!.origin : `http://${host}`;
      let url: URL, hostUrl: URL;
      try { hostUrl = new URL(expectedOrigin); url = new URL(request.url ?? "/", expectedOrigin); } catch { throw new RequestError(400, "Invalid address."); }
      const requestedHost = hostUrl.hostname.replace(/^\[|\]$/g, "");
      const allowedHost = config.cloud ? remoteRequest : remoteOrigin ? remoteRequest || requestedHost === "localhost" || (isIP(requestedHost) !== 0 && loopbackAddress(requestedHost)) : privateHost(requestedHost);
      if (!allowedHost || hostUrl.host !== host || url.origin !== expectedOrigin) throw new RequestError(403, "Open the phone address shown on the computer.");
      if (request.headers.origin && request.headers.origin !== expectedOrigin) throw new RequestError(403, "Open this page directly from the computer's phone link.");
      if (request.method === "POST" && url.pathname === "/api/pair") {
        if (remoteOrigin) throw new RequestError(403, "The six-digit code is unavailable for protected phone testing. Use the protected connection link from your computer.");
        if (Date.now() - pairingWindow > 60000) { pairingWindow = Date.now(); pairingAttempts = 0; }
        if (pairingAttempts >= 5) throw new RequestError(429, "Wait a minute before trying the connection code again.");
        const body = await jsonBody(request);
        if (typeof body.code !== "string" || body.code !== pairingCode) { pairingAttempts++; throw new RequestError(401, "That code did not match. Use the six digits shown on your computer."); }
        return sendJson(response, { token: accessToken });
      }
      const protectedRoute = url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/");
      if (protectedRoute) {
        const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? (remoteOrigin ? (remoteRequest ? sessionCookie(request) : "") : url.searchParams.get("key")) ?? "";
        if (Buffer.byteLength(supplied) !== Buffer.byteLength(accessToken) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(accessToken))) throw new RequestError(401, "Open the current phone link from your computer to connect.");
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        if (remoteRequest && request.headers.authorization?.startsWith("Bearer ")) {
          response.setHeader("Set-Cookie", `__Host-vibe-session=${accessToken}; HttpOnly; Secure; SameSite=Strict; Path=/`);
        }
        return sendJson(response, { ready: true, connectionMode, ...(config.cloud ? { limits: hostedLimits } : {}) });
      }
      if (request.method === "GET" && url.pathname === "/api/status") return sendJson(response, { busy: busy || !!currentJobId, progress });
      if (request.method === "GET" && config.cloud && url.pathname.startsWith("/api/jobs/")) {
        const jobId = url.pathname.slice("/api/jobs/".length);
        if (!idPattern.test(jobId)) throw new RequestError(404, "That edit could not be found.");
        const record = jobs.get(jobId);
        return sendJson(response, record ? { ...record, progress: record.status === "running" ? progress : record.progress } : { jobId, status: "failed", progress: 0, error: "That edit is no longer available after the test server restarted. Your saved recordings are safe. Try the action again." });
      }
      if (request.method === "POST" && url.pathname === "/api/stop") {
        if (config.cloud) throw new RequestError(403, "The hosted test cannot be stopped from this page.");
        const address = request.socket.remoteAddress ?? "";
        const forwarded = Object.keys(request.headers).some((header) => header === "forwarded" || header.startsWith("x-forwarded-") || header === "x-real-ip" || header === "via");
        if (remoteRequest || forwarded || !loopbackAddress(address)) {
          throw new RequestError(403, "Stop Phone Preview from the computer running it.");
        }
        if (!config.onStop) throw new RequestError(405, "This host does not support the stop shortcut.");
        response.once("finish", () => { setImmediate(() => { void Promise.resolve().then(() => config.onStop!()).catch(() => console.error("Phone Preview could not stop cleanly.")); }); });
        return sendJson(response, { stopping: true });
      }
      if (request.method === "POST" && url.pathname === "/api/cancel") {
        cancelled = !!active || !!analysisController || !!currentJobId;
        if (analysisController) { analysisController.abort(); return sendJson(response, true); }
        return sendJson(response, active?.kill() ?? !!currentJobId);
      }
      if (request.method === "PUT" && url.pathname === "/api/upload") {
        if (config.cloud) { response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.flushHeaders(); }
        return sendJson(response, await job(async () => {
          if (uploads.size >= (config.cloud ? hostedLimits.maxRecordings : 500)) throw new RequestError(400, config.cloud ? "This hosted test holds up to 8 recordings. Continue with the videos already added." : "This phone workspace already has 500 recordings. Use the desktop editor for additional recordings.");
          const name = path.basename(path.win32.basename(url.searchParams.get("name") ?? "video.mov")).replace(/[\x00-\x1f]/g, "").slice(0, 200);
          const extension = path.extname(name).toLowerCase();
          if (!extensions.has(extension)) throw new RequestError(400, "Choose a MOV, MP4, M4V, AVI, MKV, or WebM video.");
          const max = config.cloud ? Math.min(config.maxUploadBytes ?? hostedLimits.maxUploadBytes, hostedLimits.maxUploadBytes) : config.maxUploadBytes ?? 10 * 1024 ** 3, length = Number(request.headers["content-length"] ?? 0);
          const remaining = config.cloud ? hostedLimits.maxTotalSourceBytes - [...uploads.values()].reduce((sum, item) => sum + (item.bytes ?? hostedLimits.maxUploadBytes), 0) : Infinity;
          if (!Number.isFinite(length) || length > max || length > remaining) throw new RequestError(413, config.cloud ? "This hosted test allows 50 MB per recording and 100 MB of recordings in total. Choose a shorter, smaller video." : "This video is too large for this phone preview. Try a recording under 10 GB.");
          const id = randomUUID(), file = path.join(uploadDirectory, `${id}${extension}`); let received = 0;
          const limiter = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; if (received > Math.min(max, remaining)) return callback(new Error("This upload exceeds the hosted test's file or total-storage limit.")); if (length) progress = Math.min(.99, received / length); callback(null, chunk); } });
          try {
            await pipeline(request, limiter, createWriteStream(file, { flags: "wx" }));
            if (!received) throw new RequestError(400, "That video was empty.");
            const item = { id, name, extension, bytes: received }; uploads.set(id, item);
            try {
              if (config.cloud) { await probeAsset(id); await config.cloud.storage.uploadFile(`recordings/${id}${extension}`, file, "application/octet-stream"); }
              await writeSaved("recordings.json", [...uploads.values()].map(({ asset: _asset, ...saved }) => saved));
            }
            catch (error) { uploads.delete(id); if (config.cloud) await config.cloud.storage.delete(`recordings/${id}${extension}`).catch(() => {}); throw error; }
            return { id, path: id, name };
          } catch (error) { await rm(file, { force: true }).catch(() => {}); throw error; }
        }));
      }
      if (request.method === "GET" && url.pathname === "/api/project/latest") {
        return await workResponse(response, () => job(async () => { await projectWrite.catch(() => {}); const raw = await readSaved("latest-project.json"); return raw === null ? null : validateProject(raw); }));
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/")) {
        const body = await jsonBody(request);
        if (url.pathname === "/api/probe") return await workResponse(response, () => job(() => probeAsset(body.path)));
        if (url.pathname === "/api/preview") return await workResponse(response, () => job(async () => {
          const asset = await probeAsset(body.id), { file } = sourceFile(body.id);
          if (previewCache.has(body.id)) return { url: mediaUrl(previewCache.get(body.id)!) };
          const id = randomUUID(), output = path.join(generatedDirectory, `${id}.mp4`);
          try { await run(config.ffmpegBinary, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", file,
            "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2", "-r", "24", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", output], asset.duration);
            await saveShared(id, { file: output, kind: "video", pin: `source:${body.id}` }); previewCache.set(body.id, id); return { url: mediaUrl(id) };
          } catch (error) { await rm(output, { force: true }).catch(() => {}); throw error; }
        }));
        if (url.pathname === "/api/preview-cut" || url.pathname === "/api/render") return await workResponse(response, () => rendered(body, url.pathname === "/api/preview-cut"));
        if (url.pathname === "/api/analyze-audio" || url.pathname === "/api/suggest") return await workResponse(response, () => job(async () => {
          const asset = await probeAsset(body.asset?.path), { file } = sourceFile(asset.path);
          if (!asset.hasAudio) return url.pathname === "/api/analyze-audio" ? [] : chooseAudioHighlight(asset, []);
          const reduceRumble = url.pathname === "/api/analyze-audio" && body.reduceRumble === true, key = `${asset.path}:${reduceRumble}`;
          let bins = audioCache.get(key);
          if (!bins) {
            analysisController = new AbortController();
            try { bins = await measureAudio(config.ffmpegBinary, file, reduceRumble, analysisController.signal); }
            catch (error) { if (cancelled) throw new RequestError(409, "Sound analysis stopped. Your selections and recordings are safe."); throw error; }
            finally { analysisController = undefined; }
            audioCache.set(key, bins);
          }
          return url.pathname === "/api/analyze-audio" ? bins : chooseAudioHighlight(asset, bins);
        }));
        if (url.pathname === "/api/project/open") return await workResponse(response, () => job(() => validateProject(body.snapshot)));
        if (url.pathname === "/api/project/save" && body.automatic === true) {
          if (busy || currentJobId) return sendJson(response, { cancelled: true });
          const snapshot = cachedProject(body.snapshot);
          if (!snapshot) return sendJson(response, { cancelled: true });
          await saveLatest(snapshot);
          return sendJson(response, { cancelled: false, path: config.cloud ? "Saved for your hosted test" : "Saved on this computer" });
        }
        if (url.pathname === "/api/project/save") return await workResponse(response, () => job(async () => {
          const { snapshot } = await validateProject(body.snapshot); await saveLatest(snapshot);
          const id = randomUUID(), file = path.join(generatedDirectory, `${id}.json`); await atomicJson(file, snapshot);
          try { await saveShared(id, { file, kind: "project", name: "Vibe Capsule Project.json", pin: "project" }); }
          catch (error) { await rm(file, { force: true }).catch(() => {}); throw error; }
          return { cancelled: false, path: config.cloud ? "Saved for your hosted test" : "Saved on this computer", downloadUrl: downloadUrl(id) };
        }));
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/media/")) {
        const resource = shared.get(url.pathname.slice(7));
        if (!resource) throw new RequestError(404, "This preview has expired. Make a new preview from your project.");
        await ensureLocal(`generated/${path.basename(resource.file)}`, resource.file);
        if (resource.kind === "project") {
          response.setHeader("Content-Type", "application/json"); response.setHeader("Content-Disposition", 'attachment; filename="Vibe Capsule Project.json"');
          return response.end(request.method === "HEAD" ? undefined : await readFile(resource.file));
        }
        const result = await previewResponse(resource.file, new Request("http://localhost/", { method: request.method, headers: request.headers.range ? { Range: request.headers.range } : {} }));
        result.headers.delete("Access-Control-Allow-Origin");
        result.headers.forEach((value, key) => response.setHeader(key, value)); response.statusCode = result.status;
        if (url.searchParams.get("download") === "1") response.setHeader("Content-Disposition", 'attachment; filename="Vibe Capsule.mp4"');
        if (!result.body) return response.end();
        await pipeline(Readable.fromWeb(result.body as any), response); return;
      }
      if ((request.method === "GET" || request.method === "HEAD") && !protectedRoute) {
        let relative: string; try { relative = decodeURIComponent(url.pathname); } catch { throw new RequestError(400, "Invalid address."); }
        if (relative.includes("\\") || relative.includes("\0")) throw new RequestError(404, "Page not found.");
        const file = path.resolve(staticDirectory, `.${relative === "/" ? "/index.html" : relative}`);
        if (!file.startsWith(staticDirectory + path.sep)) throw new RequestError(404, "Page not found.");
        const info = await stat(file); if (!info.isFile()) throw new RequestError(404, "Page not found.");
        const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
        response.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-store" });
        if (request.method === "HEAD") return response.end(); await pipeline(createReadStream(file), response); return;
      }
      throw new RequestError(404, "That action is not available.");
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent && !(config.cloud && request.method === "PUT" && request.url?.startsWith("/api/upload"))) { response.destroy(); return; }
      const status = error instanceof RequestError ? error.status : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400;
      const message = (error as NodeJS.ErrnoException).code === "ENOENT" ? "That page or recording could not be found." : error instanceof Error ? error.message : "Something interrupted this request. Try again.";
      sendJson(response, { error: message.includes(dataDirectory) ? "The computer could not read or save this file. Check that it has enough space." : message }, status);
    }
  });
  server.requestTimeout = 60 * 60 * 1000; server.headersTimeout = 30000;
  return {
    server, token: accessToken, pairingCode, dataDirectory,
    listen: () => new Promise<{ host: string; port: number }>((resolve, reject) => {
      const host = listenHost; server.once("error", reject);
      server.listen(config.port ?? 4317, host, () => { server.removeListener("error", reject); const address = server.address(); resolve({ host, port: typeof address === "object" && address ? address.port : config.port ?? 4317 }); });
    }),
    close: async () => { cancelled = true; active?.kill(); analysisController?.abort(); server.closeAllConnections(); await Promise.allSettled([...backgroundTasks, projectWrite, ...downloading.values()]); if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
