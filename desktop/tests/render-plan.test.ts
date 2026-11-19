import test from "node:test";
import assert from "node:assert/strict";
import { buildRenderCommand, suggestedRange, type MediaAsset } from "../src/shared/render-plan.ts";

const clip: MediaAsset = { path: "C:\\source.mov", name: "source.mov", duration: 120, width: 1920, height: 1080, hasAudio: true };

test("suggested range is safely inside the source", () => {
  assert.deepEqual(suggestedRange(clip), { start: 54, end: 66 });
});

test("render command creates normalized MP4 with concat and progress", () => {
  const { args, totalSeconds } = buildRenderCommand([{ asset: clip, start: 4, end: 9 }], "C:\\out.mp4");
  assert.equal(totalSeconds, 5);
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("-progress"));
  assert.match(args[args.indexOf("-filter_complex") + 1], /concat=n=1:v=1:a=1/);
});

test("silent clips receive a generated stereo soundtrack", () => {
  const silent = { ...clip, hasAudio: false };
  const { args } = buildRenderCommand([{ asset: silent, start: 4, end: 9 }], "C:\\out.mp4");
  assert.ok(args.includes("anullsrc=channel_layout=stereo:sample_rate=48000"));
});
