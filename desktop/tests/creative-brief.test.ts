import test from "node:test";
import assert from "node:assert/strict";
import { interpretCreativeBrief, makeFirstCut, refineCut, type CreativeClip } from "../src/shared/creative-brief.ts";

const options = { aspect: "vertical" as const, reduceRumble: true };
const recording = (number: number, extra: Partial<CreativeClip> = {}): CreativeClip => ({
  asset: { path: `C:\\recording-${number}.mov`, name: `Recording ${number}`, duration: 90, width: 1920, height: 1080, hasAudio: true },
  start: 39, end: 51, included: true, selectionSource: "suggested", locked: false, excludedByUser: false, ...extra,
});

test("plain brief uses existing manual section, parses a length, and asks before shortening protected footage", () => {
  const clips = [recording(1, { start: 5, end: 185, asset: { ...recording(1).asset, duration: 240 }, selectionSource: "manual", locked: true }), recording(2)];
  const brief = interpretCreativeBrief({ description: "Give me a two-minute recap of the whole night. Make it energetic, include several songs, and keep the section I marked. Vertical." }, clips, options);
  assert.equal(brief.videoType, "recap");
  assert.equal(brief.vibe, "energetic");
  assert.equal(brief.selectionMode, "keep-and-choose");
  assert.equal(brief.targetSeconds, 120);
  assert.equal(brief.options.finish, "vivid");
  assert.equal(brief.options.transition, "cut");
  assert.equal(brief.options.reduceRumble, true);
  assert.equal(brief.conflict?.kind, "protected-over-target");
  assert.match(brief.summary, /marked sections stay/);
  assert.match(brief.limitations.join(" "), /not identified automatically/);
  assert.throws(() => makeFirstCut(clips, brief), /marked sections/);
  const cut = makeFirstCut(clips, brief, "extend");
  assert.equal(cut.clips[0].start, 5);
  assert.equal(cut.clips[0].end, 185);
  assert.equal(cut.clips[0].locked, true);
  assert.equal(cut.plannedSeconds, 180);
  assert.equal(clips[0].end, 185);
});

test("choose for me still protects a manually marked section and an explicit exclusion", () => {
  const clips = [recording(1, { start: 12, end: 25, selectionSource: "manual", locked: true }), recording(2, { included: false, excludedByUser: true }), recording(3)];
  const brief = interpretCreativeBrief({ description: "Choose for me", targetSeconds: 30 }, clips, options);
  const cut = makeFirstCut(clips, brief);
  assert.deepEqual([cut.clips[0].start, cut.clips[0].end], [12, 25]);
  assert.equal(cut.clips[0].locked, true);
  assert.equal(cut.clips[1].included, false);
  assert.equal(cut.clips[1].excludedByUser, true);
  assert.equal(cut.clips[2].included, true);
  assert.ok(Math.abs(cut.plannedSeconds - 30) < 0.05);
});

test("use my sections includes only marked ranges and asks for a mark when none exists", () => {
  const clips = [recording(1), recording(2, { selectionSource: "manual", locked: true, start: 20, end: 44 })];
  const brief = interpretCreativeBrief({ description: "Use my sections" }, clips, options);
  const cut = makeFirstCut(clips, brief);
  assert.deepEqual(cut.clips.map((clip) => clip.included), [false, true]);
  assert.equal(cut.plannedSeconds, 24);
  assert.equal(interpretCreativeBrief({ description: "Use my sections" }, [recording(1)], options).conflict?.kind, "no-marked-sections");
});

test("vibes change selection density and supported finishing choices", () => {
  const clips = Array.from({ length: 8 }, (_, index) => recording(index + 1));
  const energetic = interpretCreativeBrief({ description: "", vibe: "energetic", targetSeconds: 80 }, clips, options);
  const cinematic = interpretCreativeBrief({ description: "", vibe: "cinematic", targetSeconds: 80 }, clips, options);
  const clean = interpretCreativeBrief({ description: "", vibe: "clean-live", targetSeconds: 80 }, clips, options);
  assert.equal(makeFirstCut(clips, energetic).clips.filter((clip) => clip.included).length, 8);
  assert.equal(makeFirstCut(clips, cinematic).clips.filter((clip) => clip.included).length, 3);
  assert.equal(makeFirstCut(clips, clean).clips.filter((clip) => clip.included).length, 2);
  assert.deepEqual([cinematic.options.finish, cinematic.options.transition], ["cinematic", "fade"]);
  assert.deepEqual([clean.options.finish, clean.options.transition], ["natural", "cut"]);
});

