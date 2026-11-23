import test from "node:test";
import assert from "node:assert/strict";
import { interpretCreativeBrief, makeFirstCut, refineCut, freshWizardTargetSeconds, type CreativeClip } from "../src/shared/creative-brief.ts";

const options = { aspect: "vertical" as const, reduceRumble: true };
const recording = (number: number, extra: Partial<CreativeClip> = {}): CreativeClip => ({
  asset: { path: `C:\\recording-${number}.mov`, name: `Recording ${number}`, duration: 90, width: 1920, height: 1080, hasAudio: true },
  start: 39, end: 51, included: true, selectionSource: "suggested", locked: false, excludedByUser: false, ...extra,
});

test("fresh wizard starts with a ninety-second three-part music direction without a loudness promise", () => {
  const clips = [recording(1), recording(2), recording(3)];
  const brief = interpretCreativeBrief({ description: "", separatePicture: true, tempoArc: true,
    targetSeconds: freshWizardTargetSeconds("") }, clips, options);
  assert.equal(brief.targetSeconds, 90);
  assert.equal(brief.soundtrackIntent?.segmentCount, 3);
  assert.equal(brief.soundtrackIntent?.tempoArc, true);
  assert.equal(brief.soundtrackIntent?.buildEnding, false);
  assert.match(brief.summary, /0:30 each/);
  assert.match(brief.summary, /slow opening, mid-tempo middle, upbeat finale/);
  assert.doesNotMatch(brief.summary, /sound-energy build|strongest measured ending/);
  assert.match(brief.limitations.join(" "), /cannot support that progression/);
});

test("fresh default duration yields to prompt lengths and intact or marked-only requests", () => {
  assert.equal(freshWizardTargetSeconds("Make a two-minute recap"), 120);
  assert.equal(freshWizardTargetSeconds("A 45-second recap"), 45);
  assert.equal(freshWizardTargetSeconds("Keep the full performance intact"), null);
  assert.equal(freshWizardTargetSeconds("Use only my selected sections"), null);
  const intact = interpretCreativeBrief({ description: "Keep the full performance intact", separatePicture: true,
    tempoArc: true, targetSeconds: freshWizardTargetSeconds("Keep the full performance intact") }, [recording(1)], options);
  assert.equal(intact.keepWholePerformance, true);
  assert.equal(intact.targetSeconds, null);
  assert.equal(intact.soundtrackIntent, null);
  const custom = interpretCreativeBrief({ description: "Three sound moments, slow music first and an upbeat finish",
    separatePicture: true, tempoArc: false, targetSeconds: 72, soundMomentCount: 4 },
  [recording(1), recording(2), recording(3), recording(4)], options);
  assert.equal(custom.targetSeconds, 72);
  assert.equal(custom.soundtrackIntent?.segmentCount, 4);
  assert.equal(custom.soundtrackIntent?.tempoArc, false);
});

test("tempo language shares the setting while legacy projects and marked moments keep their choices", () => {
  const clips = [recording(1), recording(2), recording(3)];
  const fromWords = interpretCreativeBrief({ description: "Three sound moments: a slow opening, mid-tempo middle, upbeat finale" }, clips, options);
  assert.equal(fromWords.soundtrackIntent?.tempoArc, true);
  const legacy = interpretCreativeBrief({ description: "Three sound moments", targetSeconds: 36 }, clips, options);
  assert.equal(legacy.targetSeconds, 36);
  assert.equal(legacy.soundtrackIntent?.tempoArc, undefined);
  const marked = interpretCreativeBrief({ description: "Keep my marked section", separatePicture: true,
    targetSeconds: 90, tempoArc: true }, [{ ...clips[0], locked: true, selectionSource: "manual" }, clips[1], clips[2]], options);
  assert.doesNotMatch(marked.summary, /0:30 each/);
  assert.match(marked.limitations.join(" "), /marked sections keep their length/);
  assert.deepEqual([clips[0].start, clips[0].end], [39, 51]);
  assert.throws(() => interpretCreativeBrief({ description: "", tempoArc: "yes" as unknown as boolean }, clips, options), /valid music/);
});

