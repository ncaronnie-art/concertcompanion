import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectSnapshot } from "../src/shared/project-file.ts";

const project = {
  version: 1,
  clips: [{
    asset: { path: "C:\\concert\\first.mov", name: "first.mov", duration: 60, width: 1920, height: 1080, hasAudio: true },
    start: 10, end: 24, included: true, selectionSource: "manual", locked: true,
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
  assert.equal(normalized.clips[1].framing, undefined, "older projects retain the default framing");
  assert.equal(normalized.version, 2, "older projects reopen in the current project format");
  assert.equal(normalized.audioSelections, null);
  assert.equal(normalized.briefDirty, false);
});

test("malformed projects cannot replace validated selection or export settings", () => {
  assert.throws(() => parseProjectSnapshot({ ...project, version: 2 }), /invalid soundtrack/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [{ ...project.clips[0], end: 80 }] }), /invalid section/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [project.clips[0], project.clips[0]] }), /same recording/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [{ ...project.clips[0], framing: "arbitrary" }] }), /invalid section/);
  assert.throws(() => parseProjectSnapshot({ ...project, options: { ...project.options, finish: "shell" } }), /invalid video settings/);
  assert.throws(() => parseProjectSnapshot({ ...project, briefInput: { ...project.briefInput, targetSeconds: Number.POSITIVE_INFINITY } }), /invalid creative brief/);
});

test("v2 saves independent sound moments and an unfinished edit without losing recoverable work", () => {
  const source = project.clips[0].asset;
  const normalized = parseProjectSnapshot({ ...project, version: 2, briefDirty: true,
    briefInput: { ...project.briefInput, reduceRumble: false },
    clips: [{ ...project.clips[0], end: 26 }, project.clips[1]],
    audioSelections: [
      { asset: { ...source, previewUrl: "session-only" }, start: 10, end: 24, locked: true },
      { asset: source, start: 30, end: 36 },
    ],
  });
  assert.equal(normalized.briefDirty, true);
  assert.equal(normalized.briefInput.reduceRumble, false);
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
});
