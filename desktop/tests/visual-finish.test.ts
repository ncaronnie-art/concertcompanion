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

test("a protected moment keeps its timing while the chosen look and fade apply", () => {
  const protectedPair = [{ ...pair[0], locked: true }, pair[1]];
  const { args } = buildRenderCommand(protectedPair, "out.mp4", { aspect: "vertical", reduceRumble: false, finish: "vivid", transition: "fade" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph.split("[v0]")[0], /eq=contrast=1\.06/);
  assert.match(graph, /,fade=t=out/);
  assert.match(graph, /,fade=t=in/);
});

test("a very short adjoining clip does not leave a one-sided fade", () => {
  const { args } = buildRenderCommand([pair[0], { asset, start: 1, end: 1.3 }], "out.mp4", { aspect: "vertical", reduceRumble: false, transition: "fade" });
  assert.doesNotMatch(args[args.indexOf("-filter_complex") + 1], /,fade=t=/);
});

test("fit framing preserves the complete source over a restrained backdrop, with softened audio cuts", () => {
  const { args, totalSeconds } = buildRenderCommand([{ ...pair[0], framing: "fit", locked: true }], "out.mp4", { aspect: "landscape", reduceRumble: false, transition: "cut" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.equal(totalSeconds, 1);
  assert.match(graph, /split=2/);
  assert.match(graph, /boxblur=10:1/);
  assert.match(graph, /force_original_aspect_ratio=decrease:force_divisible_by=2/);
  assert.match(graph, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
  assert.doesNotMatch(graph, /crop=1280:720/);
  assert.match(graph, /afade=t=in:st=0:d=0\.008/);
  assert.match(graph, /afade=t=out:st=0\.992:d=0\.008/);
  assert.throws(() => buildRenderCommand([{ ...pair[0], framing: "invalid" as "fill" }], "out.mp4"), /valid framing/);
});

test("9:13 defaults to a stable center crop while older 9:16 projects keep their framing", () => {
  const landscape = { ...asset, width: 1920, height: 1080 };
  const portrait = { ...asset, width: 1080, height: 1920 };
  const graph = (source: typeof asset, aspect: "portrait913" | "vertical" | "landscape", framing?: "fit" | "fill", focus?: number) => {
    const { args } = buildRenderCommand([{ asset: source, start: 0, end: 1, framing, focus }], "out.mp4", { aspect, reduceRumble: false });
    return args[args.indexOf("-filter_complex") + 1];
  };
  assert.match(graph(landscape, "vertical"), /scale=720:1280:force_original_aspect_ratio=decrease/);
  assert.match(graph(landscape, "portrait913"), /scale=720:1040:force_original_aspect_ratio=increase,crop=720:1040:\(iw-ow\)\*0\.500:\(ih-oh\)\/2/);
  assert.match(graph(landscape, "portrait913", "fill", 0), /crop=720:1040:\(iw-ow\)\*0\.000/);
  assert.match(graph(landscape, "portrait913", "fill", 1), /crop=720:1040:\(iw-ow\)\*1\.000/);
  assert.match(graph(landscape, "portrait913", "fit"), /scale=720:1040:force_original_aspect_ratio=decrease/);
  assert.match(graph(portrait, "landscape"), /scale=1280:720:force_original_aspect_ratio=decrease/);
  assert.match(graph(portrait, "vertical"), /force_original_aspect_ratio=increase,crop=720:1280/);
  assert.match(graph(landscape, "landscape"), /force_original_aspect_ratio=increase,crop=1280:720/);
  assert.match(graph(landscape, "vertical", "fill"), /force_original_aspect_ratio=increase,crop=720:1280/);
  assert.match(graph(landscape, "landscape", "fit"), /scale=1280:720:force_original_aspect_ratio=decrease/);
  assert.throws(() => buildRenderCommand([{ asset: landscape, start: 0, end: 1, focus: 1.2 }], "out.mp4"), /valid focal position/);
});

test("9:13 draft and export use the same focal crop at their respective resolutions", () => {
  const selection = { ...pair[0], focus: 0.25 };
  const options = { aspect: "portrait913" as const, reduceRumble: false };
  const draft = buildRenderCommand([selection], "draft.mp4", options, "draft");
  const final = buildRenderCommand([selection], "final.mp4", options);
  const draftGraph = draft.args[draft.args.indexOf("-filter_complex") + 1];
  const finalGraph = final.args[final.args.indexOf("-filter_complex") + 1];
  assert.match(draftGraph, /scale=360:520:force_original_aspect_ratio=increase,crop=360:520:\(iw-ow\)\*0\.250/);
  assert.match(finalGraph, /scale=720:1040:force_original_aspect_ratio=increase,crop=720:1040:\(iw-ow\)\*0\.250/);
});

test("draft render keeps the edit choices at a faster, smaller preview quality", () => {
  const selections = [{ ...pair[0], framing: "fit" as const }];
  const options = { aspect: "vertical" as const, reduceRumble: true, finish: "warm" as const, transition: "fade" as const };
  const draft = buildRenderCommand(selections, "draft.mp4", options, "draft");
  const exportPlan = buildRenderCommand(selections, "final.mp4", options);
  const draftGraph = draft.args[draft.args.indexOf("-filter_complex") + 1];
  assert.equal(draft.totalSeconds, exportPlan.totalSeconds);
  assert.match(draftGraph, /scale=360:640:force_original_aspect_ratio=decrease/);
  assert.match(draftGraph, /highpass=f=80/);
  assert.match(draftGraph, /colorchannelmixer/);
  assert.equal(draft.args[draft.args.indexOf("-preset") + 1], "ultrafast");
  assert.equal(draft.args[draft.args.indexOf("-crf") + 1], "30");
  assert.equal(draft.args[draft.args.indexOf("-b:a") + 1], "96k");
  assert.equal(exportPlan.args[exportPlan.args.indexOf("-preset") + 1], "medium");
  assert.throws(() => buildRenderCommand(selections, "out.mp4", options, "other" as "draft"), /valid render profile/);
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

function pixelAt(binary: string, video: string, x: number, y: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-v", "error", "-ss", "0.5", "-i", video, "-frames:v", "1",
      "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "pipe:1"], { windowsHide: true });
    const chunks: Buffer[] = []; let error = "";
    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data) => error += data);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error)));
  });
}

