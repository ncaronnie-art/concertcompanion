import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { interpretCreativeBrief, makeFirstCut, type CreativeClip } from "../src/shared/creative-brief.ts";
import { buildRenderCommand } from "../src/shared/render-plan.ts";

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (part) => stdout += part);
    child.stderr.on("data", (part) => stderr += part);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}

test("creative brief preserves a marked section and exports its first cut through FFmpeg", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-creative-export-"));
  const ffmpeg = ffmpegPath as unknown as string;
  try {
    const sources = ["red", "blue", "green"].map((color) => path.join(root, `${color}.mp4`));
    for (const [index, file] of sources.entries()) {
      await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${["red", "blue", "green"][index]}:size=160x90:rate=24:duration=3`,
        "-f", "lavfi", "-i", `sine=frequency=${440 + index * 110}:sample_rate=48000:duration=3`,
        "-c:v", "libx264", "-c:a", "aac", file]);
    }
    const clips: CreativeClip[] = sources.map((file, index) => ({
      asset: { path: file, name: path.basename(file), duration: 3, width: 160, height: 90, hasAudio: true },
      start: index === 0 ? 0.25 : 0.5, end: index === 0 ? 1.25 : 2.5,
      included: index !== 2, selectionSource: index === 0 ? "manual" : "suggested",
      locked: index === 0, excludedByUser: index === 2,
    }));
    const brief = interpretCreativeBrief({ description: "Four-second cinematic recap. Keep my section, choose the rest, horizontal.",
      videoType: "recap", vibe: "cinematic", selectionMode: "keep-and-choose", targetSeconds: 4,
      aspect: "landscape" }, clips, { aspect: "vertical", reduceRumble: false });
    assert.equal(brief.conflict, null);
    const cut = makeFirstCut(clips, brief);
    assert.deepEqual({ start: cut.clips[0].start, end: cut.clips[0].end, locked: cut.clips[0].locked }, { start: 0.25, end: 1.25, locked: true });
    assert.equal(cut.clips[2].included, false, "the explicitly excluded video stays out");
    assert.ok(Math.abs(cut.plannedSeconds - 4) < 0.05);

    const output = path.join(root, "first-cut.mp4");
    const plan = buildRenderCommand(cut.clips.filter((clip) => clip.included), output, cut.options);
    const filters = plan.args[plan.args.indexOf("-filter_complex") + 1];
    assert.match(filters, /eq=contrast=1[.]07/, "cinematic look reaches the render plan");
    assert.match(filters, /\[0:v\][^;]*eq=contrast=1[.]07/, "a protected section keeps its timing while the selected look stays consistent");
    await run(ffmpeg, plan.args);
    await run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
    const metadata = JSON.parse(await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", output]));
    assert.ok(Math.abs(Number(metadata.format.duration) - 4) < 0.25);
    assert.ok(metadata.streams.some((stream: { codec_type: string; codec_name: string; width: number; height: number }) => stream.codec_type === "video" && stream.codec_name === "h264" && stream.width === 1280 && stream.height === 720));
    assert.ok(metadata.streams.some((stream: { codec_type: string; codec_name: string }) => stream.codec_type === "audio" && stream.codec_name === "aac"));
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 60_000 });
