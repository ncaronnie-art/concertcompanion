import test from "node:test";
import assert from "node:assert/strict";
import { buildRenderCommand, buildAudioLedRenderCommand, renderDimensions, type MediaAsset } from "../src/shared/render-plan.js";

const asset: MediaAsset = { path: "portrait.mp4", name: "portrait", duration: 20,
  audioDuration: 20, width: 720, height: 1280, hasAudio: true };
const options = { aspect: "vertical" as const, quality: "high" as const, reduceRumble: false,
  transition: "smoothslide" as const, audioTransition: "crossfade" as const, audioCrossfadeSeconds: 2 };

test("best available export keeps native portrait detail and only uses Full HD when supplied", () => {
  assert.deepEqual(renderDimensions(options, "export", [asset]), { width: 720, height: 1280 });
  assert.deepEqual(renderDimensions(options, "export", [{ ...asset, width: 1080, height: 1920 }]), { width: 1080, height: 1920 });
  assert.deepEqual(renderDimensions(options, "export", [{ ...asset, width: 2160, height: 3840 }]), { width: 1080, height: 1920 });
  assert.deepEqual(renderDimensions(options, "draft", [asset]), { width: 360, height: 640 });
  assert.throws(() => renderDimensions(options, "export", [{ ...asset, width: Number.NaN }]), /dimensions/);
});

test("manual sections remain protected even when a legacy project lacks an explicit lock", () => {
  const clips = [{ asset, start: 2, end: 6, selectionSource: "manual" as const },
    { asset: { ...asset, path: "second.mp4" }, start: 2, end: 6 }];
  const snapshot = JSON.stringify(clips);
  const joined = buildRenderCommand(clips, "joined.mp4", options);
  const graph = joined.args[joined.args.indexOf("-filter_complex") + 1];
  assert.doesNotMatch(graph, /xfade=|acrossfade=/);
  assert.equal(joined.totalSeconds, 8);
  assert.equal(JSON.stringify(clips), snapshot);
  const separate = buildAudioLedRenderCommand(clips, clips.map(c => ({ asset: c.asset, start: 8, end: 12 })), "independent.mp4", options);
  const independentGraph = separate.args[separate.args.indexOf("-filter_complex") + 1];
  assert.doesNotMatch(independentGraph, /\bxfade=/);
  assert.match(independentGraph, /acrossfade=/, "unmarked independent sound still uses its requested blend");
});
