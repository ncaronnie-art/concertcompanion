import type { AudioSelection, ExportOptions } from "./render-plan.js";
import { scoreAudioBins, type AudioBin, type HighlightFocus } from "./suggestions.js";
import { alignSoundtrackBeats, alignPictureCutsToMusic } from "./music-timing.js";
import type { CreativeBrief, CreativeClip } from "./creative-brief.js";

export type AudioStoryResult<T extends CreativeClip> = {
  clips: T[];
  audioSelections: AudioSelection[];
  options: ExportOptions;
  plannedSeconds: number;
  notes: string[];
};

type Span = { asset: AudioSelection["asset"]; start: number; end: number };
type ScoredSelection = { selection: AudioSelection; span: Span; score: number; energy: number; clipping: number; tailRise: number; measured: boolean; performance: number; performanceMeasured: boolean; eventUsed: boolean; vocalSupport?: boolean; openingVocalSupport?: boolean; endingVocalSupport?: boolean; crowdNoise: number; tempoBpm?: number };
type Gap = { kind: "gap"; duration: number; count: number; selections: ScoredSelection[] };
type Anchor = { kind: "anchor"; selection: AudioSelection };
const MIN = 0.1;
const EPS = 0.05;
const BIN_SECONDS = 0.5;
const length = (selection: { start: number; end: number }) => selection.end - selection.start;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const included = (clip: CreativeClip) => clip.included && !clip.excludedByUser;
const protectedClip = (clip: CreativeClip) => included(clip) && (clip.locked || clip.selectionSource === "manual");
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end - 0.001 && b.start < a.end - 0.001;

function availableAudioEnd(asset: AudioSelection["asset"], bins: AudioBin[] | undefined): number {
  if (!bins?.length) return 0;
  const decodedEnd = bins.at(-1)?.endSeconds;
  // Older or hand-built bins represent complete half-second windows.
  return Math.min(asset.duration, decodedEnd === undefined ? bins.length * BIN_SECONDS : decodedEnd);
}

function centeredRange(clip: CreativeClip, seconds: number) {
  const center = (clip.start + clip.end) / 2;
  const start = Math.max(0, Math.min(clip.asset.duration - seconds, center - seconds / 2));
  return { start, end: start + seconds };
}

function picturePace(vibe: CreativeBrief["vibe"]): number {
  return ({ energetic: 8, cinematic: 30, nostalgic: 24, intimate: 35, "clean-live": 45, custom: 16 })[vibe];
}

function allocate(total: number, capacities: number[]): number[] {
  if (capacities.length === 0) return total <= EPS ? [] : (() => { throw new Error("Add more footage to fill the requested length."); })();
  if (total + EPS < capacities.length * MIN || sum(capacities) + EPS < total) {
    throw new Error("There is not enough nonrepeating footage for this length and number of sections.");
  }
  const result = capacities.map(() => MIN);
  let remaining = total - capacities.length * MIN;
  let active = capacities.map((_, index) => index);
  while (remaining > 0.0001 && active.length) {
    const share = remaining / active.length;
    let added = 0;
    const next: number[] = [];
    for (const index of active) {
      const room = Math.max(0, capacities[index] - result[index]);
      const portion = Math.min(share, room);
      result[index] += portion;
      added += portion;
      if (room - portion > 0.0001) next.push(index);
    }
    remaining -= added;
    if (added < 0.0001) break;
    active = next;
  }
  if (remaining > EPS) throw new Error("The selected recordings cannot fill this length without repeating footage.");
  return result;
}

function planPicture<T extends CreativeClip>(clips: T[], brief: CreativeBrief): { clips: T[]; seconds: number } {
  const intent = brief.soundtrackIntent!;
  const eligible = clips.flatMap((clip, index) => !clip.excludedByUser ? [index] : []);
  const marked = eligible.filter((index) => protectedClip(clips[index]));
  const protectedSeconds = sum(marked.map((index) => length(clips[index])));
  const natural = sum(clips.filter(included).map(length));
  const target = brief.targetSeconds ?? natural;
  if (target + EPS < protectedSeconds) throw new Error("Your marked picture and original sound are longer than the requested video. Extend the length or adjust those sections.");
  if (brief.selectionMode === "use-my-sections" && target > protectedSeconds + EPS) {
    throw new Error("Your marked sections do not fill this length. Add more marked footage or choose a shorter length.");
  }
  const remaining = Math.max(0, target - protectedSeconds);
  const markedSet = new Set(marked);
  const candidates = eligible.filter((index) => !markedSet.has(index));
  candidates.sort((a, b) => Number(clips[b].included) - Number(clips[a].included) ||
    (brief.vibe === "energetic" ? a - b : clips[b].asset.duration - clips[a].asset.duration || a - b));
  const requestedSources = intent.separatePicture ? brief.pictureSourceCount : null;
  const needed = requestedSources === null ? 0 : requestedSources - marked.length;
  if (needed < 0 || needed > candidates.length) {
    throw new Error("The picture recording count conflicts with protected sections or available videos. Review the count.");
  }
  if (remaining < needed * MIN - EPS) throw new Error("There is not enough time for the requested picture recordings while keeping your marked sections.");
  const desired = requestedSources === null ? remaining < MIN ? 0 : Math.min(candidates.length,
    Math.floor((remaining + 0.0001) / MIN), Math.ceil(remaining / picturePace(brief.vibe))) : needed;
  const picked = candidates.slice(0, desired);
  if (requestedSources === null) {
    while (sum(picked.map((index) => clips[index].asset.duration)) + EPS < remaining && picked.length < candidates.length) {
      picked.push(candidates[picked.length]);
    }
  } else {
    // Keep already included suggestions when possible, but replace a short one
    // if another imported recording is needed to fill the chosen duration.
    while (sum(picked.map((index) => clips[index].asset.duration)) + EPS < remaining) {
      const replacement = candidates.filter((index) => !picked.includes(index))
        .sort((a, b) => clips[b].asset.duration - clips[a].asset.duration)[0];
      const shortest = [...picked].sort((a, b) => clips[a].asset.duration - clips[b].asset.duration)[0];
      if (replacement === undefined || shortest === undefined ||
        clips[replacement].asset.duration <= clips[shortest].asset.duration) break;
      picked[picked.indexOf(shortest)] = replacement;
    }
    if (picked.length !== needed || sum(picked.map((index) => clips[index].asset.duration)) + EPS < remaining) {
      throw new Error("The requested number of picture recordings cannot fill this length without repeats. Choose more recordings or a shorter video.");
    }
  }
  const amounts = allocate(remaining, picked.map((index) => clips[index].asset.duration));
  const allocations = new Map(picked.map((index, position) => [index, amounts[position]]));
  const next = clips.map((clip, index) => {
    if (clip.excludedByUser) return { ...clip, included: false };
    if (markedSet.has(index)) return { ...clip };
    const amount = allocations.get(index);
    if (amount === undefined) return { ...clip, included: false };
    return { ...clip, ...centeredRange(clip, amount), included: true, locked: false, selectionSource: "suggested" as const };
  });
  const actual = sum(next.filter(included).map(length));
  if (Math.abs(actual - target) > EPS) throw new Error("The picture sections do not match the requested length.");
  if (requestedSources !== null && new Set(next.filter(included).map((clip) => clip.asset.path)).size !== requestedSources) {
    throw new Error("The picture edit does not match the requested recording count. Review the plan.");
  }
  return { clips: next as T[], seconds: actual };
}

