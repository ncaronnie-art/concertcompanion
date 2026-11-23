import test from "node:test";
import assert from "node:assert/strict";
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.ts";
import { planAudioStory } from "../src/shared/audio-story.ts";
import { scoreAudioBins, type AudioBin } from "../src/shared/suggestions.ts";

const clip = (number: number, seconds = 45): CreativeClip => ({ asset: {
  path: `three-act-${number}.mp4`, name: `three-act-${number}.mp4`, duration: seconds,
  audioDuration: seconds, width: 720, height: 1280, hasAudio: true }, start: 0,
  end: Math.min(12, seconds), included: true, locked: false, excludedByUser: false, selectionSource: "suggested" });

function bins(seconds: number, tempo?: number, rms = 0.2, noise = 0.1): AudioBin[] {
  return Array.from({ length: Math.ceil(seconds * 2) }, (_, index) => {
    const start = index * 0.5, end = Math.min(seconds, start + 0.5);
    const beatTimes: number[] = [];
    if (tempo) for (let beat = Math.ceil(start * tempo / 60) * 60 / tempo; beat < end - 1e-7; beat += 60 / tempo) beatTimes.push(beat);
    return { rms, clipping: 0, tonalProminence: 0.5, crowdNoise: noise, endSeconds: end,
      ...(tempo ? { tempoBpm: tempo, beatConfidence: 0.9, beatTimes } : {}) };
  });
}

const plan = (clips: CreativeClip[], byPath: Record<string, AudioBin[]>, targetSeconds = 90, count = 3) =>
  planAudioStory(clips, interpretCreativeBrief({ description: "A recap", targetSeconds,
    separatePicture: true, soundMomentCount: count, pictureSourceCount: clips.length,
    tempoArc: true }, clips, { aspect: "vertical", reduceRumble: false, highlightFocus: "performance" }), byPath);

test("three thirty-second moments build measured tempo rather than simply loudness", () => {
  const clips = [clip(1), clip(2), clip(3), clip(4)];
  const inputs = structuredClone(clips);
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path,
    bins(45, [70, 105, 145, 180][i], [0.3, 0.2, 0.12, 0.6][i], i === 3 ? 0.95 : 0.1)]));
  const result = plan(clips, byPath);
  assert.equal(result.plannedSeconds, 90);
  assert.deepEqual(result.audioSelections.map(s => s.end - s.start), [30, 30, 30]);
  assert.deepEqual(result.audioSelections.map(s => s.asset.path), clips.slice(0, 3).map(c => c.asset.path));
  assert.match(result.notes.join(" "), /slower measured pulse to faster pulse/);
  assert.deepEqual(clips, inputs);
});

test("short loud recordings do not silently turn three equal moments into uneven lengths", () => {
  const clips = [clip(1, 15), clip(2, 40), clip(3, 40), clip(4, 40)];
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path,
    bins(c.asset.duration, [170, 70, 105, 145][i], i === 0 ? 0.8 : 0.2)]));
  const result = plan(clips, byPath);
  assert.ok(result.audioSelections.every(s => s.asset.path !== clips[0].asset.path));
  assert.deepEqual(result.audioSelections.map(s => s.end - s.start), [30, 30, 30]);
});

test("equal moments fail clearly when source audio coverage cannot fill them", () => {
  const clips = [clip(1), clip(2), clip(3)];
  const byPath = Object.fromEntries(clips.map(c => [c.asset.path, bins(29, 100)]));
  assert.throws(() => plan(clips, byPath), /not enough nonrepeating sound.*equal 30.0-second/);
});

