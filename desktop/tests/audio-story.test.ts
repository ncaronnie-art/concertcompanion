import test from "node:test";
import assert from "node:assert/strict";
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.ts";
import { planAudioStory, refineAudioStory } from "../src/shared/audio-story.ts";
import type { AudioBin } from "../src/shared/suggestions.ts";

const recording = (number: number, extra: Partial<CreativeClip> = {}): CreativeClip => ({
  asset: { path: `C:\\show\\clip-${number}.mov`, name: `clip-${number}.mov`, duration: 90,
    width: 1920, height: 1080, hasAudio: true },
  start: 39, end: 51, included: true, selectionSource: "suggested", locked: false,
  excludedByUser: false, ...extra,
});
const bins = (rms: number, count = 180): AudioBin[] =>
  Array.from({ length: count }, () => ({ rms, clipping: 0 }));
const total = (items: Array<{start:number;end:number}>) =>
  items.reduce((value, item) => value + item.end - item.start, 0);
const prompt = "3 audio clips featuring the cleaning audio and ending with a crescendo. I want video footage from multiple clips on top of that.";

const shortRecording = (number: number, extra: Partial<CreativeClip> = {}): CreativeClip =>
  recording(number, { asset: { ...recording(number).asset, duration: 2 }, start: 0, end: 2, ...extra });
const separatePrompt = "Three audio moments and video footage from multiple clips over the soundtrack.";

test("separate picture does not silently reproduce the joined edit with three fully used recordings", () => {
  const clips = [shortRecording(1), shortRecording(2), shortRecording(3),
    shortRecording(4, { included: false, excludedByUser: true })];
  const brief = interpretCreativeBrief({ description: separatePrompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip) => [clip.asset.path, bins(0.2, 4)]));
  const result = planAudioStory(clips, brief, byPath);
  const shots = result.clips.filter((clip) => clip.included);
  assert.equal(result.audioSelections.length, 3);
  assert.equal(result.clips[3].excludedByUser, true);
  assert.equal(result.clips[3].included, false);
  assert.ok(shots.every((clip, index) => clip.asset.path !== result.audioSelections[index].asset.path),
    "picture should not repeat its original source sound at the same output positions");
  assert.deepEqual(clips.slice(0, 3).map((clip) => clip.asset.name), ["clip-1.mov", "clip-2.mov", "clip-3.mov"],
    "source selections are unchanged");
});

test("protected picture and sound stay aligned while other suggested shots separate", () => {
  const clips = [shortRecording(1), shortRecording(2, { locked: true, selectionSource: "manual" }), shortRecording(3)];
  const brief = interpretCreativeBrief({ description: separatePrompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip) => [clip.asset.path, bins(0.2, 4)]));
  const result = planAudioStory(clips, brief, byPath);
  assert.equal(result.clips[1].asset.path, clips[1].asset.path);
  assert.deepEqual([result.clips[1].start, result.clips[1].end, result.clips[1].locked], [0, 2, true]);
  assert.deepEqual([result.audioSelections[1].asset.path, result.audioSelections[1].start,
    result.audioSelections[1].end, result.audioSelections[1].locked], [clips[1].asset.path, 0, 2, true]);
  assert.notEqual(result.clips[0].asset.path, result.audioSelections[0].asset.path);
  assert.notEqual(result.clips[2].asset.path, result.audioSelections[2].asset.path);
});

test("manual clip order is never changed to fake a separate picture edit", () => {
  const clips = [shortRecording(1, { orderLocked: true }), shortRecording(2, { locked: true,
    selectionSource: "manual" }), shortRecording(3, { orderLocked: true })];
  const brief = interpretCreativeBrief({ description: separatePrompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip) => [clip.asset.path, bins(0.2, 4)]));
  assert.throws(() => planAudioStory(clips, brief, byPath), /picture sections would still match their original sound/);
  assert.deepEqual(clips.map((clip) => clip.asset.name), ["clip-1.mov", "clip-2.mov", "clip-3.mov"]);
});

