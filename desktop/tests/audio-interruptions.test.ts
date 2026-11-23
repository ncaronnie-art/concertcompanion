import test from "node:test";
import assert from "node:assert/strict";
import { scanAudioInterruptions } from "../src/shared/audio-interruptions.ts";
import { scoreAudioBins, chooseAudioHighlight, type AudioBin } from "../src/shared/suggestions.ts";
import { planAudioStory } from "../src/shared/audio-story.ts";
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.ts";

const sung: AudioBin = { rms: 0.2, clipping: 0, singingScore: 0.2, musicScore: 0.6,
  crowdScore: 0.015, speechScore: 0.005, eventStatus: "classified", eventCoverage: 1,
  tonalProminence: 0.5, crowdNoise: 0.1 };
const speech: AudioBin = { ...sung, rms: 0.35, singingScore: 0.015, musicScore: 0.15, speechScore: 0.4 };
const crowd: AudioBin = { ...sung, rms: 0.4, singingScore: 0.02, musicScore: 0.2, crowdScore: 0.4 };
const rows = (count = 120) => Array.from({ length: count }, () => ({ ...sung }));
const source = (id: number, seconds = 60): CreativeClip => ({ asset: { name: `source-${id}.mp4`, path: `source-${id}.mp4`,
  duration: seconds, audioDuration: seconds, width: 720, height: 1280, hasAudio: true },
  start: 0, end: 12, included: true, excludedByUser: false, locked: false, selectionSource: "suggested" });

test("short speech and crowd interruptions are found anywhere in a longer selected range", () => {
  for (const [at, bin] of [[0, speech], [30, speech], [58, crowd]] as const) {
    const bins = rows(60); bins[at] = { ...bin }; bins[at + 1] = { ...bin };
    const report = scanAudioInterruptions(bins, { start: 0, end: 30 });
    assert.equal(report.status, "checked"); assert.ok(report.risk > 0.4);
    assert.ok(report.intervals.some(i => i.start <= at * 0.5 && i.end >= (at + 2) * 0.5));
    assert.ok(report.intervals.every(i => i.start >= 0 && i.end <= 30));
  }
});

test("a speech interruption does not need crowd-family evidence", () => {
  const bins = rows(60); bins[20] = { ...speech, crowdScore: 0 }; bins[21] = { ...speech, crowdScore: 0 };
  assert.ok(scanAudioInterruptions(bins, { start: 0, end: 30 }).intervals.some(i => i.kind === "speech"));
});

test("big sung notes and drum accents are not crowd interruptions without event evidence", () => {
  const bins = rows();
  bins[30] = { ...sung, rms: 0.9, singingScore: 0.8, musicScore: 0.9 };
  bins[60] = { ...sung, rms: 0.95, singingScore: 0.001, musicScore: 0.95 };
  const report = scanAudioInterruptions(bins, { start: 0, end: 60 });
  assert.equal(report.risk, 0); assert.deepEqual(report.intervals, []);
});

test("steady or quieter crowd atmosphere is not labeled a loud interruption", () => {
  const steady = rows().map(bin => ({ ...bin, crowdScore: 0.35, singingScore: 0.02, musicScore: 0.1 }));
  assert.deepEqual(scanAudioInterruptions(steady, { start: 0, end: 60 }).intervals, []);
  const quiet = rows(); quiet[60] = { ...crowd, rms: 0.1 }; quiet[61] = { ...crowd, rms: 0.1 };
  assert.deepEqual(scanAudioInterruptions(quiet, { start: 0, end: 60 }).intervals, []);
});

test("missing, partial and decoded-tail coverage cannot be reported fully checked", () => {
  assert.equal(scanAudioInterruptions(undefined, { start: 0, end: 30 }).status, "unavailable");
  assert.equal(scanAudioInterruptions(rows().map(bin => ({ ...bin, eventStatus: "unavailable" })), { start: 0, end: 30 }).status, "unavailable");
  const bins = rows(60); bins[59] = { ...sung, eventStatus: "unmeasured", eventCoverage: 0.7, endSeconds: 29.9 };
  const partial = scanAudioInterruptions(bins, { start: 0, end: 30 });
  assert.equal(partial.status, "partial"); assert.ok(partial.analyzedFraction < 1);
  assert.equal(scanAudioInterruptions(rows(59), { start: 0, end: 30 }).status, "partial");
  assert.equal(scanAudioInterruptions(rows(60).map(bin => ({ ...bin, singingScore: 0, musicScore: 0, speechScore: 0, crowdScore: 0 })), { start: 0, end: 30 }).status, "checked");
});

