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