test("portrait 9:13 stays the default while explicit shapes remain available", () => {
  const clips = [recording(1)];
  const portrait = { aspect: "portrait913" as const, reduceRumble: false };
  assert.equal(interpretCreativeBrief({ description: "A clean recap" }, clips, portrait).aspect, "portrait913");
  assert.match(interpretCreativeBrief({ description: "A clean recap" }, clips, portrait).summary, /portrait 9:13/);
  assert.equal(interpretCreativeBrief({ description: "Make it vertical" }, clips, options).aspect, "portrait913");
  assert.equal(interpretCreativeBrief({ description: "Use 9:13" }, clips, options).aspect, "portrait913");
  assert.equal(interpretCreativeBrief({ description: "Use 9:16" }, clips, portrait).aspect, "vertical");
  assert.equal(interpretCreativeBrief({ description: "Use 16:9" }, clips, portrait).aspect, "landscape");
  assert.equal(interpretCreativeBrief({ description: "Use 9:13", aspect: "landscape" }, clips, portrait).aspect, "landscape");
  const subjectRequest = interpretCreativeBrief({ description: "Automatically center the crop on the singer" }, clips, portrait);
  assert.match(subjectRequest.limitations.join(" "), /cannot identify or follow a performer/);
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
  assert.equal(energetic.options.showClipLabels, false, "vibe must not add unsolicited text");
  assert.equal(cinematic.options.showClipLabels, false);
  assert.equal(clean.options.showClipLabels, false);
});

test("video title and user named moments shape the brief without inventing song labels", () => {
  const clips = [recording(1, { label: "First song" }), recording(2)];
  const brief = interpretCreativeBrief({ description: "Cinematic recap", eventTitle: "The Night", showClipLabels: true, vibe: "cinematic" }, clips, options);
  assert.equal(brief.options.eventTitle, "The Night");
  assert.equal(brief.options.showClipLabels, true);
  assert.match(brief.summary, /opening title “The Night”/);
  assert.match(brief.summary, /your named moments on video/);
  const separateSound = interpretCreativeBrief({ description: "Cinematic recap", eventTitle: "The Night",
    vibe: "cinematic", separatePicture: true, soundMomentCount: 3, pictureSourceCount: 2,
    showClipLabels: true }, clips, options);
  assert.equal(separateSound.options.showClipLabels, false, "picture labels must not imply the wrong song over separate audio");
  assert.doesNotMatch(separateSound.summary, /named moments on video/);
});

test("one-song stays in one recording, and unsupported requests are disclosed", () => {
  const clips = [recording(1), recording(2)];
  const brief = interpretCreativeBrief({ description: "Just this song, horizontal, with lyrics and slow motion", targetSeconds: 30 }, clips, options);
  assert.equal(brief.videoType, "one-song");
  assert.equal(brief.aspect, "landscape");
  assert.equal(brief.conflict?.kind, "one-song-choose-recording");
  assert.throws(() => makeFirstCut(clips, brief), /Which recording/);
  const chosen = [recording(1, { included: false }), recording(2)];
  const chosenBrief = interpretCreativeBrief({ description: "Just this song, horizontal, with lyrics and slow motion", targetSeconds: 30 }, chosen, options);
  assert.equal(chosenBrief.conflict, null);
  const cut = makeFirstCut(chosen, chosenBrief);
  assert.deepEqual(cut.clips.map((clip) => clip.included), [false, true]);
  assert.equal(cut.plannedSeconds, 30);
  assert.match(brief.limitations.join(" "), /Opening event titles and your named moments are supported/);
  assert.match(brief.limitations.join(" "), /speed changes/i);
  const named = interpretCreativeBrief({ description: "Several songs" }, [recording(1, { label: "Song A" }), recording(2, { label: "Song B" })], options);
  assert.match(named.summary, /your labeled songs/);
  assert.match(named.limitations.join(" "), /labels/);
});

test("one-song source choice preserves explicit exclusions and does not silently pick a source", () => {
  const clips = [recording(1), recording(2), recording(3, { included: false, excludedByUser: true })];
  const unresolved = interpretCreativeBrief({ description: "A single song" }, clips, options);
  assert.equal(unresolved.conflict?.kind, "one-song-choose-recording");
  const chosen = clips.map((clip, index) => index === 0 ? { ...clip, included: false } : clip);
  const brief = interpretCreativeBrief({ description: "A single song" }, chosen, options);
  assert.equal(brief.conflict, null);
  const cut = makeFirstCut(chosen, brief);
  assert.deepEqual(cut.clips.map((clip) => clip.included), [false, true, false]);
  assert.equal(cut.clips[2].excludedByUser, true);
});