function measuredTempo(bins: AudioBin[]): number | undefined {
  const supported = bins.filter(bin => (bin.beatConfidence ?? 0) >= 0.65 &&
    Number.isFinite(bin.tempoBpm) && bin.tempoBpm! >= 45 && bin.tempoBpm! <= 220);
  const beats = supported.reduce((n, bin) => n + (bin.beatTimes?.length ?? 0), 0);
  if (supported.length < bins.length * 0.5 || beats < 6) return undefined;
  const tempos = supported.map(bin => bin.tempoBpm!).sort((a, b) => a - b);
  const median = tempos[Math.floor(tempos.length / 2)];
  // Half/double-time ambiguity is not evidence for a smooth tempo progression.
  if (tempos.filter(tempo => Math.abs(tempo / median - 1) <= 0.08).length < tempos.length * 0.8) return undefined;
  return median;
}

function progressesInTempo(tempos: number[]): boolean {
  if (tempos.length < 2 || !tempos.every((tempo, index) => index === 0 || tempo >= tempos[index - 1] * 1.05)) return false;
  if (tempos.length === 3) {
    const middle = (tempos[1] - tempos[0]) / (tempos[2] - tempos[0]);
    // A middle act should not hug the opening or finale. This is a relative
    // pacing preference, not a genre label or a claim about perceived song tempo.
    return middle >= 0.25 && middle <= 0.75;
  }
  return true;
}

function scoreWindow(bins: AudioBin[] | undefined, start: number, seconds: number, focus: HighlightFocus = "balanced") {
  if (!bins?.length) return { score: 0, energy: 0, clipping: 0, tailRise: 0, measured: false, performance: 0, performanceMeasured: false, eventUsed: false, vocalSupport: undefined as boolean | undefined,
    openingVocalSupport: undefined as boolean | undefined, endingVocalSupport: undefined as boolean | undefined,
    crowdNoise: 0, tempoBpm: undefined as number | undefined };
  const first = Math.min(bins.length - 1, Math.max(0, Math.floor(start / BIN_SECONDS)));
  const last = Math.min(bins.length, Math.max(first + 1, Math.ceil((start + seconds) / BIN_SECONDS)));
  let rms = 0, clipping = 0;
  for (let index = first; index < last; index++) { rms += bins[index].rms; clipping += bins[index].clipping; }
  const count = Math.max(1, last - first);
  const energy = rms / count;
  const clippingFraction = clipping / count;
  const third = Math.max(1, Math.floor(count / 3));
  const head = sum(bins.slice(first, first + third).map((bin) => bin.rms)) / third;
  const tail = sum(bins.slice(last - third, last).map((bin) => bin.rms)) / third;
  // Penalize clipped sound when choosing a window; order the chosen moments by
  // actual measured energy, not by this quality score.
  const window = bins.slice(first, last);
  const features = scoreAudioBins(window, focus);
  const openingFeatures = scoreAudioBins(bins.slice(first,
    Math.min(last, Math.ceil((start + Math.min(4, seconds)) / BIN_SECONDS))), focus);
  const endingFeatures = scoreAudioBins(bins.slice(Math.max(first,
    Math.floor((start + seconds - Math.min(4, seconds)) / BIN_SECONDS)), last), focus);
  const openingCount = Math.min(count, 8);
  const opening = sum(window.slice(0, openingCount).map(bin => bin.rms)) / openingCount;
  // A loud later section must not conceal several quiet lead-in seconds. This
  // finds low-activity gaps, not the semantic point where a singer begins.
  const leadInPenalty = focus === "performance" ? energy * 0.4 * Math.max(0, 1 - opening / Math.max(energy, 0.002)) : 0;
  return { score: features.score - leadInPenalty, energy, clipping: clippingFraction, tailRise: tail - head, measured: true,
    performance: -features.crowdNoise, performanceMeasured: features.performanceMeasured, eventUsed: features.eventUsed,
    vocalSupport: features.vocalSupport,
    openingVocalSupport: openingFeatures.vocalSupport === undefined ? undefined :
      openingFeatures.vocalSupport && openingFeatures.singingEvidence >= openingFeatures.crowdEvidence,
    endingVocalSupport: endingFeatures.vocalSupport,
    crowdNoise: features.crowdNoise, tempoBpm: measuredTempo(window) };
}

function freeSpans(assets: AudioSelection["asset"][], reserved: AudioSelection[],
  binsByPath: Readonly<Record<string, AudioBin[]>>): Span[] {
  const spans: Span[] = [];
  for (const asset of assets) {
    // Video/container duration may extend beyond the actual audio stream.
    const audioEnd = availableAudioEnd(asset, binsByPath[asset.path]);
    if (audioEnd < MIN) continue;
    const occupied = reserved.filter((selection) => selection.asset.path === asset.path)
      .map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start);
    let position = 0;
    for (const taken of occupied) {
      if (taken.start - position >= MIN - 0.0001) spans.push({ asset, start: position, end: taken.start });
      position = Math.max(position, taken.end);
    }
    if (audioEnd - position >= MIN - 0.0001) spans.push({ asset, start: position, end: audioEnd });
  }
  return spans;
}

