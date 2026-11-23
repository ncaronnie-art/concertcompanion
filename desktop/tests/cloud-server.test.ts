import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { createMobileServer } from "../mobile/server.ts";
import { hostedLimits, type CloudStorage } from "../mobile/cloud-storage.ts";

const run = (binary: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(binary, args, { windowsHide: true }); let error = "";
  child.stderr.on("data", (chunk) => { error += chunk; }); child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error)));
});
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

class DiskStorage implements CloudStorage {
  failUpload = false;
  constructor(readonly directory: string) {}
  async readJson(key: string) { try { return JSON.parse(await readFile(path.join(this.directory, key), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
  async writeJson(key: string, value: unknown) { await mkdir(path.dirname(path.join(this.directory, key)), { recursive: true }); await writeFile(path.join(this.directory, key), JSON.stringify(value)); }
  async downloadFile(key: string, destination: string) { try { await copyFile(path.join(this.directory, key), destination); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
  async uploadFile(key: string, source: string, _contentType: string) { if (this.failUpload) throw new Error("Synthetic storage failure"); await mkdir(path.dirname(path.join(this.directory, key)), { recursive: true }); await copyFile(source, path.join(this.directory, key)); }
  async delete(key: string) { await rm(path.join(this.directory, key), { force: true }); }
}

test("hosted jobs preserve uploads, selections and downloads across a clean scratch restart", { timeout: 120000 }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-cloud-test-")), scratch = path.join(folder, "scratch");
  const storage = new DiskStorage(path.join(folder, "durable"));
  const fixture = path.join(folder, "concert.mov");
  await run(ffmpeg as unknown as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=9", "-f", "lavfi", "-i", "sine=frequency=440:duration=9", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", fixture]);
  const original = await readFile(fixture), originalHash = digest(original), key = "a".repeat(64);
  const tracked: Promise<unknown>[] = [];
  const config = { dataDirectory: scratch, staticDirectory: folder, ffmpegBinary: ffmpeg as unknown as string, ffprobeBinary: ffprobe.path,
    port: 0, token: key, remoteOrigin: "https://capsule.example", cloud: { storage, keepAlive: (task: Promise<unknown>) => { tracked.push(task); } } };
  let host = await createMobileServer(config), port = (await host.listen()).port;
  const request = (route: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; value: any; bytes: Buffer; headers: Record<string, any> }>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path: route, method, agent: false, headers: { Host: "capsule.example", Cookie: `__Host-vibe-session=${key}`, ...headers } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk))); res.on("end", () => {
        const bytes = Buffer.concat(chunks); let value: any; try { value = JSON.parse(bytes.toString()); } catch { value = bytes.toString(); }
        resolve({ status: res.statusCode!, value, bytes, headers: res.headers });
      });
    }); req.on("error", reject); req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  const waitJob = async (jobId: string) => {
    for (let count = 0; count < 1000; count++) {
      const response = await request(`/api/jobs/${jobId}`); assert.equal(response.status, 200);
      if (response.value.status !== "running") return response.value;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error("Synthetic hosted job did not finish");
  };
  const call = async (route: string, body?: unknown) => {
    const started = await request(route, body === undefined ? "GET" : "POST", body);
    assert.equal(started.status, 202, JSON.stringify(started.value)); assert.match(started.value.jobId, /^[a-f0-9-]{36}$/);
    const finished = await waitJob(started.value.jobId); assert.equal(finished.status, "completed", JSON.stringify(finished)); return finished.result;
  };
  try {
    const health = await request("/api/health"); assert.equal(health.value.connectionMode, "hosted-test"); assert.equal(health.value.limits.maxUploadBytes, hostedLimits.maxUploadBytes);
    assert.equal((await request("/api/status", "GET", undefined, { Host: `127.0.0.1:${port}` })).status, 403);
    assert.equal((await request(`/api/jobs/${randomUUID()}`, "GET", undefined, { Cookie: "" })).status, 401);
    assert.equal((await request(`/api/status?key=${key}`, "GET", undefined, { Cookie: "" })).status, 401);
    assert.equal((await request("/api/stop", "POST", {})).status, 403);
    assert.equal((await request("/api/pair", "POST", { code: host.pairingCode })).status, 403);
    const upload = await request("/api/upload?name=concert.mov", "PUT", original); assert.equal(upload.status, 200); assert.ok(upload.value.id, JSON.stringify(upload.value));
    const asset = await call("/api/probe", { path: upload.value.path }); assert.equal(asset.hasAudio, true);
    const preview = await call("/api/preview", { id: upload.value.id }); assert.match(preview.url, /^\/media\/[a-f0-9-]{36}$/);
    const bins = await call("/api/analyze-audio", { asset, reduceRumble: true }); assert.ok(bins.length > 0);
    const clip = { asset, start: .5, end: 3.5, included: true, selectionSource: "manual", locked: true, excludedByUser: false, focus: .25 };
    const options = { aspect: "portrait913", reduceRumble: true, finish: "warm", eventTitle: "Hosted test" };
    const tooMany = await request("/api/render", "POST", { selections: Array.from({ length: 9 }, () => clip), options });
    const rejected = await waitJob(tooMany.value.jobId); assert.equal(rejected.status, "failed"); assert.match(rejected.error, /8 picture sections/);
    const tooManySounds = await request("/api/render", "POST", { selections: [clip], audioSelections: Array.from({ length: 4 }, (_, index) => ({ asset, start: index, end: index + 1 })), options });
    const soundRejected = await waitJob(tooManySounds.value.jobId); assert.equal(soundRejected.status, "failed"); assert.match(soundRejected.error, /3 sound sections/);
    const tooLong = await request("/api/render", "POST", { selections: Array.from({ length: 8 }, () => ({ ...clip, start: 0, end: 8 })), options });
    const lengthRejected = await waitJob(tooLong.value.jobId); assert.equal(lengthRejected.status, "failed"); assert.match(lengthRejected.error, /60 seconds/);
    const draft = await call("/api/preview-cut", { selections: [clip], options }); assert.ok(draft.url);
    const output = await call("/api/render", { selections: [clip], options }); assert.match(output.downloadUrl, /^\/media\/[a-f0-9-]{36}\?download=1$/);
    const snapshot = { version: 2, clips: [clip], options, briefInput: { description: "Keep this section" }, audioSelections: null };
    const saved = await call("/api/project/save", { snapshot }); assert.ok(saved.downloadUrl);
    const automatic = await request("/api/project/save", "POST", { snapshot, automatic: true }); assert.equal(automatic.status, 200); assert.equal(automatic.value.cancelled, false);
    const bytes = await request(output.downloadUrl); assert.equal(bytes.status, 200);
    await writeFile(path.join(folder, "export.mp4"), bytes.bytes);
    await run(ffmpeg as unknown as string, ["-v", "error", "-i", path.join(folder, "export.mp4"), "-f", "null", "-"]);
    const cancel = await request("/api/render", "POST", { selections: [clip], options: { ...options, finish: "cinematic" } }); assert.equal(cancel.status, 202);
    assert.equal((await request("/api/cancel", "POST", {})).value, true);
    const stopped = await waitJob(cancel.value.jobId); assert.equal(stopped.status, "cancelled");
    await host.close();
    const interruptedId = randomUUID(); const savedJobs = await storage.readJson("jobs.json");
    await storage.writeJson("jobs.json", [...savedJobs, { jobId: interruptedId, status: "running", progress: .5 }]);
    assert.ok(scratch.startsWith(folder + path.sep)); await rm(scratch, { recursive: true, force: true });
    host = await createMobileServer(config); port = (await host.listen()).port;
    const interrupted = await request(`/api/jobs/${interruptedId}`); assert.equal(interrupted.value.status, "failed"); assert.match(interrupted.value.error, /restarted/);
    const reopened = await call("/api/project/latest"); assert.equal(reopened.snapshot.clips[0].locked, true); assert.equal(reopened.snapshot.clips[0].start, .5); assert.equal(reopened.snapshot.clips[0].focus, .25);
    const range = await request(output.downloadUrl, "GET", undefined, { Range: "bytes=0-127" }); assert.equal(range.status, 206); assert.equal(range.bytes.length, 128);
    assert.equal((await request(output.downloadUrl, "GET", undefined, { Cookie: "" })).status, 401);
    assert.equal(digest(await readFile(fixture)), originalHash);
    assert.equal(digest(await readFile(path.join(storage.directory, `recordings/${upload.value.id}.mov`))), originalHash, "durable uploaded original is unchanged");
    assert.equal(tracked.length, 11, "every background action is registered with host keepAlive");
  } finally { await host.close(); await rm(folder, { recursive: true, force: true }); }
});

