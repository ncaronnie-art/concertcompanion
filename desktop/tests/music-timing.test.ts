import test from "node:test";
import assert from "node:assert/strict";
import { alignPictureCutsToMusic, alignSoundtrackBeats, type MusicTimingBin } from "../src/shared/music-timing.ts";
import { planSourceCrossfades } from "../src/shared/audio-crossfade.ts";

const asset = (name: string, seconds = 30) => ({ path: `${name}.mp4`, name, duration: seconds,
  audioDuration: seconds, width: 720, height: 1280, hasAudio: true });
const sound = (name: string, start = 2, end = 12, seconds = 30) => ({ asset: asset(name, seconds), start, end });
const picture = (name: string, start: number, end: number, seconds = 30) => ({ ...sound(name, start, end, seconds), included: true,
  selectionSource: "suggested" as "suggested" | "manual", locked: false, excludedByUser: false, framing: "fill" as const, focus: 0.7 });
function grid(bpm = 120, phase = 0.1, seconds = 30, confidence = 0.95): MusicTimingBin[] {
  const bins: MusicTimingBin[] = Array.from({ length: seconds * 2 }, (_, index) => ({ endSeconds: (index + 1) / 2,
    tempoBpm: bpm, beatConfidence: confidence, beatTimes: [] }));
  for (let beat = phase; beat < seconds; beat += 60 / bpm) bins[Math.floor(beat * 2)].beatTimes!.push(beat);
  return bins;
}
const total = (selections: { start: number; end: number }[]) => selections.reduce((sum, s) => sum + s.end - s.start, 0);
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} differs from ${expected}`);

test("automatic sound ranges align measured beats throughout the actual overlap without changing length or speed", () => {
  const source = [sound("a"), sound("b")];
  const before = structuredClone(source);
  const plan = alignSoundtrackBeats(source, { "a.mp4": grid(), "b.mp4": grid(120, 0.3) });
  assert.equal(plan.alignedCount, 1);
  assert.equal(plan.boundaries[0].status, "aligned");
  close(plan.boundaries[0].shiftSeconds, 0.2);
  assert.ok(plan.boundaries[0].matchedBeats! >= 3);
  assert.ok(plan.boundaries[0].maxBeatErrorSeconds! < 0.001);
  close(total(plan.audioSelections), total(source));
  close(plan.audioSelections[1].end - plan.audioSelections[1].start, 10);
  assert.deepEqual(source, before);
  assert.deepEqual(plan.audioSelections[0], source[0]);
});

test("already matching beats retain the selected range exactly", () => {
  const source = [sound("a"), sound("b")];
  const plan = alignSoundtrackBeats(source, { "a.mp4": grid(), "b.mp4": grid() });
  assert.equal(plan.alignedCount, 1);
  assert.equal(plan.boundaries[0].status, "already-aligned");
  assert.deepEqual(plan.audioSelections, source);
});

test("different tempos, uncertain/no grids, and unavailable source room preserve sound and explain the fallback", () => {
  const source = [sound("a"), sound("b")];
  const different = alignSoundtrackBeats(source, { "a.mp4": grid(), "b.mp4": grid(100) });
  assert.equal(different.boundaries[0].status, "different-tempo");
  const uncertain = alignSoundtrackBeats(source, { "a.mp4": grid(), "b.mp4": grid(120, 0.3, 30, 0.3) });
  assert.equal(uncertain.boundaries[0].status, "uncertain-beat");
  const missing = alignSoundtrackBeats(source, {});
  assert.equal(missing.boundaries[0].status, "uncertain-beat");
  const noRoomSource = [sound("a"), sound("b", 0, 30)];
  const noRoom = alignSoundtrackBeats(noRoomSource, { "a.mp4": grid(), "b.mp4": grid(120, 0.3) });
  assert.equal(noRoom.boundaries[0].status, "no-room");
  for (const plan of [different, uncertain, missing]) {
    assert.equal(plan.alignedCount, 0);
    assert.deepEqual(plan.audioSelections, source);
    assert.match(plan.notes.join(" "), /ordinary blends/);
  }
  assert.deepEqual(noRoom.audioSelections, noRoomSource);
});

test("protected sound and manual ranges remain exact even when phase adjustment would be possible", () => {
  for (const flag of [{ locked: true }, { selectionSource: "manual" as const }]) {
    const source = [{ ...sound("a"), ...flag }, sound("b")];
    const plan = alignSoundtrackBeats(source, { "a.mp4": grid(), "b.mp4": grid(120, 0.3) });
    assert.deepEqual(plan.audioSelections, source);
    assert.equal(plan.boundaries[0].status, "protected");
  }
});

test("sound alignment does not borrow a repeated source range or ignore the actual audio end", () => {
  const source = [sound("a"), sound("b"), sound("b", 12.1, 16.1)];
  const plan = alignSoundtrackBeats(source, { "a.mp4": grid(), "b.mp4": grid(120, 0.3) });
  assert.ok(plan.audioSelections[1].end <= plan.audioSelections[2].start);
  close(plan.boundaries[0].shiftSeconds, -0.3);
  close(total(plan.audioSelections), total(source));
  const short = [sound("a"), { ...sound("b"), asset: { ...asset("b"), audioDuration: 12 } }];
  const limited = alignSoundtrackBeats(short, { "a.mp4": grid(), "b.mp4": grid(120, 0.3) });
  assert.ok(limited.audioSelections[1].end <= 12);
});

test("picture cuts follow the soundtrack grid while preserving duration, clip count and untouched fields", () => {
  const clips = [picture("a", 2, 6.2), picture("b", 2, 7.8)];
  const before = structuredClone(clips);
  const plan = alignPictureCutsToMusic(clips, [sound("music", 0, 10)], { "music.mp4": grid(120, 0) });
  assert.equal(plan.alignedCount, 1);
  close(plan.boundaries[0].cutSeconds, 4);
  close(plan.clips[0].end, 6);
  close(plan.clips[1].start, 1.8);
  close(total(plan.clips), 10);
  assert.deepEqual(plan.clips.map(c => [c.asset.path, c.framing, c.focus, c.included]), clips.map(c => [c.asset.path, c.framing, c.focus, c.included]));
  assert.deepEqual(clips, before);
});

test("a one-sided dissolve aligns its actual visible midpoint rather than the nominal boundary", () => {
  const clips = [picture("a", 0, 4, 4), picture("b", 2, 8)];
  const plan = alignPictureCutsToMusic(clips, [sound("music", 0, 10)], { "music.mp4": grid(120, 0.2) }, { pictureCrossfadeSeconds: 0.4 });
  close(plan.boundaries[0].originalSeconds, 3.8);
  assert.equal(plan.alignedCount, 1);
  const actual = planSourceCrossfades(plan.clips, { medium: "video", desiredSeconds: 0.4 }).boundaries[0];
  const midpoint = (actual.overlapStartSeconds + actual.overlapEndSeconds) / 2;
  assert.ok(Math.abs(midpoint - plan.boundaries[0].beatSeconds!) <= 1 / 30);
  close(midpoint, 3.7);
  close(total(plan.clips), 10);
});

test("marked picture ranges keep their source range and output position; exclusions stay excluded", () => {
  const clips = [picture("a", 2, 6.2), { ...picture("excluded", 1, 5), included: false, excludedByUser: true },
    picture("b", 2, 7.8), { ...picture("kept", 1, 5), selectionSource: "manual" as const }, picture("last", 3, 7)];
  const plan = alignPictureCutsToMusic(clips, [sound("music", 0, 18)], { "music.mp4": grid(120, 0) });
  assert.deepEqual(plan.clips[1], clips[1]);
  assert.deepEqual(plan.clips[3], clips[3]);
  close(total(plan.clips.slice(0, 3).filter(c => c.included)), 10);
  close(total(plan.clips.filter(c => c.included)), 18);
  assert.equal(plan.clips.filter(c => c.included).length, 4);
  assert.equal(plan.boundaries.filter(b => b.status === "protected").length, 2);
});

test("a later picture adjustment cannot move an earlier matched dissolve off the beat by borrowing its handles", () => {
  const clips = [picture("reused", 0, 4, 10), picture("middle", 0, 4, 10), picture("reused", 4.2, 8.2, 10)];
  const plan = alignPictureCutsToMusic(clips, [sound("music", 0, 12)], { "music.mp4": grid(120, 0.1) }, { pictureCrossfadeSeconds: 0.4 });
  const overlaps = planSourceCrossfades(plan.clips, { medium: "video", desiredSeconds: 0.4 }).boundaries;
  for (const [index, decision] of plan.boundaries.entries()) {
    if (["aligned", "already-aligned"].includes(decision.status)) {
      const midpoint = (overlaps[index].overlapStartSeconds + overlaps[index].overlapEndSeconds) / 2;
      assert.ok(Math.abs(midpoint - decision.beatSeconds!) <= 1 / 30);
    }
  }
  close(total(plan.clips), total(clips));
  assert.ok(plan.clips[0].end <= plan.clips[2].start);
});

test("picture timing falls back unchanged when no safe reliable beat is available", () => {
  const clips = [picture("a", 0, 4.2, 4.2), picture("b", 0, 5.8, 5.8)];
  const plan = alignPictureCutsToMusic(clips, [sound("music", 0, 10)], { "music.mp4": grid(120, 0) });
  assert.equal(plan.alignedCount, 0);
  assert.deepEqual(plan.clips, clips);
  const oldAnalysis = alignPictureCutsToMusic(clips, [sound("music", 0, 10)], { "music.mp4": [{ endSeconds: 10 }] });
  assert.equal(oldAnalysis.alignedCount, 0);
  assert.deepEqual(oldAnalysis.clips, clips);
});

test("invalid options and mismatched timelines are rejected instead of producing an invalid project", () => {
  assert.throws(() => alignSoundtrackBeats([sound("a"), sound("b")], {}, { maxShiftSeconds: NaN }), /adjustment/);
  assert.throws(() => alignSoundtrackBeats([sound("a"), sound("b")], {}, { crossfadeSeconds: -1 }), /overlap/);
  assert.throws(() => alignPictureCutsToMusic([picture("a", 0, 5)], [sound("music", 0, 10)], {}), /same length/);
  assert.throws(() => alignPictureCutsToMusic([picture("a", 0, 10)], [sound("music", 0, 10)], {}, { pictureCrossfadeSeconds: Infinity }), /picture blend/);
});
