import { planSourceCrossfades } from "./audio-crossfade.js";
import type { AudioSelection, RenderSelection } from "./render-plan.js";

// These are measured local rhythm cues, not song, phrase, or downbeat labels.
// Optional fields keep old RMS-only analyses usable without inventing a grid.
export type MusicTimingBin = {
  endSeconds?: number;
  beatTimes?: number[];
  tempoBpm?: number;
  beatConfidence?: number;
};
export type MusicTimingBins = Readonly<Record<string, readonly MusicTimingBin[] | undefined>>;
type Beat = { seconds: number; bpm: number; confidence: number };
type Sound = AudioSelection & { selectionSource?: "suggested" | "manual"; excludedByUser?: boolean };
type Picture = RenderSelection & { included: boolean; excludedByUser?: boolean };
export type SoundBeatDecision = {
  index: number;
  status: "aligned" | "already-aligned" | "protected" | "uncertain-beat" | "different-tempo" | "no-room";
  shiftSeconds: number;
  matchedBeats?: number;
  maxBeatErrorSeconds?: number;
};
export type PictureBeatDecision = {
  index: number;
  status: "aligned" | "already-aligned" | "protected" | "no-safe-beat";
  originalSeconds: number;
  cutSeconds: number;
  beatSeconds?: number;
};
const EPS = 0.000001;
const MIN_CONFIDENCE = 0.65;
const FRAME = 1 / 30;
const duration = (selection: { start: number; end: number }) => selection.end - selection.start;
const protectedRange = (selection: { locked?: boolean; selectionSource?: string; excludedByUser?: boolean }) =>
  selection.locked === true || selection.selectionSource === "manual" || selection.excludedByUser === true;
const selected = (clip: Picture) => clip.included && !clip.excludedByUser;

function validShift(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Choose a music timing adjustment from zero to one second.");
  return value;
}

function beats(bins: readonly MusicTimingBin[] | undefined, start = 0, end = Infinity): Beat[] {
  const found: Beat[] = [];
  for (const bin of bins ?? []) {
    const confidence = bin.beatConfidence, bpm = bin.tempoBpm;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || confidence > 1 ||
      typeof bpm !== "number" || !Number.isFinite(bpm) || bpm < 30 || bpm > 300) continue;
    for (const seconds of bin.beatTimes ?? []) {
      if (Number.isFinite(seconds) && seconds >= Math.max(0, start) - EPS && seconds <= end + EPS) found.push({ seconds, bpm, confidence });
    }
  }
  found.sort((a, b) => a.seconds - b.seconds || b.confidence - a.confidence);
  return found.filter((beat, index) => index === 0 || beat.seconds - found[index - 1].seconds > 0.015);
}

function localGrid(bins: readonly MusicTimingBin[] | undefined, around: number) {
  const nearby = beats(bins, around - 3, around + 3);
  if (nearby.length < 4) return undefined;
  const tempos = nearby.map(beat => beat.bpm).sort((a, b) => a - b);
  const bpm = tempos[Math.floor(tempos.length / 2)];
  const stable = nearby.filter(beat => Math.abs(beat.bpm - bpm) / bpm <= 0.035);
  return stable.length >= 4 && stable.length / nearby.length >= 0.8 ? { beats: stable, bpm } : undefined;
}

function noRepeatedRanges(selections: readonly { asset: { path: string }; start: number; end: number }[]): boolean {
  return selections.every((current, index) => selections.every((other, otherIndex) => index === otherIndex ||
    current.asset.path !== other.asset.path || current.end <= other.start + EPS || other.end <= current.start + EPS));
}

function audioEnd(selection: Sound, bins: readonly MusicTimingBin[] | undefined): number {
  const measured = selection.asset.audioDuration ?? bins?.at(-1)?.endSeconds ?? (bins?.length ? bins.length * 0.5 : selection.asset.duration);
  return Math.min(selection.asset.duration, measured);
}

function soundOverlap<T extends Sound>(selections: readonly T[], index: number, desired: number) {
  return planSourceCrossfades(selections.map(s => ({ ...s, locked: protectedRange(s) })),
    { desiredSeconds: desired }).boundaries[index];
}

