import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { createMobileServer } from "../mobile/server.ts";
import { measureAudio } from "../electron/audio-analysis.ts";

const run = (binary: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(binary, args, { windowsHide: true }); let stderr = "";
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-3000); });
  child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
});
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

test("protected phone mode rejects invalid origins, non-loopback binds, and short access keys", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-phone-config-test-"));
  const config = { dataDirectory: path.join(folder, "data"), staticDirectory: folder, ffmpegBinary: process.execPath, ffprobeBinary: process.execPath, port: 0 };
  try {
    for (const remoteOrigin of ["", "http://phone.example", "https://phone.example/", "https://phone.example/path", "https://user:secret@phone.example", "https://phone.example?key=test", "https://phone.example#key", "https://*.example", "//phone.example", "https://phone.example:443"]) {
      await assert.rejects(createMobileServer({ ...config, remoteOrigin }), /exact HTTPS origin/, remoteOrigin);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "phone.example"]) {
      await assert.rejects(createMobileServer({ ...config, remoteOrigin: "https://phone.example", host }), /listen only on this computer/);
    }
    await assert.rejects(createMobileServer({ ...config, remoteOrigin: "https://phone.example", token: "a".repeat(32) }), /32-byte phone access key/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("protected phone origin keeps API and media private and forwarded shutdown inaccessible", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-phone-remote-test-"));
  const remoteOrigin = "https://phone.example:9443", remoteHost = "phone.example:9443";
  await writeFile(path.join(folder, "index.html"), "<!doctype html><title>Vibe Capsule connection</title>");
  const fixture = path.join(folder, "short.mov");
  await run(ffmpeg as unknown as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=blue:size=320x240:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", fixture]);
  let callbackCount = 0;
  const host = await createMobileServer({ dataDirectory: path.join(folder, "data"), staticDirectory: folder,
    ffmpegBinary: ffmpeg as unknown as string, ffprobeBinary: ffprobe.path, port: 0, remoteOrigin,
    onStop: () => { callbackCount++; } });
  const { port, host: boundHost } = await host.listen();
  const localHost = `127.0.0.1:${port}`;
  const request = (route: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) => new Promise<{ status: number; body: string; bytes: Buffer; headers: Record<string, any> }>((resolve, reject) => {
    const outgoing = httpRequest({ hostname: "127.0.0.1", port, path: route, method, agent: false,
      headers: { Host: remoteHost, ...headers } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
      response.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode!, body: bytes.toString("utf8"), bytes, headers: response.headers }); });
    }); outgoing.on("error", reject); outgoing.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  const authorized = { Authorization: `Bearer ${host.token}` };
  try {
    assert.equal(boundHost, "127.0.0.1"); assert.match(host.token, /^[a-f0-9]{64}$/);
    const page = await request("/"); assert.equal(page.status, 200); assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.ok(!page.body.includes(host.token)); assert.ok(!page.body.includes(host.pairingCode));
    for (const route of ["/api/health", "/api/status", "/api/project/latest", "/media/00000000-0000-0000-0000-000000000000"]) {
      assert.equal((await request(route)).status, 401, `${route} requires authentication`);
      assert.equal((await request(route, "GET", { Authorization: "Bearer wrong" })).status, 401);
    }
    assert.equal((await request("/api/upload?name=test.mp4", "PUT")).status, 401);
    assert.equal((await request("/api/cancel", "POST")).status, 401);
    const health = await request("/api/health", "GET", { ...authorized, Origin: remoteOrigin });
    assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.body), { ready: true, connectionMode: "protected-remote" });
    assert.deepEqual(health.headers["set-cookie"], [`__Host-vibe-session=${host.token}; HttpOnly; Secure; SameSite=Strict; Path=/`]);
    const Cookie = `__Host-vibe-session=${host.token}`;
    assert.equal((await request("/api/status", "GET", { Cookie })).status, 200);
    for (const invalidCookie of ["__Host-vibe-session=wrong", `vibe-session=${host.token}`, `${Cookie}; ${Cookie}`, "__Host-vibe-session=%00"]) {
      assert.equal((await request("/api/status", "GET", { Cookie: invalidCookie })).status, 401);
    }
    assert.equal((await request(`/api/status?key=${host.token}`)).status, 401, "remote query strings cannot authorize requests");
    assert.equal((await request("/media/missing?key=wrong")).status, 401);
    assert.equal((await request(`/media/missing?key=${host.token}`)).status, 401);
    assert.equal((await request("/media/missing", "GET", { Cookie })).status, 404, "authenticated media uses registered resources only");
    const call = async (route: string, body: unknown) => {
      const response = await request(route, "POST", { Cookie, Origin: remoteOrigin, "Content-Type": "application/json" }, body);
      assert.equal(response.status, 200, response.body); return JSON.parse(response.body);
    };
    const uploaded = await request("/api/upload?name=short.mov", "PUT", { Cookie, Origin: remoteOrigin }, await readFile(fixture));
    assert.equal(uploaded.status, 200, uploaded.body);
    const file = JSON.parse(uploaded.body), asset = await call("/api/probe", { path: file.path });
    const preview = await call("/api/preview", { id: file.id });
    assert.match(preview.url, /^\/media\/[a-f0-9-]{36}$/); assert.ok(!preview.url.includes(host.token));
    assert.equal((await request(preview.url)).status, 401);
    const range = await request(preview.url, "GET", { Cookie, Range: "bytes=0-127" });
    assert.equal(range.status, 206); assert.equal(range.bytes.length, 128); assert.match(range.headers["content-range"], /^bytes 0-127\//);
    const options = { aspect: "portrait913", reduceRumble: false };
    const clip = { asset, start: 0, end: 1, included: true, selectionSource: "manual", locked: true, excludedByUser: false };
    const rendered = await call("/api/render", { selections: [clip], options });
    assert.match(rendered.downloadUrl, /^\/media\/[a-f0-9-]{36}\?download=1$/);
    const saved = await call("/api/project/save", { snapshot: { version: 2, clips: [clip], options, briefInput: { description: "Keep this short moment" }, audioSelections: null } });
    assert.match(saved.downloadUrl, /^\/media\/[a-f0-9-]{36}\?download=1$/);
    const download = await request(rendered.downloadUrl, "GET", { Cookie });
    assert.equal(download.status, 200); assert.match(download.headers["content-disposition"], /Vibe Capsule.mp4/);
    const output = path.join(folder, "remote-result.mp4"); await writeFile(output, download.bytes);
    await run(ffmpeg as unknown as string, ["-v", "error", "-i", output, "-f", "null", "-"]);
    for (const Host of ["phone.example", "evil.phone.example:9443", "phone.example.attacker.test:9443", "attacker.test", "192.168.1.20:4317"]) {
      assert.equal((await request("/api/status", "GET", { ...authorized, Host, "X-Forwarded-Host": remoteHost })).status, 403, `${Host} is not allowed`);
    }
    for (const Origin of ["http://phone.example:9443", "https://phone.example", "https://phone.example:9443.attacker.test", "null", `http://${localHost}`]) {
      assert.equal((await request("/api/status", "GET", { ...authorized, Origin })).status, 403, `${Origin} is not the exact remote origin`);
    }
    assert.equal((await request(`http://${remoteHost}/api/status`, "GET", authorized)).status, 403, "absolute request targets cannot downgrade the origin");
    const localHealth = await request("/api/health", "GET", { ...authorized, Host: localHost, Origin: `http://${localHost}` });
    assert.equal(localHealth.status, 200, "plain localhost control remains available");
    assert.equal(localHealth.headers["set-cookie"], undefined, "secure sessions are only established at the exact remote HTTPS origin");
    assert.equal((await request("/api/status", "GET", { Cookie, Host: localHost })).status, 401, "remote session cookies cannot authorize local control");
    assert.equal((await request("/api/status", "GET", { ...authorized, Host: localHost, Origin: remoteOrigin })).status, 403);
    for (const Host of [remoteHost, localHost]) {
      const pairing = await request("/api/pair", "POST", { Host, ...authorized }, { code: host.pairingCode });
      assert.equal(pairing.status, 403); assert.ok(!pairing.body.includes(host.token));
    }
    assert.equal((await request("/api/stop", "POST")).status, 401);
    assert.equal((await request("/api/stop", "POST", authorized)).status, 403, "remote Host cannot stop even through loopback");
    for (const header of ["Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-Port", "X-Real-IP", "Via"]) {
      assert.equal((await request("/api/stop", "POST", { ...authorized, Host: localHost, [header]: "" })).status, 403, `${header} makes shutdown unavailable`);
    }
    assert.equal(callbackCount, 0);
    assert.equal((await request("/api/stop", "POST", { ...authorized, Host: localHost })).status, 200);
    for (let attempt = 0; attempt < 20 && !callbackCount; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(callbackCount, 1);
  } finally { await host.close(); await rm(folder, { recursive: true, force: true }); }
});