test("automatic vertical framing keeps visible details at both landscape edges", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-auto-framing-"));
  const binary = ffmpegPath as string;
  try {
    const source = path.join(root, "wide.mp4"), output = path.join(root, "vertical-draft.mp4");
    await execute(binary, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=320x180:rate=30:duration=1",
      "-vf", "drawbox=x=0:y=0:w=60:h=180:c=yellow:t=fill,drawbox=x=260:y=0:w=60:h=180:c=white:t=fill",
      "-c:v", "libx264", source]);
    const wide = { asset: { ...asset, path: source, width: 320, height: 180, duration: 1, hasAudio: false }, start: 0, end: 1 };
    const { args } = buildRenderCommand([wide], output, { aspect: "vertical", reduceRumble: false }, "draft");
    await execute(binary, args);
    const top = await pixelAt(binary, output, 180, 10);
    const left = await pixelAt(binary, output, 10, 320);
    const right = await pixelAt(binary, output, 350, 320);
    assert.ok(top[0] < 95 && top[1] < 95 && top[2] < 95, `expected muted background, got ${top.subarray(0, 3).toString("hex")}`);
    assert.ok(left[0] > 150 && left[1] > 150 && left[2] < 80, `expected left yellow detail, got ${left.subarray(0, 3).toString("hex")}`);
    assert.ok(right[0] > 150 && right[1] > 150 && right[2] > 150, `expected right white detail, got ${right.subarray(0, 3).toString("hex")}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 60_000 });

test("new portrait crop keeps the chosen side of 13:9 footage in a playable draft", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-portrait-focus-"));
  const binary = ffmpegPath as string;
  try {
    const source = path.join(root, "wide.mp4");
    await execute(binary, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=312x216:rate=30:duration=1",
      "-vf", "drawbox=x=0:y=0:w=78:h=216:c=yellow:t=fill,drawbox=x=234:y=0:w=78:h=216:c=white:t=fill",
      "-c:v", "libx264", source]);
    const wide = { asset: { ...asset, path: source, width: 312, height: 216, duration: 1, hasAudio: false }, start: 0, end: 1 };
    const render = async (focus: number) => {
      const output = path.join(root, `focus-${focus}.mp4`);
      const { args } = buildRenderCommand([{ ...wide, focus }], output,
        { aspect: "portrait913", reduceRumble: false }, "draft");
      await execute(binary, args);
      return pixelAt(binary, output, 180, 260);
    };
    const left = await render(0);
    const center = await render(0.5);
    const right = await render(1);
    assert.ok(left[0] > 150 && left[1] > 150 && left[2] < 80, `expected yellow left stage, got ${left.subarray(0, 3).toString("hex")}`);
    assert.ok(center[0] > 150 && center[1] < 80 && center[2] < 80, `expected red center stage, got ${center.subarray(0, 3).toString("hex")}`);
    assert.ok(right[0] > 150 && right[1] > 150 && right[2] > 150, `expected white right stage, got ${right.subarray(0, 3).toString("hex")}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 60_000 });

