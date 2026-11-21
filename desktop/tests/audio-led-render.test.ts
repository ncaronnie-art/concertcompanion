import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildAudioLedRenderCommand, buildRenderCommand, type AudioSelection, type MediaAsset, type RenderSelection } from "../src/shared/render-plan.ts";
import { validateRenderedOutput } from "../electron/output-integrity.ts";

const media = (name: string, duration = 6, hasAudio = true): MediaAsset =>
  ({ path: `${name}.mp4`, name: `${name}.mp4`, duration, width: 160, height: 90, hasAudio });
const video: RenderSelection[] = [
  { asset: media("red"), start: 0, end: 2, locked: true },
  { asset: media("blue"), start: 0, end: 4 },
];
const audio: AudioSelection[] = [
  { asset: media("low"), start: 0, end: 2, locked: true },
  { asset: media("middle"), start: 0, end: 2 },
  { asset: media("high"), start: 0, end: 2 },
];

test("independent soundtrack uses only its three sound sources and keeps exact selected ranges", () => {
  const options = { aspect: "landscape" as const, reduceRumble: true, finish: "cinematic" as const, transition: "fade" as const };
  const draft = buildAudioLedRenderCommand(video, audio, "draft.mp4", options, "draft");
  const finished = buildAudioLedRenderCommand(video, audio, "final.mp4", options);
  const graph = draft.args[draft.args.indexOf("-filter_complex") + 1];
  assert.equal(draft.totalSeconds, 6);
  assert.equal(finished.totalSeconds, 6);
  assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vout\]/);
  assert.match(graph, /\[a0\]\[a1\]\[a2\]concat=n=3:v=0:a=1\[acat\]/);
  assert.match(graph, /\[2:a\].*highpass=f=80/);
  assert.match(graph, /eq=contrast=1\.07:saturation=0\.90/);
  assert.doesNotMatch(graph, /\[(?:0|1):a\]/);
  assert.deepEqual(draft.args.filter((arg) => arg.endsWith(".mp4") && arg !== "draft.mp4"),
    ["red.mp4", "blue.mp4", "low.mp4", "middle.mp4", "high.mp4"]);
  assert.equal(draft.args[draft.args.indexOf("-preset") + 1], "ultrafast");
  assert.equal(finished.args[finished.args.indexOf("-preset") + 1], "medium");
  const legacy = buildRenderCommand(video, "legacy.mp4", options);
  assert.match(legacy.args[legacy.args.indexOf("-filter_complex") + 1], /concat=n=2:v=1:a=1/);
});

test("audio-led rendering rejects silent, invalid, and unmatched sound without touching locked ranges", () => {
  const options = { aspect: "landscape" as const, reduceRumble: false };
  const snapshot = JSON.stringify({ video, audio });
  assert.throws(() => buildAudioLedRenderCommand(video, audio.slice(0, 2), "bad.mp4", options), /different lengths/);
  assert.throws(() => buildAudioLedRenderCommand(video, [{ ...audio[0], asset: media("silent", 6, false) }, ...audio.slice(1)], "bad.mp4", options), /audible range/);
  assert.throws(() => buildAudioLedRenderCommand(video, [{ ...audio[0], start: -1 }, ...audio.slice(1)], "bad.mp4", options), /audible range/);
  assert.throws(() => buildAudioLedRenderCommand(video, [{ ...audio[0], end: 6.5 }, ...audio.slice(1)], "bad.mp4", options), /audible range/);
  assert.throws(() => buildAudioLedRenderCommand([], audio, "bad.mp4", options), /video section/);
  assert.equal(JSON.stringify({ video, audio }), snapshot);
});

function run(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => error = (error + chunk.toString()).slice(-4000));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error || `FFmpeg stopped (${code}).`)));
  });
}

