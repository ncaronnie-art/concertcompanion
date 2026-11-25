import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildAudioLedRenderCommand, buildRenderCommand, type MediaAsset, type RenderSelection } from "../src/shared/render-plan.ts";
import { mapVisualMusicCues } from "../src/shared/visual-cues.ts";
import { hdrToSdrFilter } from "../src/shared/video-color.ts";

const execute = (exe: string, args: string[], raw = false) => new Promise<Buffer | string>((resolve, reject) => {
  const child = spawn(exe, args, { windowsHide: true }); const chunks: Buffer[] = []; let error = "";
  child.stdout.on("data", d => chunks.push(d)); child.stderr.on("data", d => error += d);
  child.on("error", reject); child.on("close", code => code === 0 ? resolve(raw ? Buffer.concat(chunks) : Buffer.concat(chunks).toString()) : reject(Error(error)));
});

test("soundtrack beat cues map to independent picture sources without changing approved ranges", () => {
  const asset: MediaAsset = { path: "sound", name: "sound", duration: 30, width: 320, height: 180, hasAudio: true };
  const pictures = [{ asset: { ...asset, path: "picture" }, start: 12, end: 16, locked: true }];
  const sounds = [{ asset, start: 8, end: 10 }, { asset, start: 20, end: 22 }];
  const result = mapVisualMusicCues(pictures, sounds, new Map([["sound", [
    { rms: .2, clipping: 0, beatConfidence: .9, beatTimes: [8.5, 20.5] },
    { rms: .2, clipping: 0, beatConfidence: .2, beatTimes: [9] },
  ]]]));
  assert.deepEqual(result[0].visualCues?.map(c => c.seconds), [12.5, 14.5]);
  assert.equal(result[0].locked, true); assert.equal(result[0].start, 12); assert.equal(result[0].end, 16);
  assert.equal(pictures[0].asset.path, "picture"); assert.equal("visualCues" in pictures[0], false);
});

test("smart crops move in the rendered picture; Off and uncertain tracking keep deliberate fallbacks", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-visual-pipeline-"));
  try {
    const source = path.join(folder, "source.mp4");
    await execute(ffmpeg as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=blue:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-vf", "drawbox=x=160:y=0:w=160:h=180:color=red:t=fill", "-c:v", "libx264", "-c:a", "aac", source]);
    const asset: MediaAsset = { path: source, name: "source", duration: 2, width: 320, height: 180, hasAudio: true };
    const selection: RenderSelection = { asset, start: 0, end: 2, framing: "fill", tracking: { version: 1, coverage: 1, subjectLocked: true, suggestedFraming: "fill", notes: [], keyframes: [
      { time: 0, x: 0, y: 0, width: .3164, height: 1, confidence: .9, status: "tracking" },
      { time: 1.8, x: .6836, y: 0, width: .3164, height: 1, confidence: .9, status: "tracking" },
    ] } };
    for (const mode of ["follow-performer", "off", "fallback", "long-plan"] as const) {
      const output = path.join(folder, `${mode}.mp4`);
      const shot = mode === "fallback" ? { ...selection, tracking: { ...selection.tracking!, suggestedFraming: "fit" as const } } :
        mode === "long-plan" ? { ...selection, tracking: { ...selection.tracking!, keyframes: Array.from({ length: 256 }, (_, i) => ({ ...selection.tracking!.keyframes[0], time: i / 255 * 1.8, x: i / 255 * .6836 })) } } : selection;
      const plan = buildRenderCommand([shot], output, { aspect: "vertical", reduceRumble: false, quality: "high", smartFraming: mode === "off" ? "off" : "follow-performer" });
      await execute(ffmpeg as string, plan.args);
      await execute(ffmpeg as string, ["-v", "error", "-i", output, "-f", "null", "-"]);
      const color = async (time: string) => await execute(ffmpeg as string, ["-v", "error", "-ss", time, "-i", output, "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"], true) as Buffer;
      const early = await color("0.1"), late = await color("1.7");
      if (mode === "follow-performer" || mode === "long-plan") { assert.ok(early[2] > early[0] * 2); assert.ok(late[0] > late[2] * 2); }
      else assert.ok(Math.abs(early[0] - late[0]) < 4 && Math.abs(early[2] - late[2]) < 4);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("HDR conversion and Y2K finish compose through the existing independent-track animated export", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-hdr-finish-"));
  try {
    const source = path.join(folder, "hdr.mp4"), output = path.join(folder, "neon.mp4");
    await execute(ffmpeg as string, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x288:r=30:d=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-c:a", "aac", "-metadata", "location=+30.000-097.000/", source]);
    const asset: MediaAsset = { path: source, name: "hdr", duration: 4, audioDuration: 4, width: 160, height: 288, hasAudio: true, colorTransfer: "arib-std-b67" };
    const picture = [{ asset, start: .2, end: 1.2, visualCues: [{ seconds: .5, confidence: .9 }] }, { asset, start: 2, end: 3 }];
    const sound = [{ asset, start: .5, end: 2.5 }];
    const plan = buildAudioLedRenderCommand(picture, sound, output, { aspect: "vertical", reduceRumble: true, quality: "high", effects: "full-y2k", videoEnhancement: "clean", transition: "dissolve" });
    assert.ok(plan.args.join(" ").includes(hdrToSdrFilter("arib-std-b67")));
    await execute(ffmpeg as string, plan.args);
    await execute(ffmpeg as string, ["-v", "error", "-i", output, "-f", "null", "-"]);
    const probe = JSON.parse(await execute(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:format_tags:stream=codec_type,width,height", "-of", "json", output]) as string);
    assert.ok(Math.abs(Number(probe.format.duration) - 2) < .1);
    assert.equal(probe.streams.find((s: { codec_type: string }) => s.codec_type === "video").width, 180);
    assert.ok(probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio"));
    assert.ok(!Object.keys(probe.format.tags ?? {}).some(k => /location|gps/i.test(k)), "camera location metadata is omitted from a shareable reel");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
