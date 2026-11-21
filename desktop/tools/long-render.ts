import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildAudioLedRenderCommand, buildRenderCommand, type MediaAsset } from "../src/shared/render-plan.js";

function run(binary: string, args: string[]) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true }); const chunks: Buffer[] = []; let error = "";
    child.stdout.on("data", (data: Buffer) => chunks.push(data)); child.stderr.on("data", (data) => { error = (error + data).slice(-4000); });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error || `Process exited ${code}`)));
  });
}

const root = await mkdtemp(path.join(tmpdir(), "compass-long-test-"));
const binary = ffmpeg as unknown as string;
try {
  const fixtures = [
    { color: "red", duration: 310, tone: 440 },
    { color: "green", duration: 105, tone: 660 },
    { color: "blue", duration: 105, tone: 880 },
  ];
  const selections = [];
  for (const [index, fixture] of fixtures.entries()) {
    const file = path.join(root, `source-${index}.mp4`);
    await run(binary, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=${fixture.color}:size=320x240:rate=10:duration=${fixture.duration}`, "-f", "lavfi", "-i", `sine=frequency=${fixture.tone}:sample_rate=48000:duration=${fixture.duration}`, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", file]);
    const asset: MediaAsset = { path: file, name: `source-${index}.mp4`, duration: fixture.duration, width: 320, height: 240, hasAudio: true };
    selections.push({ asset, start: 2, end: 102 });
  }
  const output = path.join(root, "five-minute.mp4");
  const plan = buildRenderCommand(selections, output);
  console.log("Rendering five minutes from three synthetic sources, including a source longer than five minutes.");
  const started = Date.now();
  await run(binary, ["-loglevel", "error", ...plan.args]);
  const metadata = JSON.parse((await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", output])).toString());
  assert.ok(Math.abs(Number(metadata.format.duration) - 300) < 0.3, `Duration: ${metadata.format.duration}`);
  assert.ok(metadata.streams.some((s: { codec_type: string; codec_name: string }) => s.codec_type === "audio" && s.codec_name === "aac"));
  const video = metadata.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  assert.equal(video.codec_name, "h264"); assert.equal(video.width, 720); assert.equal(video.height, 1280);
  for (const [time, channel] of [[50, 0], [150, 1], [250, 2]] as const) {
    const rgb = await run(binary, ["-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"]);
    assert.equal(rgb.length, 3); assert.ok(rgb[channel] > rgb[(channel + 1) % 3] * 1.5 && rgb[channel] > rgb[(channel + 2) % 3] * 1.5, `Wrong source at ${time}s: ${rgb.toString("hex")}`);
  }
  await run(binary, ["-v", "error", "-i", output, "-f", "null", "-"]);
  console.log(`Five-minute synthetic export passed in ${Math.round((Date.now() - started) / 1000)} seconds, with complete decode and correct source order.`);

  const separateOutput = path.join(root, "five-minute-audio-led.mp4");
  const separate = buildAudioLedRenderCommand(selections,
    [selections[2], selections[0], selections[1]], separateOutput);
  const separateStarted = Date.now();
  await run(binary, ["-loglevel", "error", ...separate.args]);
  const separateMetadata = JSON.parse((await run(ffprobe.path, ["-v", "error", "-show_entries",
    "format=duration:stream=codec_type,codec_name,duration", "-of", "json", separateOutput])).toString());
  assert.ok(Math.abs(Number(separateMetadata.format.duration) - 300) < 0.3);
  assert.ok(separateMetadata.streams.some((stream: { codec_type: string; codec_name: string; duration: string }) =>
    stream.codec_type === "audio" && stream.codec_name === "aac" && Math.abs(Number(stream.duration) - 300) < 0.3),
  "The separate soundtrack must cover the full five minutes.");
  await run(binary, ["-v", "error", "-i", separateOutput, "-f", "null", "-"]);
  console.log(`Five-minute synthetic sound-led export passed in ${Math.round((Date.now() - separateStarted) / 1000)} seconds, with three separate sound sections and complete decode.`);
} finally { await rm(root, { recursive: true, force: true }); }