test("bundled FFmpeg renders a playable graded reel with duration preserving fades", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-visual-finish-"));
  try {
    const source = path.join(root, "source.mp4"), output = path.join(root, "finished.mp4");
    await execute(ffmpegPath as string, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:size=320x240:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libx264", "-c:a", "aac", source]);
    const selected = pair.map((part) => ({ ...part, framing: "fit" as const, asset: { ...asset, path: source } }));
    const { args, totalSeconds } = buildRenderCommand(selected, output, { aspect: "landscape", reduceRumble: false, finish: "warm", transition: "fade" });
    await execute(ffmpegPath as string, args);
    const data = JSON.parse(await execute(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", output]));
    assert.ok(Math.abs(Number(data.format.duration) - totalSeconds) < 0.2);
    assert.ok(data.streams.some((stream: { codec_type: string; codec_name: string; width?: number; height?: number }) => stream.codec_type === "video" && stream.codec_name === "h264" && stream.width === 1280 && stream.height === 720));
    assert.ok(data.streams.some((stream: { codec_type: string; codec_name: string }) => stream.codec_type === "audio" && stream.codec_name === "aac"));
    await execute(ffmpegPath as string, ["-v", "error", "-i", output, "-f", "null", "-"]);
    const border = await pixelAt(ffmpegPath as string, output, 10, 360);
    const picture = await pixelAt(ffmpegPath as string, output, 640, 360);
    assert.equal(border.length, 12);
    assert.ok(border[0] < 95 && border[1] < 95 && border[2] < 95, `expected dark frame surround, got ${border.subarray(0, 3).toString("hex")}`);
    assert.ok(picture[0] > 150 && picture[1] > 60 && picture[0] > picture[2] * 2, `expected visible orange image, got ${picture.subarray(0, 3).toString("hex")}`);
    const draftOutput = path.join(root, "draft.mp4");
    const draftPlan = buildRenderCommand(selected, draftOutput, { aspect: "landscape", reduceRumble: false, finish: "warm", transition: "fade" }, "draft");
    await execute(ffmpegPath as string, draftPlan.args);
    const draftData = JSON.parse(await execute(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", draftOutput]));
    assert.ok(Math.abs(Number(draftData.format.duration) - draftPlan.totalSeconds) < 0.2);
    assert.ok(draftData.streams.some((stream: { codec_type: string; codec_name: string; width?: number; height?: number }) => stream.codec_type === "video" && stream.codec_name === "h264" && stream.width === 640 && stream.height === 360));
    await execute(ffmpegPath as string, ["-v", "error", "-i", draftOutput, "-f", "null", "-"]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 60_000 });
