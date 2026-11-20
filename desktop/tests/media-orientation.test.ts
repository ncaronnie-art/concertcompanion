import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { displayDimensions } from "../electron/media-orientation.ts";

test("display dimensions account for display-matrix and legacy rotation metadata", () => {
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, tags: { rotate: "270" } }), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }), { width: 1920, height: 1080 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, side_data_list: [{ rotation: 90.01 }], tags: { rotate: "0" } }), { width: 1080, height: 1920 });
});

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let output = "", error = "";
    child.stdout.on("data", (data) => output += data);
    child.stderr.on("data", (data) => error += data);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(error)));
  });
}

test("rotation metadata from a synthetic phone-style MP4 matches FFmpeg's displayed frame", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-rotation-"));
  const ffmpeg = ffmpegPath as string;
  try {
    const encoded = path.join(root, "encoded.mp4");
    const rotated = path.join(root, "rotated.mp4");
    const decodedFrame = path.join(root, "decoded.png");
    await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=320x180:rate=30:duration=1", "-c:v", "libx264", encoded]);
    await run(ffmpeg, ["-v", "error", "-y", "-display_rotation", "90", "-i", encoded, "-c", "copy", rotated]);
    const metadata = JSON.parse(await run(ffprobe.path, ["-v", "error", "-show_streams", "-of", "json", rotated]));
    const stream = metadata.streams?.[0];
    assert.ok(stream?.side_data_list?.some((item: { rotation?: number }) => Math.abs(item.rotation ?? 0) === 90));
    assert.deepEqual({ width: stream.width, height: stream.height }, { width: 320, height: 180 });
    assert.deepEqual(displayDimensions(stream), { width: 180, height: 320 });
    await run(ffmpeg, ["-v", "error", "-y", "-i", rotated, "-frames:v", "1", decodedFrame]);
    const actual = JSON.parse(await run(ffprobe.path, ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", decodedFrame]));
    assert.deepEqual({ width: actual.streams[0].width, height: actual.streams[0].height }, { width: 180, height: 320 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, { timeout: 30_000 });