test("hosted uploads flush headers early, reject quotas, and roll back failed persistence", { timeout: 60000 }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-cloud-limits-")), storage = new DiskStorage(path.join(folder, "durable"));
  const fixture = path.join(folder, "short.mp4");
  await run(ffmpeg as unknown as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:size=160x120:duration=1", "-c:v", "libx264", "-preset", "ultrafast", fixture]);
  const original = await readFile(fixture), key = "b".repeat(64);
  const config = { dataDirectory: path.join(folder, "scratch"), staticDirectory: folder, ffmpegBinary: ffmpeg as unknown as string, ffprobeBinary: ffprobe.path, port: 0,
    token: key, remoteOrigin: "https://capsule.example", cloud: { storage, keepAlive: () => {} } };
  let host = await createMobileServer(config), port = (await host.listen()).port;
  const upload = (length: number, data: Buffer, waitForHeaders = false) => new Promise<any>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path: "/api/upload?name=short.mp4", method: "PUT", agent: false, headers: { Host: "capsule.example", Authorization: `Bearer ${key}`, "Content-Length": length } }, (res) => {
      if (waitForHeaders) req.end(data);
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    }); req.on("error", reject); if (waitForHeaders) req.flushHeaders(); else req.end(data);
  });
  try {
    storage.failUpload = true;
    const failed = await upload(original.length, original, true); assert.match(failed.error, /Synthetic storage failure/);
    assert.deepEqual(await readdir(path.join(config.dataDirectory, "recordings")), []);
    assert.equal(await storage.readJson("recordings.json"), null, "failed storage upload doesn't consume source quota");
    storage.failUpload = false;
    const oversized = await upload(hostedLimits.maxUploadBytes + 1, Buffer.alloc(0)); assert.match(oversized.error, /50 MB/);
    const longFile = path.join(folder, "long.mp4"), wideFile = path.join(folder, "wide.mp4"), squareFile = path.join(folder, "square.mp4");
    await run(ffmpeg as unknown as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:size=160x120:rate=1:duration=61", "-c:v", "libx264", "-preset", "ultrafast", longFile]);
    await run(ffmpeg as unknown as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:size=1922x1080:rate=1:duration=1", "-c:v", "libx264", "-preset", "ultrafast", wideFile]);
    await run(ffmpeg as unknown as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:size=1600x1600:rate=1:duration=1", "-c:v", "libx264", "-preset", "ultrafast", squareFile]);
    for (const file of [longFile, wideFile, squareFile]) {
      const bytes = await readFile(file); const rejected = await upload(bytes.length, bytes);
      assert.match(rejected.error, /60 seconds and 1080p/);
      assert.deepEqual(await readdir(path.join(config.dataDirectory, "recordings")), [], "invalid source leaves no cached original or quota entry");
    }
    const accepted = await upload(original.length, original, true); assert.ok(accepted.id);
    await host.close();
    const records = await storage.readJson("recordings.json"); records[0].bytes = hostedLimits.maxTotalSourceBytes;
    await storage.writeJson("recordings.json", records);
    host = await createMobileServer(config); port = (await host.listen()).port;
    const total = await upload(original.length, original); assert.match(total.error, /100 MB/);
    assert.equal((await storage.readJson("recordings.json")).length, 1);
  } finally { await host.close(); await rm(folder, { recursive: true, force: true }); }
});