function measuredSoundMatch<T extends Sound>(selections: readonly T[], index: number, binsByPath: MusicTimingBins, desired: number) {
  const outgoing = selections[index], incoming = selections[index + 1];
  const outGrid = localGrid(binsByPath[outgoing.asset.path], outgoing.end);
  const inGrid = localGrid(binsByPath[incoming.asset.path], incoming.start);
  if (!outGrid || !inGrid || Math.abs(outGrid.bpm - inGrid.bpm) / Math.max(outGrid.bpm, inGrid.bpm) > 0.035) return undefined;
  const overlap = soundOverlap(selections, index, desired);
  if (overlap.overlapSeconds < 0.25) return undefined;
  const outBeats = outGrid.beats.map(beat => overlap.originalBoundarySeconds + beat.seconds - outgoing.end)
    .filter(time => time >= overlap.overlapStartSeconds - EPS && time <= overlap.overlapEndSeconds + EPS);
  const inBeats = inGrid.beats.map(beat => overlap.originalBoundarySeconds + beat.seconds - incoming.start)
    .filter(time => time >= overlap.overlapStartSeconds - EPS && time <= overlap.overlapEndSeconds + EPS);
  if (outBeats.length < 2 || inBeats.length < 2) return undefined;
  const errors = outBeats.map(time => Math.min(...inBeats.map(other => Math.abs(time - other))));
  const reverseErrors = inBeats.map(time => Math.min(...outBeats.map(other => Math.abs(time - other))));
  const error = Math.max(...errors, ...reverseErrors);
  // Both directions prevent a half/double-time grid from being called a match.
  return error <= 0.06 ? { count: Math.min(outBeats.length, inBeats.length), error } : undefined;
}

/** Translate only automatic source ranges, never song speed or output duration.
 * A successful match requires two or more measured beat pairs inside the REAL
 * crossfade, with no more than 60ms drift across that overlap. */
