import test from "node:test";
import assert from "node:assert/strict";
import { audibleReviewRanges, buildSoundReview, soundReviewNeedsDecision, soundReviewSignature, type SoundReview } from "../src/shared/audio-review.ts";
import type { AudioSelection, ExportOptions, RenderSelection } from "../src/shared/render-plan.ts";

const options: ExportOptions = { aspect: "vertical", reduceRumble: false, audioTransition: "crossfade", audioCrossfadeSeconds: 2 };
const make = (name: string, start = 5, end = 15): AudioSelection => ({
  asset: { path: name, name, width: 720, height: 1280, duration: 30, audioDuration: 30, hasAudio: true }, start, end });

test("sound review includes borrowed overlap handles and respects manual/protected ranges", () => {
  const sound = [make("a"), make("b")];
  assert.deepEqual(audibleReviewRanges(sound, sound, options).map(s => [s.start, s.end]), [[5, 16], [4, 15]]);
  const protectedPicture: RenderSelection[] = sound.map(s => ({ ...s, selectionSource: "manual" }));
  assert.deepEqual(audibleReviewRanges(protectedPicture, null, options).map(s => [s.start, s.end]), [[5, 15], [5, 15]]);
  assert.deepEqual(audibleReviewRanges(sound, [{ ...sound[0], locked: true }, sound[1]], options).map(s => [s.start, s.end]), [[5, 15], [5, 15]]);
});

test("review approval changes with selected sound, ordering, locks, processing and overlap, but not picture-only finishing", () => {
  const sound = [make("a"), make("b")], signature = soundReviewSignature(sound, sound, options);
  assert.equal(soundReviewSignature(sound.map(s => ({ ...s, focus: 0.3 })), sound, { ...options, finish: "vivid" }), signature);
  for (const changed of [sound.toReversed(), [{ ...sound[0], start: 6 }, sound[1]], [{ ...sound[0], locked: true }, sound[1]]]) {
    assert.notEqual(soundReviewSignature(sound, changed, options), signature);
  }
  assert.notEqual(soundReviewSignature(sound, sound, { ...options, reduceRumble: true }), signature);
  assert.notEqual(soundReviewSignature(sound, sound, { ...options, audioCrossfadeSeconds: 4 }), signature);
  assert.notEqual(soundReviewSignature(sound, sound, { ...options, transition: "fade" }), signature);
});

test("missing analysis requires a review decision; silent footage does not create a false warning", () => {
  const sound = [make("a")];
  const review = buildSoundReview(sound, sound, options, {});
  assert.equal(review.items[0].report.status, "unavailable");
  assert.equal(soundReviewNeedsDecision(review), true);
  const silent = [{ ...sound[0], asset: { ...sound[0].asset, hasAudio: false } }];
  assert.deepEqual(buildSoundReview(silent, null, options, {}).items, []);
});

test("partial coverage is disclosed without forcing acknowledgment for a minor tail, while findings always need a decision", () => {
  const report: SoundReview = { signature: "current", items: [{ selection: make("a"), index: 0,
    report: { status: "partial", intervals: [], risk: 0, analyzedFraction: 0.97 } }] };
  assert.equal(soundReviewNeedsDecision(report), false);
  assert.equal(soundReviewNeedsDecision({ ...report, items: [{ ...report.items[0], report: { ...report.items[0].report, analyzedFraction: 0.5 } }] }), true);
  assert.equal(soundReviewNeedsDecision({ ...report, items: [{ ...report.items[0], report: { ...report.items[0].report, analyzedFraction: 0.81 } }] }), true);
  assert.equal(soundReviewNeedsDecision({ ...report, items: [{ ...report.items[0], selection: make("long", 0, 600),
    report: { ...report.items[0].report, analyzedFraction: 0.99 } }] }), true);
  assert.equal(soundReviewNeedsDecision({ ...report, items: [{ ...report.items[0], report: { ...report.items[0].report,
    intervals: [{ start: 9, end: 10, kind: "speech", severity: 0.6 }] } }] }), true);
});
