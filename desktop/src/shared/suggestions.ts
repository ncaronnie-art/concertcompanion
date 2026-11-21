import { suggestedRange, type MediaAsset } from "./render-plan.js";

export type AudioBin = { rms: number; clipping: number; endSeconds?: number };
export type Suggestion = { start: number; end: number; reason: string };

// Inspired by CompassCore's signal ranking: local audio energy and clipping are
// clues, not song recognition or proof that a moment is visually good.
export function chooseAudioHighlight(asset: MediaAsset, bins: AudioBin[], binSeconds = 0.5): Suggestion {
  const fallback = { ...suggestedRange(asset), reason: "No clear audio signal; using a middle section as a starting point." };
  if (!asset.hasAudio || !bins.length || bins.reduce((peak, bin) => Math.max(peak, bin.rms), 0) < 0.002) return fallback;
  const length = Math.min(12, asset.duration);
  const count = Math.max(1, Math.round(length / binSeconds));
  let bestScore = -Infinity, bestIndex = 0;
  for (let index = 0; index <= Math.max(0, bins.length - count); index++) {
    const window = bins.slice(index, index + count);
    const energy = window.reduce((sum, bin) => sum + bin.rms, 0) / window.length;
    const clipping = window.reduce((sum, bin) => sum + bin.clipping, 0) / window.length;
    const score = energy - clipping * 0.8;
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  }
  const start = Math.max(0, Math.min(bestIndex * binSeconds, asset.duration - length));
  return { start, end: start + length, reason: "Suggested for stronger sound energy and less distortion. Listen and adjust—it may include crowd noise." };
}