test("changed ranges exclude old warnings and keep absolute source timestamps", () => {
  const bins = rows(120); bins[20] = { ...speech }; bins[21] = { ...speech };
  assert.ok(scanAudioInterruptions(bins, { start: 9.75, end: 11.25 }).intervals.every(i => i.start >= 9.75 && i.end <= 11.25));
  assert.deepEqual(scanAudioInterruptions(bins, { start: 15, end: 45 }).intervals, []);
  assert.throws(() => scanAudioInterruptions(bins, { start: 5, end: 2 }), /valid sound range/);
});

test("scoring shifted slices uses absolute coverage rather than treating decoded tail times as relative", () => {
  const bins = rows(80).map((bin, index) => ({ ...bin, endSeconds: (index + 1) * 0.5 }));
  bins[79].endSeconds = 39.8;
  const absolute = scanAudioInterruptions(bins, { start: 10, end: 40 });
  assert.equal(absolute.status, "partial"); assert.ok(Math.abs(absolute.analyzedFraction - 29.8 / 30) < 1e-8);
  const scored = scoreAudioBins(bins.slice(20), "performance", absolute);
  assert.equal(scored.interruptionStatus, "partial");
  assert.equal(scored.interruptionRisk, 0);
});

test("a short interruption lowers performance ranking without changing balanced intent", () => {
  const clean = rows(60), interrupted = rows(60); interrupted[30] = { ...speech }; interrupted[31] = { ...speech };
  assert.ok(scoreAudioBins(clean, "performance").score > scoreAudioBins(interrupted, "performance").score);
  const raw = scoreAudioBins(interrupted, "balanced");
  assert.equal(raw.interruptionRisk, 0);
  assert.equal(raw.score, interrupted.reduce((n, b) => n + b.rms, 0) / interrupted.length);
  const long = [...interrupted, ...clean];
  const highlight = chooseAudioHighlight(source(1).asset, long, 0.5, "performance");
  assert.ok(highlight.end <= 15 || highlight.start >= 16);
});

test("automatic equal sections avoid a middle interruption but preserve a user-protected one", () => {
  const clips = [source(1, 30), source(2, 30), source(3, 30), source(4, 30)];
  const bins = Object.fromEntries(clips.map((clip, i) => [clip.asset.path, rows(60).map((b, at) => ({ ...b,
    tempoBpm: [70, 100, 140, 140][i], beatConfidence: 0.9, beatTimes: [at * 0.5] }))]));
  bins[clips[2].asset.path][30] = { ...bins[clips[2].asset.path][30], ...speech };
  bins[clips[2].asset.path][31] = { ...bins[clips[2].asset.path][31], ...speech };
  const options = { aspect: "vertical" as const, reduceRumble: false, highlightFocus: "performance" as const };
  const input = { description: "Recap", targetSeconds: 90, separatePicture: true, soundMomentCount: 3, pictureSourceCount: 4, tempoArc: true };
  const cut = planAudioStory(clips, interpretCreativeBrief(input, clips, options), bins);
  assert.ok(cut.audioSelections.every(s => s.asset.path !== clips[2].asset.path));
  assert.ok(cut.audioSelections.every(s => s.end - s.start === 30));
  const protectedClips = [{ ...clips[2], start: 0, end: 30, locked: true, selectionSource: "manual" as const }, clips[0], clips[1], clips[3]];
  const kept = planAudioStory(protectedClips, interpretCreativeBrief(input, protectedClips, options), bins);
  assert.ok(kept.audioSelections.some(s => s.asset.path === clips[2].asset.path && s.start === 0 && s.end === 30 && s.locked));
});