function chooseTickets(spans: Span[], count: number, seconds: number,
  binsByPath: Readonly<Record<string, AudioBin[]>>,
  preference: { buildEnding: boolean; variedLabels: boolean; highlightFocus?: HighlightFocus;
    labelsByPath: Readonly<Record<string, string>>; usedLabels: ReadonlySet<string> }): Span[] {
  if (count < 1) return [];
  const sampleLength = seconds / count;
  const samples = new Map(spans.map((span) => [span,
    bestWithin(span, Math.min(length(span), sampleLength), binsByPath[span.asset.path], false, preference.highlightFocus)]));
  const canFill = (candidates: Span[]) => candidates.length >= count &&
    sum([...candidates].sort((a, b) => length(b) - length(a)).slice(0, count).map(length)) + EPS >= seconds;
  const canFillWithSplits = (candidates: Span[]) => candidates.length > 0 &&
    sum(candidates.map(span => Math.floor((length(span) + 0.000001) / MIN))) >= count &&
    sum([...candidates].sort((a, b) => length(b) - length(a)).slice(0, count).map(length)) + EPS >= seconds;
  // Length alone must not let a silent recording displace audible performance.
  // Use the highlight suggestion's conservative signal floor, then retain the
  // full pool when this preference would prevent the requested count or length.
  // Marked sound is already reserved separately and never enters this ranking.
  const audible = spans.filter((span) => samples.get(span)!.energy >= 0.002);
  const withSignal = canFill(audible) ? audible : spans;
  const clean = withSignal.filter((span) => samples.get(span)!.clipping < 0.02);
  const qualityPool = canFill(clean) ? clean : withSignal;
  const classified = qualityPool.filter(span => samples.get(span)!.vocalSupport === true);
  const pool = canFillWithSplits(classified) ? classified : qualityPool;
  const labelOf = (span: Span) => preference.labelsByPath[span.asset.path] ?? "";
  const choose = (distinctSources: boolean, wanted: number): Span[] | null => {
    const chosen: Span[] = [];
    const usedLabels = new Set(preference.usedLabels);
    let capacity = 0;
    while (chosen.length < wanted) {
      const usedPaths = new Set(chosen.map((span) => span.asset.path));
      const candidates = pool.filter((span) => !chosen.includes(span) &&
        (!distinctSources || !usedPaths.has(span.asset.path)));
      candidates.sort((a, b) => {
        const firstEndingChoice = preference.buildEnding && chosen.length === 0;
        const aNovel = Number(preference.variedLabels && !!labelOf(a) && !usedLabels.has(labelOf(a)));
        const bNovel = Number(preference.variedLabels && !!labelOf(b) && !usedLabels.has(labelOf(b)));
        if (!firstEndingChoice && aNovel !== bNovel) return bNovel - aNovel;
        const aSound = samples.get(a)!, bSound = samples.get(b)!;
        if ((aSound.vocalSupport === true) !== (bSound.vocalSupport === true)) return aSound.vocalSupport === true ? -1 : 1;
        if (preference.highlightFocus === "performance" && !aSound.eventUsed && !bSound.eventUsed && aSound.performanceMeasured && bSound.performanceMeasured &&
          Math.abs(aSound.crowdNoise - bSound.crowdNoise) > 0.35) return aSound.crowdNoise - bSound.crowdNoise;
        if (preference.buildEnding && chosen.length > 0 && wanted > 1) {
          // A crescendo needs audible contrast, not merely the three loudest
          // windows in ascending order. Keep the strongest clean source for
          // the end and seek measured, still audible levels before it.
          const peak = samples.get(chosen[0])!.energy;
          const target = peak * (0.65 + 0.35 * (wanted - chosen.length - 1) / (wanted - 1));
          const floor = peak * 0.55;
          const aEnergy = samples.get(a)!.energy, bEnergy = samples.get(b)!.energy;
          if ((aEnergy >= floor) !== (bEnergy >= floor)) return aEnergy >= floor ? -1 : 1;
          const contrast = Math.abs(aEnergy - target) - Math.abs(bEnergy - target);
          if (Math.abs(contrast) > 0.000001) return contrast;
        }
        const score = samples.get(b)!.score - samples.get(a)!.score;
        if (Math.abs(score) > 0.000001) return score;
        if (aNovel !== bNovel) return bNovel - aNovel;
        return length(b) - length(a);
      });
      const candidate = candidates.find((span) => {
        const remainingSlots = wanted - chosen.length - 1;
        const rest = candidates.filter((other) => other !== span &&
          (!distinctSources || other.asset.path !== span.asset.path));
        const capacities = distinctSources ? (() => {
          const longestBySource = new Map<string, number>();
          for (const other of rest) longestBySource.set(other.asset.path,
            Math.max(longestBySource.get(other.asset.path) ?? 0, length(other)));
          return [...longestBySource.values()];
        })() : rest.map(length);
        capacities.sort((a, b) => b - a);
        return capacities.length >= remainingSlots &&
          capacity + length(span) + sum(capacities.slice(0, remainingSlots)) + EPS >= seconds;
      });
      if (!candidate) return null;
      chosen.push(candidate); capacity += length(candidate);
      const label = labelOf(candidate); if (label) usedLabels.add(label);
    }
    return chosen;
  };
  const distinctCount = new Set(pool.map((span) => span.asset.path)).size;
  let chosen = distinctCount >= count ? choose(true, count) : null;
  chosen ??= choose(false, Math.min(count, pool.length));
  if (!chosen) throw new Error(`There is not enough nonrepeating sound for ${count} separate moments at this length. Add recordings or shorten the video.`);
  while (chosen.length < count && chosen.length) {
    const largest = chosen.reduce((best, span, index) => length(span) > length(chosen[best]) ? index : best, 0);
    const span = chosen[largest], middle = (span.start + span.end) / 2;
    if (middle - span.start < MIN - 0.0001) break;
    chosen.splice(largest, 1, { asset: span.asset, start: span.start, end: middle },
      { asset: span.asset, start: middle, end: span.end });
  }
  if (chosen.length !== count || sum(chosen.map(length)) + EPS < seconds) {
    throw new Error(`There is not enough nonrepeating sound for ${count} separate moments at this length. Add recordings or shorten the video.`);
  }
  return chosen;
}

