import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { measureAudio } from "../electron/audio-analysis.ts";
import { alignPictureCutsToMusic, alignSoundtrackBeats } from "../src/shared/music-timing.ts";
import { buildAudioLedRenderCommand, type AudioSelection, type ExportOptions,
  type MediaAsset, type RenderSelection } from "../src/shared/render-plan.ts";

const ffmpeg = ffmpegPath as string;
const SOURCE_SECONDS = 18;

function run(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Synthetic media processing timed out.")); }, 90_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-6000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr || `Media process stopped: ${code}`)); });
  });
}

async function fixture(folder: string, name: string, color: string, bpm: number, phase: number): Promise<MediaAsset> {
  // Independent ground truth: deterministic kick/click transients at known
  // timestamps. The test subsequently measures the AAC-decoded source, not
  // these raw samples, before any planning or rendering takes place.
  const sr = 8000, samples = new Float32Array(SOURCE_SECONDS * sr);
  let seed = 37;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let onset = phase; onset < SOURCE_SECONDS - 0.2; onset += 60 / bpm) {
    for (let n = 0; n < sr * 0.09; n++) {
      const i = Math.round(onset * sr) + n;
      if (i < samples.length) samples[i] += Math.exp(-n / sr * 65) * (Math.sin(2 * Math.PI * 95 * n / sr) * 0.5 + random() * 0.3);
    }
  }
  const pcm = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, i) => pcm.writeFloatLE(sample, i * 4));
  const raw = path.join(folder, `${name}.f32le`), file = path.join(folder, `${name}.mp4`);
  await writeFile(raw, pcm);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", String(sr), "-ac", "1", "-i", raw,
    "-f", "lavfi", "-i", `color=c=${color}:size=320x180:rate=30:duration=${SOURCE_SECONDS}`,
    "-map", "1:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", String(SOURCE_SECONDS), file]);
  return { path: file, name: path.basename(file), width: 320, height: 180,
    duration: SOURCE_SECONDS, audioDuration: SOURCE_SECONDS, hasAudio: true };
}

async function metadata(file: string) {
  return JSON.parse((await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,duration", "-of", "json", file])).toString()) as {
    format: { duration: string }; streams: Array<{ codec_type: string; codec_name: string; duration: string }>;
  };
}

async function assertPlayable(file: string, seconds: number) {
  const info = await metadata(file), video = info.streams.find(s => s.codec_type === "video"), audio = info.streams.find(s => s.codec_type === "audio");
  assert.equal(video?.codec_name, "h264"); assert.equal(audio?.codec_name, "aac");
  assert.ok(Math.abs(Number(info.format.duration) - seconds) <= 1 / 30 + 0.005, `Requested ${seconds}s, got ${info.format.duration}s`);
  assert.ok(Math.abs(Number(video!.duration) - Number(audio!.duration)) <= 1 / 30 + 0.005, "Picture and sound stay synchronized");
  await run(ffmpeg, ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]);
}

