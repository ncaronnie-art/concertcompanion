import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AudioEventFeatures, AudioEventBins, eventScores } from "../src/shared/audio-event-features.js";

export function syntheticAudio() {
  let seed = 37;
  return Float32Array.from({ length: 16000 * 1.44 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const t = i / 16000;
    return .12 * Math.sin(2 * Math.PI * (180 * t + 470 * t * t)) + .04 * Math.sin(2 * Math.PI * 330 * t) +
      .02 * (seed / 4294967296 * 2 - 1);
  });
}
export const reference = JSON.parse(readFileSync(new URL("./fixtures/yamnet-synthetic-reference.json", import.meta.url), "utf8"));

test("log-mel features match an independent NumPy reference, including the reflected start", () => {
  const processor = new AudioEventFeatures(), pcm = syntheticAudio();
  const patches = [...processor.push(pcm), ...processor.finish()];
  assert.equal(patches.length, 2);
  assert.equal(patches[0].features.length, 6144);
  for (const [index, expected] of reference.feature_samples as [number, number][]) {
    assert.ok(Math.abs(patches[0].features[index] - expected) < .00004, `Feature ${index} differs: ${patches[0].features[index]} vs ${expected}`);
  }
  assert.deepEqual(patches.map(patch => [patch.start, patch.end]), [[0, .96], [.48, 1.44]]);
});

test("PCM chunk boundaries do not change features, including the reflected end", () => {
  const pcm = syntheticAudio().slice(0, 15200), whole = new AudioEventFeatures(), streaming = new AudioEventFeatures();
  const expected = [...whole.push(pcm), ...whole.finish()], actual = [];
  for (let i = 0; i < pcm.length; i += 317) actual.push(...streaming.push(pcm.subarray(i, i + 317)));
  actual.push(...streaming.finish());
  assert.deepEqual(actual, expected);
  assert.equal(actual.length, 1);
  assert.equal(actual[0].end, .95);
});

test("short sources and incomplete tails do not manufacture padded classifier windows", () => {
  for (const length of [0, 1, 159, 512, 15199]) {
    const processor = new AudioEventFeatures();
    assert.equal([...processor.push(new Float32Array(length)), ...processor.finish()].length, 0);
    assert.deepEqual(processor.finish(), []);
    assert.throws(() => processor.push(new Float32Array(1)), /already finished/);
  }
  const processor = new AudioEventFeatures();
  const patches = [...processor.push(new Float32Array(16000 * 2.19)), ...processor.finish()];
  assert.equal(patches.length, 3); // 0, .48, .96; the incomplete 1.44 patch is absent.
  assert.equal(patches.at(-1)!.end, 1.92);
  assert.ok(patches.every(patch => patch.features.every(value => Math.abs(value - Math.log(.001)) < 1e-6)));
});

test("long streams retain bounded PCM and context instead of source-length buffers", () => {
  const processor = new AudioEventFeatures(), chunk = new Float32Array(4096);
  let patchCount = 0;
  for (let i = 0; i < 300; i++) {
    patchCount += processor.push(chunk).length;
    assert.ok(processor.bufferedSamples <= 512);
    assert.ok(processor.bufferedFrames < 96);
  }
  patchCount += processor.finish().length;
  assert.equal(patchCount, Math.floor((Math.floor(300 * 4096 / 160) + 1 - 96) / 48) + 1);
  assert.equal(processor.bufferedSamples, 0);
  assert.equal(processor.bufferedFrames, 0);
});

test("event families use independent sigmoid maxima and reject malformed inference", () => {
  const logits = new Float32Array(521).fill(-10);
  logits[24] = 0; logits[29] = Math.log(3); logits[132] = Math.log(4); logits[64] = Math.log(1 / 3); logits[0] = 0;
  const result = eventScores(logits);
  assert.ok(Math.abs(result.singingScore - .75) < 1e-7);
  assert.ok(Math.abs(result.musicScore - .8) < 1e-7);
  assert.ok(Math.abs(result.crowdScore - .25) < 1e-7);
  assert.equal(result.speechScore, .5);
  assert.throws(() => eventScores(new Float32Array(3)), /invalid scores/);
  logits[17] = NaN;
  assert.throws(() => eventScores(logits), /invalid scores/);
});

test("overlapping patches weight scores without double-counting covered time or inventing tail scores", () => {
  const bins = new AudioEventBins();
  bins.add(0, .96, { singingScore: .8, musicScore: .9, crowdScore: .1, speechScore: .2 });
  bins.add(.48, 1.44, { singingScore: .2, musicScore: .5, crowdScore: .3, speechScore: .1 });
  const result = bins.finish(2.1);
  assert.equal(result.length, 5);
  assert.equal(result[0].eventCoverage, 1);
  assert.equal(result[1].eventCoverage, 1);
  assert.ok(Math.abs(result[1].singingScore! - (.8 * .46 + .2 * .5) / .96) < 1e-8);
  assert.ok(Math.abs(result[2].eventCoverage - .88) < 1e-8);
  assert.equal(result[2].eventStatus, "classified");
  assert.deepEqual(result[3], { eventStatus: "unmeasured", eventCoverage: 0 });
  assert.deepEqual(result[4], { eventStatus: "unmeasured", eventCoverage: 0 });
  const edge = new AudioEventBins();
  edge.add(0, .96, { singingScore: .4, musicScore: .7, crowdScore: .1, speechScore: .1 });
  assert.equal(edge.finish(.96)[1].eventCoverage, 1);
});
