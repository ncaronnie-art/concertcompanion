import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { createMobileServer } from "../mobile/server.ts";
import { hostedLimits, type CloudStorage } from "../mobile/cloud-storage.ts";

type StoredResource = { id: string; kind: "video" | "project"; bytes: number; pin?: string };
class FixtureStorage implements CloudStorage {
  json = new Map<string, unknown>();
  files = new Map<string, Buffer>();
  deleted: string[] = [];
  failGeneratedUpload = false;
  failGeneratedRegistry = false;
  async readJson(key: string) { return structuredClone(this.json.get(key) ?? null); }
  async writeJson(key: string, value: unknown) {
    if (key === "generated.json" && this.failGeneratedRegistry) throw new Error("Synthetic generated registry failure");
    this.json.set(key, structuredClone(value));
  }
  async downloadFile(key: string, destination: string) {
    const bytes = this.files.get(key); if (!bytes) return false;
    await writeFile(destination, bytes); return true;
  }
  async uploadFile(key: string, source: string) {
    if (key.startsWith("generated/") && this.failGeneratedUpload) throw new Error("Synthetic generated upload failure");
    this.files.set(key, await readFile(source));
  }
  async delete(key: string) { this.deleted.push(key); this.files.delete(key); }
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fixtureVideo = (file: string) => new Promise<void>((resolve, reject) => {
  const child = spawn(ffmpeg as unknown as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=blue:size=160x120:rate=12:duration=1", "-c:v", "libx264", "-preset", "ultrafast", file], { windowsHide: true });
  let detail = ""; child.stderr.on("data", (data) => { detail += data; }); child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(detail)));
});

async function setup(pinBudgetFull = false) {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-cloud-retention-"));
  const fixture = path.join(folder, "source.mp4"); await fixtureVideo(fixture);
  const source = await readFile(fixture), sourceId = randomUUID(), sourceKey = `recordings/${sourceId}.mp4`;
  const storage = new FixtureStorage();
  storage.files.set(sourceKey, source);
  storage.json.set("recordings.json", [{ id: sourceId, name: "source.mp4", extension: ".mp4", bytes: source.length }]);
  // Byte weights simulate a full quota while actual media fixtures stay tiny.
  const resources: StoredResource[] = pinBudgetFull ? [
    { id: randomUUID(), kind: "video", bytes: hostedLimits.maxOutputBytes, pin: "draft" },
    { id: randomUUID(), kind: "video", bytes: hostedLimits.maxOutputBytes, pin: "export" },
  ] : [
    { id: randomUUID(), kind: "video", bytes: source.length, pin: `source:${sourceId}` },
    { id: randomUUID(), kind: "video", bytes: source.length, pin: "draft" },
    { id: randomUUID(), kind: "video", bytes: source.length, pin: "export" },
    { id: randomUUID(), kind: "project", bytes: 2, pin: "project" },
    ...Array.from({ length: hostedLimits.maxGeneratedFiles - 4 }, (): StoredResource => ({ id: randomUUID(), kind: "video", bytes: source.length })),
  ];
  for (const item of resources) storage.files.set(`generated/${item.id}.${item.kind === "video" ? "mp4" : "json"}`, item.kind === "video" ? source : Buffer.from("{}"));
  storage.json.set("generated.json", resources);
  const tasks: Promise<unknown>[] = [], key = "d".repeat(64);
  const host = await createMobileServer({ dataDirectory: path.join(folder, "cache"), staticDirectory: folder,
    ffmpegBinary: ffmpeg as unknown as string, ffprobeBinary: ffprobe.path, token: key, port: 0, remoteOrigin: "https://retention.example",
    cloud: { storage, keepAlive: (work) => { tasks.push(work); } } });
  const { port } = await host.listen();
  const request = (route: string, body?: unknown, range?: string, method = body === undefined ? "GET" : "POST") => new Promise<{ status: number; bytes: Buffer; value: any }>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path: route, method, agent: false,
      headers: { Host: "retention.example", Authorization: `Bearer ${key}`, ...(range ? { Range: range } : {}) } }, (res) => {
      const pieces: Buffer[] = []; res.on("data", (data) => pieces.push(Buffer.from(data))); res.on("error", reject);
      res.on("end", () => { const bytes = Buffer.concat(pieces); let value; try { value = JSON.parse(bytes.toString()); } catch { /* Video response. */ } resolve({ status: res.statusCode!, bytes, value }); });
    }); req.on("error", reject); req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  const call = async (route: string, body: unknown) => {
    const started = await request(route, body); assert.equal(started.status, 202, JSON.stringify(started.value));
    await tasks.at(-1);
    const finished = await request(`/api/jobs/${started.value.jobId}`); assert.equal(finished.status, 200); return finished.value;
  };
  const probed = await call("/api/probe", { path: sourceId }); assert.equal(probed.status, "completed");
  const snapshot = { version: 2, clips: [{ asset: probed.result, start: 0, end: .8, included: true, selectionSource: "manual", locked: true, excludedByUser: false }],
    options: { aspect: "portrait913", reduceRumble: false }, briefInput: { description: "Keep my section" }, audioSelections: null };
  const verifySources = () => assert.equal(hash(storage.files.get(sourceKey)!), hash(source), "the durable recording remains byte-for-byte unchanged");
  const close = async () => { await host.close(); assert.ok(path.resolve(folder).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(folder, { recursive: true, force: true }); };
  return { storage, resources, request, call, snapshot, verifySources, close, source, cache: path.join(folder, "cache") };
}

