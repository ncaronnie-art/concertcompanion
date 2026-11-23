import type { ProjectSnapshot } from "../shared/project-file";
import { PhoneJobTimeout, waitForPhoneJob, type PhoneJob } from "./phone-jobs";

export type PhoneHealth = {
  ready: boolean;
  connectionMode: "local-network" | "protected-remote" | "hosted-test";
  limits?: { maxUploadBytes: number; maxTotalSourceBytes: number; maxSourceSeconds: number; maxOutputSeconds: number; maxRecordings: number; maxPictureSections: number; maxAudioSections: number };
};
let connection: PhoneHealth | undefined;
let jobProgress = (_value: number) => {};
let waitingForJob = false;
export const phoneConnection = () => connection;
export const hostedPhoneTest = () => connection?.connectionMode === "hosted-test";
export function phoneLimitSummary(health: PhoneHealth | undefined = connection): string {
  if (health?.connectionMode !== "hosted-test" || !health.limits) return "";
  const limits = health.limits;
  return `Short videos only: up to ${limits.maxSourceSeconds} seconds and ${Math.floor(limits.maxUploadBytes / 1024 ** 2)} MB each; ${Math.floor(limits.maxTotalSourceBytes / 1024 ** 2)} MB and ${limits.maxRecordings} recordings total. Finished video: up to ${limits.maxOutputSeconds} seconds, with ${limits.maxPictureSections} picture sections and ${limits.maxAudioSections} separate sound moments at most. Use 1080p footage; 4K is not supported in this test.`;
}
export function validatePhoneEdit(pictureSections: number, audioSections: number | undefined, health: PhoneHealth | undefined = connection): void {
  if (health?.connectionMode !== "hosted-test" || !health.limits) return;
  const limits = health.limits;
  if (pictureSections > limits.maxPictureSections) {
    const adjustment = audioSections === undefined ? "Choose fewer videos or sections and review your plan. For an existing edit with original sound, Fewer cuts can help." : "Reduce Videos to show or choose fewer picture sections, then review your plan.";
    throw new Error(`This phone test supports up to ${limits.maxPictureSections} picture sections; this edit has ${pictureSections}. ${adjustment} Your kept sections have not been changed.`);
  }
  if (audioSections !== undefined && audioSections > limits.maxAudioSections) {
    throw new Error(`This phone test supports up to ${limits.maxAudioSections} separate sound moments; this edit has ${audioSections}. Choose ${limits.maxAudioSections} or fewer under Sound moments and review your plan. Your kept sections have not been changed.`);
  }
}
export function validatePhoneFiles(files: Pick<File, "name" | "size">[], health: PhoneHealth | undefined = connection): void {
  if (health?.connectionMode !== "hosted-test" || !health.limits) return;
  const limits = health.limits;
  if (files.length > limits.maxRecordings) throw new Error(`Choose at most ${limits.maxRecordings} recordings for this small phone test.`);
  const large = files.find((file) => file.size > limits.maxUploadBytes);
  if (large) throw new Error(`${large.name} is too large for this test. Choose a shorter copy under ${Math.floor(limits.maxUploadBytes / 1024 ** 2)} MB; your original stays untouched.`);
  if (files.reduce((bytes, file) => bytes + file.size, 0) > limits.maxTotalSourceBytes) throw new Error(`These videos total more than ${Math.floor(limits.maxTotalSourceBytes / 1024 ** 2)} MB. Choose fewer or shorter videos for this test.`);
}
export function readPhoneUpload(text: string, status: number): { id: string; path: string } {
  const data = JSON.parse(text);
  // The hosted upload sends headers early; its final body can report a failure even with HTTP 200.
  if (data?.error || status < 200 || status >= 300) throw new Error(data?.error || "Upload failed. Please try again.");
  if (typeof data?.id !== "string" || typeof data?.path !== "string") throw new Error("The upload did not finish correctly. Please try again.");
  return data;
}

const storageKey = "vibe-phone-key";
let inMemoryKey = "";
export function phoneKey(): string {
  if (inMemoryKey) return inMemoryKey;
  try { return sessionStorage.getItem(storageKey) ?? ""; } catch { return ""; }
}
export const remotePhoneTest = () => connection ? connection.connectionMode === "protected-remote" : location.protocol === "https:";
export function rememberPhoneKey(key: string) {
  inMemoryKey = key;
  try { sessionStorage.setItem(storageKey, key); } catch { /* Private links still work for this page session. */ }
}

