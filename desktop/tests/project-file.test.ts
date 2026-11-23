import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectSnapshot } from "../src/shared/project-file.ts";

const project = {
  version: 1,
  clips: [{
    asset: { path: "C:\\concert\\first.mov", name: "first.mov", duration: 60, width: 1920, height: 1080, hasAudio: true },
    start: 10, end: 24, included: true, selectionSource: "manual", locked: true, orderLocked: true,
    excludedByUser: false, label: "Opening song", framing: "fit", previewUrl: "compass-media://preview/session-only",
  }, {
    asset: { path: "C:\\concert\\second.mov", name: "second.mov", duration: 90, width: 1920, height: 1080, hasAudio: true },
    start: 30, end: 42, included: false, selectionSource: "suggested", locked: false,
    excludedByUser: true,
  }],
  options: { aspect: "landscape", reduceRumble: true, finish: "cinematic", transition: "fade" },
  briefInput: { description: "Keep my marked section", videoType: "recap", vibe: "cinematic", selectionMode: "keep-and-choose", targetSeconds: 120, aspect: "landscape" },
};

test("project round trip retains selected ranges, locks, exclusions, brief and finish", () => {
  const normalized = parseProjectSnapshot(project);
  assert.deepEqual(parseProjectSnapshot(JSON.parse(JSON.stringify(normalized))), normalized);
  assert.deepEqual(normalized.clips.map(({ start, end, locked, excludedByUser }) => ({ start, end, locked, excludedByUser })), [
    { start: 10, end: 24, locked: true, excludedByUser: false },
    { start: 30, end: 42, locked: false, excludedByUser: true },
  ]);
  assert.equal("previewUrl" in normalized.clips[0], false, "temporary preview URLs are not persisted");
  assert.equal(normalized.options.finish, "cinematic");
  assert.equal(normalized.clips[0].label, "Opening song");
  assert.equal(normalized.clips[0].framing, "fit");
  assert.equal(normalized.clips[0].orderLocked, true);
  assert.equal(normalized.clips[1].framing, undefined, "older projects retain the default framing");
  assert.equal(normalized.clips[0].focus, undefined, "older projects keep centered framing unless a focus was saved");
  assert.equal(normalized.version, 2, "older projects reopen in the current project format");
  assert.equal(normalized.audioSelections, null);
  assert.equal(normalized.briefDirty, false);
  assert.equal(normalized.briefInput.tempoArc, undefined, "older projects do not acquire a new music direction");
});

test("saved music direction retains explicit duration and count instead of receiving fresh defaults", () => {
  for (const tempoArc of [true, false]) {
    const saved = parseProjectSnapshot({ ...project, briefDirty: true,
      briefInput: { ...project.briefInput, tempoArc, targetSeconds: 72, soundMomentCount: 4 } });
    const reopened = parseProjectSnapshot(JSON.parse(JSON.stringify(saved)));
    assert.equal(reopened.briefInput.tempoArc, tempoArc);
    assert.equal(reopened.briefInput.targetSeconds, 72);
    assert.equal(reopened.briefInput.soundMomentCount, 4);
    assert.deepEqual(reopened.clips, saved.clips);
    assert.deepEqual(reopened.options, saved.options);
  }
  assert.throws(() => parseProjectSnapshot({ ...project,
    briefInput: { ...project.briefInput, tempoArc: "yes" } }), /invalid creative brief/);
});

test("malformed projects cannot replace validated selection or export settings", () => {
  assert.throws(() => parseProjectSnapshot({ ...project, version: 2 }), /invalid soundtrack/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [{ ...project.clips[0], end: 80 }] }), /invalid section/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [project.clips[0], project.clips[0]] }), /same recording/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [{ ...project.clips[0], framing: "arbitrary" }] }), /invalid section/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [{ ...project.clips[0], focus: -0.1 }] }), /invalid section/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [{ ...project.clips[0], focus: Number.NaN }] }), /invalid section/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [{ ...project.clips[0], orderLocked: "yes" }] }), /invalid section/);
  assert.throws(() => parseProjectSnapshot({ ...project, options: { ...project.options, finish: "shell" } }), /invalid video settings/);
  assert.throws(() => parseProjectSnapshot({ ...project, briefInput: { ...project.briefInput, targetSeconds: Number.POSITIVE_INFINITY } }), /invalid creative brief/);
});

test("9:13 projects retain focal position without changing older 9:16 projects", () => {
  const portrait = parseProjectSnapshot({ ...project,
    clips: [{ ...project.clips[0], framing: "fill", focus: 0.15 }, project.clips[1]],
    options: { ...project.options, aspect: "portrait913" },
    briefInput: { ...project.briefInput, aspect: "portrait913" },
  });
  assert.equal(portrait.options.aspect, "portrait913");
  assert.equal(portrait.briefInput.aspect, "portrait913");
  assert.equal(portrait.clips[0].focus, 0.15);
  assert.deepEqual(parseProjectSnapshot(JSON.parse(JSON.stringify(portrait))), portrait);
  const oldPortrait = parseProjectSnapshot({ ...project, options: { ...project.options, aspect: "vertical" } });
  assert.equal(oldPortrait.options.aspect, "vertical");
});