test("hosted retention evicts superseded artifacts while keeping current source, draft and export links after restart", { timeout: 60000 }, async () => {
  const fixture = await setup();
  try {
    const saved = await fixture.call("/api/project/save", { snapshot: fixture.snapshot });
    assert.equal(saved.status, "completed", JSON.stringify(saved));
    const manifest = await fixture.storage.readJson("generated.json") as StoredResource[];
    assert.equal(manifest.length, hostedLimits.maxGeneratedFiles);
    for (const kept of fixture.resources.slice(0, 3)) {
      assert.ok(manifest.some((item) => item.id === kept.id && item.pin === kept.pin), `keeps ${kept.pin}`);
      const range = await fixture.request(`/media/${kept.id}`, undefined, "bytes=0-127");
      assert.equal(range.status, 206); assert.deepEqual(range.bytes, fixture.source.subarray(0, 128));
    }
    assert.equal(manifest.filter((item) => item.pin === "project").length, 1, "only the latest project download stays pinned");
    assert.equal((await fixture.request(saved.result.downloadUrl)).status, 200);
    assert.ok(fixture.storage.deleted.length >= 1, "older generated artifacts make room");
    assert.ok(fixture.storage.deleted.every((key) => key.startsWith("generated/")));
    fixture.verifySources();
  } finally { await fixture.close(); }
});

test("failed artifact upload and registry commit preserve existing media and the durable manifest", { timeout: 60000 }, async () => {
  const fixture = await setup();
  try {
    const before = await fixture.storage.readJson("generated.json");
    const oldKeys = new Set(fixture.resources.map((item) => `generated/${item.id}.${item.kind === "video" ? "mp4" : "json"}`));
    for (const failure of ["upload", "registry"] as const) {
      fixture.storage.failGeneratedUpload = failure === "upload";
      fixture.storage.failGeneratedRegistry = failure === "registry";
      const failed = await fixture.call("/api/project/save", { snapshot: fixture.snapshot });
      assert.equal(failed.status, "failed"); assert.match(failed.error, /Synthetic generated/);
      assert.deepEqual(await fixture.storage.readJson("generated.json"), before);
      assert.ok(fixture.storage.deleted.every((key) => !oldKeys.has(key)), "a failed replacement cannot delete an existing file");
      const range = await fixture.request(`/media/${fixture.resources[1].id}`, undefined, "bytes=0-127");
      assert.equal(range.status, 206); assert.deepEqual(range.bytes, fixture.source.subarray(0, 128));
      fixture.verifySources();
    }
  } finally { await fixture.close(); }
});

