import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { measureAudio } from "../electron/audio-analysis.ts";
import { planAudioStory } from "../src/shared/audio-story.ts";
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.ts";
import type { MediaAsset } from "../src/shared/render-plan.ts";

function run(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let error = "";
    child.stderr.on("data", (data) => error = (error + data.toString()).slice(-4000));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error || `FFmpeg stopped (${code}).`)));
  });
}

test("a final partial audio bin cannot be mistaken for a full half-second", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-partial-bin-"));
  try {
    const file = path.join(root, "short-sound.mov");
    await run(ffmpegPath as string, ["-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:size=160x90:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.26",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le", file]);
    const bins = await measureAudio(ffmpegPath as string, file);
    assert.equal(bins.length, 3);
    assert.ok(Math.abs(bins.at(-1)!.endSeconds! - 1.26) < 0.02,
      `expected 1.26s decoded audio, got ${bins.at(-1)?.endSeconds}`);
    const asset: MediaAsset = { path: file, name: "short-sound.mov", duration: 3, width: 160, height: 90, hasAudio: true };
    const clip: CreativeClip = { asset, start: 0, end: 3, included: true, excludedByUser: false,
      locked: false, selectionSource: "suggested" };
    const options = { aspect: "landscape" as const, reduceRumble: false };
    const input = { description: "Make a 1.4-second video with 1 audio clip.", targetSeconds: 1.4 };
    const brief = interpretCreativeBrief(input, [clip], options);
    assert.throws(() => planAudioStory([clip], brief, { [file]: bins }), /not enough nonrepeating sound/);

    const protectedClip: CreativeClip = { ...clip, end: 1.4, locked: true, selectionSource: "manual" };
    const protectedBrief = interpretCreativeBrief(input, [protectedClip], options);
    assert.throws(() => planAudioStory([protectedClip], protectedBrief, { [file]: bins }),
      /marked sound.*ends after its available audio/);
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 60_000 });
