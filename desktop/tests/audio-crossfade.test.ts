import test from "node:test";
import assert from "node:assert/strict";
import { planSourceCrossfades } from "../src/shared/audio-crossfade.ts";

function sound(name: string, start: number, end: number, duration = 30,
  audioDuration: number | null = duration, locked = false) {
  return { asset: { path: `C:\\show\\${name}.mov`, name: `${name}.mov`, duration,
    ...(audioDuration === null ? {} : { audioDuration }), hasAudio: true }, start, end, locked };
}

test("balanced source handles crossfade without moving selected moments or changing total length", () => {
  const originals = [sound("one", 2, 10, 12), sound("two", 2, 10, 10)];
  const before = structuredClone(originals);
  const plan = planSourceCrossfades(originals, { desiredSeconds: 2 });
  assert.deepEqual(plan.extendedSelections.map(({ start, end }) => [start, end]), [[2, 11], [1, 10]]);
  assert.deepEqual(plan.boundaries.map((boundary) => [boundary.outgoingExtraSeconds,
    boundary.incomingLeadSeconds, boundary.overlapSeconds,
    boundary.originalBoundarySeconds, boundary.overlapStartSeconds, boundary.overlapEndSeconds]),
  [[1, 1, 2, 8, 7, 9]]);
  assert.equal(plan.totalSeconds, 16);
  assert.equal(plan.extendedSelections.reduce((total, selection) => total + selection.end - selection.start, 0) -
    plan.boundaries[0].overlapSeconds, plan.totalSeconds);
  assert.deepEqual(originals, before, "planning does not edit the project selections");
  assert.deepEqual(plan.warnings, []);
});

test("a missing outgoing audio handle moves the whole overlap to the incoming lead", () => {
  const plan = planSourceCrossfades([sound("one", 0, 10, 30, null),
    sound("two", 3, 13, 20)], { desiredSeconds: 2 });
  assert.equal(plan.boundaries[0].outgoingExtraSeconds, 0);
  assert.equal(plan.boundaries[0].incomingLeadSeconds, 2);
  assert.equal(plan.boundaries[0].overlapSeconds, 2);
  assert.equal(plan.extendedSelections[0].end, 10);
  assert.equal(plan.extendedSelections[1].start, 1);
  assert.equal(plan.totalSeconds, 20);
});

test("a missing incoming lead moves the whole overlap to the outgoing tail", () => {
  const plan = planSourceCrossfades([sound("one", 0, 10, 12, 12),
    sound("two", 0, 10, 10, 10)], { desiredSeconds: 2 });
  assert.deepEqual([plan.boundaries[0].outgoingExtraSeconds,
    plan.boundaries[0].incomingLeadSeconds, plan.boundaries[0].overlapSeconds], [2, 0, 2]);
  assert.equal(plan.extendedSelections[0].end, 12);
  assert.equal(plan.extendedSelections[1].start, 0);
});

test("two joins preserve all three original output positions and exact planned length", () => {
  const plan = planSourceCrossfades([sound("one", 2, 12, 14),
    sound("two", 3, 15, 18), sound("three", 4, 14, 16)], { desiredSeconds: 2 });
  assert.deepEqual(plan.boundaries.map((boundary) => boundary.originalBoundarySeconds), [10, 22]);
  assert.deepEqual(plan.boundaries.map((boundary) => boundary.overlapSeconds), [2, 2]);
  assert.equal(plan.totalSeconds, 32);
  const extendedSeconds = plan.extendedSelections.reduce((sum, selection) =>
    sum + selection.end - selection.start, 0);
  assert.equal(extendedSeconds - plan.boundaries.reduce((sum, boundary) =>
    sum + boundary.overlapSeconds, 0), plan.totalSeconds);
});

test("measured audio end limits an outgoing extension even when container video is longer", () => {
  const plan = planSourceCrossfades([sound("one", 0, 10, 30, 10.5),
    sound("two", 2, 12, 20, 20)], { desiredSeconds: 2 });
  assert.equal(plan.boundaries[0].outgoingExtraSeconds, 0.5);
  assert.equal(plan.boundaries[0].incomingLeadSeconds, 1.5);
  assert.equal(plan.extendedSelections[0].end, 10.5);
  assert.equal(plan.boundaries[0].overlapSeconds, 2);
});

