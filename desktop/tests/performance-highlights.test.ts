import test from "node:test";
import assert from "node:assert/strict";
import { chooseAudioHighlight, scoreAudioBins, type AudioBin } from "../src/shared/suggestions.ts";
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.ts";
import { planAudioStory } from "../src/shared/audio-story.ts";

const clip = (id: number): CreativeClip => ({ asset: { path: `clip${id}.mp4`, name: `clip${id}.mp4`, duration: 40,
  audioDuration: 40, width: 720, height: 1280, hasAudio: true }, start: 14, end: 26,
  included: true, selectionSource: "suggested", locked: false, excludedByUser: false });
const noisy: AudioBin = { rms: 0.4, clipping: 0, tonalProminence: 0.08, crowdNoise: 0.9 };
const musical: AudioBin = { rms: 0.12, clipping: 0, tonalProminence: 0.8, crowdNoise: 0.1 };
const measured = [...Array.from({ length: 40 }, () => ({ ...noisy })), ...Array.from({ length: 40 }, () => ({ ...musical }))];

test("performance preference chooses a quieter sustained phrase over a louder noisy section", () => {
  const asset = clip(1).asset;
  assert.equal(chooseAudioHighlight(asset, measured, 0.5, "balanced").start, 0);
  const preferred = chooseAudioHighlight(asset, measured, 0.5, "performance");
  assert.equal(preferred.start, 20);
  assert.match(preferred.reason, /does not identify the singer/);
  assert.ok(scoreAudioBins([musical], "performance").score > scoreAudioBins([noisy], "performance").score);
  assert.ok(scoreAudioBins([noisy], "performance").score > scoreAudioBins([{ ...noisy, rms: 0 }], "performance").score,
    "the preference must not replace audible material with silence");
  const legacy = measured.map(({ rms, clipping }) => ({ rms, clipping }));
  assert.equal(chooseAudioHighlight(asset, legacy, 0.5, "performance").start, 0);
});

test("creative language uses the same validated music preferences and explicit choices win", () => {
  const clips = [clip(1), clip(2), clip(3)];
  const input = { description: "Beat matching, video cuts follow the music, and big vocal moments over crowd noise. No text." };
  const brief = interpretCreativeBrief(input, clips, { aspect: "vertical", reduceRumble: false });
  assert.equal(brief.options.beatSync, true);
  assert.equal(brief.options.highlightFocus, "performance");
  assert.equal(brief.options.audioTransition, "crossfade");
  assert.equal(brief.options.eventTitle, "");
  assert.equal(brief.options.showClipLabels, false);
  const separateSentences = interpretCreativeBrief({ description: "Favor big vocal moments over crowd noise. Video cuts follow the music." }, clips,
    { aspect: "vertical", reduceRumble: false });
  assert.doesNotMatch(separateSentences.limitations.join(" "), /Portrait cropping/);
  const explicit = interpretCreativeBrief({ ...input, beatSync: false, highlightFocus: "balanced" }, clips,
    { aspect: "vertical", reduceRumble: false });
  assert.equal(explicit.options.beatSync, false);
  assert.equal(explicit.options.highlightFocus, "balanced");
  const negative = interpretCreativeBrief({ description: "No beat matching. Do not favor the performance." }, clips,
    { aspect: "vertical", reduceRumble: false, beatSync: true, highlightFocus: "performance" });
  assert.equal(negative.options.beatSync, false);
  assert.equal(negative.options.highlightFocus, "balanced");
});

test("performance preference changes actual soundtrack ranges without changing count, duration, or originals", () => {
  const clips = [clip(1), clip(2), clip(3)];
  const original = structuredClone(clips);
  const bins = Object.fromEntries(clips.map(c => [c.asset.path, measured]));
  const make = (highlightFocus: "balanced" | "performance") => planAudioStory(clips, interpretCreativeBrief({
    description: "A recap with three sound moments and separate pictures", targetSeconds: 36,
    separatePicture: true, soundMomentCount: 3, pictureSourceCount: 3 }, clips,
    { aspect: "vertical", reduceRumble: false, highlightFocus }), bins);
  const before = make("balanced"), after = make("performance");
  assert.equal(after.audioSelections.length, 3);
  assert.equal(after.plannedSeconds, 36);
  assert.ok(before.audioSelections.every(s => s.start < 1));
  assert.ok(after.audioSelections.every(s => s.start >= 20));
  assert.deepEqual(clips, original);
});

test("a requested energy build does not let crowd noise win over performance cues", () => {
  const clips = [clip(1), clip(2), clip(3), clip(4)];
  const cues = [{ ...musical, rms: 0.2 }, { ...musical, rms: 0.12 }, { ...musical, rms: 0.13 }, { ...noisy, rms: 0.15 }];
  const bins = Object.fromEntries(clips.map((c, i) => [c.asset.path, Array.from({ length: 80 }, () => ({ ...cues[i] }))]));
  const brief = interpretCreativeBrief({ description: "Three sound moments ending with a crescendo and separate pictures", targetSeconds: 36,
    separatePicture: true, soundMomentCount: 3, pictureSourceCount: 3 }, clips,
    { aspect: "vertical", reduceRumble: false, highlightFocus: "performance" });
  const result = planAudioStory(clips, brief, bins);
  assert.ok(result.audioSelections.every(s => s.asset.path !== "clip4.mp4"), "crowd-like source cannot win just by matching a loudness target");
  const legacy = Object.fromEntries(Object.entries(bins).map(([p, bins]) => [p, bins.map(({ rms, clipping }) => ({ rms, clipping }))]));
  const fallback = planAudioStory(clips, brief, legacy);
  assert.match(fallback.notes.join(" "), /performance cues were unavailable/);
  assert.doesNotMatch(fallback.notes.join(" "), /Favored sustained/);
});