test("keep this performance intact selects the full original recording", () => {
  const clips = [recording(1), recording(2, { included: false, excludedByUser: true })];
  const brief = interpretCreativeBrief({ description: "Keep this performance intact. Clean presentation." }, clips, options);
  assert.equal(brief.videoType, "one-song");
  assert.equal(brief.keepWholePerformance, true);
  assert.equal(brief.conflict, null);
  assert.match(brief.summary, /^1:30/);
  const cut = makeFirstCut(clips, brief);
  assert.deepEqual([cut.clips[0].start, cut.clips[0].end], [0, 90]);
  assert.equal(cut.clips[0].locked, true);
  assert.equal(cut.clips[1].excludedByUser, true);
  assert.equal(cut.plannedSeconds, 90);
  assert.deepEqual([clips[0].start, clips[0].end], [39, 51]);
});

test("guided defaults keep an intact performance continuous with its original picture and sound", () => {
  const clips = [recording(1, { included: false }), recording(2), recording(3, { included: false, excludedByUser: true })];
  const original = structuredClone(clips);
  const brief = interpretCreativeBrief({ description: "Keep this performance intact but clean up the presentation",
    separatePicture: true, eventTitle: "Our night" }, clips, options);
  assert.equal(brief.conflict, null);
  assert.equal(brief.soundtrackIntent, null, "the default wizard setting must not invent a separate soundtrack request");
  assert.equal(brief.pictureSourceCount, null);
  assert.equal(brief.targetSeconds, null);
  assert.match(brief.summary, /^1:30.*whole performance stays/);
  const cut = makeFirstCut(clips, brief);
  assert.deepEqual(cut.clips.map((clip) => clip.included), [false, true, false]);
  assert.deepEqual([cut.clips[1].start, cut.clips[1].end, cut.clips[1].locked], [0, 90, true]);
  assert.equal(cut.clips[2].excludedByUser, true);
  assert.equal(cut.plannedSeconds, 90);
  assert.equal(cut.options.eventTitle, "Our night");
  assert.deepEqual(clips, original);
});

test("an intact performance with explicit independent sound or picture instructions asks which edit to make", () => {
  const clips = [recording(1, { start: 0, end: 90, selectionSource: "manual", locked: true }), recording(2, { included: false })];
  const original = structuredClone(clips);
  const inputs = [
    { description: "Keep this performance intact, but use three audio moments" },
    { description: "Keep this performance intact with a separate soundtrack" },
    { description: "Keep this performance intact, with footage from multiple videos over the soundtrack" },
    { description: "Keep this performance intact, with picture from two recordings" },
    { description: "Keep this performance intact", separatePicture: true, soundMomentCount: 3 },
    { description: "Keep this performance intact", separatePicture: true, pictureSourceCount: 2 },
  ];
  for (const input of inputs) {
    const brief = interpretCreativeBrief(input, clips, options);
    assert.equal(brief.conflict?.kind, "intact-vs-soundtrack", JSON.stringify(input));
    assert.match(brief.conflict?.message ?? "", /Keep the whole performance.*or.*separate soundtrack/);
    assert.throws(() => makeFirstCut(clips, brief));
  }
  assert.deepEqual(clips, original, "asking for clarification must not alter the locked performance");
  for (const wording of ["without a separate soundtrack", "don't use independent audio", "no replacement sound"]) {
    const brief = interpretCreativeBrief({ description: `Keep this performance intact, ${wording}`,
      separatePicture: true }, clips, options);
    assert.equal(brief.conflict, null, wording);
    assert.equal(brief.soundtrackIntent, null, wording);
  }
});

test("one sound moment and one picture recording remain compatible with keeping a performance intact", () => {
  const clips = [recording(1)];
  const brief = interpretCreativeBrief({ description: "Keep this performance intact and clean up the sound",
    separatePicture: true, soundMomentCount: 1, pictureSourceCount: 1 }, clips,
  { aspect: "portrait913", reduceRumble: false, finish: "cinematic", transition: "fade" });
  assert.equal(brief.conflict, null);
  assert.equal(brief.soundtrackIntent, null);
  const cut = makeFirstCut(clips, brief);
  assert.equal(cut.plannedSeconds, 90);
  assert.equal(cut.options.reduceRumble, true);
  assert.equal(cut.options.finish, "cinematic");
  assert.match(brief.limitations.join(" "), /cannot remove crowd voices/);
});