async function rawRequest<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<{ response: Response; result: T }> {
  const response = await fetch(`/api/${route}`, { method: body === undefined ? "GET" : "POST",
    signal,
    headers: { Authorization: `Bearer ${phoneKey()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let result: any;
  try { result = await response.json(); }
  catch { throw new Error(hostedPhoneTest() ? "The test connection was interrupted. Check your internet connection and try again." : "The phone connection was interrupted. Check that your computer and test link are still running, then try again."); }
  if (!response.ok) throw new Error(result.error || "This step could not finish. Check the connection and try again.");
  return { response, result };
}

export async function phoneRequest<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const { response, result } = await rawRequest<T | { jobId: string }>(route, body, signal);
  if (response.status !== 202) return result as T;
  if (!result || typeof result !== "object" || !("jobId" in result) || typeof result.jobId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.jobId)) {
    throw new Error("This step did not start correctly. Your edit is still here; please try again.");
  }
  waitingForJob = true;
  try {
    return await waitForPhoneJob<T>(result.jobId, async (id, pollSignal) =>
      (await rawRequest<PhoneJob<T>>(`jobs/${encodeURIComponent(id)}`, undefined, pollSignal)).result, jobProgress);
  } catch (error) {
    if (error instanceof PhoneJobTimeout) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
      try { await rawRequest("cancel", {}, controller.signal); } catch { /* Keep the original timeout explanation. */ }
      finally { clearTimeout(timer); }
    }
    throw error;
  } finally { waitingForJob = false; }
}
const request = phoneRequest;

function chooseFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = accept; input.multiple = multiple;
    input.style.cssText = "position:fixed;left:-10000px";
    document.body.append(input);
    const finish = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener("cancel", () => finish([]), { once: true });
    input.click();
  });
}

export function installBrowserBridge() {
  if (window.concertCompass) return;
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (/^[a-zA-Z0-9_-]{32,128}$/.test(fragment.get("key") ?? "")) {
    rememberPhoneKey(fragment.get("key")!);
    history.replaceState(null, "", location.pathname);
  }
  const progressListeners = new Set<(value: number) => void>();
  const activityListeners = new Set<(value: string) => void>();
  let upload: XMLHttpRequest | null = null, uploading = false, stopped = false, polling = false;
  const progress = (value: number) => progressListeners.forEach((callback) => callback(value));
  jobProgress = progress;
  const activity = (value: string) => activityListeners.forEach((callback) => callback(value));
  window.setInterval(async () => {
    if (!phoneKey() || polling || uploading || waitingForJob || document.hidden) return;
    polling = true;
    try { const status = await request<{ progress: number; busy: boolean }>("status"); if (status.busy) progress(status.progress); }
    catch { /* A failed operation reports its own connection error. */ }
    finally { polling = false; }
  }, 900);
  window.concertCompass = {
    mobile: true,
    async pickVideos() {
      const files = await chooseFiles("video/*,.mov,.mp4,.m4v", true);
      validatePhoneFiles(files);
      const uploaded: { id: string; path: string }[] = [];
      stopped = false; uploading = true;
      try {
        for (const [index, file] of files.entries()) {
          if (stopped) break;
          activity(`Sending video ${index + 1} of ${files.length} ${hostedPhoneTest() ? "to the Netlify test" : "to your computer"}. Keep Safari open…`);
          progress(0);
          const result = await new Promise<{ id: string; path: string }>((resolve, reject) => {
            const xhr = new XMLHttpRequest(); upload = xhr;
            xhr.open("PUT", `/api/upload?name=${encodeURIComponent(file.name)}`);
            xhr.setRequestHeader("Authorization", `Bearer ${phoneKey()}`);
            xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(event.loaded / event.total); };
            xhr.onload = () => {
              try { resolve(readPhoneUpload(xhr.responseText, xhr.status)); }
              catch (error) { reject(error instanceof SyntaxError ? new Error("The connection could not accept this upload. Check that the test link is running and has transfer allowance remaining, then try a shorter video.") : error); }
            };
            xhr.onerror = () => reject(new Error(hostedPhoneTest() ? "The video did not finish uploading. Check your internet connection, keep Safari open, and try a shorter video." : remotePhoneTest() ? "The video did not reach your computer. Check your internet connection and that the computer's private test link is still running." : "The video did not reach your computer. Keep both devices on the same Wi-Fi and try again."));
            xhr.onabort = () => reject(new Error("Upload stopped. Your original video is safe."));
            xhr.send(file);
          });
          uploaded.push(result);
        }
        return uploaded;
      } finally { upload = null; uploading = false; }
    },
    probe: (path) => request("probe", { path }),
    preview: async (id) => (await request<{ url: string }>("preview", { id })).url,
    previewCut: (selections, options, audioSelections) => request("preview-cut", { selections, options, audioSelections }),
    analyzeAudio: (asset, reduceRumble) => request("analyze-audio", { asset, reduceRumble }),
    suggest: (asset) => request("suggest", { asset }),
    render: (selections, options, audioSelections) => request("render", { selections, options, audioSelections }),
    async cancelRender() { stopped = true; const wasUploading = !!upload; upload?.abort(); return await request<boolean>("cancel", {}) || wasUploading; },
    saveProject: (snapshot, automatic) => request("project/save", { snapshot, automatic }),
    async openProject(recent = false) {
      if (recent) return request("project/latest");
      const [file] = await chooseFiles(".json,application/json");
      if (!file) return null;
      if (file.size > 2 * 1024 * 1024) throw new Error("Choose a Vibe Capsule project file, not a video.");
      const snapshot = JSON.parse(await file.text()) as ProjectSnapshot;
      return request("project/open", { snapshot });
    },
    onProgress: (callback) => { progressListeners.add(callback); },
    onActivity: (callback) => { activityListeners.add(callback); },
  };
}

export async function verifyPhoneConnection() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try { connection = await request<PhoneHealth>("health", undefined, controller.signal); return connection; }
  catch (error) { if (controller.signal.aborted) throw new Error("The connection took too long. Check your internet connection and try again."); throw error; }
  finally { clearTimeout(timer); }
}
export async function pairPhone(code: string) {
  const response = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Check the code on your computer.");
  rememberPhoneKey(data.token);
}