test("one-song stays in one recording, and unsupported requests are disclosed", () => {
  const clips = [recording(1), recording(2)];
  const brief = interpretCreativeBrief({ description: "Just this song, horizontal, with lyrics and slow motion", targetSeconds: 30 }, clips, options);
  assert.equal(brief.videoType, "one-song");
  assert.equal(brief.aspect, "landscape");
  assert.equal(makeFirstCut(clips, brief).clips.filter((clip) => clip.included).length, 1);
  assert.match(brief.limitations.join(" "), /Text overlays and captions/);
  assert.match(brief.limitations.join(" "), /speed changes/);
  const named = interpretCreativeBrief({ description: "Several songs" }, [recording(1, { label: "Song A" }), recording(2, { label: "Song B" })], options);
  assert.match(named.summary, /your labeled songs/);
  assert.match(named.limitations.join(" "), /labels/);
});

test("one-song with a marked section keeps its existing length when no new target is supplied", () => {
  const clips = [recording(1, { start: 15, end: 35, selectionSource: "manual", locked: true }), recording(2)];
  const brief = interpretCreativeBrief({ description: "Just this song. Keep my selected section intact." }, clips, options);
  assert.equal(brief.conflict, null);
  assert.match(brief.summary, /^0:20/);
  const cut = makeFirstCut(clips, brief);
  assert.equal(cut.plannedSeconds, 20);
  assert.deepEqual(cut.clips.map((clip) => clip.included), [true, false]);
  assert.deepEqual([cut.clips[0].start, cut.clips[0].end], [15, 35]);
});

test("length review counts only footage available without changing a locked range", () => {
  const clips = [recording(1, { start: 10, end: 20, selectionSource: "manual", locked: true }), recording(2)];
  const brief = interpretCreativeBrief({ description: "A long recap", targetSeconds: 120 }, clips, options);
  assert.equal(brief.conflict?.kind, "insufficient-footage");
  assert.equal(brief.conflict?.availableSeconds, 100);
  assert.match(brief.conflict?.message ?? "", /without changing marked sections/);
});

test("a several-song brief prefers distinct user-labeled recordings without claiming detection", () => {
  const clips = Array.from({ length: 8 }, (_, index) => recording(index + 1));
  clips[5].label = "Song A";
  clips[6].label = "Song B";
  const brief = interpretCreativeBrief({ description: "A cinematic recap with several songs", targetSeconds: 30 }, clips, options);
  const cut = makeFirstCut(clips, brief);
  assert.equal(cut.clips[5].included, true);
  assert.equal(cut.clips[6].included, true);
  assert.match(brief.limitations.join(" "), /not detected/);
});

test("refinements change only the requested section, keep locks, and use no reanalysis", () => {
  const clips = [recording(1, { start: 5, end: 17, selectionSource: "manual", locked: true }), recording(2), recording(3)];
  const brief = interpretCreativeBrief({ description: "", targetSeconds: 36 }, clips, options);
  const alternate = refineCut(clips, { kind: "choose-another", path: clips[1].asset.path }, brief);
  assert.ok(alternate.clips[1].start >= clips[1].end);
  assert.deepEqual(alternate.clips[0], clips[0]);
  assert.deepEqual(alternate.clips[2], clips[2]);
  assert.deepEqual(clips[1], recording(2));
  const kept = refineCut(alternate.clips, { kind: "keep-section", path: clips[1].asset.path }, brief);
  assert.equal(kept.clips[1].locked, true);
  assert.throws(() => refineCut(kept.clips, { kind: "choose-another", path: clips[1].asset.path }, brief), /protected/);
  const fewer = refineCut(clips, { kind: "fewer-cuts" }, brief);
  assert.equal(fewer.clips[0].included, true);
  assert.equal(fewer.clips.filter((clip) => clip.included).length, 2);
  assert.match(fewer.notes[0], /shorter/);
});
