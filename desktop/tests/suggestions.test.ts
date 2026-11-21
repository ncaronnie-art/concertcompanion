import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { measureAudio } from "../electron/audio-analysis.ts";
import { chooseAudioHighlight } from "../src/shared/suggestions.ts";
import type { MediaAsset } from "../src/shared/render-plan.ts";

const asset: MediaAsset = { path: "sample.wav", name: "sample.wav", duration: 24, width: 320, height: 240, hasAudio: true };
test("audio ranking prefers energetic, less-distorted sections and falls back for silence", () => {
  const bins = [...Array(24).fill({ rms: 0.03, clipping: 0 }), ...Array(24).fill({ rms: 0.3, clipping: 0 })];
  assert.equal(chooseAudioHighlight(asset, bins).start, 12);
  assert.equal(chooseAudioHighlight(asset, bins.map(() => ({ rms: 0, clipping: 0 }))).start, 6);
  assert.equal(chooseAudioHighlight(asset, [...Array(24).fill({ rms: 0.1, clipping: 0 }), ...Array(24).fill({ rms: 0.4, clipping: 0.9 })]).start, 0);
});

test("streaming audio analysis finds a louder synthetic section", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-suggestion-"));
  try {
    const file = path.join(root, "energy.wav"), binary = ffmpegPath as unknown as string;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ["-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,12)\\,0.03\\,0.4)*sin(2*PI*440*t):s=8000:d=24", file], { windowsHide: true });
      let error = ""; child.stderr.on("data", (data) => error += data); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error)));
    });
    const bins = await measureAudio(binary, file);
    assert.equal(bins.length, 48);
    assert.ok(chooseAudioHighlight({ ...asset, path: file }, bins).start >= 11.5);
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 30000 });

test("filtered analysis measures the same low-rumble reduction used for export", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-filtered-analysis-"));
  try {
    const binary = ffmpegPath as string;
    const create = (file: string, signal: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ["-v", "error", "-y", "-f", "lavfi", "-i",
        `aevalsrc=${signal}:s=48000:d=2`, "-c:a", "pcm_s16le", file], { windowsHide: true });
      let error = "";
      child.stderr.on("data", (data) => error += data);
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error)));
    });
    const bass = path.join(root, "bass.wav"), treble = path.join(root, "treble.wav");
    await create(bass, "0.6*sin(2*PI*40*t)+0.1*sin(2*PI*440*t)");
    await create(treble, "0.2*sin(2*PI*440*t)");
    const average = (bins: Awaited<ReturnType<typeof measureAudio>>) =>
      bins.reduce((sum, bin) => sum + bin.rms, 0) / bins.length;
    const bassRaw = average(await measureAudio(binary, bass));
    const bassClean = average(await measureAudio(binary, bass, true));
    const trebleRaw = average(await measureAudio(binary, treble));
    const trebleClean = average(await measureAudio(binary, treble, true));
    assert.ok(bassClean < bassRaw * 0.5, `40 Hz rumble persisted: ${bassRaw} -> ${bassClean}`);
    assert.ok(trebleClean > trebleRaw * 0.8, `440 Hz sound was over-attenuated: ${trebleRaw} -> ${trebleClean}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 30000 });
