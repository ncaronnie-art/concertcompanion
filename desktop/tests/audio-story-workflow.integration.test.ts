import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { measureAudio } from "../electron/audio-analysis.ts";
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.ts";
import { planAudioStory } from "../src/shared/audio-story.ts";
import { buildAudioLedRenderCommand } from "../src/shared/render-plan.ts";
import type { AudioBin } from "../src/shared/suggestions.ts";

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (part) => { stdout += part; });
    child.stderr.on("data", (part) => { stderr = (stderr + part.toString()).slice(-4000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `FFmpeg stopped (${code}).`)));
  });
}

test("Ronnie's three-part sound brief becomes a separate picture-and-audio MP4", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-story-flow-"));
  const ffmpeg = ffmpegPath as string;
  try {
    const fixtures = [
      { name: "red-high", color: "red", tone: 700, volume: 1.4 },
      { name: "blue-low", color: "blue", tone: 300, volume: 0.3 },
      { name: "green-middle", color: "green", tone: 500, volume: 0.8 },
    ];
    const clips: CreativeClip[] = [];
    for (const fixture of fixtures) {
      const file = path.join(root, `${fixture.name}.mp4`);
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `color=c=${fixture.color}:size=160x90:rate=30:duration=2`,
        "-f", "lavfi", "-i", `sine=frequency=${fixture.tone}:sample_rate=48000:duration=2`,
        "-af", `volume=${fixture.volume}`, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", file]);
      clips.push({ asset: { path: file, name: path.basename(file), duration: 2,
        width: 160, height: 90, hasAudio: true }, start: 0, end: 2,
        included: true, locked: false, excludedByUser: false, selectionSource: "suggested" });
    }

    const brief = interpretCreativeBrief({ description:
      "3 audio clips featuring the cleaning audio and ending with a crescendo. I want video footage from multiple clips on top of that." },
    clips, { aspect: "landscape", reduceRumble: false });
    assert.equal(brief.conflict, null);
    assert.equal(brief.soundtrackIntent?.segmentCount, 3);
    assert.equal(brief.soundtrackIntent?.buildEnding, true);
    assert.equal(brief.soundtrackIntent?.separatePicture, true);
    assert.equal(brief.options.reduceRumble, true);
    assert.match(brief.summary, /3 audio moments/);
    assert.match(brief.summary, /picture from 3 recordings/);
    assert.ok(brief.limitations.some((item) => /cannot remove crowd voices/i.test(item)));

    const bins: Record<string, AudioBin[]> = {};
    for (const clip of clips) bins[clip.asset.path] = await measureAudio(ffmpeg, clip.asset.path);
    const cut = planAudioStory(clips, brief, bins);
    const picture = cut.clips.filter((clip) => clip.included && !clip.excludedByUser);
    assert.equal(cut.audioSelections.length, 3);
    assert.ok(new Set(picture.map((clip) => clip.asset.path)).size >= 2);
    assert.equal(cut.audioSelections.at(-1)?.asset.name, "red-high.mp4", "measured strongest sound ends the story");
    assert.notEqual(cut.audioSelections[0].asset.path, picture[0].asset.path,
      "the first picture and soundtrack sources are independent");
    assert.ok(Math.abs(cut.plannedSeconds - 6) < 0.05);

    const output = path.join(root, "story.mp4");
    const command = buildAudioLedRenderCommand(picture, cut.audioSelections, output, cut.options);
    await run(ffmpeg, command.args);
    await run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
    const probe = JSON.parse(await run(ffprobe.path, ["-v", "error", "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,duration", "-of", "json", output]));
    assert.ok(Math.abs(Number(probe.format.duration) - 6) < 0.25);
    assert.ok(probe.streams.some((stream: { codec_type: string; codec_name: string }) =>
      stream.codec_type === "video" && stream.codec_name === "h264"));
    assert.ok(probe.streams.some((stream: { codec_type: string; codec_name: string; duration: string }) =>
      stream.codec_type === "audio" && stream.codec_name === "aac" && Math.abs(Number(stream.duration) - 6) < 0.25));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 120_000 });