function bestWithin(span: Span, seconds: number, bins: AudioBin[] | undefined, preferRisingTail = false, focus: HighlightFocus = "balanced"): ScoredSelection {
  const lastStart = span.end - seconds;
  if (lastStart < span.start - EPS) throw new Error("A sound section cannot fit within the available recording.");
  const steps = Math.min(2000, Math.max(1, Math.ceil((lastStart - span.start) / BIN_SECONDS)));
  let bestStart = span.start, best = scoreWindow(bins, span.start, seconds, focus);
  for (let index = 1; index <= steps; index++) {
    const start = span.start + (lastStart - span.start) * index / steps;
    const score = scoreWindow(bins, start, seconds, focus);
    const rank = score.score + (preferRisingTail ? Math.max(0, score.tailRise) * 0.2 : 0);
    const bestRank = best.score + (preferRisingTail ? Math.max(0, best.tailRise) * 0.2 : 0);
    const supported = score.vocalSupport === true && score.clipping < 0.02;
    const bestSupported = best.vocalSupport === true && best.clipping < 0.02;
    if ((supported && !bestSupported) || supported === bestSupported && rank > bestRank + 0.000001) { bestStart = start; best = score; }
  }
  return { selection: { asset: span.asset, start: bestStart, end: bestStart + seconds },
    span, score: best.score, energy: best.energy, clipping: best.clipping,
    tailRise: best.tailRise, measured: best.measured, performance: best.performance, performanceMeasured: best.performanceMeasured, eventUsed: best.eventUsed, vocalSupport: best.vocalSupport,
    openingVocalSupport: best.openingVocalSupport, endingVocalSupport: best.endingVocalSupport,
    crowdNoise: best.crowdNoise, tempoBpm: best.tempoBpm };
}

