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
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.ts";
import { planAudioStory } from "../src/shared/audio-story.ts";
import { buildAudioLedRenderCommand, type MediaAsset } from "../src/shared/render-plan.ts";
import { parseProjectSnapshot } from "../src/shared/project-file.ts";
import { scoreAudioBins } from "../src/shared/suggestions.ts";

const ffmpeg = ffmpegPath as string;
function run(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    const chunks: Buffer[] = []; let error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Three-part media test timed out.")); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4000); });
    child.on("error", value => { clearTimeout(timer); reject(value); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error || "Media process failed.")); });
  });
}
async function fixture(folder: string, name: string, color: string, bpm: number, duration = 36, noisy = false): Promise<MediaAsset> {
  const sr = 8000, samples = new Float32Array(duration * sr);
  let seed = 91;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  if (noisy) for (let n = 0; n < samples.length; n++) samples[n] = random() * .65;
  else for (let onset = .12; onset < duration - .2; onset += 60 / bpm) {
    for (let n = 0; n < sr * .09; n++) {
      const i = Math.round(onset * sr) + n;
      if (i < samples.length) samples[i] += Math.exp(-n / sr * 65) * (Math.sin(2 * Math.PI * 95 * n / sr) * .5 + random() * .3);
    }
  }
  const raw = path.join(folder, name + ".f32le"), file = path.join(folder, name + ".mp4");
  const data = Buffer.alloc(samples.length * 4); samples.forEach((value, i) => data.writeFloatLE(value, i * 4));
  await writeFile(raw, data);
  await run(ffmpeg, ["-v", "error", "-y", "-f", "f32le", "-ar", String(sr), "-ac", "1", "-i", raw,
    "-f", "lavfi", "-i", "color=c=" + color + ":size=180x320:rate=30:duration=" + duration,
    "-map", "1:v", "-map", "0:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-t", String(duration), file]);
  return { path: file, name: path.basename(file), duration, audioDuration: duration, width: 180, height: 320, hasAudio: true };
}
async function pulseCount(file: string, from: number): Promise<number> {
  const raw = await run(ffmpeg, ["-v", "error", "-ss", String(from), "-i", file, "-t", "10", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
  let count = 0, last = -Infinity;
  for (let at = 0; at + 40 < raw.length / 4; at += 40) {
    let squares = 0;
    for (let i = at; i < at + 40; i++) squares += raw.readFloatLE(i * 4) ** 2;
    if (Math.sqrt(squares / 40) > .02) { if (at / 8000 - last > .12) count++; last = at / 8000; }
  }
  return count;
}
test("90-second first cut exports three equal, increasing-tempo sound sections without selecting loud noise or stretching a short clip", { timeout: 300_000 }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-three-act-"));
  try {
    const assets = [
      await fixture(folder, "slow-60", "red", 60),
      await fixture(folder, "middle-90", "green", 90),
      await fixture(folder, "finale-120", "blue", 120),
      await fixture(folder, "loud-noise", "yellow", 0, 36, true),
      await fixture(folder, "too-short", "purple", 120, 15),
    ];
    const hashes = async () => Promise.all(assets.map(async a => createHash("sha256").update(await readFile(a.path)).digest("hex")));
    const originals = await hashes();
    const clips: CreativeClip[] = assets.map(asset => ({ asset, start: 0, end: 12, included: true, locked: false,
      excludedByUser: false, selectionSource: "suggested", framing: "fill" }));
    const measurements = await Promise.all(assets.map(a => measureAudio(ffmpeg, a.path)));
    const bins = Object.fromEntries(assets.map((a, i) => [a.path, measurements[i]]));
    const input = { description: "90-second recap, three equal sound moments, slower opening then mid-tempo then an upbeat finale. No text.",
      targetSeconds: 90, soundMomentCount: 3, separatePicture: true, pictureSourceCount: 4, tempoArc: true, highlightFocus: "performance" as const };
    const options = { aspect: "vertical" as const, reduceRumble: false, quality: "high" as const, highlightFocus: "performance" as const,
      transition: "dissolve" as const, audioTransition: "crossfade" as const, audioCrossfadeSeconds: 2, beatSync: true };
    const brief = interpretCreativeBrief(input, clips, options);
    assert.equal(brief.conflict, null);
    const planned = planAudioStory(clips, brief, bins);
    assert.equal(planned.plannedSeconds, 90);
    assert.deepEqual(planned.audioSelections.map(s => s.asset.name), ["slow-60.mp4", "middle-90.mp4", "finale-120.mp4"],
      JSON.stringify({ chosen: planned.audioSelections.map(s => ({ name: s.asset.name, start: s.start, end: s.end })),
        measurements: assets.map((asset, index) => ({ name: asset.name,
          first30: scoreAudioBins(measurements[index].slice(0, 60), "performance"),
          first4: scoreAudioBins(measurements[index].slice(0, 8), "performance"),
          pulses: measurements[index].reduce((count, bin) => count + (bin.beatTimes?.length ?? 0), 0),
          tempos: [...new Set(measurements[index].map(bin => bin.tempoBpm).filter(Boolean))] })) }));
    for (const s of planned.audioSelections) assert.ok(Math.abs(s.end - s.start - 30) < .001);
    const snapshot = parseProjectSnapshot({ version: 2, clips: planned.clips, options: planned.options,
      audioSelections: planned.audioSelections, briefInput: input, briefDirty: false });
    assert.equal(snapshot.briefInput.tempoArc, true);
    assert.equal(snapshot.briefInput.targetSeconds, 90);
    const output = path.join(folder, "three-act.mp4");
    const command = buildAudioLedRenderCommand(snapshot.clips.filter(c => c.included && !c.excludedByUser), snapshot.audioSelections!, output, snapshot.options);
    assert.ok(Math.abs(command.totalSeconds - 90) < .001);
    await run(ffmpeg, command.args);
    const meta = JSON.parse((await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,duration,width,height", "-of", "json", output])).toString());
    const video = meta.streams.find((s: {codec_type: string}) => s.codec_type === "video");
    const audio = meta.streams.find((s: {codec_type: string}) => s.codec_type === "audio");
    assert.equal(video.codec_name, "h264"); assert.equal(audio.codec_name, "aac");
    assert.equal(video.width, 180); assert.equal(video.height, 320);
    assert.ok(Math.abs(Number(meta.format.duration) - 90) <= 1 / 30 + .005);
    assert.ok(Math.abs(Number(video.duration) - Number(audio.duration)) <= 1 / 30 + .005);
    await run(ffmpeg, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
    const pulses = [await pulseCount(output, 10), await pulseCount(output, 40), await pulseCount(output, 70)];
    for (const [i, expected] of [10, 15, 20].entries()) assert.ok(Math.abs(pulses[i] - expected) <= 1, "Rendered pulse count " + pulses + " must preserve the intended musical speeds");
    assert.deepEqual(await hashes(), originals, "Source recordings remain unchanged.");
  } finally {
    const target = path.resolve(folder);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith("vibe-three-act-"));
    await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
});
