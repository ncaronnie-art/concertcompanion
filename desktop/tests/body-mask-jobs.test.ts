import test from "node:test";
import assert from "node:assert/strict";
import { prepareRenderBodyMasks, withoutBodyMaskPaths, type BodyMaskWorker } from "../electron/body-mask-jobs.js";
import { renderVideoWindows, type RenderSelection } from "../src/shared/render-plan.js";
import type { BodyMask } from "../src/shared/body-mask.js";

const shot = (path = "first.mov"): RenderSelection => ({ asset: { path, name: path, duration: 20, width: 320, height: 180, hasAudio: true }, start: 2, end: 5 });
const matte = (asset: RenderSelection["asset"], start: number, end: number, coverage = 1): BodyMask => ({
  version: 1, path: "generated-mask.mkv", start, end, width: 320, height: 180, sourceWidth: asset.width, sourceHeight: asset.height,
  fps: 30, frames: Math.ceil((end - start) * 30), coverage, modelId: "synthetic-only", modelSha256: "0".repeat(64), sourceSHA256: "1".repeat(64), warnings: [],
});

test("body pass strips caller-controlled mask paths and off does no model work", async () => {
  const source = { ...shot(), bodyMask: matte(shot().asset, 0, 20) };
  let calls = 0;
  const result = await prepareRenderBodyMasks("ffmpeg", [source], { aspect: "vertical", reduceRumble: false, bodyOutline: "off" }, "unused", { worker: async () => { calls++; throw Error("must not run"); } });
  assert.equal(calls, 0); assert.equal(result.selections[0].bodyMask, undefined);
  assert.equal(source.bodyMask.path, "generated-mask.mkv"); assert.notEqual(result.selections[0], source);
  assert.equal(withoutBodyMaskPaths([source])[0].start, 2);
});

test("mask preparation covers actual transition handles while preserving approved sections and subject", async () => {
  const sections = [{ ...shot(), subject: { x: .4, y: .5 } }, { ...shot("second.mov"), start: 8, end: 12 }];
  const before = JSON.stringify(sections), requests: { start: number; end: number; subject?: unknown }[] = [];
  const worker: BodyMaskWorker = async (_binary, asset, options) => {
    requests.push({ start: options.start, end: options.end, subject: options.subject });
    options.onProgress?.({ frames: 1, fraction: 1, sourceTime: options.end, phase: "done" });
    return matte(asset, options.start, options.end);
  };
  const progress: number[] = [];
  const options = { aspect: "vertical" as const, reduceRumble: true, bodyOutline: "subtle" as const, transition: "dissolve" as const };
  const result = await prepareRenderBodyMasks("ffmpeg", sections, options, "cache", { worker, onProgress: p => progress.push(p) });
  assert.deepEqual(requests.map(r => [r.start, r.end]), [[2, 5.2]]);
  assert.deepEqual(requests[0].subject, { x: .4, y: .5 });
  assert.equal(JSON.stringify(sections), before); assert.deepEqual(result.selections.map(s => [s.start, s.end]), [[2, 5], [8, 12]]);
  assert.equal(result.usable, 1); assert.equal(progress.at(-1), 1); assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]));
  const extended = renderVideoWindows(result.selections, options);
  assert.ok(extended.filter(s => s.bodyMask).every(s => s.bodyMask!.start <= s.start && s.bodyMask!.end >= s.end));
});

test("locks prevent borrowed footage, and partial silhouettes stay honest", async () => {
  const sections = [{ ...shot(), end: 12, locked: true }, { ...shot("second.mov"), end: 12 }];
  const seen: number[][] = [];
  const result = await prepareRenderBodyMasks("ffmpeg", sections, { aspect: "vertical", reduceRumble: false, bodyOutline: "subtle", transition: "smoothslide" }, "cache", {
    worker: async (_binary, asset, options) => { seen.push([options.start, options.end]); return matte(asset, options.start, options.end, asset.path === "first.mov" ? 1 : .01); },
  });
  assert.deepEqual(seen, [[2, 12], [2, 12]]); assert.equal(result.usable, 1); assert.match(result.note!, /1 of 2/);
  assert.equal(result.selections[0].locked, true); assert.equal(result.selections[1].bodyMask, undefined);
});

