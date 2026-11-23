import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PhoneJobTimeout, waitForPhoneJob, type PhoneJob } from "../src/renderer/phone-jobs.ts";
import { phoneRequest, rememberPhoneKey, verifyPhoneConnection, hostedPhoneTest, remotePhoneTest, validatePhoneFiles, validatePhoneEdit, phoneLimitSummary, readPhoneUpload, installBrowserBridge, pairPhone, type PhoneHealth } from "../src/renderer/browser-bridge.ts";
import { App } from "../src/renderer/App.tsx";

const health: PhoneHealth = { ready: true, connectionMode: "hosted-test", limits: {
  maxUploadBytes: 50 * 1024 ** 2, maxTotalSourceBytes: 100 * 1024 ** 2, maxSourceSeconds: 60, maxOutputSeconds: 60, maxRecordings: 8, maxPictureSections: 8, maxAudioSections: 3,
} };

test("phone processing polls until the original result arrives and clamps progress", async () => {
  const result = { url: "/media/finished" }, progress: number[] = [];
  const responses: PhoneJob<typeof result>[] = [
    { jobId: "job-1", status: "running", progress: -0.1 },
    { jobId: "job-1", status: "running", progress: 0.6 },
    { jobId: "job-1", status: "completed", progress: 2, result },
  ];
  assert.deepEqual(await waitForPhoneJob("job-1", async () => responses.shift()!, (value) => progress.push(value), { intervalMs: 1 }), result);
  assert.deepEqual(progress, [0, 0.6, 1]);
});

test("failed, cancelled and mismatched jobs never become a successful cut", async () => {
  for (const [job, expected] of [
    [{ jobId: "job-1", status: "failed", progress: 0, error: "Choose a shorter source." }, /shorter source/],
    [{ jobId: "job-1", status: "cancelled", progress: 0.3 }, /Processing stopped/],
    [{ jobId: "someone-else", status: "completed", progress: 1, result: {} }, /did not match/],
    [{ jobId: "job-1", status: "completed", progress: 1 }, /could not be retrieved/],
  ] as const) {
    await assert.rejects(waitForPhoneJob("job-1", async () => job, () => {}, { intervalMs: 1 }), expected);
  }
});

test("a stalled processing request is aborted at its bounded timeout", async () => {
  let aborted = false;
  await assert.rejects(waitForPhoneJob("job-1", async (_id, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
  }), () => {}, { timeoutMs: 10 }), PhoneJobTimeout);
  assert.equal(aborted, true);
});

test("bridge preserves synchronous results and uses authenticated opaque job URLs", async (context) => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  const calls: { url: string; method?: string; authorization: string | null }[] = [];
  rememberPhoneKey("test-session-key".repeat(4));
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method, authorization: new Headers(init?.headers).get("Authorization") });
    return new Response(JSON.stringify(url === "/api/preview" ? { jobId: "job-1" } :
      url === "/api/jobs/job-1" ? { jobId: "job-1", status: "completed", progress: 1, result: { url: "/media/finished" } } : { id: "source-1" }),
    { status: url === "/api/preview" ? 202 : 200 });
  };
  assert.deepEqual(await phoneRequest("probe", { path: "source" }), { id: "source-1" });
  assert.deepEqual(await phoneRequest("preview", { id: "source-1" }), { url: "/media/finished" });
  assert.deepEqual(calls.map((call) => [call.url, call.method]), [["/api/probe", "POST"], ["/api/preview", "POST"], ["/api/jobs/job-1", "GET"]]);
  assert.ok(calls.every((call) => call.authorization?.startsWith("Bearer ") && !call.url.includes("key=")));
  globalThis.fetch = async () => new Response(JSON.stringify({ jobId: "../../outside" }), { status: 202 });
  await assert.rejects(phoneRequest("preview", {}), /did not start correctly/);
});

test("hosted limits reject oversized selections before upload without constraining LAN mode", () => {
  const file = (size: number) => ({ name: "concert.mov", size });
  assert.doesNotThrow(() => validatePhoneFiles([file(50 * 1024 ** 2), file(50 * 1024 ** 2)], health));
  assert.throws(() => validatePhoneFiles([file(50 * 1024 ** 2 + 1)], health), /too large/);
  assert.throws(() => validatePhoneFiles([file(40 * 1024 ** 2), file(40 * 1024 ** 2), file(40 * 1024 ** 2)], health), /total more than/);
  assert.throws(() => validatePhoneFiles(Array.from({ length: 9 }, () => file(1)), health), /at most 8/);
  assert.doesNotThrow(() => validatePhoneFiles([file(10 ** 10)], { ready: true, connectionMode: "local-network" }));
  assert.match(phoneLimitSummary(health), /50 MB each; 100 MB and 8 recordings/);
});

