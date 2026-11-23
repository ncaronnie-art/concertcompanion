import { suggestedRange, type MediaAsset } from "./render-plan.js";
import { scanAudioInterruptions, type AudioInterruptionReport } from "./audio-interruptions.js";

export type AudioBin = { rms: number; clipping: number; endSeconds?: number;
  tonalProminence?: number; crowdNoise?: number; beatTimes?: number[];
  tempoBpm?: number; beatConfidence?: number;
  // Local event-model scores, not calibrated probabilities or singer identity.
  singingScore?: number; musicScore?: number; crowdScore?: number; speechScore?: number;
  eventStatus?: "classified" | "unavailable" | "unmeasured";
  eventCoverage?: number; eventFailure?: string };
export type HighlightFocus = "balanced" | "performance";
export type Suggestion = { start: number; end: number; reason: string };

// Texture cannot distinguish a singer from an instrument or a sustained crowd
// scream. Use it conservatively to penalize noisy passages, never as a large
// positive vocal score. Older analyses keep their established energy ranking.
export function scoreAudioBins(bins: readonly AudioBin[], focus: HighlightFocus = "balanced", interruptionReport?: AudioInterruptionReport) {
  const count = Math.max(1, bins.length);
  const energy = bins.reduce((sum, bin) => sum + bin.rms, 0) / count;
  const clipping = bins.reduce((sum, bin) => sum + bin.clipping, 0) / count;
  const measured = bins.filter(bin => Number.isFinite(bin.tonalProminence) && Number.isFinite(bin.crowdNoise));
  const performanceMeasured = measured.length >= count * 0.6;
  const unit = (v: number) => Math.max(0, Math.min(1, v));
  const tonalProminence = measured.reduce((sum, bin) => sum + unit(bin.tonalProminence!), 0) / Math.max(1, measured.length);
  const crowdNoise = measured.reduce((sum, bin) => sum + unit(bin.crowdNoise!), 0) / Math.max(1, measured.length);
  const audibleTexture = bins.reduce((sum, bin) => sum + bin.rms *
    (1 - unit(Number.isFinite(bin.crowdNoise) ? bin.crowdNoise! : crowdNoise)) ** 2, 0) / count;
  const coverage = (bin: AudioBin) => bin.eventCoverage === undefined ? 1 :
    Number.isFinite(bin.eventCoverage) && bin.eventCoverage >= 0 && bin.eventCoverage <= 1 ? bin.eventCoverage : 0;
  const hasEvents = (bin: AudioBin) => bin.eventStatus !== "unavailable" && bin.eventStatus !== "unmeasured" && coverage(bin) > 0 &&
    [bin.singingScore, bin.musicScore, bin.crowdScore, bin.speechScore]
      .every(value => Number.isFinite(value) && value! >= 0 && value! <= 1);
  const events = bins.filter(hasEvents);
  const eventWeightSum = events.reduce((sum, bin) => sum + coverage(bin), 0);
  const eventMeasured = eventWeightSum >= count * 0.6;
  const averageEvent = (key: "singingScore" | "musicScore" | "crowdScore" | "speechScore") =>
    events.reduce((sum, bin) => sum + bin[key]! * coverage(bin), 0) / Math.max(1e-9, eventWeightSum);
  const singingEvidence = averageEvent("singingScore"), musicEvidence = averageEvent("musicScore");
  const crowdEvidence = averageEvent("crowdScore"), speechEvidence = averageEvent("speechScore");
  // A model can emit near-zero scores for synthetic tones or unsupported sound.
  // That is no usable semantic evidence: retain the existing signal fallback.
  const eventUsed = focus === "performance" && eventMeasured && energy >= 0.002 &&
    Math.max(singingEvidence, musicEvidence, crowdEvidence, speechEvidence) >= 0.03;
  const eventWeight = (bin: AudioBin) => {
    const singing = bin.singingScore!, music = bin.musicScore!, crowd = bin.crowdScore!, speech = bin.speechScore!;
    const presence = (singing + music) / (singing + music + crowd + speech + 0.05);
    const vocalShare = singing / (singing + music * 0.25 + crowd + speech * 0.75 + 0.02);
    return presence * (0.04 + 0.96 * vocalShare);
  };
  const vocalActivity = events.reduce((sum, bin) => sum + eventWeight(bin) * coverage(bin), 0) / Math.max(1e-9, eventWeightSum);
  const eventSound = events.reduce((sum, bin) => sum + bin.rms * eventWeight(bin) * coverage(bin), 0) / Math.max(1e-9, eventWeightSum);
  const openingEvents = bins.slice(0, Math.min(8, bins.length)).filter(hasEvents);
  const openingCoverage = openingEvents.reduce((sum, bin) => sum + coverage(bin), 0);
  const openingSinging = openingEvents.reduce((sum, bin) => sum + bin.singingScore! * coverage(bin), 0) / Math.max(1e-9, openingCoverage);
  // Prefer a passage that is already singing when it begins. This changes only
  // ranking: never invent, repeat, time-stretch, or shorten a protected moment.
  const vocalLeadIn = eventUsed && openingCoverage >= Math.min(8, bins.length) * 0.6 && singingEvidence >= 0.03 ?
    Math.max(0, 1 - openingSinging / singingEvidence) : 0;
  const fallbackScore = focus === "performance" && performanceMeasured && energy >= 0.002 ?
    audibleTexture - clipping * 0.8 : energy - clipping * 0.8;
  // An unclassified opening or tail is uncertainty, not extra high-scoring
  // singing. Discount the ranking for incomplete coverage without inventing
  // zero-valued class observations for that missing audio.
  const baseScore = eventUsed ? eventSound * Math.min(1, eventWeightSum / count) * (1 - 0.65 * vocalLeadIn) - clipping * 0.8 : fallbackScore;
  // A brief shout can disappear in the mean of a long section. Check short
  // windows throughout it and penalize the strongest interruption, not just
  // the amount of crowd sound averaged across the whole selection.
  // Callers scoring a slice supply its original source-time report, so absolute
  // decoded-tail times cannot be mistaken for relative slice positions.
  const interruptions = focus === "performance" && bins.length ? interruptionReport ??
    scanAudioInterruptions(bins, { start: 0, end: bins.length * 0.5 }) : undefined;
  const interruptionRisk = interruptions?.risk ?? 0;
  const score = baseScore - (Math.max(0, baseScore) + energy * 0.25) * interruptionRisk * 0.9;
  const vocalSupport = eventUsed ? singingEvidence >= musicEvidence * 0.03 && singingEvidence >= crowdEvidence * 0.75 &&
    musicEvidence + singingEvidence > crowdEvidence + speechEvidence : undefined;
  return { score, energy, clipping, tonalProminence, crowdNoise, performanceMeasured,
    eventMeasured, eventUsed, vocalSupport, singingEvidence, musicEvidence, crowdEvidence, speechEvidence, vocalActivity,
    interruptionRisk, interruptionStatus: interruptions?.status ?? "unavailable" as const };
}

