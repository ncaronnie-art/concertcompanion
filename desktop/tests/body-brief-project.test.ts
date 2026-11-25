import test from "node:test";
import assert from "node:assert/strict";
import { interpretCreativeBrief, makeFirstCut, type CreativeClip } from "../src/shared/creative-brief.js";
import { parseProjectSnapshot } from "../src/shared/project-file.js";

const clip: CreativeClip = { asset: { path: "C:\\concert\\hero.mov", name: "hero.mov", duration: 60, width: 1920, height: 1080, hasAudio: true },
  start: 12, end: 24, included: true, selectionSource: "manual", locked: true, excludedByUser: false, subject: { x: .6, y: .4 } };
const options = { aspect: "vertical" as const, reduceRumble: true, audioTransition: "crossfade" as const, audioCrossfadeSeconds: 2.5, beatSync: true };

test("a body-tracing brief becomes a validated visual setting without replacing the locked performance or sound settings", () => {
  const input = { description: "Electric body-tracing neon outlines, no added text", selectionMode: "use-my-sections" as const };
  const brief = interpretCreativeBrief(input, [clip], options);
  const cut = makeFirstCut([clip], brief);
  assert.equal(cut.options.bodyOutline, "electric");
  assert.match(brief.summary, /electric performer outlines/);
  assert.equal(cut.options.eventTitle, ""); assert.equal(cut.options.showClipLabels, false);
  for (const key of ["reduceRumble", "audioTransition", "audioCrossfadeSeconds", "beatSync"] as const) assert.equal(cut.options[key], options[key]);
  assert.deepEqual(cut.clips.map(c => [c.asset.path, c.start, c.end, c.locked, c.subject]), [[clip.asset.path, 12, 24, true, clip.subject]]);
  const soft = interpretCreativeBrief({ ...input, description: "Soft performer outlines" }, [clip], cut.options);
  assert.equal(soft.options.bodyOutline, "subtle");
  assert.equal(interpretCreativeBrief({ ...input, description: "Electric body outlines with soft bloom and gentler effects" }, [clip], cut.options).options.bodyOutline, "electric");
  for (const description of ["No neon outlines", "Without body outlines", "Do not use effects"]) {
    assert.equal(interpretCreativeBrief({ ...input, description }, [clip], cut.options).options.bodyOutline, "off");
  }
});

test("saving retains the outline choice and subject but discards private mask paths", () => {
  const saved = parseProjectSnapshot({ version: 1, clips: [{ ...clip, bodyMask: { path: "C:\\private\\injected.mkv" } }],
    options: { ...options, bodyOutline: "electric" }, briefInput: { description: "Keep it", selectionMode: "use-my-sections" } });
  const reopened = parseProjectSnapshot(JSON.parse(JSON.stringify(saved)));
  assert.equal(reopened.options.bodyOutline, "electric"); assert.equal("bodyMask" in reopened.clips[0], false);
  assert.deepEqual(reopened.clips[0].subject, clip.subject);
  assert.deepEqual(reopened.clips.map(c => [c.start, c.end, c.locked]), [[12, 24, true]]);
  assert.equal(parseProjectSnapshot({ ...saved, options }).options.bodyOutline, undefined, "an older project never acquires an effect");
  assert.throws(() => parseProjectSnapshot({ ...saved, options: { ...options, bodyOutline: "movie=unsafe" } }), /invalid video settings/);
});