test("no clean silhouette is an actionable failure, never a fabricated body outline", async () => {
  await assert.rejects(prepareRenderBodyMasks("ffmpeg", [shot()], { aspect: "vertical", reduceRumble: false, bodyOutline: "electric" }, "cache", {
    worker: async (_binary, asset, options) => matte(asset, options.start, options.end, 0),
  }), /Choose a performer.*switch Performer neon off/);
});

test("Electric requests only bounded accent shots and keeps every other picture unchanged", async () => {
  const sections = Array.from({ length: 10 }, (_, index) => ({ ...shot(`shot-${index}.mov`), end: 12,
    visualCues: [{ seconds: 6, confidence: .95, strength: 1 }] }));
  const before = JSON.stringify(sections), requests: number[] = [];
  const result = await prepareRenderBodyMasks("ffmpeg", sections, { aspect: "vertical", reduceRumble: false, bodyOutline: "electric" }, "cache", {
    worker: async (_binary, asset, options) => {
      assert.equal(options.activeRanges?.length, 1);
      const range = options.activeRanges![0]; assert.ok(Math.abs(range.end - range.start - .8) < .001);
      requests.push(range.start); return matte(asset, options.start, options.end, .08);
    },
  });
  assert.ok(requests.length <= 7 && requests.length >= 4);
  assert.equal(result.selections.length, sections.length); assert.equal(JSON.stringify(sections), before);
  assert.ok(result.selections.some(s => !s.bodyMask)); assert.match(result.note!, /short music-timed accents/);
  assert.deepEqual(result.selections.map(s => [s.asset.path, s.start, s.end]), sections.map(s => [s.asset.path, s.start, s.end]));
});

test("cancellation preserves the input and does not report incomplete masks as ready", async () => {
  const controller = new AbortController(), sections = [shot()], before = JSON.stringify(sections);
  await assert.rejects(prepareRenderBodyMasks("ffmpeg", sections, { aspect: "vertical", reduceRumble: false, bodyOutline: "electric" }, "cache", {
    signal: controller.signal, worker: async (_binary, asset, options) => { controller.abort(); return matte(asset, options.start, options.end); },
  }), error => error instanceof Error && error.name === "AbortError");
  assert.equal(JSON.stringify(sections), before);
});

test("an accent fades within its actual reliable run without changing cached mask provenance", async () => {
  const section = { ...shot(), subject: { x: .5, y: .5, time: 3 } };
  let cached: BodyMask | undefined;
  const result = await prepareRenderBodyMasks("ffmpeg", [section], { aspect: "vertical", reduceRumble: false, bodyOutline: "electric" }, "cache", {
    worker: async (_binary, asset, options) => {
      const start = options.activeRanges![0].start;
      cached = { ...matte(asset, options.start, options.end, 13 / 90), activeRanges: options.activeRanges,
        frameQuality: Array.from({ length: 24 }, (_, i) => ({ time: start + i / 30, status: i < 13 ? "accepted" as const : "suppressed" as const, confidence: i < 13 ? .8 : 0 })) };
      return cached;
    },
  });
  const range = result.selections[0].bodyMask!.activeRanges![0];
  assert.ok(Math.abs(range.start - 2.6) < .0001); assert.ok(Math.abs(range.end - (2.6 + 13 / 30)) < .0001);
  assert.ok(Math.abs(cached!.activeRanges![0].end - 3.4) < .0001, "cached requested window remains unchanged");
  assert.equal(result.selections[0].bodyMask!.path, cached!.path);
});

test("separate short mask flashes cannot add up to a successful accent", async () => {
  await assert.rejects(prepareRenderBodyMasks("ffmpeg", [shot()], { aspect: "vertical", reduceRumble: false, bodyOutline: "electric" }, "cache", {
    worker: async (_binary, asset, options) => {
      const start = options.activeRanges![0].start;
      return { ...matte(asset, options.start, options.end, .2), frameQuality: Array.from({ length: 24 }, (_, i) => ({
        time: start + i / 30, status: i < 6 || i >= 12 && i < 18 ? "accepted" as const : "suppressed" as const, confidence: .8 })) };
    },
  }), /clean performer silhouette/);
});
