import test from "node:test";
import assert from "node:assert/strict";
import { chooseAudioHighlight, scoreAudioBins, type AudioBin } from "../src/shared/suggestions.ts";
import { planAudioStory } from "../src/shared/audio-story.ts";
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.ts";

const voice: AudioBin = { rms: 0.2, clipping: 0, tonalProminence: 0.5, crowdNoise: 0.15,
  singingScore: 0.2, musicScore: 0.6, crowdScore: 0.02, speechScore: 0.01 };
const instrumental: AudioBin = { ...voice, rms: 0.45, singingScore: 0.002, musicScore: 0.8, crowdScore: 0.01, speechScore: 0.001 };
const crowd: AudioBin = { ...voice, rms: 0.4, tonalProminence: 0.95, crowdNoise: 0.1,
  singingScore: 0.002, musicScore: 0.02, crowdScore: 0.3, speechScore: 0.5 };
const repeat = (bin: AudioBin, count = 80) => Array.from({ length: count }, () => ({ ...bin }));
const clip = (n: number): CreativeClip => ({ asset: { name: `event-${n}.mp4`, path: `event-${n}.mp4`,
  duration: 40, audioDuration: 40, width: 720, height: 1280, hasAudio: true }, start: 0, end: 12,
  included: true, locked: false, excludedByUser: false, selectionSource: "suggested" });

test("local event scores favor singing with music over loud instrumental or crowd speech", () => {
  const singing = scoreAudioBins(repeat(voice), "performance");
  assert.equal(singing.eventUsed, true);
  assert.ok(singing.score > scoreAudioBins(repeat(instrumental), "performance").score);
  assert.ok(singing.score > scoreAudioBins(repeat(crowd), "performance").score);
  assert.ok(scoreAudioBins(repeat(instrumental), "performance").score > scoreAudioBins(repeat(crowd), "performance").score);
  assert.equal(scoreAudioBins(repeat(voice), "balanced").eventUsed, false,
    "the explicit balanced option retains its established meaning");
});

test("model confidence cannot give inaudible sound a free positive singing bonus", () => {
  const inaudible = { ...voice, rms: 0.0001, singingScore: 1, musicScore: 1, crowdScore: 0, speechScore: 0 };
  const quietSinging = { ...voice, rms: 0.025 };
  assert.ok(scoreAudioBins(repeat(quietSinging), "performance").score > scoreAudioBins(repeat(inaudible), "performance").score);
  assert.equal(scoreAudioBins(repeat(inaudible), "performance").eventUsed, false);
});

test("missing and unusable event evidence retain the legacy signal fallback", () => {
  const legacy = repeat({ rms: 0.2, clipping: 0.01 });
  const zero = legacy.map(bin => ({ ...bin, singingScore: 0, musicScore: 0, crowdScore: 0, speechScore: 0 }));
  const invalid = legacy.map(bin => ({ ...bin, singingScore: Number.NaN, musicScore: 2, crowdScore: -1, speechScore: 0 }));
  for (const input of [zero, invalid]) {
    const result = scoreAudioBins(input, "performance");
    assert.equal(result.eventUsed, false);
    assert.equal(result.score, scoreAudioBins(legacy, "performance").score);
    assert.ok(Number.isFinite(result.score));
  }
});

test("partial coverage and unavailable metadata do not pretend the full window was classified", () => {
  const adequate = repeat({ ...voice, eventStatus: "classified", eventCoverage: 0.8 });
  const sparse = repeat({ ...voice, eventStatus: "classified", eventCoverage: 0.2 });
  const stale = repeat({ ...voice, eventStatus: "unavailable", eventCoverage: 1, eventFailure: "Local sound analysis is unavailable." });
  assert.equal(scoreAudioBins(adequate, "performance").eventUsed, true);
  for (const input of [sparse, stale]) {
    const result = scoreAudioBins(input, "performance");
    assert.equal(result.eventUsed, false);
    assert.equal(result.eventMeasured, false);
    assert.ok(Number.isFinite(result.score));
  }
});

test("a singing passage starts after an instrumental lead-in instead of rewarding its loud opening", () => {
  const bins = [...repeat(instrumental, 16), ...repeat(voice, 64)];
  const suggestion = chooseAudioHighlight(clip(1).asset, bins, 0.5, "performance");
  assert.ok(suggestion.start >= 8);
  assert.equal(suggestion.end - suggestion.start, 12);
  assert.match(suggestion.reason, /local model estimates/);
  assert.match(suggestion.reason, /does not identify the singer/);
});

