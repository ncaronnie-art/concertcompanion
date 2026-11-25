import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import { buildAudioLedRenderCommand, type ExportOptions, type RenderSelection } from "../src/shared/render-plan.js";
import type { BodyMask } from "../src/shared/body-mask.js";

function run(args: string[]) { return new Promise<Buffer>((resolve, reject) => {
  const process = spawn(ffmpeg as string, ["-v", "error", "-nostdin", ...args], { windowsHide: true });
  const chunks: Buffer[] = []; let error = "";
  process.stdout.on("data", d => chunks.push(d)); process.stderr.on("data", d => error += d);
  process.on("error", reject); process.on("close", code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error(error)));
}); }

test("real render keeps source-space masks aligned through crop, tracking and fit, including a nonzero mask offset; soundtrack is identical", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capsule-mask-render-"));
  try {
    const source = path.join(directory, "source.mkv"), maskPath = path.join(directory, "mask.mkv");
    // Deliberately synthetic body blocks. These verify geometry, NOT detection.
    await run(["-y", "-f", "lavfi", "-i", "color=c=0x18202a:s=320x180:r=30:d=3,drawbox=x=204:y=45:w=32:h=90:color=0x806e64:t=fill", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=3", "-c:v", "ffv1", "-c:a", "pcm_s16le", "-threads", "1", source]);
    // First half-second has a mask on the WRONG side. Source time1 must seek
    // to mask0.5, so the wrong-side silhouette must never reach this selection.
    await run(["-y", "-f", "lavfi", "-i", "nullsrc=s=320x180:r=30:d=2,format=gray,geq=lum='255*between(Y,45,134)*if(lt(T,0.5),between(X,30,61),between(X,204,235))'", "-c:v", "ffv1", "-threads", "1", maskPath]);
    const mask: BodyMask = { version: 1, path: maskPath, start: .5, end: 2.5, width: 320, height: 180, sourceWidth: 320, sourceHeight: 180, fps: 30, frames: 60, coverage: 1, modelId: "synthetic-test-only", modelSha256: "fixture", sourceSHA256: "fixture", warnings: [] };
    const selection: RenderSelection = { asset: { path: source, name: "source.mkv", duration: 3, width: 320, height: 180, hasAudio: true }, start: 1, end: 2, framing: "fill", focus: .78, bodyMask: mask };
    const settings: ExportOptions = { aspect: "vertical", quality: "high", finish: "natural", reduceRumble: true, transition: "cut", bodyOutline: "electric" };
    const cases: { name: string; selection: RenderSelection; options: ExportOptions; bounds: number[] }[] = [
      // High-quality synthetic180p output is180x320: cover scale16/9,
      // then crop389px excess at78%. Expected body x60..118,y80..240.
      { name: "focus", selection, options: settings, bounds: [60, 80, 118, 240] },
      { name: "tracked", selection: { ...selection, focus: .1, tracking: { version: 1, subjectLocked: true, coverage: 1, suggestedFraming: "fill", notes: [], keyframes: [{ time: 1, x: .5, y: 0, width: .3164, height: 1, confidence: 1, status: "tracking" }, { time: 2, x: .5, y: 0, width: .3164, height: 1, confidence: 1, status: "tracking" }] } }, options: { ...settings, smartFraming: "follow-performer" }, bounds: [78, 80, 135, 240] },
      { name: "fit", selection: { ...selection, framing: "fit" }, options: settings, bounds: [114, 135, 133, 186] },
    ];
    for (const fixture of cases) {
      const outputs: Buffer[] = [], soundHashes: string[] = [];
      for (const bodyOutline of ["off", "electric"] as const) {
        const output = path.join(directory, `${fixture.name}-${bodyOutline}.mp4`);
        const command = buildAudioLedRenderCommand([fixture.selection], [{ asset: selection.asset, start: 1, end: 2 }], output, { ...fixture.options, bodyOutline });
        const args = [...command.args]; args.splice(2, 0, "-threads", "1"); args.splice(args.length - 1, 0, "-threads", "1");
        await run(args);
        outputs.push(await run(["-ss", "0.1", "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]));
        soundHashes.push((await run(["-i", output, "-map", "0:a", "-f", "hash", "-hash", "sha256", "pipe:1"])).toString());
      }
      assert.equal(soundHashes[0], soundHashes[1], fixture.name + ": body effects changed the soundtrack");
      const [clean, neon] = outputs, [left, top, right, bottom] = fixture.bounds;
      assert.equal(clean.length, 180 * 320 * 3); assert.equal(neon.length, clean.length);
      let nearby = 0, distant = 0;
      for (let y = 0; y < 320; y++) for (let x = 0; x < 180; x++) {
        const at = (y * 180 + x) * 3, delta = Math.max(...[0, 1, 2].map(c => Math.abs(clean[at + c] - neon[at + c])));
        if (delta > 35) {
          if (x >= left - 9 && x <= right + 9 && y >= top - 9 && y <= bottom + 9) nearby++; else distant++;
        }
      }
      assert.ok(nearby > 60, `${fixture.name}: no visible silhouette at the picture's actual crop`);
      assert.ok(distant < 25, `${fixture.name}: ${distant} displaced outline pixels outside the source body`);
    }
    assert.throws(() => buildAudioLedRenderCommand([{ ...selection, bodyMask: { ...mask, start: 1.5 } }], [{ asset: selection.asset, start: 1, end: 2 }], "out.mp4", settings), /no longer matches/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