test("ordered suggested shots use different source windows when their recordings have room", () => {
  const clips = [1, 2].map((number) => recording(number, {
    asset: { ...recording(number).asset, duration: 4 }, start: 0, end: 2,
    orderLocked: true,
  }));
  const brief = interpretCreativeBrief({ description:
    "Two audio moments and video footage from multiple clips over the soundtrack." }, clips,
  { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip) => [clip.asset.path, bins(0.2, 8)]));
  const result = planAudioStory(clips, brief, byPath);
  assert.deepEqual(result.clips.map((clip) => clip.asset.path), clips.map((clip) => clip.asset.path),
    "manual order remains intact");
  assert.ok(result.clips.some((clip, index) => Math.abs(clip.start - result.audioSelections[index].start) >= 0.5),
    "at least one picture window differs from the original sound window");
});

test("three measured sound moments build under a separate multi-recording picture edit", () => {
  const clips = [recording(1), recording(2), recording(3)];
  const brief = interpretCreativeBrief({ description: prompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip, index) =>
    [clip.asset.path, bins([0.08, 0.24, 0.48][index])])) as Record<string, AudioBin[]>;
  const result = planAudioStory(clips, brief, byPath);
  assert.equal(result.audioSelections.length, 3);
  assert.equal(new Set(result.audioSelections.map((selection) => selection.asset.path)).size, 3);
  assert.deepEqual(result.audioSelections.map((selection) =>
    byPath[selection.asset.path][0].rms), [0.08, 0.24, 0.48]);
  assert.equal(result.clips.filter((clip) => clip.included).length, 3);
  assert.ok(Math.abs(total(result.audioSelections) - total(result.clips.filter((clip) => clip.included))) < 0.05);
  assert.equal(result.options.reduceRumble, true);
  assert.match(result.notes.join(" "), /strongest measured sound moment last/);
  assert.deepEqual(clips.map((clip) => [clip.start, clip.end]), [[39, 51], [39, 51], [39, 51]],
    "planning does not mutate originals or source selections");
});

test("silent video can supply picture while one audible source supplies disjoint sound sections", () => {
  const clips = [recording(1), recording(2, { asset: { ...recording(2).asset, hasAudio: false } }),
    recording(3, { asset: { ...recording(3).asset, hasAudio: false } })];
  const brief = interpretCreativeBrief({ description: prompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const result = planAudioStory(clips, brief, { [clips[0].asset.path]: bins(0.2) });
  assert.equal(result.audioSelections.length, 3);
  assert.ok(result.audioSelections.every((selection) => selection.asset.path === clips[0].asset.path));
  assert.equal(new Set(result.clips.filter((clip) => clip.included).map((clip) => clip.asset.path)).size, 3);
  const ranges = [...result.audioSelections].sort((a, b) => a.start - b.start);
  assert.ok(ranges.every((selection, index) => index === 0 || ranges[index - 1].end <= selection.start + 0.001));
});

test("marked picture and original sound remain aligned in the existing order", () => {
  const clips = [recording(1), recording(2, { start: 5, end: 17, locked: true, selectionSource: "manual" }), recording(3)];
  const brief = interpretCreativeBrief({ description: `Energetic ${prompt}` }, clips,
    { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip, index) =>
    [clip.asset.path, bins([0.1, 0.2, 0.4][index])])) as Record<string, AudioBin[]>;
  const result = planAudioStory(clips, brief, byPath);
  assert.deepEqual(new Set(result.clips.filter((clip) => clip.included).map((clip) => clip.asset.path)),
    new Set(clips.map((clip) => clip.asset.path)));
  assert.equal(result.clips[1].asset.path, clips[1].asset.path,
    "the marked section remains between the other two shots");
  assert.deepEqual([result.clips[1].start, result.clips[1].end], [5, 17]);
  const marked = result.audioSelections.find((selection) => selection.locked);
  assert.ok(marked);
  assert.deepEqual([marked.asset.path, marked.start, marked.end], [clips[1].asset.path, 5, 17]);
  const pictureOffset = result.clips[0].end - result.clips[0].start;
  const soundOffset = result.audioSelections.slice(0, result.audioSelections.indexOf(marked))
    .reduce((value, selection) => value + selection.end - selection.start, 0);
  assert.ok(Math.abs(pictureOffset - soundOffset) < 0.05);
  assert.ok(Math.abs(total(result.audioSelections) - total(result.clips.filter((clip) => clip.included))) < 0.05);
});

test("explicit picture count uses exactly that many distinct recordings", () => {
  const clips = [recording(1), recording(2), recording(3), recording(4)];
  const brief = interpretCreativeBrief({ description: prompt, soundMomentCount: 3,
    pictureSourceCount: 2, targetSeconds: 24 }, clips, { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip) => [clip.asset.path, bins(0.2)]));
  const result = planAudioStory(clips, brief, byPath);
  assert.equal(result.audioSelections.length, 3);
  assert.equal(result.clips.filter((clip) => clip.included).length, 2);
  assert.equal(new Set(result.clips.filter((clip) => clip.included).map((clip) => clip.asset.path)).size, 2);
  assert.equal(result.plannedSeconds, 24);
});