function chooseTempoArc(spans: Span[], count: number, seconds: number,
  binsByPath: Readonly<Record<string, AudioBin[]>>, focus: HighlightFocus,
  labels: { varied: boolean; byPath: Readonly<Record<string, string>>; used: ReadonlySet<string> }): ScoredSelection[] {
  const amount = seconds / count;
  let candidates: ScoredSelection[] = [];
  const seen = new Set<string>();
  const remember = (candidate: ScoredSelection) => {
    const key = `${candidate.selection.asset.path}|${candidate.selection.start.toFixed(4)}`;
    if (!seen.has(key)) { candidates.push(candidate); seen.add(key); }
  };
  const add = (span: Span) => {
    if (length(span) + 0.000001 < amount) return;
    const candidate = bestWithin(span, amount, binsByPath[span.asset.path], false, focus);
    remember(candidate);
  };
  for (const span of spans) {
    if (length(span) + 0.000001 < amount) continue;
    add(span);
    // The highest-scoring window may straddle two tempo estimates. Keep a good
    // stable window from each measured pulse band as a real creative alternative.
    const byTempo = new Map<string, ScoredSelection>();
    const lastStart = span.end - amount;
    const steps = Math.min(2000, Math.max(1, Math.ceil((lastStart - span.start) / BIN_SECONDS)));
    for (let index = 0; index <= steps; index++) {
      const start = span.start + (lastStart - span.start) * index / steps;
      const score = scoreWindow(binsByPath[span.asset.path], start, amount, focus);
      const band = `${score.tempoBpm === undefined ? "unknown" : Math.round(Math.log(score.tempoBpm) / Math.log(1.1))}|${score.openingVocalSupport}|${score.endingVocalSupport}`;
      if (!byTempo.has(band) || score.score > byTempo.get(band)!.score) byTempo.set(band,
        { selection: { asset: span.asset, start, end: start + amount }, span, ...score });
    }
    byTempo.forEach(remember);
    // Include fixed edge choices and a disjoint partition, so one long source
    // can fill multiple equal moments without repeating or stretching audio.
    add({ ...span, end: span.start + amount });
    add({ ...span, start: span.end - amount });
    const pieces = Math.min(count, Math.floor((length(span) + 0.000001) / amount));
    for (let index = 0; index < pieces; index++) add({ asset: span.asset,
      start: span.start + length(span) * index / pieces,
      end: span.start + length(span) * (index + 1) / pieces });
  }
  const capacity = (pool: ScoredSelection[]) => {
    const endBySource = new Map<string, number>();
    let amount = 0;
    for (const candidate of [...pool].sort((a, b) => a.selection.end - b.selection.end)) {
      const selection = candidate.selection;
      if (selection.start < (endBySource.get(selection.asset.path) ?? -Infinity) - 0.000001) continue;
      endBySource.set(selection.asset.path, selection.end);
      amount++;
    }
    return amount;
  };
  // Source variety cannot override an available audible, clean, supported
  // alternative. Keep the full pool only when needed to fill the user's length.
  for (const keep of [(c: ScoredSelection) => c.energy >= 0.002,
    (c: ScoredSelection) => c.clipping < 0.02,
    (c: ScoredSelection) => c.vocalSupport === true]) {
    const preferred = candidates.filter(keep);
    if (capacity(preferred) >= count) candidates = preferred;
  }
  // Unknown event evidence is not evidence of singing. If actual supported
  // vocals cannot fill the length, keep measured instrumental music competing
  // with unclassified sources rather than removing it in favor of unknown noise.
  candidates.sort((a, b) => b.score - a.score);
  // Keep planning bounded even for a large library. A candidate is a source
  // range, not decoded media, and the beam never retains more than 128 plans.
  candidates.splice(Math.max(512, count * 4));
  const strongest = Math.max(0.002, ...candidates.map(c => c.score));
  const classifiedStrength = Math.max(0, ...candidates.filter(c => c.vocalSupport === true).map(c => c.score));
  const fallbackStrength = Math.max(0.002, ...candidates.filter(c => !c.eventUsed).map(c => c.score));
  const quality = (candidate: ScoredSelection) => {
    if (classifiedStrength > 0) return candidate.eventUsed ? Math.max(-1, candidate.score / classifiedStrength) :
      Math.max(-1, Math.min(0.4, candidate.score / fallbackStrength * 0.4));
    return Math.max(-1, candidate.score / strongest);
  };
  const adequate = (candidate: ScoredSelection) => candidate.energy >= 0.002 && candidate.clipping < 0.02 &&
    candidate.vocalSupport !== false && quality(candidate) >= 0.4;
  const boundaryScore = (chosen: ScoredSelection[]) => {
    if (chosen.length < count) return chosen.reduce((score, candidate) => score + (adequate(candidate) ?
      (Number(candidate.openingVocalSupport === true) + Number(candidate.endingVocalSupport === true)) / 2 : 0), 0);
    const ordered = chosen.every(candidate => candidate.tempoBpm !== undefined) ?
      [...chosen].sort((a, b) => a.tempoBpm! - b.tempoBpm!) : chosen;
    return ordered.reduce((score, candidate, index) => score + Number(adequate(candidate) &&
      candidate.openingVocalSupport === true && (index !== ordered.length - 1 || candidate.endingVocalSupport === true)), 0);
  };
  const coherent = (chosen: ScoredSelection[]) => {
    if (!chosen.every(c => c.tempoBpm !== undefined && adequate(c))) return false;
    const tempos = chosen.map(c => c.tempoBpm!).sort((a, b) => a - b);
    return tempos.length < 2 || (tempos.length < count ?
      tempos.every((tempo, index) => index === 0 || tempo >= tempos[index - 1] * 1.05) : progressesInTempo(tempos));
  };
  const rank = (chosen: ScoredSelection[]) => {
    const ordered = [...chosen].sort((a, b) => (a.tempoBpm ?? Infinity) - (b.tempoBpm ?? Infinity));
    const tempos = ordered.flatMap(c => c.tempoBpm === undefined ? [] : [c.tempoBpm]);
    const spread = tempos.length > 1 ? Math.min(1, (tempos.at(-1)! - tempos[0]) / 80) : 0;
    const crowdPenalty = ordered.reduce((cost, c, i) => cost + (c.performanceMeasured ?
      Math.max(0, c.crowdNoise - (i === ordered.length - 1 && c.tempoBpm !== undefined ? 0.3 : 0.2)) * 2 : 0), 0);
    const gaps = tempos.slice(1).map((tempo, i) => tempo - tempos[i]);
    const imbalance = gaps.length > 1 ? (Math.max(...gaps) - Math.min(...gaps)) / 100 : 0;
    const novelLabels = labels.varied ? new Set(chosen.map(c => labels.byPath[c.selection.asset.path])
      .filter(label => !!label && !labels.used.has(label))).size : 0;
    return 2 * new Set(chosen.map(c => c.selection.asset.path)).size +
      novelLabels * 2 + chosen.filter(c => c.vocalSupport === true).length * 3 + sum(chosen.map(quality)) +
      0.35 * tempos.length + 0.6 * spread - 0.6 * imbalance - crowdPenalty;
  };
  type State = { chosen: ScoredSelection[]; next: number; rank: number; coherent: boolean; boundaries: number };
  const diverse = (states: State[], limit: number) => {
    const selected: State[] = [], signatures = new Set<string>();
    for (const state of states) {
      const signature = state.chosen.map(c => `${c.selection.asset.path}|${c.tempoBpm === undefined ? "unknown" :
        Math.round(Math.log(c.tempoBpm) / Math.log(1.1))}|${c.openingVocalSupport}|${c.endingVocalSupport}`).sort().join("\n");
      if (signatures.has(signature)) continue;
      selected.push(state); signatures.add(signature);
      if (selected.length >= limit) return selected;
    }
    for (const state of states) if (!selected.includes(state)) {
      selected.push(state); if (selected.length >= limit) break;
    }
    return selected;
  };
  const byEnd = candidates.map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.selection.end - b.candidate.selection.end);
  const canComplete = (chosen: ScoredSelection[], next: number, needed: number) => {
    if (needed === 0) return true;
    const endBySource = new Map<string, number>();
    let capacity = 0;
    for (const { candidate, index } of byEnd) {
      if (index < next) continue;
      const selection = candidate.selection;
      if (chosen.some(c => c.selection.asset.path === selection.asset.path && overlap(c.selection, selection))) continue;
      if (selection.start < (endBySource.get(selection.asset.path) ?? -Infinity) - 0.000001) continue;
      endBySource.set(selection.asset.path, selection.end);
      if (++capacity >= needed) return true;
    }
    return false;
  };
  let beam: State[] = [{ chosen: [], next: 0, rank: 0, coherent: true, boundaries: 0 }];
  for (let position = 0; position < count; position++) {
    const next: State[] = [];
    for (const state of beam) for (let index = state.next; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (state.chosen.some(c => c.selection.asset.path === candidate.selection.asset.path && overlap(c.selection, candidate.selection))) continue;
      const chosen = [...state.chosen, candidate];
      if (!canComplete(chosen, index + 1, count - position - 1)) continue;
      next.push({ chosen, next: index + 1, rank: rank(chosen), coherent: coherent(chosen), boundaries: boundaryScore(chosen) });
    }
    next.sort((a, b) => b.boundaries - a.boundaries || b.rank - a.rank);
    const progressing = next.filter(state => state.coherent);
    const fallback = next.filter(state => !state.coherent);
    // Keep both hypotheses alive. Otherwise many high-quality near-identical
    // tempos can prune the only viable slower/middle/finale path too early.
    beam = progressing.length && fallback.length ? [...diverse(progressing, 64), ...diverse(fallback, 64)] : diverse(next, 128);
    if (!beam.length) throw new Error(`There is not enough nonrepeating sound for ${count} equal ${amount.toFixed(1)}-second moments. Add longer recordings or shorten the video.`);
  }
  beam.sort((a, b) => Number(b.boundaries === count) - Number(a.boundaries === count) ||
    Number(b.coherent) - Number(a.coherent) || b.boundaries - a.boundaries || b.rank - a.rank);
  const chosen = beam[0].chosen;
  // Volume is not tempo. If any moment lacks a trustworthy pulse measurement,
  // retain the quality ranking and report the unresolved progression honestly.
  return chosen.every(c => c.tempoBpm !== undefined) ? chosen.sort((a, b) => a.tempoBpm! - b.tempoBpm!) : chosen;
}