test("host stop requires local connection and valid token, and acknowledges before callback", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-phone-stop-test-"));
  let callbackCount = 0, responseFinished = false, simulatedLan = false;
  const host = await createMobileServer({ dataDirectory: path.join(folder, "data"), staticDirectory: folder,
    ffmpegBinary: process.execPath, ffprobeBinary: process.execPath, port: 0,
    onStop: () => { assert.equal(responseFinished, true, "HTTP response finishes before shutdown callback"); callbackCount++; } });
  host.server.on("connection", (socket) => { if (simulatedLan) Object.defineProperty(socket, "remoteAddress", { value: "192.168.1.22" }); });
  host.server.on("request", (request, response) => { if (request.url === "/api/stop") response.on("finish", () => { if (response.statusCode === 200) responseFinished = true; }); });
  const { port } = await host.listen();
  const stopRequest = (token?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}/api/stop`, { method: "POST", agent: false,
      headers: token ? { Authorization: `Bearer ${token}` } : {} }, (response) => {
        let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, body }));
      }); request.on("error", reject); request.end();
  });
  try {
    assert.equal((await stopRequest()).status, 401);
    assert.equal((await stopRequest("wrong")).status, 401);
    simulatedLan = true;
    assert.equal((await stopRequest(host.token)).status, 403);
    assert.equal(callbackCount, 0);
    simulatedLan = false;
    const response = await stopRequest(host.token);
    assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), { stopping: true });
    for (let attempt = 0; attempt < 20 && !callbackCount; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(callbackCount, 1);
  } finally { await host.close(); await rm(folder, { recursive: true, force: true }); }
});

test("phone host pairs safely, uploads video, seeks preview, exports titles, and reopens after restart", { timeout: 120000 }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-phone-test-"));
  const staticDirectory = path.join(folder, "site"), dataDirectory = path.join(folder, "data");
  await mkdir(staticDirectory); await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Vibe Capsule</title>");
  const fixture = path.join(folder, "source.mov");
  await run(ffmpeg as unknown as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=green:size=320x240:rate=24:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", fixture]);
  const original = await readFile(fixture), originalHash = hash(original);
  const controller = new AbortController();
  const interruptedAnalysis = measureAudio(ffmpeg as unknown as string, fixture, false, controller.signal);
  controller.abort();
  await assert.rejects(interruptedAnalysis, (error: Error) => error.name === "AbortError", "sound analysis responds to host cancellation");
  const config = { dataDirectory, staticDirectory, ffmpegBinary: ffmpeg as unknown as string, ffprobeBinary: ffprobe.path, port: 0, maxUploadBytes: 1024 * 1024 };
  let host = await createMobileServer(config); let port = (await host.listen()).port;
  let base = `http://127.0.0.1:${port}`;
  const call = async (route: string, body?: unknown) => {
    const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  try {
    assert.match(await (await fetch(base)).text(), /Vibe Capsule/);
    assert.deepEqual(await call("/api/health"), { ready: true, connectionMode: "local-network" });
    assert.equal((await fetch(base + "/api/status")).status, 401);
    assert.equal((await fetch(base + "/%2e%2e%2fdata/access-key")).status, 404);
    assert.equal((await fetch(base + "/api/status", { headers: { Authorization: `Bearer ${host.token}`, Origin: "https://unrelated.example" } })).status, 403);
    const rebinding = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(base + "/api/status", { headers: { Host: "attacker.example", Authorization: `Bearer ${host.token}` } }, (response) => { response.resume(); resolve(response.statusCode!); }); request.on("error", reject); request.end();
    });
    assert.equal(rebinding, 403);
    const lanHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(base + "/api/status", { headers: { Host: "192.168.1.20:4317", Origin: "http://192.168.1.20:4317", Authorization: `Bearer ${host.token}` } }, (response) => { response.resume(); resolve(response.statusCode!); }); request.on("error", reject); request.end();
    });
    assert.equal(lanHost, 200, "default mode still accepts same-origin private network hosts");
    const pair = await fetch(base + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: host.pairingCode }) });
    assert.equal((await pair.json()).token, host.token);
    const uploadedResponse = await fetch(base + "/api/upload?name=Ronnie%27s%20concert.mov", { method: "PUT", headers: { Authorization: `Bearer ${host.token}` }, body: original });
    assert.equal(uploadedResponse.status, 200); const uploaded = await uploadedResponse.json();
    assert.match(uploaded.path, /^[a-f0-9-]{36}$/); assert.equal(uploaded.name, "Ronnie's concert.mov");
    const asset = await call("/api/probe", { path: uploaded.path }); assert.equal(asset.width, 320); assert.equal(asset.hasAudio, true);
    assert.equal((await fetch(base + "/api/probe", { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path: fixture }) })).status, 404);
    const preview = await call("/api/preview", { id: uploaded.id });
    const range = await fetch(base + preview.url, { headers: { Range: "bytes=0-127" } });
    assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 128); assert.match(range.headers.get("content-range")!, /^bytes 0-127\//);
    const head = await fetch(base + preview.url, { method: "HEAD" }); assert.equal(head.headers.get("accept-ranges"), "bytes"); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(base + preview.url.replace(/\?key=.*/, ""))).status, 401);
    const options = { aspect: "portrait913", reduceRumble: false, eventTitle: "Ronnie's night", showClipLabels: true };
    const clip = { asset, start: 0, end: 3.5, included: true, selectionSource: "manual", locked: true, excludedByUser: false, label: "Opening song" };
    const bins = await call("/api/analyze-audio", { asset }); assert.ok(bins.length > 1);
    const draft = await call("/api/preview-cut", { selections: [clip], options }); assert.ok(draft.url);
    const result = await call("/api/render", { selections: [clip], options }); assert.match(result.downloadUrl, /download=1/);
    const downloaded = await fetch(base + result.downloadUrl); assert.match(downloaded.headers.get("content-disposition")!, /Vibe Capsule.mp4/);
    const output = path.join(folder, "result.mp4"); await writeFile(output, Buffer.from(await downloaded.arrayBuffer()));
    await run(ffmpeg as unknown as string, ["-v", "error", "-i", output, "-f", "null", "-"]);
    const titleFrame = path.join(folder, "title.gray");
    await run(ffmpeg as unknown as string, ["-v", "error", "-ss", "0.8", "-i", output, "-frames:v", "1", "-vf", "crop=640:230:40:90,format=gray", "-f", "rawvideo", titleFrame]);
    assert.ok((await readFile(titleFrame)).filter((value) => value > 210).length > 50, "opening title is visible in the phone export");
    const generatedBeforeCancel = (await readdir(path.join(dataDirectory, "generated"))).sort();
    const pendingRender = fetch(base + "/api/render", { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ selections: [clip], options: { ...options, finish: "warm" } }) });
    let stopped = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await call("/api/status");
      if (status.busy) {
        const conflicting = await fetch(base + "/api/preview", { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: uploaded.id }) });
        assert.equal(conflicting.status, 409, "only one video-processing job runs at once");
        stopped = await call("/api/cancel", {}); if (stopped) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stopped, true);
    const cancelledRender = await pendingRender; assert.equal(cancelledRender.status, 409); assert.match((await cancelledRender.json()).error, /Processing stopped/);
    assert.deepEqual((await readdir(path.join(dataDirectory, "generated"))).sort(), generatedBeforeCancel, "cancelled render leaves no partial MP4 or overlay");
    const uploadCount = (await readdir(path.join(dataDirectory, "recordings"))).length;
    const interrupted = httpRequest(base + "/api/upload?name=interrupted.mov", { method: "PUT", headers: { Authorization: `Bearer ${host.token}`, "Content-Length": "10000" } });
    interrupted.on("error", () => {}); interrupted.write(Buffer.alloc(100));
    for (let attempt = 0; attempt < 100 && !(await call("/api/status")).busy; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    interrupted.destroy();
    for (let attempt = 0; attempt < 100 && (await call("/api/status")).busy; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await call("/api/status")).busy, false);
    assert.equal((await readdir(path.join(dataDirectory, "recordings"))).length, uploadCount, "interrupted upload is removed");
    const snapshot = { version: 2, clips: [clip], options, briefInput: { description: "Keep this moment" }, audioSelections: null };
    const filesBeforeAutosave = await readdir(path.join(dataDirectory, "generated"));
    const automatic = await call("/api/project/save", { snapshot, automatic: true }); assert.equal(automatic.cancelled, false); assert.equal(automatic.downloadUrl, undefined);
    assert.deepEqual(await readdir(path.join(dataDirectory, "generated")), filesBeforeAutosave, "autosave does not create extra export files");
    const saved = await call("/api/project/save", { snapshot }); assert.ok(saved.downloadUrl);
    const previousToken = host.token; await host.close(); host = await createMobileServer(config); port = (await host.listen()).port; base = `http://127.0.0.1:${port}`;
    assert.equal(host.token, previousToken);
    const reopened = await call("/api/project/latest"); assert.equal(reopened.snapshot.clips[0].locked, true); assert.equal(reopened.snapshot.options.eventTitle, options.eventTitle); assert.equal(reopened.files[0].path, uploaded.id);
    assert.equal(hash(await readFile(fixture)), originalHash, "original footage remained byte-for-byte unchanged");
    assert.equal(hash(await readFile(path.join(dataDirectory, "recordings", uploaded.id + ".mov"))), originalHash, "uploaded original was not rewritten");
    for (let index = 0; index < 5; index++) assert.equal((await fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ code: "wrong" }) })).status, 401);
    assert.equal((await fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ code: host.pairingCode }) })).status, 429);
  } finally { await host.close(); await rm(folder, { recursive: true, force: true }); }
});