test("one picture recording can carry separate sound and picks a source long enough", () => {
  const clips = [recording(1, { asset: { ...recording(1).asset, duration: 8 }, start: 0, end: 4 }),
    recording(2, { asset: { ...recording(2).asset, duration: 40 }, start: 10, end: 18, included: false })];
  const brief = interpretCreativeBrief({ description: "Three sound moments", separatePicture: true,
    pictureSourceCount: 1, targetSeconds: 20 }, clips, { aspect: "vertical", reduceRumble: false });
  assert.equal(brief.conflict, null);
  const byPath = Object.fromEntries(clips.map((clip) => [clip.asset.path, bins(0.2, clip.asset.duration * 2)]));
  const result = planAudioStory(clips, brief, byPath);
  const pictures = result.clips.filter((clip) => clip.included);
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].asset.path, clips[1].asset.path);
  assert.equal(result.audioSelections.length, 3);
  assert.equal(result.plannedSeconds, 20);
});

test("a blank length plans a feasible one-recording picture cut", () => {
  const clips = [1, 2, 3].map((number) => recording(number, {
    asset: { ...recording(number).asset, duration: 12 }, start: 0, end: 12,
  }));
  const brief = interpretCreativeBrief({ description: "Three sound moments", separatePicture: true,
    pictureSourceCount: 1 }, clips, { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip) => [clip.asset.path, bins(0.2, 24)]));
  const result = planAudioStory(clips, brief, byPath);
  assert.equal(result.plannedSeconds, 12);
  assert.equal(result.clips.filter((clip) => clip.included).length, 1);
  assert.equal(result.audioSelections.length, 3);
});

test("impossible lock alignment is rejected before render", () => {
  const clips = [recording(1, { locked: true, selectionSource: "manual" }), recording(2),
    recording(3, { locked: true, selectionSource: "manual" }), recording(4)];
  const brief = interpretCreativeBrief({ description: `Energetic ${prompt}`, pictureSourceCount: 4 }, clips,
    { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip) => [clip.asset.path, bins(0.2)]));
  assert.throws(() => planAudioStory(clips, brief, byPath), /at least 4 sound moments/);
});

test("sound sections stop at measured audio coverage even when video runs longer", () => {
  const clips = [recording(1), recording(2, { asset: { ...recording(2).asset, hasAudio: false } })];
  const brief = interpretCreativeBrief({ description: prompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  assert.throws(() => planAudioStory(clips, brief, { [clips[0].asset.path]: bins(0.2, 20) }),
    /not enough nonrepeating sound/);
  const locked = [recording(1, { start: 10, end: 22, locked: true, selectionSource: "manual" }), recording(2)];
  const lockedBrief = interpretCreativeBrief({ description: prompt }, locked,
    { aspect: "vertical", reduceRumble: false });
  assert.throws(() => planAudioStory(locked, lockedBrief, { [locked[0].asset.path]: bins(0.2, 20) }),
    /ends after its available audio/);
});

test("change one sound moment without changing others, its duration, or protected ranges", () => {
  const clips = [recording(1), recording(2), recording(3)];
  const brief = interpretCreativeBrief({ description: prompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip, index) =>
    [clip.asset.path, bins([0.1, 0.2, 0.3][index])])) as Record<string, AudioBin[]>;
  const planned = planAudioStory(clips, brief, byPath).audioSelections;
  const next = refineAudioStory(planned, 0, byPath);
  assert.equal(next[0].asset.path, planned[0].asset.path);
  assert.equal(next[0].end - next[0].start, planned[0].end - planned[0].start);
  assert.ok(next[0].start >= planned[0].end + 0.2 || next[0].end <= planned[0].start - 0.2);
  assert.deepEqual(next.slice(1), planned.slice(1));
  assert.deepEqual(next.length, planned.length);
  assert.throws(() => refineAudioStory([{ ...planned[0], locked: true }], 0, byPath), /protected/);
});

test("an explicit exclusion stays out of both timelines", () => {
  const clips = [recording(1), recording(2), recording(3, { included: false, excludedByUser: true })];
  const brief = interpretCreativeBrief({ description: prompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip, index) =>
    [clip.asset.path, bins([0.1, 0.2, 0.9][index])])) as Record<string, AudioBin[]>;
  const result = planAudioStory(clips, brief, byPath);
  assert.equal(result.clips[2].included, false);
  assert.ok(result.audioSelections.every((selection) => selection.asset.path !== clips[2].asset.path));
  assert.equal(result.audioSelections.length, 3);
});