test("a full protected media budget rejects new work without deleting the current draft or export", { timeout: 60000 }, async () => {
  const fixture = await setup(true);
  try {
    const before = await fixture.storage.readJson("generated.json");
    const failed = await fixture.call("/api/project/save", { snapshot: fixture.snapshot });
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    assert.match(failed.error, /space|storage|limit|room|budget/i);
    assert.deepEqual(await fixture.storage.readJson("generated.json"), before);
    assert.deepEqual(fixture.storage.deleted, []);
    for (const item of fixture.resources) assert.equal((await fixture.request(`/media/${item.id}`, undefined, "bytes=0-127")).status, 206);
    fixture.verifySources();
  } finally { await fixture.close(); }
});

test("a failed local cache mirror cannot roll back an already committed durable recording or result", { timeout: 60000 }, async () => {
  const fixture = await setup();
  try {
    // Creating directories at these cache-file paths makes atomic rename fail on Windows and Unix.
    await mkdir(path.join(fixture.cache, "recordings.json"));
    await mkdir(path.join(fixture.cache, "generated.json"));
    const uploaded = await fixture.request("/api/upload?name=another.mp4", fixture.source, undefined, "PUT");
    assert.equal(uploaded.status, 200); assert.ok(uploaded.value.id, JSON.stringify(uploaded.value));
    const records = await fixture.storage.readJson("recordings.json") as { id: string }[];
    assert.ok(records.some((item) => item.id === uploaded.value.id));
    assert.equal(hash(fixture.storage.files.get(`recordings/${uploaded.value.id}.mp4`)!), hash(fixture.source));
    const saved = await fixture.call("/api/project/save", { snapshot: fixture.snapshot });
    assert.equal(saved.status, "completed", JSON.stringify(saved));
    assert.equal((await fixture.request(saved.result.downloadUrl)).status, 200);
    const manifest = await fixture.storage.readJson("generated.json") as StoredResource[];
    assert.ok(manifest.every((item) => fixture.storage.files.has(`generated/${item.id}.${item.kind === "video" ? "mp4" : "json"}`)), "every committed registry entry still has durable media");
    fixture.verifySources();
  } finally { await fixture.close(); }
});

test("returning to a cached draft protects the draft on screen through later project saves", { timeout: 90000 }, async () => {
  const fixture = await setup();
  try {
    const body = { selections: fixture.snapshot.clips, options: fixture.snapshot.options };
    const draftA = await fixture.call("/api/preview-cut", body);
    const draftB = await fixture.call("/api/preview-cut", { ...body, options: { ...body.options, finish: "warm" } });
    assert.equal(draftA.status, "completed", JSON.stringify(draftA));
    assert.equal(draftB.status, "completed", JSON.stringify(draftB));
    assert.notEqual(draftA.result.url, draftB.result.url);
    const revisited = await fixture.call("/api/preview-cut", body);
    assert.equal(revisited.status, "completed"); assert.equal(revisited.result.url, draftA.result.url, "the existing preview is reused");
    // Repeated explicit project downloads exercise eviction without re-rendering footage.
    for (let index = 0; index < hostedLimits.maxGeneratedFiles; index++) {
      const saved = await fixture.call("/api/project/save", { snapshot: fixture.snapshot });
      assert.equal(saved.status, "completed", JSON.stringify(saved));
    }
    const current = await fixture.request(revisited.result.url, undefined, "bytes=0-127");
    assert.equal(current.status, 206, "the draft actually returned to the editor stays playable");
    assert.equal(current.bytes.length, 128);
    fixture.verifySources();
  } finally { await fixture.close(); }
});
