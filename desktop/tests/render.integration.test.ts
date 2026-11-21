import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildRenderCommand, type MediaAsset } from "../src/shared/render-plan.ts";

function execute(binary: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true }); let out = "", err = "";
    child.stdout.on("data", (data) => (out += data)); child.stderr.on("data", (data) => (err += data));
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err)));
  });
}

function samples(file: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpegPath as unknown as string, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"], { windowsHide: true });
    const chunks: Buffer[] = []; child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk)); child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("Audio decoding failed")));
  });
}

test("bundled FFmpeg renders a decodable 9:13 H.264/AAC MP4 from synthetic sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "concert-compass-"));
  try {
    const first = path.join(root, "first.mp4"), second = path.join(root, "second.mp4"), output = path.join(root, "reel.mp4");
    for (const [destination, color, frequency] of [[first, "purple", "440"], [second, "orange", "660"]] as const) {
      await execute(ffmpegPath as unknown as string, ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=${color}:size=320x240:rate=30:duration=3`, "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=3`, "-c:v", "libx264", "-c:a", "aac", destination]);
    }
    const asset = (file: string): MediaAsset => ({ path: file, name: path.basename(file), duration: 3, width: 320, height: 240, hasAudio: true });
    const { args } = buildRenderCommand([{ asset: asset(first), start: 0.25, end: 2.25 }, { asset: asset(second), start: 0.25, end: 2.25 }], output);
    await execute(ffmpegPath as unknown as string, args);
    const metadata = JSON.parse(await execute(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", output]));
    const video = metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    const audio = metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
    assert.equal(video.codec_name, "h264"); assert.equal(video.width, 720); assert.equal(video.height, 1040);
    assert.equal(audio.codec_name, "aac"); assert.ok(Math.abs(Number(metadata.format.duration) - 4) < 0.2);
    await execute(ffmpegPath as unknown as string, ["-v", "error", "-i", output, "-f", "null", "-"]);
    const silent = path.join(root, "silent.mp4"), mixed = path.join(root, "mixed.mp4");
    await execute(ffmpegPath as unknown as string, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=blue:size=240x320:rate=30:duration=2", "-c:v", "libx264", silent]);
    const silentAsset = { ...asset(silent), duration: 2, hasAudio: false };
    const mixedPlan = buildRenderCommand([{ asset: asset(first), start: 0, end: 1 }, { asset: silentAsset, start: 0, end: 1 }], mixed);
    await execute(ffmpegPath as unknown as string, mixedPlan.args);
    await execute(ffmpegPath as unknown as string, ["-v", "error", "-i", mixed, "-f", "null", "-"]);
    const mixedMeta = JSON.parse(await execute(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", mixed]));
    assert.ok(mixedMeta.streams.some((stream: {codec_type: string}) => stream.codec_type === "audio"));
    assert.ok(Math.abs(Number(mixedMeta.format.duration) - 2) < 0.2);
    const rumble = path.join(root, "rumble.mp4"), cleaned = path.join(root, "cleaned.mp4");
    await execute(ffmpegPath as unknown as string, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=blue:size=320x240:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=40:sample_rate=48000:duration=2", "-c:v", "libx264", "-c:a", "aac", rumble]);
    const landscape = buildRenderCommand([{ asset: { ...asset(rumble), duration: 2 }, start: 0, end: 2 }], cleaned, { aspect: "landscape", reduceRumble: true });
    await execute(ffmpegPath as unknown as string, landscape.args);
    const cleanMeta = JSON.parse(await execute(ffprobe.path, ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", cleaned]));
    const cleanVideo = cleanMeta.streams.find((stream: {codec_type: string}) => stream.codec_type === "video");
    assert.equal(cleanVideo.width, 1280); assert.equal(cleanVideo.height, 720);
    const rms = (buffer: Buffer) => { let sum = 0, n = 0; for (let i = Math.floor(buffer.length / 2 / 4) * 4; i + 4 <= buffer.length; i += 4) { const x = buffer.readFloatLE(i); sum += x * x; n++; } return Math.sqrt(sum / n); };
    assert.ok(rms(await samples(cleaned)) < rms(await samples(rumble)) * 0.65, "40 Hz rumble should be reduced");
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 60_000 });