test("the first seconds matter even when two windows contain similar total singing evidence", () => {
  const leadingGap = [...repeat(instrumental, 8), ...repeat(voice, 52)];
  const trailingGap = [...repeat(voice, 52), ...repeat(instrumental, 8)];
  assert.ok(scoreAudioBins(trailingGap, "performance").score > scoreAudioBins(leadingGap, "performance").score);
});

test("event-aware thirty-second planning preserves locks and avoids crowd or nonvocal alternatives", () => {
  const clips = [clip(1), clip(2), clip(3), clip(4), clip(5)];
  clips[0] = { ...clips[0], start: 5, end: 35, locked: true, selectionSource: "manual" };
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path,
    i === 0 ? repeat(crowd) : i < 3 ? [...repeat(instrumental, 12), ...repeat(voice, 68)] : repeat(i === 3 ? crowd : instrumental)]));
  const brief = interpretCreativeBrief({ description: "Recap", targetSeconds: 90, separatePicture: true,
    soundMomentCount: 3, pictureSourceCount: 5, tempoArc: true }, clips,
  { aspect: "vertical", reduceRumble: false, highlightFocus: "performance" });
  const original = structuredClone(clips);
  const result = planAudioStory(clips, brief, byPath);
  assert.deepEqual(result.audioSelections.map(s => s.asset.path), clips.slice(0, 3).map(c => c.asset.path));
  assert.deepEqual([result.audioSelections[0].start, result.audioSelections[0].end, result.audioSelections[0].locked], [5, 35, true]);
  assert.ok(result.audioSelections.slice(1).every(s => s.start >= 6 && Math.abs(s.end - s.start - 30) < 1e-6));
  assert.match(result.notes.join(" "), /model scores, not proof/);
  assert.deepEqual(clips, original);
});

test("a third crowd-only recording cannot displace another sung section that can fill the length", () => {
  const clips = [clip(1), clip(2), clip(3)].map((c, i) => ({ ...c,
    asset: { ...c.asset, duration: i < 2 ? 65 : 40, audioDuration: i < 2 ? 65 : 40 } }));
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, repeat(i < 2 ? voice : crowd, c.asset.duration * 2)]));
  const brief = interpretCreativeBrief({ description: "Recap", targetSeconds: 90, separatePicture: true,
    soundMomentCount: 3, pictureSourceCount: 3, tempoArc: true }, clips,
  { aspect: "vertical", reduceRumble: false, highlightFocus: "performance" });
  const result = planAudioStory(clips, brief, byPath);
  assert.ok(result.audioSelections.every(s => s.asset.path !== clips[2].asset.path));
  assert.equal(new Set(result.audioSelections.map(s => s.asset.path)).size, 2);
  assert.match(result.notes.join(" "), /3 sound moments come from 2 recordings/);
  for (let i = 0; i < result.audioSelections.length; i++) for (let j = 0; j < i; j++) {
    const a = result.audioSelections[i], b = result.audioSelections[j];
    assert.ok(a.asset.path !== b.asset.path || a.start >= b.end - 1e-6 || b.start >= a.end - 1e-6);
  }
});

test("unavailable loud windows cannot win from the different fallback score scale", () => {
  const unmeasured: AudioBin = { rms: 0.6, clipping: 0, tonalProminence: 0.8, crowdNoise: 0.05,
    eventStatus: "unavailable", eventFailure: "Local sound analysis is unavailable." };
  const sourceBins = [...repeat(unmeasured, 40), ...repeat(voice, 40)];
  assert.ok(chooseAudioHighlight(clip(1).asset, sourceBins, 0.5, "performance").start >= 20);
  const clips = [clip(1), clip(2), clip(3), clip(4)];
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, repeat(i === 3 ? unmeasured : voice)]));
  const brief = interpretCreativeBrief({ description: "Recap", targetSeconds: 90, separatePicture: true,
    soundMomentCount: 3, pictureSourceCount: 4, tempoArc: true }, clips,
  { aspect: "vertical", reduceRumble: false, highlightFocus: "performance" });
  const result = planAudioStory(clips, brief, byPath);
  assert.ok(result.audioSelections.every(s => s.asset.path !== clips[3].asset.path));
});

