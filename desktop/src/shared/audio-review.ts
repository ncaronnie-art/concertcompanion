import { planSourceCrossfades } from "./audio-crossfade.js";
import { scanAudioInterruptions, type AudioInterruptionReport } from "./audio-interruptions.js";
import type { AudioSelection, ExportOptions, RenderSelection } from "./render-plan.js";
import type { AudioBin } from "./suggestions.js";

export type SoundReviewItem = { selection: AudioSelection; report: AudioInterruptionReport; index: number };
export type SoundReview = { signature: string; items: SoundReviewItem[] };

export function soundReviewSignature(picture: readonly RenderSelection[], soundtrack: readonly AudioSelection[] | null,
  options: ExportOptions): string {
  // Picture color/framing edits do not change the sound being reviewed. Source
  // order, timing, handles, locks, and audio processing do invalidate approval.
  const sound = soundtrack ?? picture;
  return JSON.stringify({ separateSound: soundtrack !== null, reduceRumble: options.reduceRumble,
    audioEdgeFades: options.transition === "fade",
    audioTransition: options.audioTransition ?? "cut", overlap: options.audioCrossfadeSeconds ?? 2,
    ranges: sound.map(selection => ({ path: selection.asset.path, duration: selection.asset.duration,
      audioDuration: selection.asset.audioDuration, hasAudio: selection.asset.hasAudio,
      start: selection.start, end: selection.end,
      locked: selection.locked || (soundtrack === null && "selectionSource" in selection && selection.selectionSource === "manual") })) });
}

export function audibleReviewRanges(picture: readonly RenderSelection[], soundtrack: readonly AudioSelection[] | null,
  options: ExportOptions): AudioSelection[] {
  const sound = (soundtrack ?? picture).map(selection => ({ asset: selection.asset, start: selection.start, end: selection.end,
    locked: selection.locked || (soundtrack === null && "selectionSource" in selection && selection.selectionSource === "manual") }));
  const blend = options.audioTransition === "crossfade" && sound.length > 1 && sound.every(selection => selection.asset.hasAudio);
  // These are the same borrowed source handles used by the export engine, so an
  // interruption just outside the marked core is still checked when audible.
  return blend ? planSourceCrossfades(sound, { desiredSeconds: options.audioCrossfadeSeconds ?? 2 }).extendedSelections : sound;
}

export function buildSoundReview(picture: readonly RenderSelection[], soundtrack: readonly AudioSelection[] | null,
  options: ExportOptions, binsByPath: Readonly<Record<string, readonly AudioBin[] | undefined>>): SoundReview {
  return { signature: soundReviewSignature(picture, soundtrack, options),
    items: audibleReviewRanges(picture, soundtrack, options).flatMap((selection, index) => selection.asset.hasAudio ?
      [{ selection, index, report: scanAudioInterruptions(binsByPath[selection.asset.path], selection) }] : []) };
}

export function soundReviewNeedsDecision(review: SoundReview): boolean {
  // A short model tail is disclosed, not a mandatory extra click for every
  // recording. Findings or a largely unchecked soundtrack need a decision.
  return review.items.some(item => item.report.intervals.length > 0 ||
    item.report.status === "unavailable" || item.report.analyzedFraction < 0.8 ||
    (item.selection.end - item.selection.start) * (1 - item.report.analyzedFraction) > 1);
}