test("an intact performance discloses that a requested stronger ending cannot rearrange its sound", () => {
  const clips = [recording(1)];
  const brief = interpretCreativeBrief({ description: "Keep this performance intact with a crescendo",
    separatePicture: true }, clips, options);
  assert.equal(brief.conflict, null);
  assert.equal(brief.soundtrackIntent, null);
  assert.match(brief.limitations.join(" "), /will not rearrange it to create a stronger ending/);
  const cut = makeFirstCut(clips, brief);
  assert.deepEqual([cut.clips[0].start, cut.clips[0].end], [0, 90]);
});

test("guided intact requests still require consent before replacing a marked range or extending a target", () => {
  const clips = [recording(1, { start: 15, end: 35, selectionSource: "manual", locked: true })];
  const marked = interpretCreativeBrief({ description: "Keep this performance intact", separatePicture: true }, clips, options);
  assert.equal(marked.conflict?.kind, "intact-vs-marked");
  assert.throws(() => makeFirstCut(clips, marked), /marked/);
  const kept = makeFirstCut(clips, marked, "keep-marked");
  assert.deepEqual([kept.clips[0].start, kept.clips[0].end, kept.clips[0].locked], [15, 35, true]);
  const shortTarget = interpretCreativeBrief({ description: "Keep this performance intact", separatePicture: true,
    targetSeconds: 30 }, [recording(2)], options);
  assert.equal(shortTarget.conflict?.kind, "protected-over-target");
  assert.throws(() => makeFirstCut([recording(2)], shortTarget), /whole recording/);
  assert.equal(makeFirstCut([recording(2)], shortTarget, "extend").plannedSeconds, 90);
});

test("intact performance versus a partial marked section asks one question", () => {
  const clips = [recording(1, { start: 15, end: 35, selectionSource: "manual", locked: true })];
  const brief = interpretCreativeBrief({ description: "Keep this performance intact" }, clips, options);
  assert.equal(brief.conflict?.kind, "intact-vs-marked");
  assert.match(brief.conflict?.message ?? "", /Keep your marked section or use the whole recording/);
  assert.throws(() => makeFirstCut(clips, brief), /marked/);
  const marked = makeFirstCut(clips, brief, "keep-marked");
  assert.deepEqual([marked.clips[0].start, marked.clips[0].end], [15, 35]);
  const whole = [recording(1, { start: 0, end: 90, selectionSource: "manual", locked: true })];
  const wholeBrief = interpretCreativeBrief({ description: "Keep this performance intact" }, whole, options);
  assert.equal(wholeBrief.conflict, null);
  assert.deepEqual([makeFirstCut(whole, wholeBrief).clips[0].start, makeFirstCut(whole, wholeBrief).clips[0].end], [0, 90]);
});

