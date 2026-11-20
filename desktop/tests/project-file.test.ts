import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectSnapshot } from "../src/shared/project-file.ts";

const project = {
  version: 1,
  clips: [{
    asset: { path: "C:\\concert\\first.mov", name: "first.mov", duration: 60, width: 1920, height: 1080, hasAudio: true },
    start: 10, end: 24, included: true, selectionSource: "manual", locked: true,
    excludedByUser: false, label: "Opening song", previewUrl: "compass-media://preview/session-only",
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
});

test("malformed projects cannot replace validated selection or export settings", () => {
  assert.throws(() => parseProjectSnapshot({ ...project, version: 2 }), /supported/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [{ ...project.clips[0], end: 80 }] }), /invalid section/);
  assert.throws(() => parseProjectSnapshot({ ...project, clips: [project.clips[0], project.clips[0]] }), /same recording/);
  assert.throws(() => parseProjectSnapshot({ ...project, options: { ...project.options, finish: "shell" } }), /invalid video settings/);
  assert.throws(() => parseProjectSnapshot({ ...project, briefInput: { ...project.briefInput, targetSeconds: Number.POSITIVE_INFINITY } }), /invalid creative brief/);
});