async function pulseTimes(file: string, from: number, until: number): Promise<number[]> {
  const sampleRate = 48000;
  const raw = await run(ffmpeg, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"]);
  const hop = 240, count = Math.floor(raw.length / 4), times: number[] = [];
  // Detect separate audible pulse regions from the rendered waveform. This is
  // deliberately independent of the production spectral-grid detector.
  let lastLoud = -Infinity;
  for (let start = Math.floor(from * sampleRate / hop) * hop; start + hop < Math.min(count, until * sampleRate); start += hop) {
    let squares = 0;
    for (let i = start; i < start + hop; i++) squares += raw.readFloatLE(i * 4) ** 2;
    if (Math.sqrt(squares / hop) > 0.025) {
      const seconds = start / sampleRate;
      if (seconds - lastLoud > 0.1) times.push(seconds);
      lastLoud = seconds;
    }
  }
  return times;
}

async function pictureCut(file: string): Promise<number> {
  const rgb = await run(ffmpeg, ["-v", "error", "-i", file, "-an", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"]);
  for (let frame = 0; frame < rgb.length / 3; frame++) {
    if (rgb[frame * 3 + 2] > rgb[frame * 3] * 3) return frame / 30;
  }
  throw new Error("The rendered picture never changed from red to blue.");
}

test("measured beats improve actual song overlaps and picture cuts without changing length or protected moments", { timeout: 300_000 }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-music-edit-"));
  try {
    const red = await fixture(folder, "outgoing-120", "red", 120, 0.12);
    const blue = await fixture(folder, "incoming-120", "blue", 120, 0.32);
    const slower = await fixture(folder, "incoming-90", "green", 90, 0.12);
    const assets = [red, blue, slower];
    const hash = async () => Promise.all(assets.map(async source => createHash("sha256").update(await readFile(source.path)).digest("hex")));
    const originalHashes = await hash();
    const measurements = await Promise.all(assets.map(source => measureAudio(ffmpeg, source.path)));
    const binsByPath = Object.fromEntries(assets.map((source, i) => [source.path, measurements[i]]));
    for (const [i, expectedBpm] of [120, 120, 90].entries()) {
      const confident = measurements[i].filter(bin => (bin.beatConfidence ?? 0) >= 0.65);
      assert.ok(confident.length >= 24, `Source ${i} did not yield enough confident measured beats`);
      assert.ok(confident.every(bin => Math.abs(bin.tempoBpm! - expectedBpm) < 1), `Source ${i} tempo was misidentified`);
    }
    const audio: AudioSelection[] = [{ asset: red, start: 3, end: 9 }, { asset: blue, start: 3, end: 9 }];
    const pictures = audio.map(selection => ({ ...selection, included: true, locked: false, selectionSource: "suggested" as const }));
    const before = structuredClone({ audio, pictures });
    const options: ExportOptions = { aspect: "landscape", reduceRumble: false, quality: "high",
      transition: "cut", audioTransition: "crossfade", audioCrossfadeSeconds: 2, beatSync: true };

    const sound = alignSoundtrackBeats(audio, binsByPath, { crossfadeSeconds: 2 });
    assert.equal(sound.boundaries[0].status, "aligned");
    assert.ok(Math.abs(sound.boundaries[0].shiftSeconds - 0.2) < 0.04, "Incoming source is moved to the measured matching phase");
    assert.ok(sound.boundaries[0].matchedBeats! >= 3);
    assert.ok(sound.boundaries[0].maxBeatErrorSeconds! < 0.035);
    const picture = alignPictureCutsToMusic(pictures, sound.audioSelections, binsByPath);
    assert.equal(picture.boundaries[0].status, "aligned");

    const alignedFile = path.join(folder, "aligned.mp4"), ordinaryFile = path.join(folder, "ordinary.mp4");
    const plan = buildAudioLedRenderCommand(picture.clips, sound.audioSelections, alignedFile, options);
    assert.equal(plan.totalSeconds, 12);
    await run(ffmpeg, plan.args);
    await assertPlayable(alignedFile, 12);
    await run(ffmpeg, buildAudioLedRenderCommand(pictures, audio, ordinaryFile, { ...options, beatSync: false }).args);
    const alignedPulses = await pulseTimes(alignedFile, 5.05, 6.85), ordinaryPulses = await pulseTimes(ordinaryFile, 5.05, 6.85);
    assert.equal(alignedPulses.length, 4, `Expected one pulse per beat during the overlap, got ${alignedPulses}`);
    for (const [i, time] of alignedPulses.entries()) assert.ok(Math.abs(time - (5.12 + i * 0.5)) < 0.05, `Rendered pulse ${time} missed the known beat`);
    assert.ok(ordinaryPulses.length >= 7, `Unaligned comparison should expose the doubled hits, got ${ordinaryPulses}`);
    const renderedCut = await pictureCut(alignedFile);
    assert.ok(Math.abs(renderedCut - picture.boundaries[0].beatSeconds!) <= 1 / 30 + 0.002,
      `Actual picture cut ${renderedCut} missed beat ${picture.boundaries[0].beatSeconds}`);
    assert.ok(Math.abs(renderedCut - 6.12) < 0.05, "Actual red/blue boundary follows the known music pulse");

    const keptAudio = [{ ...audio[0], locked: true }, audio[1]];
    const keptPictures = [{ ...pictures[0], selectionSource: "manual" as const }, pictures[1]];
    const protectedSound = alignSoundtrackBeats(keptAudio, binsByPath);
    const protectedPicture = alignPictureCutsToMusic(keptPictures, protectedSound.audioSelections, binsByPath);
    assert.equal(protectedSound.boundaries[0].status, "protected");
    assert.equal(protectedPicture.boundaries[0].status, "protected");
    assert.deepEqual(protectedSound.audioSelections, keptAudio);
    assert.deepEqual(protectedPicture.clips, keptPictures);
    const keptFile = path.join(folder, "protected.mp4");
    await run(ffmpeg, buildAudioLedRenderCommand(protectedPicture.clips, protectedSound.audioSelections, keptFile, options).args);
    await assertPlayable(keptFile, 12);
    assert.equal(await pictureCut(keptFile), 6, "The manual picture boundary stays exactly where the user put it");

    const differentTempo = [audio[0], { asset: slower, start: 3, end: 9 }];
    const fallback = alignSoundtrackBeats(differentTempo, binsByPath);
    assert.equal(fallback.boundaries[0].status, "different-tempo");
    assert.deepEqual(fallback.audioSelections, differentTempo, "Incompatible tempos keep original ranges and song speed");
    assert.match(fallback.notes.join(" "), /ordinary blends/);
    assert.deepEqual({ audio, pictures }, before, "Analysis and planning never mutate the original selections");
    assert.deepEqual(await hash(), originalHashes, "All source recordings remain byte-for-byte unchanged");
  } finally {
    const target = path.resolve(folder);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith("vibe-music-edit-"));
    await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
});