test("projects keep optional visual titles and named-moment display choices", () => {
  const saved = parseProjectSnapshot({ ...project,
    options: { ...project.options, eventTitle: "Olivia's Night", showClipLabels: true },
    briefInput: { ...project.briefInput, eventTitle: "Olivia's Night", showClipLabels: true },
  });
  assert.equal(saved.options.eventTitle, "Olivia's Night");
  assert.equal(saved.options.showClipLabels, true);
  assert.equal(saved.briefInput.eventTitle, "Olivia's Night");
  assert.deepEqual(parseProjectSnapshot(JSON.parse(JSON.stringify(saved))), saved);
  assert.throws(() => parseProjectSnapshot({ ...project,
    options: { ...project.options, eventTitle: "x".repeat(81) } }), /invalid video settings/);
});

test("v2 saves independent sound moments and an unfinished edit without losing recoverable work", () => {
  const source = project.clips[0].asset;
  const normalized = parseProjectSnapshot({ ...project, version: 2, briefDirty: true,
    briefInput: { ...project.briefInput, reduceRumble: false, separatePicture: true,
      soundMomentCount: 3, pictureSourceCount: 2 },
    clips: [{ ...project.clips[0], end: 26 }, project.clips[1]],
    audioSelections: [
      { asset: { ...source, previewUrl: "session-only" }, start: 10, end: 24, locked: true },
      { asset: source, start: 30, end: 36 },
    ],
  });
  assert.equal(normalized.briefDirty, true);
  assert.equal(normalized.briefInput.reduceRumble, false);
  assert.equal(normalized.briefInput.separatePicture, true);
  assert.equal(normalized.briefInput.soundMomentCount, 3);
  assert.equal(normalized.briefInput.pictureSourceCount, 2);
  assert.equal(normalized.audioSelections?.length, 2);
  assert.equal(normalized.audioSelections?.[0].locked, true);
  assert.equal("previewUrl" in normalized.audioSelections![0].asset, false);
  assert.equal(normalized.clips[0].end, 26, "unfinished picture edit remains recoverable");
  assert.deepEqual(parseProjectSnapshot(JSON.parse(JSON.stringify(normalized))), normalized);
  const excludedAfterEdit = parseProjectSnapshot({ ...project, version: 2, briefDirty: true,
    audioSelections: [{ asset: project.clips[1].asset, start: 30, end: 42 }] });
  assert.equal(excludedAfterEdit.audioSelections?.[0].asset.path, project.clips[1].asset.path,
    "an unfinished exclusion can be saved and reopened before the soundtrack is rebuilt");
});

test("v2 rejects missing, silent, overlapping, or out-of-bounds sound ranges", () => {
  const source = project.clips[0].asset;
  const base = { ...project, version: 2, audioSelections: [{ asset: source, start: 10, end: 24 }] };
  assert.throws(() => parseProjectSnapshot({ ...base, audioSelections: [
    { asset: { ...source, path: "C:\\unimported.mov" }, start: 10, end: 24 },
  ] }), /missing/);
  assert.throws(() => parseProjectSnapshot({ ...base, clips: [
    { ...project.clips[0], asset: { ...source, hasAudio: false } }, project.clips[1],
  ] }), /silent/);
  assert.throws(() => parseProjectSnapshot({ ...base, audioSelections: [
    { asset: source, start: 10, end: 24 }, { asset: source, start: 23, end: 30 },
  ] }), /repeats/);
  assert.throws(() => parseProjectSnapshot({ ...base, audioSelections: [
    { asset: source, start: 58, end: 70 },
  ] }), /outside/);
  assert.throws(() => parseProjectSnapshot({ ...base, briefDirty: "yes" }), /invalid edit status/);
  assert.throws(() => parseProjectSnapshot({ ...base,
    briefInput: { ...project.briefInput, reduceRumble: "off" } }), /invalid creative brief/);
  assert.throws(() => parseProjectSnapshot({ ...base,
    briefInput: { ...project.briefInput, separatePicture: "yes" } }), /invalid creative brief/);
  assert.throws(() => parseProjectSnapshot({ ...base,
    briefInput: { ...project.briefInput, soundMomentCount: 0 } }), /invalid creative brief/);
  assert.throws(() => parseProjectSnapshot({ ...base,
    briefInput: { ...project.briefInput, pictureSourceCount: 2.5 } }), /invalid creative brief/);
});

