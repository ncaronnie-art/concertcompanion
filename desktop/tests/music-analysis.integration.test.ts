import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import ffmpeg from "ffmpeg-static";
import { measureAudio } from "../electron/audio-analysis.js";

function wav(samples: Float32Array): Buffer {
  const file = Buffer.alloc(44 + samples.length * 2);
  file.write("RIFF", 0); file.writeUInt32LE(file.length - 8, 4); file.write("WAVEfmt ", 8);
  file.writeUInt32LE(16, 16); file.writeUInt16LE(1, 20); file.writeUInt16LE(1, 22);
  file.writeUInt32LE(8000, 24); file.writeUInt32LE(16000, 28); file.writeUInt16LE(2, 32); file.writeUInt16LE(16, 34);
  file.write("data", 36); file.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => file.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + i * 2));
  return file;
}

test("FFmpeg analysis returns musical measurements while preserving RMS, partial duration, and the source", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "vibe-music-analysis-"));
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
  try {
    const samples = new Float32Array(8000 * 12.13);
    let seed = 99;
    for (let i = 0; i < samples.length; i++) {
      const t = i / 8000, beat = ((t - 0.23) % 0.5 + 0.5) % 0.5;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] = 0.04 * Math.sin(t * 2 * Math.PI * 260) + (beat < 0.09 ? Math.exp(-beat * 65) *
        (0.5 * Math.sin(2 * Math.PI * 95 * beat) + (seed / 4294967296 * 2 - 1) * 0.3) : 0);
    }
    const source = path.join(folder, "musical fixture.wav"), contents = wav(samples);
    await writeFile(source, contents);
    const before = createHash("sha256").update(contents).digest("hex");
    const bins = await measureAudio(ffmpeg!, source);
    assert.equal(bins.length, 25);
    assert.ok(Math.abs(bins.at(-1)!.endSeconds! - 12.13) < 0.001);
    assert.ok(bins.every(b => Number.isFinite(b.rms) && b.clipping === 0 && Number.isFinite(b.tonalProminence) && Number.isFinite(b.crowdNoise)));
    const measuredRms = Math.sqrt(samples.slice(0, 4000).reduce((n, sample) => n + sample * sample, 0) / 4000);
    assert.ok(Math.abs(bins[0].rms - measuredRms) < 0.0001);
    assert.ok(bins.flatMap(b => b.beatTimes ?? []).length >= 18);
    assert.ok(bins.filter(b => b.tempoBpm).every(b => Math.abs(b.tempoBpm! - 120) < 1));
    assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"), before);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
