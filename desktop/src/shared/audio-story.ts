import type { AudioSelection, ExportOptions } from "./render-plan.js";
import type { AudioBin } from "./suggestions.js";
import type { CreativeBrief, CreativeClip } from "./creative-brief.js";

export type AudioStoryResult<T extends CreativeClip> = {
  clips: T[];
  audioSelections: AudioSelection[];
  options: ExportOptions;
  plannedSeconds: number;
  notes: string[];
};

type Span = { asset: AudioSelection["asset"]; start: number; end: number };
type ScoredSelection = { selection: AudioSelection; span: Span; score: number; energy: number; clipping: number; tailRise: number; measured: boolean };
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

function scoreWindow(bins: AudioBin[] | undefined, start: number, seconds: number): { score: number; energy: number; clipping: number; tailRise: number; measured: boolean } {
  if (!bins?.length) return { score: 0, energy: 0, clipping: 0, tailRise: 0, measured: false };
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
  return { score: energy - clippingFraction * 0.8, energy, clipping: clippingFraction, tailRise: tail - head, measured: true };
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
  binsByPath: Readonly<Record<string, AudioBin[]>>): Span[] {
  if (count < 1) return [];
  const sampleLength = seconds / count;
  const samples = new Map(spans.map((span) => [span,
    bestWithin(span, Math.min(length(span), sampleLength), binsByPath[span.asset.path])]));
  const canFill = (candidates: Span[]) => candidates.length >= count &&
    sum([...candidates].sort((a, b) => length(b) - length(a)).slice(0, count).map(length)) + EPS >= seconds;
  // Length alone must not let a silent recording displace audible performance.
  // Use the highlight suggestion's conservative signal floor, then retain the
  // full pool when this preference would prevent the requested count or length.
  // Marked sound is already reserved separately and never enters this ranking.
  const audible = spans.filter((span) => samples.get(span)!.energy >= 0.002);
  const withSignal = canFill(audible) ? audible : spans;
  const clean = withSignal.filter((span) => samples.get(span)!.clipping < 0.02);
  const pool = canFill(clean) ? clean : withSignal;
  const ranked = [...pool].sort((a, b) => length(b) - length(a));
  const distinct: Span[] = [], seen = new Set<string>();
  for (const span of ranked) if (!seen.has(span.asset.path)) { distinct.push(span); seen.add(span.asset.path); }
  let chosen = distinct.slice(0, count);
  if (sum(chosen.map(length)) + EPS < seconds || chosen.length < count) {
    chosen = ranked.slice(0, count);
  }
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

function bestWithin(span: Span, seconds: number, bins: AudioBin[] | undefined, preferRisingTail = false): ScoredSelection {
  const lastStart = span.end - seconds;
  if (lastStart < span.start - EPS) throw new Error("A sound section cannot fit within the available recording.");
  const steps = Math.min(2000, Math.max(1, Math.ceil((lastStart - span.start) / BIN_SECONDS)));
  let bestStart = span.start, best = scoreWindow(bins, span.start, seconds);
  for (let index = 1; index <= steps; index++) {
    const start = span.start + (lastStart - span.start) * index / steps;
    const score = scoreWindow(bins, start, seconds);
    const rank = score.score + (preferRisingTail ? Math.max(0, score.tailRise) * 0.2 : 0);
    const bestRank = best.score + (preferRisingTail ? Math.max(0, best.tailRise) * 0.2 : 0);
    if (rank > bestRank + 0.000001) { bestStart = start; best = score; }
  }
  return { selection: { asset: span.asset, start: bestStart, end: bestStart + seconds },
    span, score: best.score, energy: best.energy, clipping: best.clipping,
    tailRise: best.tailRise, measured: best.measured };
}

function soundtrackParts<T extends CreativeClip>(picture: T[], count: number): Array<Gap | Anchor> {
  const parts: Array<Gap | Anchor> = [];
  let gap = 0;
  for (const clip of picture.filter(included)) {
    if (protectedClip(clip)) {
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
  const audioAssets = clips.filter((clip) => !clip.excludedByUser && clip.asset.hasAudio &&
    (brief.selectionMode !== "use-my-sections" || protectedClip(clip))).map((clip) => clip.asset);
  const anchors = parts.filter((part): part is Anchor => part.kind === "anchor").map((part) => part.selection);
  for (const anchor of anchors) {
    const measuredEnd = availableAudioEnd(anchor.asset, binsByPath[anchor.asset.path]);
    if (anchor.end > measuredEnd + EPS) {
      throw new Error(`The marked sound in ${anchor.asset.name} ends after its available audio. Shorten that marked section or use the standard edit.`);
    }
  }
  const reserved: AudioSelection[] = [...anchors];
  const gaps = parts.filter((part): part is Gap => part.kind === "gap").sort((a, b) => b.duration - a.duration);
  for (const gap of gaps) {
    const spans = freeSpans(audioAssets, reserved, binsByPath);
    if (intent.buildEnding && !spans.some((span) => binsByPath[span.asset.path]?.length)) {
      throw new Error("Sound analysis could not measure a rising ending. Try again or adjust the sound moments yourself.");
    }
    const tickets = chooseTickets(spans, gap.count, gap.duration, binsByPath);
    const amounts = allocate(gap.duration, tickets.map(length));
    gap.selections = tickets.map((ticket, index) => bestWithin(ticket, amounts[index], binsByPath[ticket.asset.path]));
    if (intent.buildEnding) gap.selections.sort((a, b) => a.energy - b.energy);
    reserved.push(...gap.selections.map((scored) => scored.selection));
  }
  // A final unprotected sound moment can favor a rising tail, but never at the
  // expense of obvious clipping or a quieter ending than the earlier moments.
  const lastPart = parts.at(-1);
  if (intent.buildEnding && lastPart?.kind === "gap" && lastPart.selections.length) {
    const lastIndex = lastPart.selections.length - 1;
    const current = lastPart.selections[lastIndex];
    const alternative = bestWithin(current.span, length(current.selection),
      binsByPath[current.selection.asset.path], true);
    const prior = parts.flatMap((part) => part.kind === "anchor" ?
      [scoreWindow(binsByPath[part.selection.asset.path], part.selection.start, length(part.selection)).energy] :
      part.selections.map((selection) => selection.energy)).slice(0, -1);
    if (alternative.tailRise > current.tailRise + 0.002 &&
      alternative.clipping <= Math.max(0.02, current.clipping + 0.005) &&
      alternative.energy + 0.0001 >= Math.max(0, ...prior)) {
      lastPart.selections[lastIndex] = alternative;
    }
  }
  const audioSelections = parts.flatMap((part) => part.kind === "anchor" ? [part.selection] : part.selections.map((scored) => scored.selection));
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
  const pictureCount = separated.clips.filter(included).length;
  const notes = [`Used ${audioSelections.length} nonrepeating sound moments beneath picture from ${pictureCount} recording${pictureCount === 1 ? "" : "s"}.`];
  if (intent.separatePicture) notes.push("The suggested picture differs from its original sound for a meaningful part of the video; watch the assembled preview to judge the match.");
  if (anchors.length) notes.push("Kept your marked picture and original sound together at their original source ranges and output positions.");
  if (intent.buildEnding) {
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
  binsByPath: Readonly<Record<string, AudioBin[]>>): AudioSelection[] {
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
  const choice = pool.map((span) => bestWithin(span, seconds, binsByPath[current.asset.path]))
    .sort((a, b) => b.score - a.score)[0];
  return audioSelections.map((selection, position) => position === index ? choice.selection : selection);
}
