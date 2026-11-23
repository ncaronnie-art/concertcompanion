import { suggestedRange, type MediaAsset } from "./render-plan.js";

export type AudioBin = { rms: number; clipping: number; endSeconds?: number;
  tonalProminence?: number; crowdNoise?: number; beatTimes?: number[];
  tempoBpm?: number; beatConfidence?: number };
export type HighlightFocus = "balanced" | "performance";
export type Suggestion = { start: number; end: number; reason: string };

// Musical texture is evidence for a useful phrase, not singer identification.
// Older analyses keep their established energy ranking.
export function scoreAudioBins(bins: readonly AudioBin[], focus: HighlightFocus = "balanced") {
  const count = Math.max(1, bins.length);
  const energy = bins.reduce((sum, bin) => sum + bin.rms, 0) / count;
  const clipping = bins.reduce((sum, bin) => sum + bin.clipping, 0) / count;
  const measured = bins.filter(bin => Number.isFinite(bin.tonalProminence) && Number.isFinite(bin.crowdNoise));
  const performanceMeasured = measured.length >= count * 0.6;
  const unit = (v: number) => Math.max(0, Math.min(1, v));
  const tonalProminence = measured.reduce((sum, bin) => sum + unit(bin.tonalProminence!), 0) / Math.max(1, measured.length);
  const crowdNoise = measured.reduce((sum, bin) => sum + unit(bin.crowdNoise!), 0) / Math.max(1, measured.length);
  const score = focus === "performance" && performanceMeasured && energy >= 0.002 ?
    0.5 + 0.22 * energy / (energy + 0.03) + 0.5 * tonalProminence - 0.45 * crowdNoise - clipping * 0.8 : energy - clipping * 0.8;
  return { score, energy, clipping, tonalProminence, crowdNoise, performanceMeasured };
}

export function chooseAudioHighlight(asset: MediaAsset, bins: AudioBin[], binSeconds = 0.5,
  focus: HighlightFocus = "balanced"): Suggestion {
  const fallback = { ...suggestedRange(asset), reason: "No clear audio signal; using a middle section as a starting point." };
  if (!asset.hasAudio || !bins.length || bins.reduce((peak, bin) => Math.max(peak, bin.rms), 0) < 0.002) return fallback;
  const length = Math.min(12, asset.duration);
  const count = Math.max(1, Math.round(length / binSeconds));
  let bestScore = -Infinity, bestIndex = 0, usedPerformance = false;
  for (let index = 0; index <= Math.max(0, bins.length - count); index++) {
    const window = bins.slice(index, index + count);
    const result = scoreAudioBins(window, focus);
    if (result.score > bestScore) { bestScore = result.score; bestIndex = index; usedPerformance = result.performanceMeasured && focus === "performance"; }
  }
  const start = Math.max(0, Math.min(bestIndex * binSeconds, asset.duration - length));
  return { start, end: start + length, reason: usedPerformance ?
    "Favored a sustained musical phrase over noisy bursts. Listen to confirm the vocal moment; this does not identify the singer." :
    "Suggested for stronger sound energy and less distortion. Listen and adjust—it may include crowd noise." };
}
