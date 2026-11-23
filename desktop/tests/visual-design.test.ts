import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import { assFilter, buildOverlayAss } from "../src/shared/visual-design.ts";

function run(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg as unknown as string, args, { windowsHide: true });
    const chunks: Buffer[] = []; let error = "";
    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => { error = (error + data.toString()).slice(-3000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error || `FFmpeg exited ${code}`)));
  });
}

test("overlay timing, margins and user text are safe without inventing extra footage", () => {
  assert.equal(buildOverlayAss({ width: 720, height: 1040, style: "natural" }), null);
  const script = buildOverlayAss({ eventTitle: "Olivia's Night: 100% {\\pos(0,0)} 🎵",
    labels: [{ text: "The crowd, \"so loud\"!", start: 5, duration: 10 }],
    width: 720, height: 1040, style: "vivid" })!;
  assert.match(script, /PlayResX: 720/);
  assert.match(script, /PlayResY: 1040/);
  assert.match(script, /0:00:00\.00,0:00:02\.40,Title/);
  assert.match(script, /0:00:05\.00,0:00:07\.10,Label/);
  assert.match(script, /Olivia's Night: 100%\\N｛＼pos\(0,0\)｝ 🎵/);
  assert.doesNotMatch(script, /\{\\pos\(0,0\)\}/);
  assert.match(script, /The crowd, "so loud"!/);
  assert.throws(() => buildOverlayAss({ eventTitle: "x".repeat(81), width: 720, height: 1040, style: "natural" }), /under 81/);
  assert.throws(() => assFilter("relative.ass"), /full path/);
});

test("a short named opening shot is not hidden behind the event title", () => {
  const script = buildOverlayAss({ eventTitle: "Live tonight", labels: [
    { text: "First song", start: 0, duration: 1.5 },
    { text: "Second song", start: 1.5, duration: 4 },
  ], width: 720, height: 1040, style: "vivid" })!;
  assert.match(script, /0:00:00\.00,0:00:01\.50,Label[^\n]*First song/);
  assert.match(script, /0:00:02\.40,0:00:04\.50,Label[^\n]*Second song/);
});

test("bundled FFmpeg renders readable Unicode overlays on a playable portrait video", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe overlay test "));
  try {
    const scriptPath = path.join(folder, "event title's.ass");
    const output = path.join(folder, "title.mp4");
    const script = buildOverlayAss({ eventTitle: "Olivia's Night: ¡Qué noche! 🎵",
      labels: [{ text: "The first song", start: 0, duration: 1.5 }],
      width: 720, height: 1040, style: "cinematic" })!;
    await writeFile(scriptPath, script, "utf8");
    assert.equal(await readFile(scriptPath, "utf8"), script);
    await run(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "color=c=0x14111c:s=720x1040:r=30:d=3", "-vf", assFilter(scriptPath),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", output]);
    await run(["-v", "error", "-i", output, "-f", "null", "-"]);
    const pixels = await run(["-v", "error", "-ss", "0.8", "-i", output,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    assert.equal(pixels.length, 720 * 1040 * 3);
    let bright = 0;
    for (let y = 50; y < 330; y++) for (let x = 30; x < 660; x++) {
      const pixel = (y * 720 + x) * 3;
      if (pixels[pixel] > 150 && pixels[pixel + 1] > 130 && pixels[pixel + 2] > 120) bright++;
    }
    assert.ok(bright > 100, `Expected legible title pixels, found ${bright}`);
    const lowerPixels = await run(["-v", "error", "-ss", "0.8", "-i", output,
      "-frames:v", "1", "-vf", "crop=500:190:20:650", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    let labelBright = 0;
    for (let i = 0; i < lowerPixels.length; i += 3) {
      if (lowerPixels[i] > 150 && lowerPixels[i + 1] > 130 && lowerPixels[i + 2] > 120) labelBright++;
    }
    assert.ok(labelBright > 100, `Expected readable named first moment, found ${labelBright}`);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