test("streamed upload errors are rejected even when headers already reported HTTP 200", () => {
  assert.deepEqual(readPhoneUpload('{"id":"source-1","path":"source-1"}', 200), { id: "source-1", path: "source-1" });
  assert.throws(() => readPhoneUpload('{"error":"This test is full."}', 200), /test is full/);
  assert.throws(() => readPhoneUpload('{"error":"This source is too large."}', 413), /source is too large/);
  assert.throws(() => readPhoneUpload('{}', 200), /did not finish correctly/);
});

test("hosted edit limits accept eight picture sections and three sound moments without restricting local editing", () => {
  assert.doesNotThrow(() => validatePhoneEdit(8, 3, health));
  assert.doesNotThrow(() => validatePhoneEdit(8, undefined, health));
  assert.throws(() => validatePhoneEdit(9, undefined, health), /8 picture sections.*Fewer cuts.*kept sections have not been changed/);
  assert.throws(() => validatePhoneEdit(9, 3, health), /Reduce Videos to show/);
  assert.throws(() => validatePhoneEdit(8, 4, health), /3 separate sound moments.*Sound moments.*kept sections have not been changed/);
  assert.doesNotThrow(() => validatePhoneEdit(100, 12, { ready: true, connectionMode: "local-network", limits: health.limits }));
  assert.doesNotThrow(() => validatePhoneEdit(100, 12, { ready: true, connectionMode: "protected-remote", limits: health.limits }));
  const smaller = { ...health, limits: { ...health.limits!, maxPictureSections: 5, maxAudioSections: 2 } };
  assert.throws(() => validatePhoneEdit(6, 2, smaller), /5 picture sections/);
  assert.throws(() => validatePhoneEdit(5, 3, smaller), /2 separate sound moments/);
  assert.match(phoneLimitSummary(smaller), /5 picture sections and 2 separate sound moments/);
});

test("idle bridge sends no status requests before verification or in hosted mode, while paired local and remote progress still works", async (context) => {
  const original = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, location: globalThis.location };
  context.after(() => { Object.assign(globalThis, original); });
  let tick!: () => Promise<void>;
  globalThis.window = { setInterval: (callback: () => Promise<void>) => { tick = callback; return 1; } } as unknown as Window & typeof globalThis;
  globalThis.document = { hidden: false } as Document;
  globalThis.location = { hash: "", protocol: "https:" } as Location;
  const calls: string[] = [], progress: number[] = [];
  let mode: PhoneHealth["connectionMode"] = "hosted-test";
  globalThis.fetch = async (input) => {
    const route = String(input); calls.push(route);
    return new Response(JSON.stringify(route === "/api/health" ? { ...health, connectionMode: mode } :
      route === "/api/pair" ? { token: "paired-key".repeat(7) } : { busy: true, progress: .4 }));
  };
  rememberPhoneKey("test-key".repeat(8));
  installBrowserBridge(); window.concertCompass.onProgress((value) => progress.push(value));
  await tick(); await tick();
  assert.deepEqual(calls, [], "having a stored key does not authorize background polling before health succeeds");
  await verifyPhoneConnection(); calls.length = 0;
  await tick(); await tick();
  assert.deepEqual(calls, [], "hosted progress uses jobs and upload events, not idle status requests");
  mode = "local-network";
  await pairPhone("123456");
  assert.deepEqual(calls, ["/api/pair", "/api/health"], "newly paired local sessions verify their connection too");
  calls.length = 0; await tick();
  assert.deepEqual(calls, ["/api/status"]); assert.deepEqual(progress, [.4]);
  mode = "protected-remote";
  await verifyPhoneConnection(); calls.length = 0; await tick();
  assert.deepEqual(calls, ["/api/status"]); assert.deepEqual(progress, [.4, .4]);
});

test("authenticated hosted health produces truthful upload and storage copy without PC instructions", async (context) => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  context.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
  globalThis.fetch = async () => new Response(JSON.stringify(health));
  await verifyPhoneConnection();
  assert.equal(hostedPhoneTest(), true); assert.equal(remotePhoneTest(), false);
  globalThis.window = { concertCompass: { mobile: true } } as unknown as Window & typeof globalThis;
  const markup = renderToStaticMarkup(createElement(App));
  assert.match(markup, /uploaded to Netlify for processing/);
  assert.match(markup, /Finished video: up to 60 seconds/);
  assert.match(markup, /8 picture sections and 3 separate sound moments/);
  assert.doesNotMatch(markup, /same Wi-Fi|computer awake|approved relay|Processed on your computer/);
});