function soundtrackParts<T extends CreativeClip>(picture: T[], count: number): Array<Gap | Anchor> {
  const parts: Array<Gap | Anchor> = [];
  let gap = 0;
  for (const clip of picture.filter(included)) {
    if (protectedClip(clip)) {
      if (clip.soundExcludedByUser) throw new Error("A kept picture section also protects its original sound. Unlock that section before choosing picture-only sound exclusion.");
      if (!clip.asset.hasAudio) throw new Error("A protected picture section has no original sound. Unlock it or use the standard edit.");
      if (gap >= MIN - 0.0001) parts.push({ kind: "gap", duration: gap, count: 1, selections: [] });
      gap = 0;
      parts.push({ kind: "anchor", selection: { asset: clip.asset, start: clip.start, end: clip.end, locked: true } });
    } else gap += length(clip);
  }
  if (gap >= MIN - 0.0001) parts.push({ kind: "gap", duration: gap, count: 1, selections: [] });
  const gaps = parts.filter((part): part is Gap => part.kind === "gap");
  const anchors = parts.length - gaps.length;
  if (anchors + gaps.length > count) {
    throw new Error(`Keeping your marked picture and original sound aligned in this order needs at least ${anchors + gaps.length} sound moments. Increase the count or adjust the marked sections.`);
  }
  if (!gaps.length && anchors !== count) {
    throw new Error("Your protected sound sections fill the video. Use their count or add unmarked picture time.");
  }
  let extra = count - anchors - gaps.length;
  while (extra > 0) {
    const candidates = gaps.filter((part) => part.duration + EPS >= (part.count + 1) * MIN);
    if (!candidates.length) throw new Error("There is not enough unmarked time for this many separate sound moments.");
    candidates.sort((a, b) => b.duration / (b.count + 1) - a.duration / (a.count + 1));
    candidates[0].count++;
    extra--;
  }
  return parts;
}

// A separate soundtrack can still look like the original joined edit if the
// picture planner and sound planner independently choose the same source ranges.
// Compare the source time shown and heard at each position in the output.
function pictureSoundCoupling(picture: CreativeClip[], sound: AudioSelection[]) {
  const shots = picture.filter(included);
  let shotIndex = 0, soundIndex = 0, shotOffset = 0, soundOffset = 0;
  let joinedSeconds = 0, sameSourceSeconds = 0;
  while (shotIndex < shots.length && soundIndex < sound.length) {
    const shot = shots[shotIndex], audio = sound[soundIndex];
    const shotEnd = shotOffset + length(shot), soundEnd = soundOffset + length(audio);
    const shared = Math.max(0, Math.min(shotEnd, soundEnd) - Math.max(shotOffset, soundOffset));
    if (shot.asset.path === audio.asset.path) {
      sameSourceSeconds += shared;
      const sourceTimeDifference = Math.abs((shot.start - shotOffset) - (audio.start - soundOffset));
      if (sourceTimeDifference < 0.5) joinedSeconds += shared;
    }
    if (shotEnd <= soundEnd + 0.000001) { shotIndex++; shotOffset = shotEnd; }
    if (soundEnd <= shotEnd + 0.000001) { soundIndex++; soundOffset = soundEnd; }
  }
  return { joinedSeconds, sameSourceSeconds,
    cost: joinedSeconds * 1000 + sameSourceSeconds };
}

function canMovePicture(clip: CreativeClip) {
  return included(clip) && !protectedClip(clip) && clip.orderLocked !== true;
}

function separatePicture<T extends CreativeClip>(picture: T[], sound: AudioSelection[], totalSeconds: number):
  { clips: T[]; independentSeconds: number } {
  let next = [...picture];
  const groups: number[][] = [];
  let group: number[] = [];
  for (let index = 0; index < picture.length; index++) {
    const clip = picture[index];
    if (!included(clip)) continue;
    if (canMovePicture(clip)) group.push(index);
    else { if (group.length > 1) groups.push(group); group = []; }
  }
  if (group.length > 1) groups.push(group);

  // Rotating suggested shots within a gap keeps every protected section at the
  // same output position, even if the suggested shots have different lengths.
  for (const indices of groups) {
    const original = indices.map((index) => next[index]);
    let best = next, bestCost = pictureSoundCoupling(next, sound).cost;
    for (let shift = 1; shift < indices.length; shift++) {
      const trial = [...next];
      indices.forEach((index, position) => { trial[index] = original[(position + shift) % indices.length]; });
      const cost = pictureSoundCoupling(trial, sound).cost;
      if (cost + 0.000001 < bestCost) { best = trial; bestCost = cost; }
    }
    next = best;
  }

  // Two equal-length suggested shots can also trade places across a protected
  // anchor without changing that anchor's picture or sound placement.
  const movable = next.flatMap((clip, index) => canMovePicture(clip) ? [index] : []);
  for (let pass = 0; pass < 2; pass++) {
    let best = next, bestCost = pictureSoundCoupling(next, sound).cost;
    let checked = 0;
    for (let first = 0; first < movable.length; first++) {
      for (let second = first + 1; second < movable.length && checked < 2000; second++, checked++) {
        const a = movable[first], b = movable[second];
        if (Math.abs(length(next[a]) - length(next[b])) > 0.001) continue;
        const trial = [...next]; [trial[a], trial[b]] = [trial[b], trial[a]];
        const cost = pictureSoundCoupling(trial, sound).cost;
        if (cost + 0.000001 < bestCost) { best = trial; bestCost = cost; }
      }
      if (checked >= 2000) break;
    }
    if (best === next) break;
    next = best;
  }

  // If a suggested picture shot still exactly matches its sound, use another
  // part of that recording where one exists. Its length and output position stay.
  for (let index = 0; index < next.length; index++) {
    const clip = next[index];
    if (!included(clip) || protectedClip(clip)) continue;
    const seconds = length(clip), lastStart = clip.asset.duration - seconds;
    if (lastStart < 0.5) continue;
    const soundFromSource = sound.filter((selection) => selection.asset.path === clip.asset.path);
    const starts = [clip.start, 0, lastStart, clip.start - seconds, clip.start + seconds,
      ...soundFromSource.flatMap((selection) => [selection.end + 0.25, selection.start - seconds - 0.25])];
    let bestStart = clip.start, bestCost = pictureSoundCoupling(next, sound).cost;
    for (const start of starts) {
      if (start < 0 || start > lastStart) continue;
      const trial = [...next]; trial[index] = { ...clip, start, end: start + seconds };
      const cost = pictureSoundCoupling(trial, sound).cost;
      if (cost + 0.000001 < bestCost) { bestStart = start; bestCost = cost; }
    }
    if (bestStart !== clip.start) next[index] = { ...clip, start: bestStart, end: bestStart + seconds };
  }

  const independentSeconds = totalSeconds - pictureSoundCoupling(next, sound).joinedSeconds;
  if (independentSeconds / totalSeconds < 0.25 - 0.0001) {
    throw new Error("These picture sections would still match their original sound for most of the video. Add more footage, shorten the video, or unlock a kept section to make a separate picture edit.");
  }
  return { clips: next, independentSeconds };
}