test("new finishing settings round trip without changing protected sections or independent sound", () => {
  const options = { aspect: "vertical", reduceRumble: true, finish: "natural", transition: "dissolve",
    quality: "high", enhance: true, audioTransition: "crossfade", audioCrossfadeSeconds: 2,
    beatSync: true, highlightFocus: "performance", eventTitle: "", showClipLabels: false };
  const saved = parseProjectSnapshot({ ...project, version: 2, options,
    briefInput: { ...project.briefInput, transition: "dissolve", beatSync: true, highlightFocus: "performance" },
    audioSelections: [{ asset: project.clips[0].asset, start: 10, end: 24, locked: true }] });
  assert.deepEqual(saved.options, options);
  assert.equal(saved.briefInput.transition, "dissolve", "an explicit picture-transition choice survives review and reopen");
  assert.equal(saved.briefInput.beatSync, true, "the explicit timing choice still overrides prompt wording after reopening");
  assert.equal(saved.briefInput.highlightFocus, "performance");
  assert.deepEqual([saved.clips[0].start, saved.clips[0].end, saved.clips[0].locked, saved.clips[1].excludedByUser], [10, 24, true, true]);
  assert.deepEqual(saved.audioSelections?.map(({ start, end, locked }) => ({ start, end, locked })), [{ start: 10, end: 24, locked: true }]);
  assert.deepEqual(parseProjectSnapshot(JSON.parse(JSON.stringify(saved))), saved);
  const slide = parseProjectSnapshot({ ...saved, options: { ...options, transition: "smoothslide", quality: "standard", enhance: false, audioTransition: "cut", audioCrossfadeSeconds: 0.1, beatSync: false, highlightFocus: "balanced" } });
  assert.equal(slide.options.transition, "smoothslide");
  assert.equal(slide.options.audioCrossfadeSeconds, 0.1);
  assert.equal(slide.options.beatSync, false);
  assert.equal(slide.options.highlightFocus, "balanced");
  assert.equal(parseProjectSnapshot({ ...saved, options: { ...options, audioCrossfadeSeconds: 5 } }).options.audioCrossfadeSeconds, 5);
});

test("older projects retain their original framing and joins without receiving new export defaults", () => {
  for (const input of [project, { ...project, version: 2, audioSelections: null }]) {
    const saved = parseProjectSnapshot(input);
    assert.deepEqual(saved.options, project.options);
    for (const field of ["quality", "enhance", "audioTransition", "audioCrossfadeSeconds", "beatSync", "highlightFocus"]) {
      assert.equal(field in saved.options, false, `legacy projects must not acquire ${field}`);
    }
    assert.equal("audioDuration" in saved.clips[0].asset, false);
    assert.equal("beatSync" in saved.briefInput, false);
    assert.equal("highlightFocus" in saved.briefInput, false);
  }
});

test("invalid finishing controls cannot enter a saved project", () => {
  const invalidOptions = [
    { quality: "ultra" }, { enhance: "yes" }, { audioTransition: "blend" }, { transition: "arbitrary" },
    { beatSync: "yes" }, { beatSync: 1 }, { highlightFocus: "vocal-recognition" }, { highlightFocus: true },
    ...[0, 0.09, 5.01, Number.NaN, Number.POSITIVE_INFINITY, "2"].map((audioCrossfadeSeconds) => ({ audioCrossfadeSeconds })),
  ];
  for (const invalid of invalidOptions) {
    assert.throws(() => parseProjectSnapshot({ ...project, options: { ...project.options, ...invalid } }), /invalid video settings/);
  }
  assert.throws(() => parseProjectSnapshot({ ...project,
    briefInput: { ...project.briefInput, transition: "arbitrary" } }), /invalid creative brief/);
  for (const invalid of [{ beatSync: "yes" }, { highlightFocus: "vocal-recognition" }]) {
    assert.throws(() => parseProjectSnapshot({ ...project,
      briefInput: { ...project.briefInput, ...invalid } }), /invalid creative brief/);
  }
});

test("measured audio coverage survives project reopen for both picture and soundtrack sources", () => {
  const asset = { ...project.clips[0].asset, audioDuration: 55.25 };
  const saved = parseProjectSnapshot({ ...project, version: 2,
    clips: [{ ...project.clips[0], asset }, project.clips[1]],
    audioSelections: [{ asset, start: 10, end: 24, locked: true }] });
  assert.equal(saved.clips[0].asset.audioDuration, 55.25);
  assert.equal(saved.audioSelections?.[0].asset.audioDuration, 55.25);
  assert.deepEqual(parseProjectSnapshot(JSON.parse(JSON.stringify(saved))), saved);
  for (const audioDuration of [0, -1, 60.26, Number.NaN, Number.POSITIVE_INFINITY, "55"]) {
    assert.throws(() => parseProjectSnapshot({ ...project,
      clips: [{ ...project.clips[0], asset: { ...asset, audioDuration } }, project.clips[1]] }), /invalid video/);
  }
  assert.equal(parseProjectSnapshot({ ...project,
    clips: [{ ...project.clips[0], asset: { ...asset, audioDuration: 60.25 } }, project.clips[1]] }).clips[0].asset.audioDuration, 60.25);
});
