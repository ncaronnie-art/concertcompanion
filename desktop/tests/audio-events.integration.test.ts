import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import ffmpeg from "ffmpeg-static";
import { AudioEventFeatures } from "../src/shared/audio-event-features.js";
import { loadAudioEventModel, measureAudioEvents } from "../electron/audio-events.js";
import { measureAudio } from "../electron/audio-analysis.js";

const reference = JSON.parse(readFileSync(new URL("./fixtures/yamnet-synthetic-reference.json", import.meta.url), "utf8"));
function syntheticAudio(seconds = 1.44) {
  let seed = 37;
  return Float32Array.from({ length: Math.round(16000 * seconds) }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const t = i / 16000;
    return .12 * Math.sin(2 * Math.PI * (180 * t + 470 * t * t)) + .04 * Math.sin(2 * Math.PI * 330 * t) +
      .02 * (seed / 4294967296 * 2 - 1);
  });
}
function wav(samples: Float32Array) {
  const data = Buffer.alloc(44 + samples.length * 4);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(3, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(64000, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(32, 34);
  data.write("data", 36); data.writeUInt32LE(samples.length * 4, 40);
  samples.forEach((value, i) => data.writeFloatLE(value, 44 + i * 4));
  return data;
}
async function fixture(seconds: number) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "vibe-audio-events-"));
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const source = path.join(folder, "synthetic raw music.wav");
  await writeFile(source, wav(syntheticAudio(seconds)));
  return { folder, source };
}

test("bundled CPU WASM model matches independent Python inference on synthetic audio", async () => {
  const model = await loadAudioEventModel(), features = new AudioEventFeatures();
  const first = features.push(syntheticAudio())[0];
  const scores = await model.classify(first.features);
  for (const key of ["singingScore", "musicScore", "crowdScore", "speechScore"] as const) {
    assert.ok(Math.abs(scores[key] - reference.scores[key]) < .0001, `${key}: ${scores[key]} vs ${reference.scores[key]}`);
  }
  await assert.rejects(model.classify(new Float32Array(4)), /Invalid sound-model input/);
  const recovered = await model.classify(first.features);
  assert.deepEqual(recovered, scores);
});

test("FFmpeg raw-audio classification is independent of rumble filtering, preserves source and uncovered tail", async () => {
  const { folder, source } = await fixture(2.19);
  try {
    const before = createHash("sha256").update(await readFile(source)).digest("hex");
    const original = await measureAudio(ffmpeg!, source), cleaned = await measureAudio(ffmpeg!, source, true);
    assert.equal(original.length, 5);
    assert.ok(original.slice(0, 3).every(bin => bin.eventStatus === "classified" && [bin.singingScore, bin.musicScore, bin.crowdScore, bin.speechScore]
      .every(value => Number.isFinite(value) && value! >= 0 && value! <= 1)));
    assert.equal(original.at(-1)!.eventStatus, "unmeasured");
    assert.equal(original.at(-1)!.singingScore, undefined);
    for (let i = 0; i < original.length; i++) for (const key of ["singingScore", "musicScore", "crowdScore", "speechScore", "eventCoverage", "eventStatus"] as const)
      assert.equal(cleaned[i][key], original[i][key]);
    assert.notEqual(original[0].rms, cleaned[0].rms);
    assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"), before);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("cancellation stops an active decoder and rejects instead of returning fallback success", async () => {
  const { folder, source } = await fixture(12), controller = new AbortController();
  let called = 0;
  try {
    await assert.rejects(measureAudioEvents(ffmpeg!, source, controller.signal, { async classify() {
      called++; controller.abort(); controller.signal.throwIfAborted();
      return { singingScore: 0, musicScore: 0, crowdScore: 0, speechScore: 0 };
    } }), error => error instanceof Error && error.name === "AbortError");
    assert.equal(called, 1);
    await assert.rejects(measureAudio(ffmpeg!, source, false, controller.signal), error => error instanceof Error && error.name === "AbortError");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("missing local resources fail explicitly and a subsequent valid model load recovers", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "vibe-missing-model-"));
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
  try {
    await assert.rejects(loadAudioEventModel(folder), /Local singing and crowd analysis is unavailable/);
    assert.ok(await loadAudioEventModel());
  } finally { await rm(folder, { recursive: true, force: true }); }
});
