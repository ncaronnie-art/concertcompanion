import test from "node:test";
import assert from "node:assert/strict";
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.ts";
import { parseProjectSnapshot } from "../src/shared/project-file.ts";
const clips: CreativeClip[] = [1, 2, 3].map(id => ({ asset: { path: `source${id}.mp4`, name: `source${id}.mp4`, duration: 60,
  width: 720, height: 1280, hasAudio: true }, start: 1, end: 13, included: true, selectionSource: "suggested", locked: false, excludedByUser: false }));
const options = { aspect: "vertical" as const, reduceRumble: false };
const briefInput = { description: "Three sound moments with separate pictures", separatePicture: true, targetSeconds: 90, soundMomentCount: 3, pictureSourceCount: 3 };
test("picture-only source preferences save and reopen independently of picture inclusion", () => {
  const saved = parseProjectSnapshot({ version: 2, clips: clips.map((clip, i) => ({ ...clip, soundExcludedByUser: i === 0 })), options, briefInput, audioSelections: null });
  assert.equal(saved.clips[0].included, true);
  assert.equal(saved.clips[0].excludedByUser, false);
  assert.equal(saved.clips[0].soundExcludedByUser, true);
  assert.deepEqual(parseProjectSnapshot(JSON.parse(JSON.stringify(saved))), saved);
  const old = parseProjectSnapshot({ version: 2, clips, options, briefInput, audioSelections: null });
  assert.equal(old.clips[0].soundExcludedByUser, undefined);
  assert.throws(() => parseProjectSnapshot({ ...saved, clips: [{ ...saved.clips[0], soundExcludedByUser: "yes" }] }), /invalid section/);
});
test("a kept original sound cannot silently be discarded by a picture-only preference", () => {
  const next = clips.map((clip, i) => i === 0 ? { ...clip, locked: true, soundExcludedByUser: true } : clip);
  const brief = interpretCreativeBrief(briefInput, next, options);
  assert.equal(brief.conflict?.kind, "audio-story-picture-only-lock");
  assert.match(brief.conflict?.message ?? "", /Allow its sound, or unlock/);
});
test("available soundtrack length omits picture-only recordings while picture counts stay valid", () => {
  const next = clips.map((clip, i) => ({ ...clip, soundExcludedByUser: i !== 2 }));
  const brief = interpretCreativeBrief(briefInput, next, options);
  assert.equal(brief.pictureSourceCount, 3);
  assert.equal(brief.conflict?.kind, "audio-story-insufficient-audio");
  assert.equal(brief.conflict?.availableSeconds, 60);
});
