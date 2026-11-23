import type { AudioBin } from "./suggestions.js";

export type AudioInterruption = { start: number; end: number; kind: "crowd" | "speech"; severity: number };
export type AudioInterruptionReport = {
  status: "checked" | "partial" | "unavailable";
  intervals: AudioInterruption[];
  risk: number;
  analyzedFraction: number;
};

const unit = (value: number) => Math.max(0, Math.min(1, value));
const validScore = (value: number | undefined): value is number => Number.isFinite(value) && value! >= 0 && value! <= 1;

/** Look for short possible speech/crowd interruptions throughout a source range.
 * These are review cues, not person identification: a performer speaking can
 * trigger the same labels. Loudness without matching event evidence never does.
 * No source samples are changed and unmeasured portions never count as clear. */
export function scanAudioInterruptions(bins: readonly AudioBin[] | undefined,
  range: { start: number; end: number; binSeconds?: number }): AudioInterruptionReport {
  const { start, end, binSeconds = 0.5 } = range;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
      !Number.isFinite(binSeconds) || binSeconds <= 0) throw new Error("Choose a valid sound range to check.");
  if (!bins?.length) return { status: "unavailable", intervals: [], risk: 0, analyzedFraction: 0 };
  const first = Math.floor(start / binSeconds), last = Math.min(bins.length, Math.ceil(end / binSeconds));
  const rows = [] as Array<{ start: number; end: number; weight: number; rms: number;
    singing: number; music: number; crowd: number; speech: number }>;
  let covered = 0;
  for (let index = first; index < last; index++) {
    const bin = bins[index], from = Math.max(start, index * binSeconds);
    const decodedEnd = Number.isFinite(bin.endSeconds) ? Math.min((index + 1) * binSeconds, bin.endSeconds!) : (index + 1) * binSeconds;
    const to = Math.min(end, decodedEnd), seconds = Math.max(0, to - from);
    const coverage = bin.eventCoverage === undefined ? 1 : validScore(bin.eventCoverage) ? bin.eventCoverage : 0;
    const usable = bin.eventStatus !== "unavailable" && bin.eventStatus !== "unmeasured" &&
      [bin.singingScore, bin.musicScore, bin.crowdScore, bin.speechScore].every(validScore);
    const weight = usable ? seconds * coverage : 0;
    covered += weight;
    rows.push({ start: from, end: Math.max(from, to), weight,
      rms: Number.isFinite(bin.rms) ? Math.max(0, bin.rms) : 0,
      singing: usable ? bin.singingScore! : 0, music: usable ? bin.musicScore! : 0,
      crowd: usable ? bin.crowdScore! : 0, speech: usable ? bin.speechScore! : 0 });
  }
  const analyzedFraction = unit(covered / (end - start));
  const status = analyzedFraction >= 1 - 1e-6 ? "checked" : analyzedFraction > 0 ? "partial" : "unavailable";
  const found: AudioInterruption[] = [];
  const widths = [...new Set([1, Math.max(1, Math.ceil(1 / binSeconds)), Math.max(1, Math.ceil(2 / binSeconds))])];
  const context = Math.max(1, Math.ceil(4 / binSeconds));
  for (let index = 0; index < rows.length; index++) for (const width of widths) {
    const stop = Math.min(rows.length, index + width), from = rows[index].start, to = rows[stop - 1].end;
    if (to - from < Math.min(0.25, binSeconds) - 1e-6) continue;
    let weight = 0, rms = 0, singing = 0, music = 0, crowd = 0, speech = 0;
    for (let at = index; at < stop; at++) {
      const row = rows[at]; weight += row.weight; rms += row.rms * row.weight;
      singing += row.singing * row.weight; music += row.music * row.weight;
      crowd += row.crowd * row.weight; speech += row.speech * row.weight;
    }
    if (weight < (to - from) * 0.75) continue;
    rms /= weight; singing /= weight; music /= weight; crowd /= weight; speech /= weight;
    if (rms < 0.002) continue;
    let contextRms = 0, contextCount = 0;
    for (let at = Math.max(0, index - context); at < Math.min(rows.length, stop + context); at++) {
      if (at >= index && at < stop) continue;
      contextRms += rows[at].rms; contextCount++;
    }
    const relativeLevel = contextCount > 0 ? rms / Math.max(0.002, contextRms / contextCount) : 1;
    const louder = relativeLevel >= 1.4;
    const speechRisk = speech >= 0.12 && speech >= singing * 1.1 && speech >= music * 0.4;
    const crowdThreshold = louder ? 0.15 : 0.25;
    // A score can rise because the music gets quieter. Crowd atmosphere at
    // the same/lower level is not by itself a loud crowd interruption.
    const crowdRisk = relativeLevel >= 1.1 && crowd >= crowdThreshold && crowd >= singing * 1.1 && crowd >= music * 0.35;
    if (!speechRisk && !crowdRisk) continue;
    const kind = speechRisk && (!crowdRisk || speech / 0.12 >= crowd / crowdThreshold) ? "speech" : "crowd";
    const evidence = kind === "speech" ? speech : crowd, threshold = kind === "speech" ? 0.12 : crowdThreshold;
    found.push({ start: from, end: to, kind, severity: unit(0.4 + 0.6 * (evidence - threshold) / (1 - threshold)) });
  }
  // Overlapping half-, one- and two-second windows describe one review moment.
  const intervals: AudioInterruption[] = [];
  for (const item of found.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = intervals.at(-1);
    if (previous && item.start <= previous.end + 0.001) {
      previous.end = Math.max(previous.end, item.end);
      if (item.severity > previous.severity) { previous.kind = item.kind; previous.severity = item.severity; }
    } else intervals.push({ ...item });
  }
  const flaggedSeconds = intervals.reduce((seconds, item) => seconds + item.end - item.start, 0);
  const risk = intervals.length ? unit(Math.max(...intervals.map(item => item.severity)) + 0.1 * flaggedSeconds / (end - start)) : 0;
  return { status, intervals, risk, analyzedFraction };
}
