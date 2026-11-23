import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildAudioLedRenderCommand, buildRenderCommand, type MediaAsset,
  type RenderSelection } from "../src/shared/render-plan.ts";

const ffmpeg = ffmpegPath as string;

function run(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => error = (error + chunk.toString()).slice(-6000));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) :
      reject(new Error(error || `${binary} stopped (${code}).`)));
  });
}

async function makeSource(file: string, color: string, tone?: number) {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    `color=c=${color}:size=320x180:rate=30:duration=4`];
  if (tone) args.push("-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000:duration=4`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (tone) args.push("-c:a", "aac", "-b:a", "192k");
  args.push(file);
  await run(ffmpeg, args);
}

function asset(file: string, hasAudio = true): MediaAsset {
  return { path: file, name: path.basename(file), duration: 4,
    audioDuration: hasAudio ? 4 : undefined, width: 320, height: 180, hasAudio };
}

async function probe(file: string) {
  return JSON.parse((await run(ffprobe.path, ["-v", "error", "-show_entries",
    "format=duration:stream=codec_type,codec_name,duration,width,height", "-of", "json", file])).toString()) as {
    format: { duration: string };
    streams: Array<{ codec_type: string; codec_name: string; duration: string; width?: number; height?: number }>;
  };
}

async function audioSamples(file: string): Promise<Float32Array> {
  const raw = await run(ffmpeg, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "8000",
    "-f", "f32le", "pipe:1"]);
  const samples = new Float32Array(Math.floor(raw.length / 4));
  for (let index = 0; index < samples.length; index++) samples[index] = raw.readFloatLE(index * 4);
  return samples;
}

function amplitude(samples: Float32Array, at: number, frequency: number, seconds = 0.2): number {
  const begin = Math.floor(at * 8000), count = Math.floor(seconds * 8000);
  let sine = 0, cosine = 0;
  for (let offset = 0; offset < count; offset++) {
    const value = samples[begin + offset] ?? 0;
    const angle = 2 * Math.PI * frequency * offset / 8000;
    sine += value * Math.sin(angle);
    cosine += value * Math.cos(angle);
  }
  return 2 * Math.hypot(sine, cosine) / count;
}

function peak(samples: Float32Array): number {
  let value = 0;
  for (const sample of samples) value = Math.max(value, Math.abs(sample));
  return value;
}

async function colorAt(file: string, at: number) {
  const pixels = await run(ffmpeg, ["-v", "error", "-ss", String(at), "-i", file,
    "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"]);
  assert.equal(pixels.length, 3);
  return [...pixels];
}

function assertDuration(metadata: Awaited<ReturnType<typeof probe>>, target: number) {
  const video = metadata.streams.find((stream) => stream.codec_type === "video");
  const audio = metadata.streams.find((stream) => stream.codec_type === "audio");
  assert.ok(video && audio, "the MP4 has both picture and sound streams");
  assert.equal(video.codec_name, "h264");
  assert.equal(audio.codec_name, "aac");
  assert.ok(Math.abs(Number(metadata.format.duration) - target) < 0.12,
    `container duration ${metadata.format.duration} differs from ${target}`);
  assert.ok(Math.abs(Number(video.duration) - Number(audio.duration)) < 0.12,
    `picture ${video.duration} and sound ${audio.duration} drift apart`);
  return video;
}