export function planAudioStory<T extends CreativeClip>(clips: T[], brief: CreativeBrief,
  binsByPath: Readonly<Record<string, AudioBin[]>>): AudioStoryResult<T> {
  const intent = brief.soundtrackIntent;
  if (!intent) throw new Error("Describe a soundtrack-led edit before planning separate sound and picture.");
  if (brief.conflict) throw new Error(brief.conflict.message);
  const picture = planPicture(clips, brief);
  const parts = soundtrackParts(picture.clips, intent.segmentCount);
  const audioAssets = clips.filter((clip) => !clip.excludedByUser && !clip.soundExcludedByUser && clip.asset.hasAudio &&
    (brief.selectionMode !== "use-my-sections" || protectedClip(clip))).map((clip) => clip.asset);
  const anchors = parts.filter((part): part is Anchor => part.kind === "anchor").map((part) => part.selection);
  for (const anchor of anchors) {
    const measuredEnd = availableAudioEnd(anchor.asset, binsByPath[anchor.asset.path]);
    if (anchor.end > measuredEnd + EPS) {
      throw new Error(`The marked sound in ${anchor.asset.name} ends after its available audio. Shorten that marked section or use the standard edit.`);
    }
  }
  const reserved: AudioSelection[] = [...anchors];
  const labelsByPath = Object.fromEntries(clips.filter((clip) => !clip.excludedByUser && clip.asset.hasAudio)
    .map((clip) => [clip.asset.path, clip.label?.trim().toLowerCase() ?? ""]));
  const variedLabels = /\b(several|multiple|different|many) songs?\b/i.test(brief.description) &&
    new Set(Object.values(labelsByPath).filter(Boolean)).size > 1;
  const usedLabels = new Set(anchors.map((anchor) => labelsByPath[anchor.asset.path]).filter(Boolean));
  const lastPart = parts.at(-1);
  const finalGap = lastPart?.kind === "gap" ? lastPart : undefined;
  const canPlanEndingFirst = !!finalGap && parts.every((part) =>
    part.kind !== "gap" || part.duration <= finalGap.duration + EPS);
  const gaps = parts.filter((part): part is Gap => part.kind === "gap").sort((a, b) =>
    Number(intent.buildEnding && canPlanEndingFirst && b === finalGap) -
      Number(intent.buildEnding && canPlanEndingFirst && a === finalGap) ||
    b.duration - a.duration);
  for (const gap of gaps) {
    const spans = freeSpans(audioAssets, reserved, binsByPath);
    if (intent.buildEnding && !spans.some((span) => binsByPath[span.asset.path]?.length)) {
      throw new Error("Sound analysis could not measure a rising ending. Try again or adjust the sound moments yourself.");
    }
    if (intent.tempoArc) {
      gap.selections = chooseTempoArc(spans, gap.count, gap.duration, binsByPath, brief.options.highlightFocus ?? "balanced",
        { varied: variedLabels, byPath: labelsByPath, used: usedLabels });
    } else {
      const tickets = chooseTickets(spans, gap.count, gap.duration, binsByPath,
        { buildEnding: intent.buildEnding && gap === finalGap, variedLabels, labelsByPath, usedLabels, highlightFocus: brief.options.highlightFocus });
      const amounts = allocate(gap.duration, tickets.map(length));
      gap.selections = tickets.map((ticket, index) => bestWithin(ticket, amounts[index], binsByPath[ticket.asset.path], false, brief.options.highlightFocus));
      if (intent.buildEnding) gap.selections.sort((a, b) => a.energy - b.energy);
    }
    reserved.push(...gap.selections.map((scored) => scored.selection));
    for (const selection of gap.selections) {
      const label = labelsByPath[selection.selection.asset.path];
      if (label) usedLabels.add(label);
    }
  }
  // A final unprotected sound moment can favor a rising tail, but never at the
  // expense of obvious clipping or a quieter ending than the earlier moments.
  if (intent.buildEnding && !intent.tempoArc && lastPart?.kind === "gap" && lastPart.selections.length) {
    const lastIndex = lastPart.selections.length - 1;
    const current = lastPart.selections[lastIndex];
    const alternative = bestWithin(current.span, length(current.selection),
      binsByPath[current.selection.asset.path], true, brief.options.highlightFocus);
    const prior = parts.flatMap((part) => part.kind === "anchor" ?
      [scoreWindow(binsByPath[part.selection.asset.path], part.selection.start, length(part.selection)).energy] :
      part.selections.map((selection) => selection.energy)).slice(0, -1);
    if (alternative.tailRise > current.tailRise + 0.002 &&
      alternative.clipping <= Math.max(0.02, current.clipping + 0.005) &&
      alternative.energy + 0.0001 >= Math.max(0, ...prior)) {
      lastPart.selections[lastIndex] = alternative;
    }
  }
  let audioSelections = parts.flatMap((part) => part.kind === "anchor" ? [part.selection] : part.selections.map((scored) => scored.selection));
  const musicNotes: string[] = [];
  if (brief.options.beatSync && brief.options.audioTransition === "crossfade") {
    const aligned = alignSoundtrackBeats(audioSelections, binsByPath, { crossfadeSeconds: brief.options.audioCrossfadeSeconds ?? 2 });
    audioSelections = aligned.audioSelections;
    musicNotes.push(...aligned.notes);
  }
  if (brief.options.beatSync && brief.options.audioTransition !== "crossfade") musicNotes.push("Sound blending is off, so song joins keep their existing timing.");
  const soundSeconds = sum(audioSelections.map(length));
  if (audioSelections.length !== intent.segmentCount || Math.abs(soundSeconds - picture.seconds) > EPS) {
    throw new Error("The soundtrack and picture lengths do not match. Review the plan before exporting.");
  }
  for (let index = 0; index < audioSelections.length; index++) {
    for (let other = 0; other < index; other++) {
      if (audioSelections[index].asset.path === audioSelections[other].asset.path && overlap(audioSelections[index], audioSelections[other])) {
        throw new Error("The soundtrack repeats part of a recording. Review the plan before exporting.");
      }
    }
  }
  const separated = intent.separatePicture ? separatePicture(picture.clips, audioSelections, picture.seconds) :
    { clips: picture.clips, independentSeconds: 0 };
  if (brief.options.beatSync && intent.separatePicture) {
    const timed = alignPictureCutsToMusic(separated.clips, audioSelections, binsByPath, {
      pictureCrossfadeSeconds: ["dissolve", "smoothslide"].includes(brief.options.transition ?? "") ? 0.4 : 0 });
    if ((picture.seconds - pictureSoundCoupling(timed.clips, audioSelections).joinedSeconds) / picture.seconds >= 0.25 - 0.0001) {
      separated.clips = timed.clips;
      musicNotes.push(...timed.notes);
    } else musicNotes.push("Kept the separate picture edit unchanged because beat trims would bring it too close to the original joined recording.");
  }
  const pictureCount = separated.clips.filter(included).length;
  const notes = [`Used ${audioSelections.length} nonrepeating sound moments beneath picture from ${pictureCount} recording${pictureCount === 1 ? "" : "s"}.`];
  const soundSourceCount = new Set(audioSelections.map(selection => selection.asset.path)).size;
  if (soundSourceCount < audioSelections.length) notes.push(`The ${audioSelections.length} sound moments come from ${soundSourceCount} recording${soundSourceCount === 1 ? "" : "s"}, using different nonrepeating sections. This does not establish how many songs are included.`);
  if (intent.separatePicture) notes.push("The suggested picture differs from its original sound for a meaningful part of the video; watch the assembled preview to judge the match.");
  if (anchors.length) notes.push("Kept your marked picture and original sound together at their original source ranges and output positions.");
  if (brief.options.highlightFocus === "performance") {
    const selectedScores = audioSelections.filter(s => !s.locked).map(s => scoreWindow(binsByPath[s.asset.path], s.start, length(s), "performance"));
    const measured = selectedScores.map(sound => sound.performanceMeasured);
    notes.push(selectedScores.length && selectedScores.every(sound => sound.eventUsed) ?
      "Used local singing, music, crowd, and speech estimates to favor vocal passages and avoid lead-ins. These are model scores, not proof of the artist singing; crowd singing can be mistaken for the performance." :
      selectedScores.some(sound => sound.eventUsed) ?
      "Used local singing estimates where available and sound-quality cues elsewhere. Listen to confirm the artist: these scores cannot distinguish the singer from everyone in the crowd." :
      measured.length && measured.every(Boolean) ?
      "Favored audible sound with less noisy texture. This does not identify the singer or remove crowd voices; listen to the chosen moments." :
      measured.some(Boolean) ? "Used performance cues where measured; some moments used sound energy because those cues were unavailable. The singer is not identified." :
      "Kept protected moments or used sound energy because performance cues were unavailable. The singer is not identified.");
    if (selectedScores.some(sound => sound.vocalSupport === false)) notes.push("Some chosen moments have weak singing evidence or stronger crowd/speech estimates. More suitable sound was unavailable at this length; listen and replace them if needed.");
  }
  notes.push(...musicNotes);
  if (intent.tempoArc) {
    const measured = audioSelections.map(selection => scoreWindow(binsByPath[selection.asset.path], selection.start, length(selection), brief.options.highlightFocus));
    const tempos = measured.map(sound => sound.tempoBpm);
    const known = tempos.every((tempo): tempo is number => tempo !== undefined);
    const increasing = known && tempos.every((tempo, index) => index === 0 || tempo >= tempos[index - 1]!);
    const distinct = increasing && progressesInTempo(tempos as number[]);
    notes.push(distinct ?
      "Ordered the unprotected sound from slower measured pulse to faster pulse. Listen to confirm the feel: pulse estimates can be half or double the musical tempo." :
      "A slower-to-upbeat progression could not be confirmed from these pulse measurements or protected positions. Review the sound moments; loudness is not tempo.");
    if (measured.some(sound => sound.eventUsed)) {
      const supportedBoundaries = measured.every((sound, index) => sound.openingVocalSupport === true &&
        (index !== measured.length - 1 || sound.endingVocalSupport === true));
      notes.push(supportedBoundaries ?
        "Preferred singing-supported entrances and a singing-supported final four seconds. These are model estimates; listen to confirm the performance and ending." :
        "Singing at every entrance and at the finale could not be confirmed. Protected sections or available footage limit the choice; listen to those boundaries.");
    }
    if (anchors.length) notes.push("Kept your protected sound exactly; the remaining time is shared equally within each unprotected gap.");
    else notes.push(`Each sound moment lasts ${(picture.seconds / intent.segmentCount).toFixed(1)} seconds; no audio is repeated or sped up to fill the length.`);
  }
  if (intent.buildEnding && !intent.tempoArc) {
    const scored = audioSelections.map((selection) => scoreWindow(binsByPath[selection.asset.path], selection.start, length(selection)));
    const rising = scored.every((current, index) => index === 0 || current.energy + 0.0001 >= scored[index - 1].energy);
    const clearRise = scored.length > 1 && scored.at(-1)!.energy > scored[0].energy * 1.05;
    notes.push(rising && clearRise && scored.every((item) => item.measured && item.clipping < 0.02) ?
      "Placed the strongest measured sound moment last. Listen to confirm the ending feels like a build." :
      "Protected placement, distortion, or similar sound levels limit a smooth energy rise. Listen to the ending and adjust if needed.");
  }
  return { clips: separated.clips, audioSelections, options: brief.options, plannedSeconds: picture.seconds, notes };
}