test("one long sound recording can supply equal disjoint moments without repetition", () => {
  const clips = [clip(1, 90), clip(2, 90), clip(3, 90)];
  clips[1].asset.hasAudio = clips[2].asset.hasAudio = false;
  const result = plan(clips, { [clips[0].asset.path]: bins(90, 100) });
  const ordered = [...result.audioSelections].sort((a, b) => a.start - b.start);
  assert.ok(ordered.every((s, i) => Math.abs(s.start - i * 30) < 1e-6 && Math.abs(s.end - (i + 1) * 30) < 1e-6));
  assert.match(result.notes.join(" "), /progression could not be confirmed/);
  assert.match(result.notes.join(" "), /3 sound moments come from 1 recording/);
});

test("uncertain pulse evidence does not masquerade as a tempo progression", () => {
  const clips = [clip(1), clip(2), clip(3)];
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, bins(45, undefined, [0.3, 0.2, 0.1][i])]));
  const result = plan(clips, byPath);
  assert.match(result.notes.join(" "), /loudness is not tempo/);
  assert.doesNotMatch(result.notes.join(" "), /Ordered the unprotected sound/);
  assert.ok(result.audioSelections.every(s => Math.abs(s.end - s.start - 30) < 1e-6));
});

test("half/double-time mixtures are not treated as a reliable musical tempo", () => {
  const clips = [clip(1), clip(2), clip(3)];
  const mixed = bins(45, 70).map((bin, i) => ({ ...bin, tempoBpm: i % 2 ? 140 : 70 }));
  const result = plan(clips, { [clips[0].asset.path]: mixed,
    [clips[1].asset.path]: bins(45, 100), [clips[2].asset.path]: bins(45, 140) });
  assert.match(result.notes.join(" "), /progression could not be confirmed/);
});

test("two equal measured tempos and a faster ending do not claim a three-step progression", () => {
  const clips = [clip(1), clip(2), clip(3)];
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, bins(45, [80, 80, 140][i])]));
  const result = plan(clips, byPath);
  assert.match(result.notes.join(" "), /progression could not be confirmed/);
  assert.doesNotMatch(result.notes.join(" "), /Ordered the unprotected sound/);
});

test("protected source range and output position override the requested tempo arc", () => {
  const clips = [clip(1, 50), clip(2, 50), clip(3, 50)];
  clips[0] = { ...clips[0], start: 7, end: 37, locked: true, selectionSource: "manual" };
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, bins(50, [160, 70, 105][i])]));
  const result = plan(clips, byPath);
  assert.deepEqual([result.audioSelections[0].asset.path, result.audioSelections[0].start,
    result.audioSelections[0].end, result.audioSelections[0].locked], [clips[0].asset.path, 7, 37, true]);
  assert.match(result.notes.join(" "), /protected sound exactly/);
  assert.match(result.notes.join(" "), /progression could not be confirmed/);
});

test("a quiet lead-in loses to an available full active thirty-second passage", () => {
  const clips = [clip(1, 40), clip(2, 40), clip(3, 40)];
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path,
    bins(40, [70, 105, 140][i]).map((bin, j) => ({ ...bin, rms: j < 10 ? 0.01 : 0.2 }))]));
  const result = plan(clips, byPath);
  assert.ok(result.audioSelections.every(s => s.start >= 5));
});

test("a sustained tonal scream or instrument is not given a positive vocal bonus", () => {
  const base = { rms: 0.2, clipping: 0, crowdNoise: 0.1 };
  assert.equal(scoreAudioBins([{ ...base, tonalProminence: 1 }], "performance").score,
    scoreAudioBins([{ ...base, tonalProminence: 0.1 }], "performance").score);
});

test("twelve sound moments retain equal duration and bounded nonrepeating planning", () => {
  const clips = Array.from({ length: 12 }, (_, i) => clip(i + 1, 35));
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, bins(35, 70 + i * 8)]));
  const result = plan(clips, byPath, 360, 12);
  assert.equal(result.audioSelections.length, 12);
  assert.equal(new Set(result.audioSelections.map(s => s.asset.path)).size, 12);
  assert.ok(result.audioSelections.every(s => Math.abs(s.end - s.start - 30) < 1e-6));
});

