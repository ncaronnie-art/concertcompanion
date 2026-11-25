import { renderDimensions, renderVideoWindows, renderVisibleRegion, type ExportOptions, type RenderSelection } from "../src/shared/render-plan.js";
import type { BodyMask } from "../src/shared/body-mask.js";
import { planBodyTraceActivity, type BodyTraceWindow } from "../src/shared/body-outline-timing.js";

export type BodyMaskWorker = (ffmpeg: string, asset: RenderSelection["asset"], options: {
  start: number; end: number; subject?: RenderSelection["subject"]; analysis?: RenderSelection["visualAnalysis"];
  tracking?: RenderSelection["tracking"]; signal?: AbortSignal;
  activeRanges?: BodyTraceWindow[];
  visibleRegion?: ReturnType<typeof renderVisibleRegion>;
  onProgress?: (value: { frames: number; fraction: number; sourceTime: number; phase: string }) => void;
}, directory: string) => Promise<BodyMask>;

/** File paths for learned mattes are owned by the backend, never by project or IPC data. */
export function withoutBodyMaskPaths(selections: RenderSelection[]): RenderSelection[] {
  return selections.map(selection => {
    const { bodyMask: _untrusted, ...safe } = selection;
    return safe;
  });
}

/** Fade each graphic within the frames that actually survived the mask guards.
 * Cached mattes stay unchanged; no model work or synthetic body frames are added. */
function reliableAccentMask(mask: BodyMask, planned: BodyTraceWindow[]): BodyMask {
  if (!mask.frameQuality) return mask;
  const runs: BodyTraceWindow[] = [];
  for (const frame of mask.frameQuality) {
    if (frame.status === "suppressed") continue;
    const previous = runs.at(-1);
    if (previous && Math.abs(frame.time - previous.end) < .5 / mask.fps) previous.end = Math.min(mask.end, frame.time + 1 / mask.fps);
    else runs.push({ start: frame.time, end: Math.min(mask.end, frame.time + 1 / mask.fps) });
  }
  const activeRanges = runs.flatMap(run => planned.map(range => ({ start: Math.max(range.start, run.start), end: Math.min(range.end, run.end) })))
    .filter(range => range.end - range.start >= .35 - 1e-6).slice(0, 16);
  return { ...mask, activeRanges };
}

export async function prepareRenderBodyMasks(ffmpeg: string, selections: RenderSelection[], options: ExportOptions,
  directory: string, job: { signal?: AbortSignal; onProgress?: (fraction: number, message: string) => void; worker?: BodyMaskWorker } = {}) {
  const safe = withoutBodyMaskPaths(selections);
  renderDimensions(options, "draft", safe.map(selection => selection.asset));
  if (!options.bodyOutline || options.bodyOutline === "off") return { selections: safe, note: undefined, usable: 0 };
  const windows = renderVideoWindows(safe, options);
  // Both looks are selective accents. Continuous tracing is not offered until
  // its long-motion quality and resource use have been validated.
  const activity = planBodyTraceActivity(safe, options);
  if (!activity.ranges.size) return { selections: safe, usable: 0,
    note: "No performer-neon accents are selected. Your video continues with clean footage." };
  const worker: BodyMaskWorker = job.worker ?? (await import("./body-segmentation.js")).prepareBodyMask;
  const result: RenderSelection[] = [];
  let usable = 0;
  for (let index = 0; index < windows.length; index++) {
    job.signal?.throwIfAborted();
    const selection = windows[index];
    const activeRanges = activity?.ranges.get(index);
    if (activity && !activeRanges?.length) { result.push(safe[index]); continue; }
    const message = `Tracing performer ${index + 1} of ${windows.length}: ${selection.asset.name}`;
    job.onProgress?.(index / windows.length, message);
    const generated = await worker(ffmpeg, selection.asset, {
      start: selection.start, end: selection.end, subject: selection.subject,
      analysis: selection.visualAnalysis, tracking: selection.tracking, signal: job.signal,
      activeRanges,
      visibleRegion: renderVisibleRegion(selection, options),
      onProgress: progress => job.onProgress?.((index + Math.max(0, Math.min(1, progress.fraction))) / windows.length, message),
    }, directory);
    job.signal?.throwIfAborted();
    const mask = reliableAccentMask(generated, activeRanges ?? []);
    // A one-frame accident must not be presented as a successful body trace.
    const visibleSeconds = mask.frameQuality ? (mask.activeRanges ?? []).reduce((total, range) => total + range.end - range.start, 0) : mask.frames * mask.coverage / mask.fps;
    const accepted = mask.coverage > 0 && visibleSeconds >= 0.35;
    if (accepted) usable++;
    result.push({ ...safe[index], ...(accepted ? { bodyMask: mask } : {}) });
  }
  if (!usable) throw Error("A clean performer silhouette could not be found in these sections. Choose a performer on a clearer shot, or switch Performer neon off.");
  job.onProgress?.(1, "Performer outlines prepared. Building your video…");
  const planned = activity?.ranges.size ?? windows.length;
  return { selections: result, usable,
    note: activity ? `${usable} of ${planned} planned outline shots are usable. ${options.bodyOutline === "subtle" ? "Soft" : "Electric"} uses short ${activity.timing === "music" ? "music-timed" : activity.timing === "mixed" ? "music-timed and editorial" : "editorially timed"} accents; other moments stay clean.` :
      usable < windows.length ? `Performer outlines are usable in ${usable} of ${windows.length} shots; uncertain moments stay clean.` : "Performer silhouettes are ready." };
}