test("three sound moments can fill a five-minute target without repeating source ranges", () => {
  const clips = [recording(1), recording(2), recording(3)].map((clip) => ({
    ...clip, asset: { ...clip.asset, duration: 200 }, start: 94, end: 106,
  }));
  const brief = interpretCreativeBrief({ description: prompt, targetSeconds: 300 }, clips,
    { aspect: "vertical", reduceRumble: false });
  const byPath = Object.fromEntries(clips.map((clip, index) =>
    [clip.asset.path, bins([0.1, 0.2, 0.3][index], 400)])) as Record<string, AudioBin[]>;
  const result = planAudioStory(clips, brief, byPath);
  assert.equal(result.audioSelections.length, 3);
  assert.ok(Math.abs(total(result.audioSelections) - 300) < 0.05);
  assert.ok(Math.abs(total(result.clips.filter((clip) => clip.included)) - 300) < 0.05);
});

test("the final measured sound moment can favor an internal rise without adding gain", () => {
  const clips = [recording(1), recording(2), recording(3)].map((clip) => ({
    ...clip, asset: { ...clip.asset, duration: 36 }, start: 12, end: 24,
  }));
  const finalBins = [
    ...bins(0.5, 24), ...bins(0.2, 8), ...bins(0.4, 8), ...bins(0.7, 8), ...bins(0.1, 24),
  ];
  const byPath = { [clips[0].asset.path]: bins(0.1, 72),
    [clips[1].asset.path]: bins(0.3, 72), [clips[2].asset.path]: finalBins };
  const brief = interpretCreativeBrief({ description: prompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const last = planAudioStory(clips, brief, byPath).audioSelections.at(-1)!;
  assert.equal(last.asset.path, clips[2].asset.path);
  const firstBin = Math.floor(last.start / 0.5), endBin = Math.ceil(last.end / 0.5);
  const third = Math.floor((endBin - firstBin) / 3);
  const head = finalBins.slice(firstBin, firstBin + third).reduce((value, bin) => value + bin.rms, 0) / third;
  const tail = finalBins.slice(endBin - third, endBin).reduce((value, bin) => value + bin.rms, 0) / third;
  assert.ok(tail > head, `final moment should build within itself (${head} → ${tail})`);
});

test("quality penalty does not masquerade as energy when ordering sound moments", () => {
  const clips = [recording(1), recording(2), recording(3)];
  const byPath = { [clips[0].asset.path]: bins(0.1),
    [clips[1].asset.path]: bins(0.35),
    [clips[2].asset.path]: Array.from({ length: 180 }, () => ({ rms: 0.45, clipping: 0.2 })) };
  const brief = interpretCreativeBrief({ description: prompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const result = planAudioStory(clips, brief, byPath);
  assert.deepEqual(result.audioSelections.map((selection) => byPath[selection.asset.path][0].rms),
    [0.1, 0.35, 0.45]);
  assert.match(result.notes.join(" "), /distortion/,
    "heavily clipped sound must not be described as a clean, successful build");
});

test("a cleaner source replaces a heavily clipped one when enough sound is available", () => {
  const clips = [recording(1), recording(2), recording(3), recording(4)];
  const byPath = { [clips[0].asset.path]: bins(0.1), [clips[1].asset.path]: bins(0.35),
    [clips[2].asset.path]: Array.from({ length: 180 }, () => ({ rms: 0.45, clipping: 0.2 })),
    [clips[3].asset.path]: bins(0.4) };
  const brief = interpretCreativeBrief({ description: prompt }, clips,
    { aspect: "vertical", reduceRumble: false });
  const result = planAudioStory(clips, brief, byPath);
  assert.equal(result.audioSelections.length, 3);
  assert.ok(result.audioSelections.every((selection) => selection.asset.path !== clips[2].asset.path));
  assert.equal(result.audioSelections.at(-1)?.asset.path, clips[3].asset.path);
});