export function alignSoundtrackBeats<T extends Sound>(selections: readonly T[], binsByPath: MusicTimingBins,
  options: { crossfadeSeconds?: number; maxShiftSeconds?: number } = {}) {
  const limit = validShift(options.maxShiftSeconds ?? 0.35);
  const overlapSeconds = options.crossfadeSeconds ?? 2;
  if (!Number.isFinite(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 5) throw new Error("Choose a sound overlap from zero to five seconds.");
  const audioSelections = selections.map(selection => ({ ...selection }));
  // Validate supplied ranges once, even if there is no confident rhythm.
  planSourceCrossfades(audioSelections.map(s => ({ ...s, locked: protectedRange(s) })), { desiredSeconds: 0 });
  const boundaries: SoundBeatDecision[] = [];
  for (let index = 0; index < audioSelections.length - 1; index++) {
    const outgoing = audioSelections[index], incoming = audioSelections[index + 1];
    const decision: SoundBeatDecision = { index, status: "no-room", shiftSeconds: 0 };
    if (protectedRange(outgoing) || protectedRange(incoming)) { decision.status = "protected"; boundaries.push(decision); continue; }
    const outGrid = localGrid(binsByPath[outgoing.asset.path], outgoing.end);
    const inGrid = localGrid(binsByPath[incoming.asset.path], incoming.start);
    if (!outGrid || !inGrid) { decision.status = "uncertain-beat"; boundaries.push(decision); continue; }
    if (Math.abs(outGrid.bpm - inGrid.bpm) / Math.max(outGrid.bpm, inGrid.bpm) > 0.035) {
      decision.status = "different-tempo"; boundaries.push(decision); continue;
    }
    const candidates = [0];
    for (const a of outGrid.beats) for (const b of inGrid.beats) {
      const shift = (b.seconds - incoming.start) - (a.seconds - outgoing.end);
      if (Math.abs(shift) <= limit + EPS) candidates.push(shift);
    }
    candidates.sort((a, b) => Math.abs(a) - Math.abs(b));
    let best: { shift: number; count: number; error: number } | undefined;
    for (const shift of candidates) {
      if (incoming.start + shift < -EPS || incoming.end + shift > audioEnd(incoming, binsByPath[incoming.asset.path]) + EPS) continue;
      const candidate = audioSelections.map((selection, position) => position === index + 1 ?
        { ...selection, start: Math.max(0, selection.start + shift), end: selection.end + shift } : selection);
      if (!noRepeatedRanges(candidate)) continue;
      const match = measuredSoundMatch(candidate, index, binsByPath, overlapSeconds);
      if (!match || boundaries.some(prior => ["aligned", "already-aligned"].includes(prior.status) &&
        !measuredSoundMatch(candidate, prior.index, binsByPath, overlapSeconds))) continue;
      if (!best || match.error < best.error - 0.005 ||
        (Math.abs(match.error - best.error) <= 0.005 && Math.abs(shift) < Math.abs(best.shift))) {
        best = { shift, ...match };
      }
    }
    if (best) {
      audioSelections[index + 1] = { ...incoming, start: Math.max(0, incoming.start + best.shift), end: incoming.end + best.shift };
      Object.assign(decision, { status: Math.abs(best.shift) > 0.005 ? "aligned" : "already-aligned",
        shiftSeconds: best.shift, matchedBeats: best.count, maxBeatErrorSeconds: best.error });
    }
    boundaries.push(decision);
  }
  const alignedCount = boundaries.filter(b => b.status === "aligned" || b.status === "already-aligned").length;
  const fallbackCount = boundaries.filter(b => !["aligned", "already-aligned", "protected"].includes(b.status)).length;
  const notes: string[] = [];
  if (alignedCount) notes.push(`Aligned the measured beats at ${alignedCount} song join${alignedCount === 1 ? "" : "s"}, without changing song speed.`);
  if (fallbackCount) notes.push(`Kept ${fallbackCount} song join${fallbackCount === 1 ? "" : "s"} as ordinary blends because the beats, tempo, or available source room did not support a reliable match.`);
  if (!alignedCount && !fallbackCount && boundaries.length) notes.push("Kept protected sound sections and their joins unchanged.");
  return { audioSelections, boundaries, alignedCount, notes };
}

function soundtrackBeats(sound: readonly Sound[], binsByPath: MusicTimingBins): number[] {
  let position = 0;
  const result: number[] = [];
  for (const selection of sound) {
    result.push(...beats(binsByPath[selection.asset.path], selection.start, selection.end)
      .map(beat => position + beat.seconds - selection.start));
    position += duration(selection);
  }
  return result.sort((a, b) => a - b).filter((time, index, all) => index === 0 || time - all[index - 1] > 0.015);
}

function pictureMidpoint<T extends Picture>(clips: readonly T[], index: number, crossfadeSeconds: number): number {
  const chosen = clips.filter(selected);
  const boundary = chosen.slice(0, index + 1).reduce((sum, clip) => sum + duration(clip), 0);
  if (!crossfadeSeconds) return boundary;
  const overlap = planSourceCrossfades(chosen.map(clip => ({ ...clip, locked: protectedRange(clip) })),
    { medium: "video", desiredSeconds: crossfadeSeconds }).boundaries[index];
  return overlap ? (overlap.overlapStartSeconds + overlap.overlapEndSeconds) / 2 : boundary;
}

/** Adjacent duration changes cancel exactly, preserving later/locked positions.
 * Dissolve/glide MIDPOINTS, rather than just nominal section ends, follow beats. */
export function alignPictureCutsToMusic<T extends Picture>(clips: readonly T[], sound: readonly Sound[],
  binsByPath: MusicTimingBins, options: { maxShiftSeconds?: number; pictureCrossfadeSeconds?: number } = {}) {
  const limit = validShift(options.maxShiftSeconds ?? 0.35);
  const crossfadeSeconds = options.pictureCrossfadeSeconds ?? 0;
  if (!Number.isFinite(crossfadeSeconds) || crossfadeSeconds < 0 || crossfadeSeconds > 1) throw new Error("Choose a picture blend from zero to one second.");
  let result = clips.map(clip => ({ ...clip })) as T[];
  const indices = result.flatMap((clip, index) => selected(clip) ? [index] : []);
  const outputBeats = soundtrackBeats(sound, binsByPath);
  const boundaries: PictureBeatDecision[] = [];
  const pictureSeconds = result.filter(selected).reduce((sum, clip) => sum + duration(clip), 0);
  const soundSeconds = sound.reduce((sum, selection) => sum + duration(selection), 0);
  if (Math.abs(pictureSeconds - soundSeconds) > 0.05) throw new Error("Picture and sound must have the same length before timing cuts to music.");
  planSourceCrossfades(result.filter(selected).map(clip => ({ ...clip, locked: protectedRange(clip) })), { medium: "video", desiredSeconds: 0 });
  for (let position = 0; position < indices.length - 1; position++) {
    const first = indices[position], second = indices[position + 1];
    const outgoing = result[first], incoming = result[second];
    const originalSeconds = pictureMidpoint(result, position, crossfadeSeconds);
    const decision: PictureBeatDecision = { index: first, status: "no-safe-beat", originalSeconds, cutSeconds: originalSeconds };
    if (protectedRange(outgoing) || protectedRange(incoming)) { decision.status = "protected"; boundaries.push(decision); continue; }
    const allowed = Math.min(limit, duration(outgoing) * 0.2, duration(incoming) * 0.2);
    const nearby = outputBeats.filter(beat => Math.abs(beat - originalSeconds) <= allowed + EPS)
      .sort((a, b) => Math.abs(a - originalSeconds) - Math.abs(b - originalSeconds));
    for (const beatSeconds of nearby) {
      let shift = beatSeconds - originalSeconds;
      let candidate: T[] | undefined;
      let midpoint = originalSeconds;
      for (let iteration = 0; iteration < 8; iteration++) {
        if (Math.abs(shift) > allowed + EPS || outgoing.end + shift > outgoing.asset.duration + EPS ||
          incoming.start + shift < -EPS || duration(outgoing) + shift < 0.1 - EPS || duration(incoming) - shift < 0.1 - EPS) break;
        const proposed = result.map((clip, index) => index === first ? { ...clip, end: clip.end + shift } :
          index === second ? { ...clip, start: Math.max(0, clip.start + shift) } : clip) as T[];
        if (!noRepeatedRanges(proposed.filter(selected))) break;
        midpoint = pictureMidpoint(proposed, position, crossfadeSeconds);
        candidate = proposed;
        if (Math.abs(midpoint - beatSeconds) <= FRAME / 2) break;
        shift += beatSeconds - midpoint;
      }
      if (candidate && Math.abs(midpoint - beatSeconds) <= FRAME &&
        boundaries.every((prior, priorPosition) => !["aligned", "already-aligned"].includes(prior.status) ||
          Math.abs(pictureMidpoint(candidate!, priorPosition, crossfadeSeconds) - prior.beatSeconds!) <= FRAME)) {
        result = candidate;
        Object.assign(decision, { status: Math.abs(midpoint - originalSeconds) > 0.005 ? "aligned" : "already-aligned", cutSeconds: midpoint, beatSeconds });
        break;
      }
    }
    boundaries.push(decision);
  }
  boundaries.forEach((boundary, position) => { boundary.cutSeconds = pictureMidpoint(result, position, crossfadeSeconds); });
  const alignedCount = boundaries.filter(b => b.status === "aligned" || b.status === "already-aligned").length;
  const consideredCount = boundaries.filter(b => b.status !== "protected").length;
  const notes: string[] = [];
  if (alignedCount) notes.push(`Timed ${alignedCount} automatic picture cut${alignedCount === 1 ? "" : "s"} to the measured music beat.`);
  if (consideredCount > alignedCount) notes.push(`Kept ${consideredCount - alignedCount} picture cut${consideredCount - alignedCount === 1 ? "" : "s"} unchanged where a reliable beat or safe trim was unavailable.`);
  if (boundaries.some(b => b.status === "protected")) notes.push("Kept your marked picture sections at their original source ranges and timeline positions.");
  return { clips: result, boundaries, alignedCount, consideredCount, notes };
}
