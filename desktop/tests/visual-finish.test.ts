import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildRenderCommand, type MediaAsset } from "../src/shared/render-plan.ts";

const asset: MediaAsset = { path: "synthetic.mp4", name: "synthetic.mp4", duration: 2, width: 320, height: 240, hasAudio: true };
const pair = [{ asset, start: 0, end: 1 }, { asset, start: 1, end: 2 }];

test("visual finish is validated and preserves the selected length", () => {
  const { args, totalSeconds } = buildRenderCommand(pair, "out.mp4", { aspect: "landscape", reduceRumble: false, finish: "cinematic", transition: "fade" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.equal(totalSeconds, 2);
  assert.match(graph, /eq=contrast=1\.07:saturation=0\.90/);
  assert.match(graph, /fade=t=out/);
  assert.match(graph, /fade=t=in/);
  assert.doesNotMatch(graph, /xfade|acrossfade/);
  assert.throws(() => buildRenderCommand(pair, "out.mp4", { aspect: "landscape", reduceRumble: false, finish: "arbitrary" as "warm" }), /valid export settings/);
});

test("a protected moment gets no automatic visual look or boundary fade", () => {
  const protectedPair = [{ ...pair[0], locked: true }, pair[1]];
  const { args } = buildRenderCommand(protectedPair, "out.mp4", { aspect: "vertical", reduceRumble: false, finish: "vivid", transition: "fade" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.doesNotMatch(graph.split("[v0]")[0], /eq=|fade=/);
  assert.doesNotMatch(graph, /fade=/);
  assert.match(graph, /eq=contrast=1\.06/);
});

test("a very short adjoining clip does not leave a one-sided fade", () => {
  const { args } = buildRenderCommand([pair[0], { asset, start: 1, end: 1.3 }], "out.mp4", { aspect: "vertical", reduceRumble: false, transition: "fade" });
  assert.doesNotMatch(args[args.indexOf("-filter_complex") + 1], /fade=/);
});

function execute(binary: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (err += data));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err)));
  });
}

test("bundled FFmpeg renders a playable graded reel with duration preserving fades", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-visual-finish-"));
  try {
    const source = path.join(root, "source.mp4"), output = path.join(root, "finished.mp4");
    await execute(ffmpegPath as string, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:size=320x240:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libx264", "-c:a", "aac", source]);
    const selected = pair.map((part) => ({ ...part, asset: { ...asset, path: source } }));
    const { args, totalSeconds } = buildRenderCommand(selected, output, { aspect: "landscape", reduceRumble: false, finish: "warm", transition: "fade" });
    await execute(ffmpegPath as string, args);
    const data = JSON.parse(await execute(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", output]));
    assert.ok(Math.abs(Number(data.format.duration) - totalSeconds) < 0.2);
    assert.ok(data.streams.some((stream: { codec_type: string; codec_name: string; width?: number; height?: number }) => stream.codec_type === "video" && stream.codec_name === "h264" && stream.width === 1280 && stream.height === 720));
    assert.ok(data.streams.some((stream: { codec_type: string; codec_name: string }) => stream.codec_type === "audio" && stream.codec_name === "aac"));
    await execute(ffmpegPath as string, ["-v", "error", "-i", output, "-f", "null", "-"]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 60_000 });
