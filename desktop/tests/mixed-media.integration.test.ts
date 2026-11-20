import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildRenderCommand, type MediaAsset } from "../src/shared/render-plan.ts";

function run(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error || `Process exited ${code}.`)));
  });
}

function toneHz(pcm: Buffer): number {
  const sampleCount = Math.floor(pcm.length / 4);
  let crossings = 0;
  for (let index = 1; index < sampleCount; index++) {
    if (pcm.readFloatLE((index - 1) * 4) <= 0 && pcm.readFloatLE(index * 4) > 0) crossings++;
  }
  return crossings / (sampleCount / 8000);
}

test("mixed frame rates and orientations export with aligned picture and sound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-mixed-media-"));
  const ffmpeg = ffmpegPath as unknown as string;
  try {
    const landscape = path.join(root, "landscape-24fps.mp4");
    const portrait = path.join(root, "portrait-60fps.mp4");
    const output = path.join(root, "mixed-output.mp4");
    for (const fixture of [
      { file: landscape, color: "red", size: "320x180", fps: 24, tone: 440 },
      { file: portrait, color: "blue", size: "180x320", fps: 60, tone: 880 },
    ]) {
      await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${fixture.color}:size=${fixture.size}:rate=${fixture.fps}:duration=2`,
        "-f", "lavfi", "-i", `sine=frequency=${fixture.tone}:sample_rate=48000:duration=2`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture.file]);
    }
    const asset = (file: string, width: number, height: number): MediaAsset =>
      ({ path: file, name: path.basename(file), duration: 2, width, height, hasAudio: true });
    const plan = buildRenderCommand([
      { asset: asset(landscape, 320, 180), start: 0.25, end: 1.75 },
      { asset: asset(portrait, 180, 320), start: 0.1, end: 1.9 },
    ], output, { aspect: "landscape", reduceRumble: false, finish: "natural", transition: "fade" });
    assert.ok(Math.abs(plan.totalSeconds - 3.3) < 0.001);
    await run(ffmpeg, plan.args);
    await run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);

    const probe = JSON.parse((await run(ffprobe.path, ["-v", "error", "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,duration", "-of", "json", output])).toString());
    const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    const audio = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
    assert.equal(video.codec_name, "h264");
    assert.deepEqual([video.width, video.height, video.avg_frame_rate], [1280, 720, "30/1"]);
    assert.equal(audio.codec_name, "aac");
    assert.ok(Math.abs(Number(video.duration) - plan.totalSeconds) < 0.12, `Video duration ${video.duration}`);
    assert.ok(Math.abs(Number(audio.duration) - plan.totalSeconds) < 0.12, `Audio duration ${audio.duration}`);
    assert.ok(Math.abs(Number(video.duration) - Number(audio.duration)) < 0.12, "Audio and video durations diverged.");

    for (const sample of [{ at: 0.75, channel: 0, tone: 440 }, { at: 2.4, channel: 2, tone: 880 }]) {
      const pixel = await run(ffmpeg, ["-v", "error", "-ss", String(sample.at), "-i", output,
        "-frames:v", "1", "-vf", "crop=1:1:640:360,format=rgb24", "-f", "rawvideo", "pipe:1"]);
      assert.equal(pixel.length, 3);
      assert.ok(pixel[sample.channel] > 2 * Math.max(pixel[(sample.channel + 1) % 3], pixel[(sample.channel + 2) % 3]),
        `Wrong video at ${sample.at}s: ${pixel.toString("hex")}`);
      const pcm = await run(ffmpeg, ["-v", "error", "-ss", String(sample.at), "-i", output,
        "-t", "0.2", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
      const measured = toneHz(pcm);
      assert.ok(Math.abs(measured - sample.tone) < 40, `Wrong audio tone at ${sample.at}s: ${measured.toFixed(1)} Hz`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 90_000 });