async function makeFixture(file: string, color: string, frequency: number) {
  await run(ffmpegPath as string, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${color}:size=160x90:rate=30:duration=6`,
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=6`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", file]);
}

function power(samples: Float32Array, frequency: number, sampleRate: number): number {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let current = 0, previous = 0, older = 0;
  for (const sample of samples) {
    current = sample + coefficient * previous - older;
    older = previous;
    previous = current;
  }
  return previous * previous + older * older - coefficient * previous * older;
}

async function toneAt(file: string, at: number, expected: number) {
  const raw = await run(ffmpegPath as string, ["-v", "error", "-ss", String(at), "-t", "0.25", "-i", file,
    "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const energies = [220, 440, 660, 1000, 1200].map((frequency) => power(samples, frequency, 8000));
  const expectedEnergy = energies[[220, 440, 660, 1000, 1200].indexOf(expected)];
  assert.ok(expectedEnergy > Math.max(...energies.filter((energy) => energy !== expectedEnergy)) * 8,
    `expected ${expected} Hz at ${at}s, measured ${energies.join(", ")}`);
}

async function colorAt(file: string, at: number): Promise<Buffer> {
  return run(ffmpegPath as string, ["-v", "error", "-ss", String(at), "-i", file,
    "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"]);
}

test("rendered MP4 shows two pictures while playing three separate sound sections in order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-audio-led-"));
  try {
    const sources = [
      ["red", "red", 1000], ["blue", "blue", 1200],
      ["low", "green", 220], ["middle", "green", 440], ["high", "green", 660],
    ] as const;
    for (const [name, color, frequency] of sources) await makeFixture(path.join(root, `${name}.mp4`), color, frequency);
    const withPath = (selection: RenderSelection | AudioSelection) =>
      ({ ...selection, asset: { ...selection.asset, path: path.join(root, selection.asset.path) } });
    const output = path.join(root, "audio-led.mp4");
    const { args, totalSeconds } = buildAudioLedRenderCommand(video.map(withPath), audio.map(withPath), output,
      { aspect: "landscape", reduceRumble: true, finish: "natural", transition: "fade" }, "draft");
    await run(ffmpegPath as string, args);
    const probe = JSON.parse((await run(ffprobe.path, ["-v", "error", "-show_entries",
      "format=duration:stream=codec_type,codec_name,duration,width,height", "-of", "json", output])).toString());
    validateRenderedOutput(probe, totalSeconds, "preview");
    assert.ok(Math.abs(Number(probe.format.duration) - totalSeconds) < 0.15);
    assert.ok(probe.streams.some((stream: { codec_type: string; codec_name: string; width?: number; height?: number }) =>
      stream.codec_type === "video" && stream.codec_name === "h264" && stream.width === 640 && stream.height === 360));
    assert.ok(probe.streams.some((stream: { codec_type: string; codec_name: string }) =>
      stream.codec_type === "audio" && stream.codec_name === "aac"));
    await run(ffmpegPath as string, ["-v", "error", "-i", output, "-f", "null", "-"]);
    const firstColor = await colorAt(output, 1);
    const secondColor = await colorAt(output, 4);
    assert.ok(firstColor[0] > firstColor[2] * 4, `expected red picture, got ${firstColor.toString("hex")}`);
    assert.ok(secondColor[2] > secondColor[0] * 4, `expected blue picture, got ${secondColor.toString("hex")}`);
    await toneAt(output, 1, 220);
    await toneAt(output, 3, 440);
    await toneAt(output, 5, 660);
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 120_000 });

test("short source audio cannot silently turn into seconds of soundtrack silence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-short-audio-"));
  try {
    const source = path.join(root, "short-audio.mp4");
    const output = path.join(root, "short-audio-output.mp4");
    await run(ffmpegPath as string, ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:size=160x90:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", source]);
    const asset: MediaAsset = { path: source, name: "short-audio.mp4", duration: 3, width: 160, height: 90, hasAudio: true };
    const { args, totalSeconds } = buildAudioLedRenderCommand(
      [{ asset, start: 0, end: 3 }], [{ asset, start: 0, end: 3 }], output,
      { aspect: "landscape", reduceRumble: false }, "draft");
    await run(ffmpegPath as string, args);
    const probe = JSON.parse((await run(ffprobe.path, ["-v", "error", "-show_entries",
      "format=duration:stream=codec_type,codec_name,duration", "-of", "json", output])).toString());
    const audioTrack = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
    assert.ok(Number(audioTrack.duration) < 1.5, `unexpectedly padded soundtrack: ${audioTrack.duration}`);
    assert.throws(() => validateRenderedOutput(probe, totalSeconds, "export"), /sound ends before the picture/);
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 60_000 });
