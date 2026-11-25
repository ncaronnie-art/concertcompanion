import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { buildVisualEffects, validateVisualFinishOptions, type EffectStyle } from "../src/shared/visual-effects.ts";

const binary = ffmpeg as string;
function execute(exe: string, args: string[], raw = false): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true }); const chunks: Buffer[] = []; let error = "";
    p.stdout.on("data", d => chunks.push(d)); p.stderr.on("data", d => error += d);
    p.on("error", reject); p.on("close", code => code === 0 ? resolve(raw ? Buffer.concat(chunks) : Buffer.concat(chunks).toString()) : reject(Error(error)));
  });
}
const context = { duration: 2, namespace: "testfx", cues: [{ seconds: 0.5, confidence: 0.9, strength: 0.9 }], lightAnchors: [{ x: 0.84, y: 0.18 }] };

test("visual options reject arbitrary commands and invalid cue/box coordinates", () => {
  assert.throws(() => validateVisualFinishOptions({ effects: "movie;drawtext=bad" as EffectStyle }), /valid visual/);
  assert.throws(() => validateVisualFinishOptions({ reducedFlash: 1 as unknown as boolean }), /valid visual/);
  assert.throws(() => buildVisualEffects("0:v", "done", 160, 288, {}, { ...context, cues: [{ seconds: NaN, confidence: 1 }] }), /invalid music cue/);
  assert.throws(() => buildVisualEffects("0:v", "done", 160, 288, {}, { ...context, subjectBoxes: [{ seconds: 0, x: 0.9, y: 0.1, width: 0.2, height: 0.5, confidence: 1 }] }), /invalid tracked/);
  assert.throws(() => buildVisualEffects("0:v;movie=bad", "done", 160, 288, {}, context), /internal picture label/);
  assert.throws(() => buildVisualEffects("0:v", "done", 160, 288, {}, { ...context, metrics: { noise: 3 } }), /normalized/);
});

test("uncertain rhythm stays an honest editorial accent and reduced-flash is default", () => {
  const uncertain = buildVisualEffects("0:v", "done", 160, 288, { effects: "neon-pop" }, { duration: 6, cues: [{ seconds: 1, confidence: 0.2 }] });
  assert.equal(uncertain.musicalCueCount, 0); assert.equal(uncertain.editorialCueCount, 1);
  assert.ok(uncertain.warnings.some(w => w.includes("editorial timing")));
  const crowded = Array.from({ length: 50 }, (_, i) => ({ seconds: i / 10, confidence: 1 }));
  const reduced = buildVisualEffects("0:v", "done", 160, 288, { effects: "full-y2k" }, { duration: 6, cues: crowded });
  const stronger = buildVisualEffects("0:v", "done", 160, 288, { effects: "full-y2k", reducedFlash: false }, { duration: 6, cues: crowded });
  assert.ok(reduced.musicalCueCount < stronger.musicalCueCount);
  assert.doesNotMatch(reduced.filters.join(";"), /drawtext|subtitles|strobe|tblend/);
  assert.match(reduced.filters.join(";"), /eof_action=pass:repeatlast=0:shortest=0/);
});

test("enhancement strength and visibility corrections depend on bounded shot metrics", () => {
  const dark = buildVisualEffects("0:v", "done", 160, 288, { videoEnhancement: "enhanced" }, { duration: 2, metrics: { luma: 0.09, noise: 0.8, motion: 0.1 } });
  const bright = buildVisualEffects("0:v", "done", 160, 288, { videoEnhancement: "enhanced" }, { duration: 2, metrics: { luma: 0.7, noise: 0.1, motion: 0.8 } });
  assert.match(dark.filters.join(";"), /gamma=1\.045/);
  assert.doesNotMatch(bright.filters.join(";"), /gamma=/);
  assert.match(bright.filters.join(";"), /unsharp=5:5:0\.08/);
  assert.notEqual(dark.filters[0], bright.filters[0]);
});

test("person rectangles are never advertised or rendered as silhouette masks", () => {
  const p = buildVisualEffects("0:v", "done", 160, 288, { effects: "full-y2k" }, { ...context,
    subjectBoxes: [{ seconds: 0, x: 0.3, y: 0.1, width: 0.3, height: 0.8, confidence: 0.95 }] });
  assert.ok(p.warnings.some(w => w.includes("segmentation masks")));
  assert.doesNotMatch(p.filters.join(";"), /edgedetect|drawbox|alphamerge/);
});

test("all four effects modes render distinct playable frames while preserving time and frame count", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "compass-y2k-fx-"));
  const pixels = new Map<string, Buffer>();
  try {
    for (const style of ["none", "subtle", "neon-pop", "full-y2k"] as const) {
      const output = path.join(folder, style + ".mp4");
      const p = buildVisualEffects("0:v", "done", 160, 288, { effects: style }, context);
      await execute(binary, ["-v", "error", "-y", "-filter_complex_threads", "1", "-f", "lavfi", "-i",
        "color=c=0x18202a:s=160x288:r=30:d=2,drawbox=x=112:y=28:w=20:h=20:c=white:t=fill",
        "-filter_complex", p.filters.join(";"), "-map", "[done]", "-an", "-frames:v", "60", "-c:v", "libx264", "-crf", "15", "-pix_fmt", "yuv420p", output]);
      const metadata = JSON.parse(await execute(ffprobe.path, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]) as string);
      assert.equal(metadata.streams[0].width, 160); assert.equal(metadata.streams[0].height, 288);
      assert.equal(metadata.streams[0].nb_frames, "60"); assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.04);
      const frame = await execute(binary, ["-v", "error", "-ss", "0.75", "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], true) as Buffer;
      assert.equal(frame.length, 160 * 288 * 3); pixels.set(style, frame);
      await execute(binary, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
    }
    for (const [a, b] of [["none", "subtle"], ["subtle", "neon-pop"], ["neon-pop", "full-y2k"]]) {
      let changed = 0; const x = pixels.get(a)!, y = pixels.get(b)!;
      for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 2) changed++;
      assert.ok(changed > 80, `${a} and ${b} did not make visibly different rendered pixels: ${changed}`);
    }
    // Away from bright lights and bounded decorative accents, the performance
    // field remains visible rather than covered by an opaque graphic package.
    const full = pixels.get("full-y2k")!; const center = (144 * 160 + 80) * 3;
    assert.ok(full[center] < 85 && full[center + 1] < 85 && full[center + 2] < 100);
  } finally { await rm(folder, { recursive: true, force: true }); }
}, { timeout: 120_000 });
