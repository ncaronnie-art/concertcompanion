import { spawn } from "node:child_process";
import type { AudioBin } from "../src/shared/suggestions.js";

export function measureAudio(binary: string, source: string, reduceRumble = false, signal?: AbortSignal): Promise<AudioBin[]> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-nostdin", "-i", source, "-map", "0:a:0", "-vn"];
    // Match the export filter before calculating the bins used to rank the soundtrack.
    if (reduceRumble) args.push("-af", "aresample=48000,aformat=channel_layouts=stereo,highpass=f=80");
    args.push("-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1");
    const child = spawn(binary, args, { windowsHide: true, signal });
    const bins: AudioBin[] = []; let remainder = Buffer.alloc(0), sum = 0, count = 0, clipped = 0, stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      const chunk = Buffer.concat([remainder, data]); const limit = chunk.length - chunk.length % 4;
      for (let offset = 0; offset < limit; offset += 4) {
        const sample = chunk.readFloatLE(offset); const value = Number.isFinite(sample) ? sample : 0;
        sum += value * value; if (Math.abs(value) > 0.985) clipped++; count++;
        if (count === 4000) { bins.push({ rms: Math.sqrt(sum / count), clipping: clipped / count }); sum = 0; count = 0; clipped = 0; }
      }
      remainder = Buffer.from(chunk.subarray(limit));
    });
    child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || "Audio analysis failed."));
      if (count) bins.push({ rms: Math.sqrt(sum / count), clipping: clipped / count,
        endSeconds: bins.length * 0.5 + count / 8000 });
      resolve(bins);
    });
  });
}