test("intact performance longer than requested target can be extended only by choice", () => {
  const clips = [recording(1)];
  const brief = interpretCreativeBrief({ description: "Keep the full performance", targetSeconds: 30 }, clips, options);
  assert.equal(brief.conflict?.kind, "protected-over-target");
  assert.match(brief.conflict?.message ?? "", /whole recording/);
  assert.throws(() => makeFirstCut(clips, brief), /whole recording/);
  const cut = makeFirstCut(clips, brief, "extend");
  assert.equal(cut.plannedSeconds, 90);
  assert.equal(cut.clips[0].locked, true);
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

test("Ronnie's soundtrack-led request appears explicitly in review without claiming full cleaning", () => {
  const clips = [recording(1), recording(2), recording(3)];
  const brief = interpretCreativeBrief({ description:
    "3 audio clips featuring the cleaning audio and ending with a crescendo. I want video footage from multiple clips on top of that." },
  clips, { aspect: "vertical", reduceRumble: false, finish: "cinematic", transition: "fade" });
  assert.deepEqual(brief.soundtrackIntent, {
    segmentCount: 3, buildEnding: true, separatePicture: true, cleanupRequested: true,
  });
  assert.equal(brief.conflict, null);
  assert.equal(brief.options.reduceRumble, true);
  assert.equal(brief.options.finish, "cinematic", "an audio cleanup request does not reset the picture look");
  assert.match(brief.summary, /3 audio moments/);
  assert.match(brief.summary, /low-rumble reduction/);
  assert.match(brief.summary, /sound-energy build/);
  assert.match(brief.summary, /picture from 3 recordings over the soundtrack/);
  assert.match(brief.limitations.join(" "), /cannot remove crowd voices/);
  assert.match(brief.limitations.join(" "), /not recognition of a musical crescendo/);
  assert.throws(() => makeFirstCut(clips, brief), /separate soundtrack plan/);
});

test("natural sound and picture wording is recognized without changing legacy prompts", () => {
  const clips = [recording(1), recording(2), recording(3)];
  for (const wording of ["three sound clips", "3 audio segments", "three audio moments"]) {
    const brief = interpretCreativeBrief({ description: `${wording}, video from different clips over the audio, build to a crescendo, clean up the sound` }, clips,
      { aspect: "vertical", reduceRumble: false });
    assert.equal(brief.soundtrackIntent?.segmentCount, 3, wording);
    assert.equal(brief.soundtrackIntent?.separatePicture, true, wording);
    assert.equal(brief.soundtrackIntent?.buildEnding, true, wording);
    assert.equal(brief.options.reduceRumble, true, wording);
  }
  assert.equal(interpretCreativeBrief({ description: "Clean up the sound" }, clips,
    { aspect: "vertical", reduceRumble: false }).soundtrackIntent, null,
  "cleanup alone keeps the existing joined-picture-and-sound workflow");
});

test("an explicit sound checkbox choice overrides a cleanup phrase", () => {
  const clips = [recording(1), recording(2), recording(3)];
  const brief = interpretCreativeBrief({ description: "Three audio clips, clean up the sound", reduceRumble: false }, clips,
    { aspect: "vertical", reduceRumble: true });
  assert.equal(brief.options.reduceRumble, false);
  assert.match(brief.summary, /low-rumble reduction off/);
  assert.match(brief.limitations.join(" "), /off by your choice/);
  const enabled = interpretCreativeBrief({ description: "Three audio clips, clean up the sound", reduceRumble: true }, clips,
    { aspect: "vertical", reduceRumble: false });
  assert.equal(enabled.options.reduceRumble, true);
});

test("sound-led review distinguishes silent picture B-roll from usable soundtrack", () => {
  const audible = recording(1);
  const silentPicture = recording(2, { asset: { ...recording(2).asset, hasAudio: false } });
  const brief = interpretCreativeBrief({ description: "Three audio clips, footage from multiple clips over the audio" },
    [audible, silentPicture], { aspect: "vertical", reduceRumble: false });
  assert.equal(brief.conflict, null);
  assert.equal(brief.soundtrackIntent?.separatePicture, true);
  const noSound = interpretCreativeBrief({ description: "Three audio clips" }, [silentPicture],
    { aspect: "vertical", reduceRumble: false });
  assert.equal(noSound.conflict?.kind, "audio-story-no-sound");
});

test("sound-led review calls out count and marked-duration conflicts", () => {
  const locked = [1, 2, 3, 4].map((number) => recording(number, { selectionSource: "manual", locked: true }));
  const count = interpretCreativeBrief({ description: "Three audio clips" }, locked,
    { aspect: "vertical", reduceRumble: false });
  assert.equal(count.conflict?.kind, "audio-story-locked-count");
  const longMarked = [recording(1, { start: 0, end: 30, selectionSource: "manual", locked: true }), recording(2)];
  const length = interpretCreativeBrief({ description: "Three audio clips", targetSeconds: 20 }, longMarked,
    { aspect: "vertical", reduceRumble: false });
  assert.equal(length.conflict?.kind, "protected-over-target");
  assert.match(length.conflict?.message ?? "", /room for 2 other sound moments/);
});

test("natural soundtrack and picture phrasings reach one separate-track plan", () => {
  const clips = [recording(1), recording(2), recording(3)];
  const descriptions = [
    "Use three sound moments, reduce low rumble, build to a strong ending, and show footage from several recordings.",
    "Make a six-second recap with three sound moments. Reduce low rumble, aim for a stronger ending, and show footage from several videos over that soundtrack.",
    "Make a recap with three audio moments. Reduce low rumble, aim for a stronger ending, and put footage from several videos over the sound.",
    "Use audio from 3 clips. Clean up the sound, end with a build, and show multiple clips of video footage on top.",
    "Choose three clips for the audio. Clean the audio and build toward a crescendo. Use different video clips over the audio.",
    "Three sound clips with clean audio and a crescendo ending. Put footage from several videos on top of that.",
    "3 audio segments, cleaner audio, stronger finish, with video from different recordings over the soundtrack.",
  ];
  for (const description of descriptions) {
    const brief = interpretCreativeBrief({ description }, clips,
      { aspect: "vertical", reduceRumble: false });
    assert.equal(brief.soundtrackIntent?.segmentCount, 3, description);
    assert.equal(brief.soundtrackIntent?.separatePicture, true, description);
    assert.equal(brief.soundtrackIntent?.buildEnding, true, description);
    assert.equal(brief.soundtrackIntent?.cleanupRequested, true, description);
    assert.equal(brief.options.reduceRumble, true, description);
    assert.match(brief.summary, /picture from 3 recordings over the soundtrack/, description);
  }
});

test("picture-source wording alone keeps the existing joined edit", () => {
  const clips = [recording(1), recording(2), recording(3)];
  for (const description of [
    "Make a montage from several videos.",
    "Use multiple clips of video footage and clean up the sound.",
    "Give me three video clips with their original audio.",
  ]) {
    assert.equal(interpretCreativeBrief({ description }, clips,
      { aspect: "vertical", reduceRumble: false }).soundtrackIntent, null, description);
  }
});

test("explicit picture-over-sound choice wins without discarding count or ending", () => {
  const clips = [recording(1), recording(2), recording(3)];
  const forced = interpretCreativeBrief({ description: "Make a recap", separatePicture: true }, clips,
    { aspect: "vertical", reduceRumble: false });
  assert.deepEqual(forced.soundtrackIntent, {
    segmentCount: 3, buildEnding: false, separatePicture: true, cleanupRequested: false,
  });
  const described = interpretCreativeBrief({ description: "Three audio clips with cleaned sound and a crescendo", separatePicture: true }, clips,
    { aspect: "vertical", reduceRumble: false });
  assert.deepEqual(described.soundtrackIntent, {
    segmentCount: 3, buildEnding: true, separatePicture: true, cleanupRequested: true,
  });
  const declined = interpretCreativeBrief({ description: "Three audio clips, footage from several videos over the audio", separatePicture: false }, clips,
    { aspect: "vertical", reduceRumble: false });
  assert.equal(declined.soundtrackIntent?.segmentCount, 3);
  assert.equal(declined.soundtrackIntent?.separatePicture, false);
  assert.throws(() => interpretCreativeBrief({ description: "Three audio clips",
    separatePicture: "yes" } as unknown as Parameters<typeof interpretCreativeBrief>[0], clips,
    { aspect: "vertical", reduceRumble: false }), /valid separate soundtrack/);
});

test("review catches an all-protected picture before sound analysis without changing selections", () => {
  const clips = [1, 2, 3].map((number) => recording(number, { selectionSource: "manual", locked: true }));
  const before = structuredClone(clips);
  const brief = interpretCreativeBrief({ description: "Three sound moments over footage from several videos" }, clips, options);
  assert.equal(brief.soundtrackIntent?.separatePicture, true);
  assert.equal(brief.conflict?.kind, "audio-story-all-picture-protected");
  assert.match(brief.conflict?.message ?? "", /Unlock a section, or import an unmarked video and extend the length/);
  assert.deepEqual(clips, before);
  const withRoom = interpretCreativeBrief({ description: "Three sound moments over footage from several videos",
    targetSeconds: 48 }, [...clips, recording(4, { included: false })], options);
  assert.notEqual(withRoom.conflict?.kind, "audio-story-all-picture-protected",
    "extra time and an unmarked imported recording are left to the planner");
});

test("structured counts win over text and Review reports impossible picture counts", () => {
  const clips = [recording(1), recording(2), recording(3), recording(4)];
  const brief = interpretCreativeBrief({ description: "Two audio moments over footage from two videos",
    separatePicture: true, soundMomentCount: 3, pictureSourceCount: 4 }, clips, options);
  assert.equal(brief.soundtrackIntent?.segmentCount, 3);
  assert.equal(brief.pictureSourceCount, 4);
  assert.match(brief.summary, /3 audio moments/);
  assert.match(brief.summary, /picture from 4 recordings/);
  assert.equal(brief.conflict, null);
  const natural = interpretCreativeBrief({ description: "Three audio moments over footage from two videos" }, clips, options);
  assert.equal(natural.pictureSourceCount, 2);
  assert.equal(natural.conflict, null);
  const tooMany = interpretCreativeBrief({ description: "Three audio moments", separatePicture: true,
    pictureSourceCount: 5 }, clips, options);
  assert.equal(tooMany.conflict?.kind, "audio-story-picture-count");
  assert.match(tooMany.conflict?.message ?? "", /only 4 are available/);
  const locked = [recording(1, { locked: true }), recording(2, { selectionSource: "manual" }), recording(3)];
  const tooFew = interpretCreativeBrief({ description: "Three audio moments", separatePicture: true,
    pictureSourceCount: 1 }, locked, options);
  assert.equal(tooFew.conflict?.kind, "audio-story-picture-count");
  assert.match(tooFew.conflict?.message ?? "", /2 recordings have protected picture/);
});

test("a requested picture count is not silently used in the joined edit", () => {
  const clips = [recording(1), recording(2)];
  const brief = interpretCreativeBrief({ description: "Three sound moments", separatePicture: false,
    pictureSourceCount: 1 }, clips, options);
  assert.equal(brief.conflict?.kind, "audio-story-picture-mode");
  assert.equal(brief.pictureSourceCount, null);
  assert.equal(interpretCreativeBrief({ description: "A recap", pictureSourceCount: 1 }, clips, options)
    .conflict?.kind, "audio-story-picture-mode");
  assert.throws(() => interpretCreativeBrief({ description: "", soundMomentCount: 13 }, clips, options), /twelve sound moments/);
  assert.throws(() => interpretCreativeBrief({ description: "", pictureSourceCount: 0 }, clips, options), /whole number/);
});

test("an unset length fits the requested picture recording count without shortening an explicit length", () => {
  const clips = [1, 2, 3].map((number) => recording(number, {
    asset: { ...recording(number).asset, duration: 12 }, start: 0, end: 12,
  }));
  const automatic = interpretCreativeBrief({ description: "Three audio moments", separatePicture: true,
    pictureSourceCount: 1 }, clips, options);
  assert.equal(automatic.targetSeconds, 12);
  assert.match(automatic.summary, /^0:12/);
  assert.equal(automatic.conflict, null);
  const explicit = interpretCreativeBrief({ description: "Three audio moments", separatePicture: true,
    pictureSourceCount: 1, targetSeconds: 36 }, clips, options);
  assert.equal(explicit.targetSeconds, 36);
  assert.equal(explicit.conflict?.kind, "audio-story-picture-count");
  assert.match(explicit.conflict?.message ?? "", /cannot fill/);
});

test("no text overrides saved titles and labels while modern transition choices survive the brief", () => {
  const clips = [recording(1, { label: "Named performance" }), recording(2)];
  const current = { ...options, quality: "high" as const, transition: "dissolve" as const,
    audioTransition: "crossfade" as const, audioCrossfadeSeconds: 2, eventTitle: "Old title", showClipLabels: true };
  const brief = interpretCreativeBrief({ description: "Cinematic recap, no additional text added as an overlay.",
    transition: "smoothslide", eventTitle: "Another title", showClipLabels: true }, clips, current);
  assert.equal(brief.options.eventTitle, "");
  assert.equal(brief.options.showClipLabels, false);
  assert.equal(brief.options.transition, "smoothslide");
  assert.equal(brief.options.audioTransition, "crossfade");
  assert.match(brief.summary, /occasional glides/);
  assert.match(brief.summary, /sound overlaps up to 2s/);
  const blank = interpretCreativeBrief({ description: "" }, clips, { ...current, eventTitle: "", showClipLabels: false });
  assert.equal(blank.options.transition, "dissolve", "an unspecified vibe must not erase the chosen transition");
  assert.equal(blank.options.showClipLabels, false);
  const cinematic = interpretCreativeBrief({ description: "Cinematic recap" }, clips, current);
  assert.equal(cinematic.options.transition, "dissolve");
});