test("AAC packet rounding near the selected end is allowed but cannot become an outgoing handle", () => {
  const first = sound("aac-tail", 0, 15.138333, 15.138333, 15.138125);
  const plan = planSourceCrossfades([first, sound("next", 3, 18.138333, 20)],
    { desiredSeconds: 2 });
  assert.equal(plan.boundaries[0].outgoingExtraSeconds, 0);
  assert.equal(plan.boundaries[0].incomingLeadSeconds, 2);
  assert.equal(plan.extendedSelections[0].end, 15.138333);
  assert.throws(() => planSourceCrossfades([
    sound("too-short", 0, 10, 12, 9.9), sound("next", 2, 12, 20)]),
  /valid audio range/);
});

test("locked selections and their neighboring joins stay unchanged", () => {
  const selections = [sound("one", 2, 10), sound("kept", 3, 11, 30, 30, true),
    sound("three", 2, 10)];
  const plan = planSourceCrossfades(selections);
  assert.deepEqual(plan.extendedSelections, selections);
  assert.deepEqual(plan.boundaries.map((boundary) => [boundary.overlapSeconds, boundary.reason]),
    [[0, "locked"], [0, "locked"]]);
  assert.deepEqual(plan.warnings, []);
});

test("a join without unused source audio stays a hard boundary and explains why", () => {
  const plan = planSourceCrossfades([sound("one", 0, 10, 20, 10),
    sound("two", 0, 10, 20, 10)]);
  assert.equal(plan.boundaries[0].overlapSeconds, 0);
  assert.equal(plan.boundaries[0].reason, "no-handle");
  assert.match(plan.warnings[0], /only 0.00 seconds of the requested 2.00-second overlap/);
  assert.equal(plan.totalSeconds, 20);
});

test("two selections from one recording use the gap once, without source overlap", () => {
  const asset = sound("same", 0, 10, 30).asset;
  const plan = planSourceCrossfades([{ asset, start: 0, end: 10 },
    { asset, start: 11, end: 21 }], { desiredSeconds: 2 });
  assert.equal(plan.boundaries[0].overlapSeconds, 1);
  assert.equal(plan.extendedSelections[0].end, plan.extendedSelections[1].start);
  assert.equal(plan.totalSeconds, 20);
  assert.match(plan.warnings[0], /only 1.00 seconds/);
});

test("neighboring blends cannot consume an entire short middle section", () => {
  const plan = planSourceCrossfades([sound("one", 3, 8),
    sound("short", 3, 3.2), sound("three", 3, 8)]);
  assert.equal(plan.boundaries.length, 2);
  const intrusion = plan.boundaries[0].outgoingExtraSeconds +
    plan.boundaries[1].incomingLeadSeconds;
  assert.ok(intrusion <= 0.2 * 0.9 + 1e-6);
  assert.ok(plan.boundaries.every((boundary) => boundary.overlapSeconds <= 0.09 + 1e-6));
  assert.equal(plan.totalSeconds, 10.2);
});

test("picture mode uses video duration, including handles beyond a recording's audio", () => {
  const silent = { asset: { path: "C:\\show\\silent.mov", name: "silent.mov", duration: 12,
    hasAudio: false }, start: 0, end: 10 };
  const next = { asset: { path: "C:\\show\\next.mov", name: "next.mov", duration: 10,
    hasAudio: false }, start: 2, end: 10 };
  const plan = planSourceCrossfades([silent, next], { medium: "video", desiredSeconds: 2 });
  assert.equal(plan.boundaries[0].overlapSeconds, 2);
  assert.deepEqual(plan.extendedSelections.map(({ start, end }) => [start, end]), [[0, 11], [1, 10]]);
});

test("overlapping original source ranges are rejected before planning", () => {
  const asset = sound("same", 0, 10).asset;
  assert.throws(() => planSourceCrossfades([{ asset, start: 0, end: 10 },
    { asset, start: 9, end: 19 }]), /overlap; a crossfade cannot repeat/);
});