export function chooseAudioHighlight(asset: MediaAsset, bins: AudioBin[], binSeconds = 0.5,
  focus: HighlightFocus = "balanced"): Suggestion {
  const fallback = { ...suggestedRange(asset), reason: "No clear audio signal; using a middle section as a starting point." };
  if (!asset.hasAudio || !bins.length || bins.reduce((peak, bin) => Math.max(peak, bin.rms), 0) < 0.002) return fallback;
  const length = Math.min(12, asset.duration);
  const count = Math.max(1, Math.round(length / binSeconds));
  let bestScore = -Infinity, bestIndex = 0, usedPerformance = false, usedEvents = false, supportedVoice = false;
  for (let index = 0; index <= Math.max(0, bins.length - count); index++) {
    const window = bins.slice(index, index + count);
    const result = scoreAudioBins(window, focus, focus === "performance" ?
      scanAudioInterruptions(bins, { start: index * binSeconds, end: Math.min(asset.duration, index * binSeconds + length), binSeconds }) : undefined);
    const supported = result.vocalSupport === true && result.clipping < 0.02;
    if ((supported && !supportedVoice) || supported === supportedVoice && result.score > bestScore) {
      bestScore = result.score; bestIndex = index; usedPerformance = result.performanceMeasured && focus === "performance";
      usedEvents = result.eventUsed; supportedVoice = supported;
    }
  }
  const start = Math.max(0, Math.min(bestIndex * binSeconds, asset.duration - length));
  return { start, end: start + length, reason: usedEvents ?
    "Favored likely singing over crowd noise and instrumental lead-ins using local model estimates. Listen to confirm; this does not identify the singer." : usedPerformance ?
    "Favored audible sound with less noisy texture. Listen to confirm the vocal moment; this does not identify the singer." :
    "Suggested for stronger sound energy and less distortion. Listen and adjust—it may include crowd noise." };
}