test("the older non-arc planner does not let spectral texture override stronger classified vocals", () => {
  const clips = [clip(1), clip(2), clip(3)];
  const byPath = { [clips[0].asset.path]: repeat({ ...voice, singingScore: 0.35, crowdNoise: 0.8 }),
    [clips[1].asset.path]: repeat({ ...voice, singingScore: 0.04, crowdNoise: 0.1 }),
    [clips[2].asset.path]: repeat({ ...voice, singingScore: 0.15, crowdNoise: 0.1 }) };
  const brief = interpretCreativeBrief({ description: "Recap", targetSeconds: 24, separatePicture: true,
    soundMomentCount: 2, pictureSourceCount: 3, tempoArc: false }, clips,
  { aspect: "vertical", reduceRumble: false, highlightFocus: "performance" });
  const result = planAudioStory(clips, brief, byPath);
  assert.ok(result.audioSelections.some(s => s.asset.path === clips[0].asset.path));
  assert.ok(result.audioSelections.every(s => s.asset.path !== clips[1].asset.path));
});

test("the non-arc planner can split good long sources before admitting a third crowd recording", () => {
  const clips = [clip(1), clip(2), clip(3)].map((c, i) => ({ ...c,
    asset: { ...c.asset, duration: i < 2 ? 65 : 40, audioDuration: i < 2 ? 65 : 40 } }));
  const byPath = Object.fromEntries(clips.map((c, i) => [c.asset.path, repeat(i < 2 ? voice : crowd, c.asset.duration * 2)]));
  const brief = interpretCreativeBrief({ description: "Recap", targetSeconds: 90, separatePicture: true,
    soundMomentCount: 3, pictureSourceCount: 3, tempoArc: false }, clips,
  { aspect: "vertical", reduceRumble: false, highlightFocus: "performance" });
  const result = planAudioStory(clips, brief, byPath);
  assert.equal(result.audioSelections.length, 3);
  assert.ok(result.audioSelections.every(s => s.asset.path !== clips[2].asset.path));
  assert.ok(Math.abs(result.audioSelections.reduce((sum, s) => sum + s.end - s.start, 0) - 90) < 1e-6);
  assert.match(result.notes.join(" "), /3 sound moments come from 2 recordings/);
});

test("the tempo arc retains a lower-scoring window that finishes with supported singing", () => {
  const clips = [clip(1), clip(2), clip(3)].map(c => ({ ...c, asset: { ...c.asset, duration: 60, audioDuration: 60 } }));
  const withPulse = (rows: AudioBin[], tempo: number) => rows.map((bin, index) => ({ ...bin,
    tempoBpm: tempo, beatConfidence: 0.9, beatTimes: [index * 0.5] }));
  const byPath = { [clips[0].asset.path]: withPulse(repeat(voice, 120), 70),
    [clips[1].asset.path]: withPulse(repeat(voice, 120), 100),
    [clips[2].asset.path]: withPulse([...repeat({ ...voice, rms: 0.25 }, 52), ...repeat(crowd, 8),
      ...repeat({ ...voice, rms: 0.13 }, 60)], 140) };
  const brief = interpretCreativeBrief({ description: "Recap", targetSeconds: 90, separatePicture: true,
    soundMomentCount: 3, pictureSourceCount: 3, tempoArc: true }, clips,
  { aspect: "vertical", reduceRumble: false, highlightFocus: "performance" });
  const result = planAudioStory(clips, brief, byPath);
  const last = result.audioSelections.at(-1)!;
  assert.equal(last.asset.path, clips[2].asset.path);
  assert.ok(last.end > 30, "the higher-mean window ends in crowd; retain an alternative with singing at its end");
  const ending = scoreAudioBins(byPath[last.asset.path].slice(Math.floor((last.end - 4) * 2), Math.ceil(last.end * 2)), "performance");
  const opening = scoreAudioBins(byPath[last.asset.path].slice(Math.floor(last.start * 2), Math.ceil((last.start + 4) * 2)), "performance");
  assert.equal(opening.vocalSupport, true);
  assert.ok(opening.singingEvidence >= opening.crowdEvidence);
  assert.equal(ending.vocalSupport, true);
  assert.match(result.notes.join(" "), /singing-supported final four seconds/);
  assert.ok(result.audioSelections.every(s => Math.abs(s.end - s.start - 30) < 1e-6));
});