test("finished MP4 blends sound and picture smoothly while preserving timing, locks, and originals", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-smooth-reel-"));
  try {
    const red = path.join(folder, "red-440.mp4"), blue = path.join(folder, "blue-880.mp4");
    const silent = path.join(folder, "silent-green.mp4");
    await Promise.all([makeSource(red, "red", 440), makeSource(blue, "blue", 880),
      makeSource(silent, "green")]);
    const sourceHashes = await Promise.all([red, blue, silent].map(async (file) =>
      createHash("sha256").update(await readFile(file)).digest("hex")));
    const selections: RenderSelection[] = [
      { asset: asset(red), start: 1, end: 3 }, { asset: asset(blue), start: 1, end: 3 },
    ];
    const before = structuredClone(selections);
    const smooth = path.join(folder, "dissolve-crossfade.mp4");
    const options = { aspect: "landscape" as const, reduceRumble: false,
      transition: "dissolve" as const, audioTransition: "crossfade" as const,
      audioCrossfadeSeconds: 2, quality: "high" as const };
    const command = buildAudioLedRenderCommand(selections, selections, smooth, options);
    assert.equal(command.totalSeconds, 4);
    assert.doesNotMatch(command.args[command.args.indexOf("-filter_complex") + 1], /ass=/,
      "a video without a title does not require an overlay script");
    await run(ffmpeg, command.args);
    await run(ffmpeg, ["-v", "error", "-i", smooth, "-f", "null", "-"]);
    const video = assertDuration(await probe(smooth), 4);
    assert.deepEqual([video.width, video.height], [320, 180],
      "high quality keeps the native 180p short edge instead of inventing 720p or 1080p detail");

    const joined = await audioSamples(smooth), first = await audioSamples(red);
    const second = await audioSamples(blue);
    const sourceLevel = Math.max(amplitude(first, 1.5, 440), amplitude(second, 1.5, 880));
    const early440 = amplitude(joined, 1.25, 440), early880 = amplitude(joined, 1.25, 880);
    const mid440 = amplitude(joined, 1.9, 440), mid880 = amplitude(joined, 1.9, 880);
    const late440 = amplitude(joined, 2.65, 440), late880 = amplitude(joined, 2.65, 880);
    assert.ok(early440 > early880 * 2 && late880 > late440 * 2,
      "the outgoing tone recedes as the incoming tone rises");
    assert.ok(mid440 > sourceLevel * 0.3 && mid880 > sourceLevel * 0.3,
      "both songs are audible during the join");
    assert.ok(peak(joined) < Math.max(peak(first), peak(second)) * 1.12,
      "the complementary fade should not boost the source peak");
    const mixed = await colorAt(smooth, 2);
    assert.ok(mixed[0] > 35 && mixed[2] > 35 && mixed[0] + mixed[1] + mixed[2] > 100,
      `the dissolve should mix red and blue without black, got ${mixed}`);

    const slide = path.join(folder, "slide.mp4");
    await run(ffmpeg, buildAudioLedRenderCommand(selections, selections, slide,
      { ...options, transition: "smoothslide" }, "draft").args);
    assertDuration(await probe(slide), 4);
    const slideMiddle = await colorAt(slide, 2);
    assert.ok(slideMiddle[0] > 35 && slideMiddle[2] > 35,
      `the slide should show both scenes at the join, got ${slideMiddle}`);

    const kept: RenderSelection[] = [{ ...selections[0], locked: true }, selections[1]];
    const locked = path.join(folder, "locked.mp4");
    await run(ffmpeg, buildAudioLedRenderCommand(kept, kept, locked, options, "draft").args);
    assertDuration(await probe(locked), 4);
    const justBefore = await colorAt(locked, 1.85), justAfter = await colorAt(locked, 2.15);
    assert.ok(justBefore[0] > justBefore[2] * 3 && justAfter[2] > justAfter[0] * 3,
      "a locked selection keeps its exact hard boundary at two seconds");

    const standard = path.join(folder, "standard-with-silence.mp4");
    const standardPlan = buildRenderCommand([selections[0],
      { asset: asset(silent, false), start: 1, end: 3 }], standard,
    { ...options, audioTransition: "crossfade" }, "draft");
    await run(ffmpeg, standardPlan.args);
    assertDuration(await probe(standard), 4);
    const silentJoin = await colorAt(standard, 2);
    assert.ok(silentJoin[0] + silentJoin[1] + silentJoin[2] > 45,
      `a silent source still produces a visible transition, got ${silentJoin}`);
    const silentSound = await audioSamples(standard);
    assert.ok(amplitude(silentSound, 3.2, 440) < sourceLevel * 0.03,
      "the silent clip stays silent instead of inheriting the prior song");

    assert.deepEqual(selections, before, "building all edits leaves the original selections unchanged");
    const afterHashes = await Promise.all([red, blue, silent].map(async (file) =>
      createHash("sha256").update(await readFile(file)).digest("hex")));
    assert.deepEqual(afterHashes, sourceHashes, "processing leaves the recordings byte-for-byte unchanged");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, { timeout: 180_000 });