test("a picture-only recording stays visible but cannot supply automatically chosen sound", () => {
  const clips = [clip(1), clip(2), clip(3), { ...clip(4), soundExcludedByUser: true }];
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, bins(45, [70, 105, 145, 180][i], i === 3 ? 0.8 : 0.2)]));
  const result = plan(clips, byPath);
  assert.ok(result.clips.some(c => c.asset.path === clips[3].asset.path && c.included));
  assert.ok(result.audioSelections.every(s => s.asset.path !== clips[3].asset.path));
  assert.equal(result.clips.find(c => c.asset.path === clips[3].asset.path)?.soundExcludedByUser, true);
  const protectedClips = clips.map((c, i) => i === 3 ? { ...c, locked: true, selectionSource: "manual" as const } : c);
  assert.throws(() => plan(protectedClips, byPath), /kept section|kept picture|marked|protected|picture-only/i);
});

test("an adequately strong middle-tempo passage makes the requested arc matter", () => {
  const clips = [clip(1), clip(2), clip(3), clip(4)];
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, bins(45, [70, 120, 121, 98][i], [0.3, 0.27, 0.26, 0.18][i])]));
  const result = plan(clips, byPath);
  assert.deepEqual(result.audioSelections.map(s => s.asset.path), [clips[0].asset.path, clips[3].asset.path, clips[1].asset.path]);
  assert.match(result.notes.join(" "), /Ordered the unprotected sound/);
  const weak = { ...byPath, [clips[3].asset.path]: bins(45, 98, 0.01) };
  const fallback = plan(clips, weak);
  assert.ok(fallback.audioSelections.every(s => s.asset.path !== clips[3].asset.path));
  assert.match(fallback.notes.join(" "), /progression could not be confirmed/);
});

test("stable middle windows remain candidates when the loudest window crosses tempo estimates", () => {
  const clips = [clip(1, 60), clip(2, 60), clip(3, 60)];
  const middle = bins(60, 100).map((bin, i) => ({ ...bin,
    tempoBpm: i < 30 ? 65 : i >= 90 ? 160 : 100, rms: i < 30 || i >= 90 ? 0.3 : 0.2 }));
  const result = plan(clips, { [clips[0].asset.path]: bins(60, 70),
    [clips[1].asset.path]: middle, [clips[2].asset.path]: bins(60, 140) });
  const selectedMiddle = result.audioSelections.find(s => s.asset.path === clips[1].asset.path)!;
  assert.ok(selectedMiddle.start > 0 && selectedMiddle.start < 30);
  assert.match(result.notes.join(" "), /Ordered the unprotected sound/);
});

test("a middle pulse that hugs the opening does not claim the requested three-act progression", () => {
  const clips = [clip(1), clip(2), clip(3)];
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, bins(45, [60, 69, 121][i])]));
  const result = plan(clips, byPath);
  assert.match(result.notes.join(" "), /progression could not be confirmed/);
  assert.doesNotMatch(result.notes.join(" "), /Ordered the unprotected sound/);
});

test("unknown event evidence cannot displace measured instrumental music with loud noise", () => {
  const clips = [clip(1), clip(2), clip(3), clip(4)];
  const faint = { singingScore: 0.0002, musicScore: 0.015, crowdScore: 0.0004, speechScore: 0.01 };
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path,
    bins(45, i === 3 ? undefined : [60, 90, 120][i], [0.025, 0.037, 0.048, 0.35][i], i === 3 ? 0.995 : 0.3)
      .map(bin => ({ ...bin, ...faint, ...(i === 2 ? { musicScore: 0.07 } : {}) }))]));
  const result = plan(clips, byPath);
  assert.deepEqual(result.audioSelections.map(s => s.asset.path), clips.slice(0, 3).map(c => c.asset.path));
  assert.ok(result.audioSelections.every(s => Math.abs(s.end - s.start - 30) < 1e-6));
  assert.doesNotMatch(result.notes.join(" "), /Preferred singing-supported entrances/);
});