export function refineAudioStory(audioSelections: AudioSelection[], index: number,
  binsByPath: Readonly<Record<string, AudioBin[]>>, focus: HighlightFocus = "balanced"): AudioSelection[] {
  const current = audioSelections[index];
  if (!current) throw new Error("Choose a sound moment to change.");
  if (current.locked) throw new Error("This sound moment is protected. Unlock its marked section before changing it.");
  const reserved = audioSelections.filter((_, position) => position !== index);
  if (!binsByPath[current.asset.path]?.length) throw new Error("Sound analysis is unavailable for this recording. Review the plan to choose another sound source.");
  const alternatives = freeSpans([current.asset], [...reserved, current], binsByPath);
  const seconds = length(current);
  const after = alternatives.map((span) => ({ ...span, start: Math.max(span.start, current.end + 0.2) }))
    .filter((span) => length(span) + EPS >= seconds);
  const before = alternatives.map((span) => ({ ...span, end: Math.min(span.end, current.start - 0.2) }))
    .filter((span) => length(span) + EPS >= seconds);
  const pool = after.length ? after : before;
  if (!pool.length) throw new Error("There is no different sound moment at this length in this recording. Review the plan to choose other recordings or a shorter length.");
  const choice = pool.map((span) => bestWithin(span, seconds, binsByPath[current.asset.path], false, focus))
    .sort((a, b) => b.score - a.score)[0];
  return audioSelections.map((selection, position) => position === index ? choice.selection : selection);
}
