import { useEffect, useMemo, useRef, useState } from "react";
import {
  interpretCreativeBrief, makeFirstCut, refineCut, freshWizardTargetSeconds,
  type CreativeBrief, type CreativeBriefInput, type CreativeClip,
  type Refinement, type SelectionMode, type Vibe, type VideoType,
} from "../shared/creative-brief";
import { planAudioStory, refineAudioStory } from "../shared/audio-story";
import { suggestedRange, type AudioSelection, type ExportOptions, type MediaAsset } from "../shared/render-plan";
import type { AudioBin } from "../shared/suggestions";
import { audibleReviewRanges, buildSoundReview, soundReviewNeedsDecision, soundReviewSignature, type SoundReview } from "../shared/audio-review";
import { planVisualTracking, scoreVisualSegment, subjectAnalysisRegion, type SmartFraming, type VisualAnalysis } from "../shared/visual-tracking";
import type { EffectStyle, VideoEnhancement } from "../shared/visual-effects";

type Chosen = CreativeClip & { previewUrl: string };
type UndoState = { clips: Chosen[]; options: ExportOptions; audioSelections: AudioSelection[] | null; briefInput: CreativeBriefInput; briefDirty: boolean;
  stage: "describe" | "review" | "cut"; reviewBrief: CreativeBrief | null;
  lengthText: string; lengthFollowsDescription: boolean };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const lengthClock = (seconds: number) => {
  const rounded = Math.round(seconds * 1000) / 1000;
  return `${Math.floor(rounded / 60)}:${rounded % 60 < 10 ? "0" : ""}${(rounded % 60).toFixed(3).replace(/\.?0+$/, "")}`;
};
const videoTypes: { value: VideoType; label: string }[] = [
  { value: "highlight", label: "Highlights" }, { value: "one-song", label: "One song" },
  { value: "recap", label: "Whole-night recap" }, { value: "compilation", label: "Compilation" },
];
const vibes: { value: Vibe; label: string }[] = [
  { value: "energetic", label: "Energetic" }, { value: "cinematic", label: "Cinematic" },
  { value: "nostalgic", label: "Nostalgic" }, { value: "intimate", label: "Intimate" },
  { value: "clean-live", label: "Clean / live" }, { value: "custom", label: "Custom" },
];
const modes: { value: SelectionMode; label: string }[] = [
  { value: "use-my-sections", label: "Use my sections" },
  { value: "choose-for-me", label: "Choose for me" },
  { value: "keep-and-choose", label: "Keep mine, choose the rest" },
];
const audioBinKey = (path: string, reduceRumble: boolean) => JSON.stringify([path, reduceRumble]);
const suggestionKey = (path: string, focus: ExportOptions["highlightFocus"]) => JSON.stringify([path, focus ?? "balanced"]);
const pictureTransitionNames: Record<NonNullable<ExportOptions["transition"]>, string> = {
  cut: "straight cuts", fade: "brief fades to black", dissolve: "dissolves", smoothslide: "smooth slides",
};
const pictureTransitionName = (value: ExportOptions["transition"]) => pictureTransitionNames[value ?? "cut"];
const soundTransitionName = (value: ExportOptions) => value.audioTransition === "crossfade" ?
  `crossfades up to ${(value.audioCrossfadeSeconds ?? 2).toFixed(1)} seconds where source audio allows` : "direct joins";
const shapeRatio = (aspect: ExportOptions["aspect"]) =>
  aspect === "portrait913" ? 9 / 13 : aspect === "vertical" ? 9 / 16 : 16 / 9;
const showsCropGuide = (aspect: ExportOptions["aspect"], asset: MediaAsset, framing?: "fill" | "fit", quality?: ExportOptions["quality"]) => {
  if (framing === "fit") return false;
  if (framing === "fill" || aspect === "portrait913") return true;
  const sourceRatio = asset.width / asset.height;
  return Math.max(sourceRatio / shapeRatio(aspect), shapeRatio(aspect) / sourceRatio) < 1.45;
};
const hasSideCrop = (aspect: ExportOptions["aspect"], asset: MediaAsset, framing?: "fill" | "fit", quality?: ExportOptions["quality"]) =>
  showsCropGuide(aspect, asset, framing, quality) && asset.width / asset.height > shapeRatio(aspect) + 0.01;

function refreshTracking(clip: Chosen, mode: SmartFraming, aspect: ExportOptions["aspect"]): Chosen {
  if (mode === "off" || !clip.visualAnalysis) return { ...clip, tracking: undefined };
  const source = clip.visualAnalysis;
  // A point-specific check covers its selected range only. Extending a trim
  // must not present extrapolated framing as if the new seconds were checked.
  if (source.start > clip.start + 0.001 || source.end < clip.end - 0.05) return { ...clip, tracking: undefined };
  const analysis = { ...source, start: clip.start, end: clip.end,
    frames: source.frames.filter(frame => frame.time >= clip.start - 0.001 && frame.time <= clip.end + 0.001) };
  return { ...clip, tracking: planVisualTracking(analysis, { mode, subject: clip.subject, outputAspect: shapeRatio(aspect) }) };
}

function visualWindow(clip: Chosen, seconds: number): { start: number; end: number; score: number } | null {
  const analysis = clip.visualAnalysis;
  if (!analysis || clip.asset.duration + 1e-9 < seconds) return null;
  const starts = new Set([0, Math.max(0, clip.asset.duration - seconds), Math.max(0, Math.min(clip.start, clip.asset.duration - seconds))]);
  const step = Math.max(0.5, (clip.asset.duration - seconds) / 1200);
  for (let start = 0; start + seconds <= clip.asset.duration + 0.001; start += step) starts.add(start);
  let best: { start: number; end: number; score: number } | null = null;
  for (const start of starts) {
    const end = start + seconds;
    if (analysis.start > start + 0.001 || analysis.end < end - 0.001) continue;
    if (!analysis.frames.some(frame => frame.time >= start && frame.time <= end)) continue;
    const score = scoreVisualSegment(analysis, start, end);
    if (!best || score > best.score + 0.000001) best = { start, end, score };
  }
  return best;
}

function parseLength(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const mmss = /^(\d{1,4}):([0-5]\d(?:\.\d+)?)$/.exec(text);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 60;
  return Number.NaN;
}

function protectedPictureMatchesSoundtrack(clips: Chosen[], soundtrack: AudioSelection[]): boolean {
  type Placement = { path: string; start: number; end: number; offset: number };
  const soundPositions: Placement[] = [];
  const picturePositions: Placement[] = [];
  let offset = 0;
  for (const sound of soundtrack) {
    if (sound.locked) soundPositions.push({ path: sound.asset.path, start: sound.start, end: sound.end, offset });
    offset += sound.end - sound.start;
  }
  offset = 0;
  for (const clip of clips) {
    if (!clip.included || clip.excludedByUser) continue;
    if (clip.locked || clip.selectionSource === "manual") {
      picturePositions.push({ path: clip.asset.path, start: clip.start, end: clip.end, offset });
    }
    offset += clip.end - clip.start;
  }
  const matches = (a: Placement, b: Placement) => a.path === b.path &&
    Math.abs(a.start - b.start) < 0.06 && Math.abs(a.end - b.end) < 0.06 && Math.abs(a.offset - b.offset) < 0.06;
  return picturePositions.every((picture) => soundPositions.some((sound) => matches(picture, sound))) &&
    soundPositions.every((sound) => picturePositions.some((picture) => matches(sound, picture)));
}

export function App() {
  const [clips, setClips] = useState<Chosen[]>([]);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("Choose videos from iCloud Drive or anywhere on this PC.");
  const [progress, setProgress] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [checkingSound, setCheckingSound] = useState(false);
  const [soundReview, setSoundReview] = useState<SoundReview | null>(null);
  const [acceptedSoundSignature, setAcceptedSoundSignature] = useState<string | null>(null);
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [draftSignature, setDraftSignature] = useState<string | null>(null);
  const [audioSelections, setAudioSelections] = useState<AudioSelection[] | null>(null);
  const [storyError, setStoryError] = useState<string | null>(null);
  const [aspect, setAspect] = useState<ExportOptions["aspect"]>("vertical");
  const [reduceRumble, setReduceRumble] = useState(false);
  const [finish, setFinish] = useState<NonNullable<ExportOptions["finish"]>>("natural");
  const [transition, setTransition] = useState<NonNullable<ExportOptions["transition"]>>("dissolve");
  const [quality, setQuality] = useState<NonNullable<ExportOptions["quality"]>>("high");
  const [enhance, setEnhance] = useState(false);
  const [audioTransition, setAudioTransition] = useState<NonNullable<ExportOptions["audioTransition"]>>("crossfade");
  const [audioCrossfadeSeconds, setAudioCrossfadeSeconds] = useState(2);
  const [beatSync, setBeatSync] = useState(true);
  const [highlightFocus, setHighlightFocus] = useState<NonNullable<ExportOptions["highlightFocus"]>>("performance");
  const [eventTitle, setEventTitle] = useState("");
  const [showClipLabels, setShowClipLabels] = useState(false);
  const [effects, setEffects] = useState<EffectStyle>("none");
  const [videoEnhancement, setVideoEnhancement] = useState<VideoEnhancement>("original");
  const [reducedFlash, setReducedFlash] = useState(true);
  const [smartFraming, setSmartFraming] = useState<SmartFraming>("balanced");
  const [analyzingVisuals, setAnalyzingVisuals] = useState(false);
  const [visualProgress, setVisualProgress] = useState(0);
  const [choosingSubject, setChoosingSubject] = useState<string | null>(null);
  const [briefInput, setBriefInput] = useState<CreativeBriefInput>({ description: "", separatePicture: true, tempoArc: true });
  const [soundCountDraft, setSoundCountDraft] = useState<string | null>(null);
  const [pictureCountDraft, setPictureCountDraft] = useState<string | null>(null);
  const [briefDirty, setBriefDirty] = useState(false);
  const [lengthText, setLengthText] = useState("1:30");
  const [lengthFollowsDescription, setLengthFollowsDescription] = useState(true);
  const [reviewBrief, setReviewBrief] = useState<CreativeBrief | null>(null);
  const [stage, setStage] = useState<"describe" | "review" | "cut">("describe");
  const [undoStack, setUndoStack] = useState<UndoState[]>([]);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const players = useRef(new Map<string, HTMLVideoElement>());
  const audioSuggestions = useRef(new Map<string, { start: number; end: number }>());
  const audioBins = useRef<Record<string, AudioBin[]>>({});
  const soundReviewCache = useRef<SoundReview | null>(null);
  const soundCheckCancelled = useRef(false);
  const importCancelled = useRef(false);
  const focusDragging = useRef(false);
  const audioCrossfadeDragging = useRef(false);
  const visualAnalysisCache = useRef(new Map<string, VisualAnalysis>());
  const visualAnalysisCancelled = useRef(false);

  useEffect(() => { window.concertCompass.onProgress(setProgress); }, []);
  useEffect(() => {
    if (stage === "cut") document.getElementById("watch-first-cut")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [stage]);
  const selected = useMemo(() => clips.filter((clip) => clip.included && !clip.excludedByUser), [clips]);
  const analyzedVisualCount = clips.filter(clip => !clip.excludedByUser && !!clip.visualAnalysis).length;
  const fittedVisualCount = selected.filter(clip => smartFraming !== "off" && clip.tracking?.suggestedFraming === "fit").length;
  const totalSeconds = selected.reduce((sum, clip) => sum + (clip.end - clip.start), 0);
  const soundtrackSeconds = audioSelections?.reduce((sum, clip) => sum + (clip.end - clip.start), 0) ?? null;
  const storyLengthMismatch = soundtrackSeconds !== null && Math.abs(soundtrackSeconds - totalSeconds) > 0.06;
  const storyProtectedMismatch = audioSelections !== null && !protectedPictureMatchesSoundtrack(clips, audioSelections);
  const storyExcludedSound = audioSelections?.some((sound) => {
    const source = clips.find((clip) => clip.asset.path === sound.asset.path);
    return !source || source.excludedByUser || source.soundExcludedByUser;
  }) ?? false;
  const storyNeedsRebuild = storyLengthMismatch || storyProtectedMismatch || storyExcludedSound;
  const storyRebuildMessage = storyExcludedSound ? "A soundtrack recording is missing or was excluded. Review your plan to choose new sound." :
    storyProtectedMismatch ? "A kept picture or sound moment moved. Review your plan to keep them together." :
    "The picture and soundtrack lengths differ. Review your plan to align them again.";
  const options: ExportOptions = { aspect, reduceRumble, finish, transition, quality, enhance,
    audioTransition, audioCrossfadeSeconds, beatSync, highlightFocus, eventTitle, showClipLabels,
    effects, videoEnhancement: enhance ? undefined : videoEnhancement, reducedFlash, smartFraming };
  const availableRecordings = clips.filter((clip) => !clip.excludedByUser).length;
  const suggestedPictureCount = Math.min(3, availableRecordings);
  const suggestedSoundCount = (() => {
    if (!clips.length) return 3;
    try { return interpretCreativeBrief({ ...briefInput, soundMomentCount: undefined }, clips, options).soundtrackIntent?.segmentCount ?? 3; }
    catch { return 3; }
  })();
  const visualSignature = useMemo(() => JSON.stringify(selected.map(clip => ({ subject: clip.subject,
    tracking: clip.tracking, visualAnalysis: clip.visualAnalysis }))), [selected]);
  const cutSignature = useMemo(() => JSON.stringify({ clips: selected.map((clip) => ({ path: clip.asset.path, start: clip.start, end: clip.end, locked: clip.locked, framing: clip.framing ?? "auto", focus: clip.focus ?? 0.5, label: clip.label })), visualSignature, audioSelections, options }),
    [selected, visualSignature, audioSelections, aspect, reduceRumble, finish, transition, quality, enhance, audioTransition,
      audioCrossfadeSeconds, beatSync, highlightFocus, eventTitle, showClipLabels, effects, videoEnhancement, reducedFlash, smartFraming]);
  const guidedCutPending = briefInput.separatePicture === true && audioSelections === null;
  const currentSoundSignature = soundReviewSignature(selected, audioSelections, options);
  const currentSoundReview = soundReview?.signature === currentSoundSignature ? soundReview : null;
  const soundDecisionNeeded = currentSoundReview !== null && soundReviewNeedsDecision(currentSoundReview);
  const soundWarnings = currentSoundReview?.items.filter(item => item.report.intervals.length || item.report.status !== "checked") ?? [];

  async function checkSelectedSound(picture: Chosen[], soundtrack: AudioSelection[] | null,
    settings: ExportOptions): Promise<SoundReview | null> {
    const signature = soundReviewSignature(picture, soundtrack, settings);
    if (soundReviewCache.current?.signature === signature) return soundReviewCache.current;
    soundCheckCancelled.current = false; setCheckingSound(true);
    try {
      const ranges = audibleReviewRanges(picture, soundtrack, settings).filter(selection => selection.asset.hasAudio);
      const binsByPath: Record<string, AudioBin[] | undefined> = {};
      for (const selection of ranges) {
        if (soundCheckCancelled.current) return null;
        if (selection.asset.path in binsByPath) continue;
        // The model always measured raw audio. Reuse existing signal/model bins
        // from first-cut analysis; otherwise the raw key also shares the main
        // process cache used by Suggest a moment. No duplicate model pass.
        const rawKey = audioBinKey(selection.asset.path, false);
        const cached = audioBins.current[audioBinKey(selection.asset.path, settings.reduceRumble)] ??
          audioBins.current[rawKey] ?? audioBins.current[audioBinKey(selection.asset.path, true)];
        let bins = cached;
        if (!bins) {
          setMessage(`Checking the whole sound section in ${selection.asset.name} for possible crowd interruptions…`);
          try {
            bins = await window.concertCompass.analyzeAudio(selection.asset, false);
            audioBins.current[rawKey] = bins;
          } catch { /* Unavailable analysis is shown for review; it never counts as clear. */ }
        }
        if (soundCheckCancelled.current) return null;
        binsByPath[selection.asset.path] = bins;
      }
      const review = buildSoundReview(picture, soundtrack, settings, binsByPath);
      soundReviewCache.current = review; setSoundReview(review); setAcceptedSoundSignature(null);
      return review;
    } finally { setCheckingSound(false); }
  }

  function stopSoundCheck() {
    soundCheckCancelled.current = true;
    setMessage("Stopping the sound check after the current recording. Your selections will stay unchanged.");
  }

  function remember() {
    setUndoStack((old) => [...old.slice(-24), { clips, options, audioSelections, briefInput, briefDirty, stage, reviewBrief, lengthText, lengthFollowsDescription }]);
  }
  function applyOptions(next: ExportOptions) {
    setAspect(next.aspect); setReduceRumble(next.reduceRumble);
    setFinish(next.finish ?? "natural"); setTransition(next.transition ?? "cut");
    // Missing fields belong to an older project, not to the new-project defaults.
    setQuality(next.quality ?? "standard"); setEnhance(next.enhance ?? false);
    setAudioTransition(next.audioTransition ?? "cut"); setAudioCrossfadeSeconds(next.audioCrossfadeSeconds ?? 2);
    setBeatSync(next.beatSync ?? false); setHighlightFocus(next.highlightFocus ?? "balanced");
    setEventTitle(next.eventTitle ?? ""); setShowClipLabels(next.showClipLabels ?? false);
    setEffects(next.effects ?? "none"); setVideoEnhancement(next.videoEnhancement ?? "original");
    setReducedFlash(next.reducedFlash ?? true); setSmartFraming(next.smartFraming ?? "off");
  }
  function changeClips(next: Chosen[]) {
    remember(); setClips(next.map(clip => refreshTracking(clip, smartFraming, aspect)));
    if (stage === "review") { setReviewBrief(null); setStage("describe"); }
  }
  function changeBrief(patch: Partial<CreativeBriefInput>) {
    if (patch.description !== undefined && lengthFollowsDescription) {
      const seconds = freshWizardTargetSeconds(patch.description);
      setLengthText(seconds === null ? "" : lengthClock(seconds));
    }
    if (patch.targetSeconds !== undefined) {
      setLengthText(patch.targetSeconds === null ? "" : lengthClock(patch.targetSeconds));
      setLengthFollowsDescription(false);
    } else if (patch.selectionMode === "use-my-sections" && lengthFollowsDescription) {
      setLengthText(""); setLengthFollowsDescription(false);
    }
    if ("separatePicture" in patch && patch.separatePicture !== true && lengthFollowsDescription) {
      setLengthText(""); setLengthFollowsDescription(false);
    }
    setBriefInput((old) => ({ ...old, ...patch }));
    setBriefDirty(true);
    setReviewBrief(null); setStage("describe");
    setMessage("Your new request is saved here. Review the plan and make a first cut before exporting it.");
  }
  function editSectionsManually() {
    if (guidedCutPending) {
      setBriefInput((old) => ({ ...old, separatePicture: false, soundMomentCount: undefined, pictureSourceCount: undefined, tempoArc: false }));
      if (lengthFollowsDescription) setLengthText("");
      setLengthFollowsDescription(false);
      setBriefDirty(false); setReviewBrief(null); setStage("describe");
      setMessage("Manual editor ready. The joined video keeps the sound from each recording. Choose sections below, then export; your originals stay untouched.");
    }
    document.getElementById("clip-editor")?.scrollIntoView({ behavior: "smooth" });
  }
  function invalidateReview() {
    if (stage === "review") { setReviewBrief(null); setStage("describe"); }
  }
  function changeClip(index: number, patch: Partial<Chosen>, markManual = false) {
    changeClips(clips.map((clip, current) => current === index ? {
      ...clip, ...patch,
      ...(markManual ? { selectionSource: "manual" as const, locked: true } : {}),
    } : clip));
  }
  function changeSoundAvailability(index: number, pictureOnly: boolean) {
    changeClip(index, { soundExcludedByUser: pictureOnly });
    setBriefDirty(true);
    setMessage(pictureOnly ? "The picture stays available; this recording’s sound will be left out. Review your plan to update the soundtrack." :
      "This recording’s sound is available again. Review your plan to update the soundtrack.");
  }
  function changeFocus(index: number, focus: number) {
    if (!focusDragging.current) { changeClip(index, { focus }); return; }
    // One pointer drag is one undo step, even though the framing guide updates continuously.
    setClips((old) => old.map((clip, current) => current === index ? { ...clip, focus } : clip));
    invalidateReview();
  }
  function setShape(value: ExportOptions["aspect"]) {
    remember(); setAspect(value); setBriefInput((old) => ({ ...old, aspect: value }));
    setClips(clips.map(clip => refreshTracking(clip, smartFraming, value)));
    invalidateReview();
  }
  function changeSmartFraming(value: SmartFraming) {
    remember(); setSmartFraming(value);
    setClips(clips.map(clip => refreshTracking(clip, value, aspect)));
    invalidateReview();
    setMessage(value === "off" ? "Manual framing is ready. Your chosen crop and source sections are preserved." :
      "Smart framing uses analyzed people and visual continuity. Analyze visuals, then watch the assembled preview to check the result.");
  }
  const visualKey = (clip: Chosen) => JSON.stringify([clip.asset.path, clip.asset.duration, clip.asset.width, clip.asset.height,
    ...(clip.subject ? [clip.subject.x, clip.subject.y, clip.start, clip.end] : [])]);
  async function visualAnalysisFor(clip: Chosen): Promise<VisualAnalysis> {
    // Keep long recordings within the local detector's bounded sample budget.
    // Beyond roughly eight hours, inspect the user's selected part only.
    const wholeSource = !clip.subject && clip.asset.duration <= 7198 / 0.25;
    const start = wholeSource ? 0 : clip.start, end = wholeSource ? clip.asset.duration : clip.end;
    if (end - start > 7198 / 0.25) throw Error("Choose a section shorter than eight hours for picture analysis. Your recordings and export choices are unchanged.");
    const expectedRegion = subjectAnalysisRegion(clip.asset.width, clip.asset.height, clip.subject);
    const matchesCheck = (analysis: VisualAnalysis) => {
      const actualRegion = analysis.analysisRegion;
      const sameRegion = expectedRegion ? actualRegion && (["x", "y", "width", "height"] as const)
        .every(key => Math.abs(actualRegion[key] - expectedRegion[key]) <= 0.000001) : !actualRegion;
      return sameRegion && (clip.subject ? Math.abs(analysis.start - start) <= 0.001 && Math.abs(analysis.end - end) <= 0.001 :
        analysis.start <= start + 0.001 && analysis.end >= end - 0.05);
    };
    const cached = visualAnalysisCache.current.get(visualKey(clip));
    if (cached && matchesCheck(cached)) return cached;
    if (clip.visualAnalysis && matchesCheck(clip.visualAnalysis)) return clip.visualAnalysis;
    const fps = Math.max(0.25, Math.min(2, 7198 / (end - start)));
    const analysis = await window.concertCompass.analyzeVisual(clip.asset, { start, end, fps, ...(clip.subject ? { subject: clip.subject } : {}) });
    visualAnalysisCache.current.set(visualKey(clip), analysis);
    return analysis;
  }
  async function analyzeVisuals() {
    if (!clips.length) return;
    visualAnalysisCancelled.current = false; setBusy(true); setAnalyzingVisuals(true); setVisualProgress(0);
    const next = clips.map(clip => ({ ...clip }));
    const eligible = next.map((clip, index) => ({ clip, index })).filter(({ clip }) => !clip.excludedByUser);
    let done = 0, failed = 0;
    try {
      for (const { clip, index } of eligible) {
        if (visualAnalysisCancelled.current) break;
        setMessage(`${clip.subject ? "Taking a closer check around your point" : "Checking picture"} ${done + failed + 1} of ${eligible.length}: ${clip.asset.name}… Your original is unchanged.`);
        try { next[index] = refreshTracking({ ...clip, visualAnalysis: await visualAnalysisFor(clip) }, smartFraming, aspect); done++; }
        catch { failed++; }
        setVisualProgress((done + failed) / Math.max(1, eligible.length));
      }
      if (done) { remember(); setClips(next); invalidateReview(); }
      const partial = next.filter(clip => !clip.subject && clip.visualAnalysis && (clip.visualAnalysis.start > 0.001 || clip.visualAnalysis.end < clip.asset.duration - 0.05)).length;
      const closer = next.some(clip => !!clip.subject && !!clip.visualAnalysis?.analysisRegion);
      setMessage(`${visualAnalysisCancelled.current ? "Visual analysis stopped." : "Visual analysis finished."} ${done} recording${done === 1 ? "" : "s"} ready.${failed ? ` ${failed} could not be analyzed; their original framing remains available.` : ""}${partial ? " Very long recordings were checked only in their selected sections." : ""}${closer ? " Your chosen performers received a closer check around your points in the selected sections." : ""} Your sound, chosen sections and locks are preserved. Watch the assembled preview to check framing.`);
    } finally { setBusy(false); setAnalyzingVisuals(false); }
  }
  function stopVisualAnalysis() {
    visualAnalysisCancelled.current = true;
    setMessage("Stopping after the current recording. Completed picture checks will be kept.");
  }
  function choosePictureMoments() {
    if (!audioSelections) { setMessage("Make a separate soundtrack first. Then picture suggestions can change without changing your sound."); return; }
    if (briefDirty || storyNeedsRebuild) { setMessage("Review your updated creative plan before choosing picture moments."); return; }
    const fixed = (clip: Chosen) => clip.locked || clip.selectionSource === "manual" || clip.orderLocked || !!clip.subject;
    const chosenPaths = new Set(clips.filter(fixed).map(clip => clip.asset.path));
    const pool = clips.filter(clip => !clip.excludedByUser && !fixed(clip));
    const windowCache = new Map<string, ReturnType<typeof visualWindow>>();
    type Candidate = { clip: Chosen; window: NonNullable<ReturnType<typeof visualWindow>> };
    const candidatesFor = (slot: Chosen): Candidate[] => pool.flatMap(candidate => {
      const seconds = slot.end - slot.start, key = JSON.stringify([candidate.asset.path, seconds]);
      if (!windowCache.has(key)) windowCache.set(key, visualWindow(candidate, seconds));
      const measured = windowCache.get(key);
      // An original slot is always a feasible fallback, even if analysis could
      // not run. Unmeasured imports cannot displace measured footage.
      const window = measured ?? (candidate.asset.path === slot.asset.path ?
        { start: slot.start, end: slot.end, score: 0 } : null);
      return window ? [{ clip: candidate, window }] : [];
    }).sort((a, b) => b.window.score - a.window.score ||
      Number(b.clip.asset.path === slot.asset.path) - Number(a.clip.asset.path === slot.asset.path));
    const automaticSlots = selected.filter(clip => !fixed(clip));
    const choicesBySlot = automaticSlots.map(candidatesFor);
    // Reserve a complete source assignment before accepting a greedy choice.
    // This keeps a short slot from consuming the only source that can fill a
    // later long slot, and prevents duplicate-source fallbacks.
    const canFillRemaining = (first: number, unavailable: ReadonlySet<string>): boolean => {
      const sourceOwner = new Map<string, number>();
      const assign = (slot: number, visited: Set<string>): boolean => {
        for (const candidate of choicesBySlot[slot]) {
          const path = candidate.clip.asset.path;
          if (unavailable.has(path) || visited.has(path)) continue;
          visited.add(path);
          const owner = sourceOwner.get(path);
          if (owner === undefined || assign(owner, visited)) { sourceOwner.set(path, slot); return true; }
        }
        return false;
      };
      for (let slot = first; slot < automaticSlots.length; slot++) if (!assign(slot, new Set())) return false;
      return true;
    };
    const result: Chosen[] = [];
    let changed = 0, automaticIndex = 0;
    for (const slot of selected) {
      if (fixed(slot)) { result.push(slot); continue; }
      const best = choicesBySlot[automaticIndex].find(candidate => !chosenPaths.has(candidate.clip.asset.path) &&
        canFillRemaining(automaticIndex + 1, new Set([...chosenPaths, candidate.clip.asset.path])));
      automaticIndex++;
      if (!best) { setMessage("The available checked pictures cannot fill this edit without repeating a recording. Your cut is unchanged."); return; }
      chosenPaths.add(best.clip.asset.path);
      if (slot.asset.path !== best.clip.asset.path || Math.abs(slot.start - best.window.start) > 0.01) changed++;
      result.push(refreshTracking({ ...best.clip, start: best.window.start, end: best.window.end,
        included: true, locked: false, selectionSource: "suggested" }, smartFraming, aspect));
    }
    if (!changed) { setMessage("The checked footage did not suggest a different picture cut at these lengths. Your edit stays as it is."); return; }
    if (new Set(result.map(clip => clip.asset.path)).size !== result.length ||
      Math.abs(result.reduce((sum, clip) => sum + clip.end - clip.start, 0) - totalSeconds) > 0.00001) {
      setMessage("The picture suggestion did not preserve the edit length and source variety. Your cut is unchanged."); return;
    }
    const includedPaths = new Set(result.map(clip => clip.asset.path));
    changeClips([...result, ...clips.filter(clip => !includedPaths.has(clip.asset.path)).map(clip => ({ ...clip, included: false }))]);
    setMessage(`Updated ${changed} picture moment${changed === 1 ? "" : "s"} using measured visibility, stability and lighting across available imports. Sound, total length, kept moments and selected subjects stay unchanged. These cues do not identify the artist; review the preview.`);
  }
  function beginSubjectChoice(clip: Chosen) {
    const player = players.current.get(clip.asset.path);
    if (!player || !Number.isFinite(player.duration)) { setMessage("Wait for this source preview to load, then choose the performer again."); return; }
    player.pause();
    seek(clip, clip.start); setChoosingSubject(clip.asset.path);
    setMessage(`Showing the full original frame at the selected start of ${clip.asset.name}. Click or tap the performer to follow. The point is saved with this recording.`);
  }
  async function chooseSubject(index: number, event: { currentTarget: HTMLVideoElement; clientX: number; clientY: number }) {
    const clip = clips[index]; if (choosingSubject !== clip.asset.path || busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / clip.asset.width, rect.height / clip.asset.height);
    const left = (rect.width - clip.asset.width * scale) / 2, top = (rect.height - clip.asset.height * scale) / 2;
    const x = (event.clientX - rect.left - left) / (clip.asset.width * scale);
    const y = (event.clientY - rect.top - top) / (clip.asset.height * scale);
    if (x < 0 || x > 1 || y < 0 || y > 1) { setMessage("Choose a point inside the original picture."); return; }
    await saveSubject(index, x, y);
  }
  async function saveSubject(index: number, x: number, y: number) {
    const clip = clips[index]; if (!clip || busy || choosingSubject !== clip.asset.path) return;
    const player = players.current.get(clip.asset.path);
    if (!player || player.seeking || Math.abs(player.currentTime - clip.start) > 0.075) {
      setMessage("Wait for the preview to reach your section’s start before choosing the performer."); return;
    }
    setBusy(true); setMessage(`Taking a closer check around your point in ${clip.asset.name}…`);
    try {
      const chosen = { ...clip, subject: { x, y }, visualAnalysis: undefined };
      const next = { ...chosen, visualAnalysis: await visualAnalysisFor(chosen) };
      const mode = smartFraming === "off" ? "follow-performer" : smartFraming;
      remember(); if (smartFraming === "off") setSmartFraming(mode);
      setClips(clips.map((current, currentIndex) => refreshTracking(currentIndex === index ? next : current, mode, aspect)));
      invalidateReview(); setChoosingSubject(null);
      setMessage("Your performer point is saved after a closer check around your point. This does not recognize the artist. Uncertain moments hold the framing instead of jumping to someone else. Watch the assembled preview; check again if you change this section.");
    } catch (error) { setMessage(`Could not track that choice: ${error instanceof Error ? error.message : String(error)}. Your earlier edit is unchanged.`); }
    finally { setBusy(false); }
  }
  function clearSubject(index: number) {
    const clip = clips[index], automatic = { ...clip, subject: undefined };
    const candidate = visualAnalysisCache.current.get(visualKey(automatic)) ?? clip.visualAnalysis;
    const visualAnalysis = candidate && !candidate.analysisRegion && candidate.start <= clip.start + 0.001 && candidate.end >= clip.end - 0.05 ? candidate : undefined;
    changeClip(index, { subject: undefined, visualAnalysis, tracking: undefined }); setChoosingSubject(null);
    setMessage("Performer choice cleared. The earlier whole-frame check is used where available; analyze visuals to check any unmeasured section.");
  }
  function changePictureTransition(value: NonNullable<ExportOptions["transition"]>) {
    remember(); setTransition(value); setBriefInput((old) => ({ ...old, transition: value }));
    invalidateReview();
  }
  function changeAudioCrossfade(value: number) {
    if (!audioCrossfadeDragging.current) remember();
    setAudioCrossfadeSeconds(value); invalidateReview();
  }
  function changeMusicPreferences(patch: { beatSync?: boolean; highlightFocus?: ExportOptions["highlightFocus"] }) {
    remember();
    if (patch.beatSync !== undefined) setBeatSync(patch.beatSync);
    if (patch.highlightFocus !== undefined) setHighlightFocus(patch.highlightFocus);
    setBriefInput((old) => ({ ...old, ...patch }));
    setBriefDirty(true); setReviewBrief(null); setStage("describe");
    setMessage("Your music choices are saved here. Review the plan and make a first cut to apply them; kept sections stay protected.");
  }
  function undo() {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setUndoStack((old) => old.slice(0, -1));
    setClips(previous.clips); setChoosingSubject(null);
    setAudioSelections(previous.audioSelections);
    setBriefInput(previous.briefInput);
    setLengthText(previous.lengthText); setLengthFollowsDescription(previous.lengthFollowsDescription);
    setBriefDirty(previous.briefDirty);
    setStage(previous.stage); setReviewBrief(previous.reviewBrief);
    applyOptions(previous.options);
    setMessage("Undid the last edit. Your earlier choices are back.");
  }

  async function stopImport() {
    importCancelled.current = true;
    await window.concertCompass.cancelRender();
    setMessage("Stopping import…");
  }

  async function importVideos() {
    const paths = await window.concertCompass.pickVideos();
    if (!paths.length) return;
    importCancelled.current = false;
    setBusy(true); setImporting(true); setProgress(0); setMessage(`Preparing previews for ${paths.length} video${paths.length === 1 ? "" : "s"}…`);
    try {
      const usable: { asset: MediaAsset; previewUrl: string }[] = [];
      let failed = 0;
      let duplicates = 0;
      const knownPaths = new Set(clips.map((clip) => clip.asset.path.toLowerCase()));
      for (const [index, file] of paths.entries()) {
        if (importCancelled.current) break;
        if (knownPaths.has(file.path.toLowerCase())) { duplicates++; continue; }
        knownPaths.add(file.path.toLowerCase());
        setProgress(0); setMessage(`Preparing video ${index + 1} of ${paths.length}…`);
        try {
          const asset = await window.concertCompass.probe(file.path);
          if (asset.duration < 0.1 || !asset.width) throw new Error("Not a usable video");
          if (importCancelled.current) break;
          usable.push({ asset, previewUrl: await window.concertCompass.preview(file.id) });
        } catch { if (importCancelled.current) break; failed++; }
      }
      const newClips = usable.map(({ asset, previewUrl }) => ({ asset, previewUrl, ...suggestedRange(asset), included: true,
          selectionSource: "suggested" as const, locked: false, excludedByUser: false, framing: "fill" as const }));
      if (newClips.length) changeClips([...clips, ...newClips]);
      setMessage(importCancelled.current ? `Import stopped. ${newClips.length} video${newClips.length === 1 ? "" : "s"} already prepared are ready; your originals are safe.` : `${newClips.length} new video${newClips.length === 1 ? "" : "s"} ready.${duplicates ? ` ${duplicates} already imported.` : ""}${failed ? ` ${failed} could not be prepared; check that the files are downloaded and playable.` : ""} Describe what you want, or edit sections below.`);
    } catch (error) { setMessage(`Could not read a video: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); setImporting(false); }
  }

  async function saveProject() {
    try {
      const targetSeconds = parseLength(lengthText);
      if (targetSeconds !== undefined && (!Number.isFinite(targetSeconds) || targetSeconds < 0.1)) {
        throw new Error("Enter a length like 2:00 for two minutes, or leave it blank.");
      }
      const snapshot = { version: 2 as const, clips: clips.map(({ previewUrl: _previewUrl, ...clip }) => clip),
        options, briefInput: { ...briefInput, targetSeconds }, audioSelections, briefDirty };
      const result = await window.concertCompass.saveProject(snapshot);
      setMessage(result.cancelled ? "Save cancelled. Your edit is still here." : `Project saved: ${result.path}`);
    } catch (error) { setMessage(`Could not save project: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async function openProject() {
    setBusy(true);
    try {
      const result = await window.concertCompass.openProject();
      if (!result) return;
      const byPath = new Map(result.files.map((file) => [file.path, file.id]));
      const restored: Chosen[] = [];
      for (const saved of result.snapshot.clips) {
        const id = byPath.get(saved.asset.path);
        if (!id) throw new Error(`Could not locate ${saved.asset.name}.`);
        const asset = await window.concertCompass.probe(saved.asset.path);
        if (saved.end > asset.duration + 0.05) throw new Error(`${asset.name} changed since this project was saved.`);
        const samePicture = saved.asset.width === asset.width && saved.asset.height === asset.height && Math.abs(saved.asset.duration - asset.duration) < 0.05;
        restored.push({ ...saved, asset, visualAnalysis: samePicture ? saved.visualAnalysis : undefined,
          tracking: samePicture ? saved.tracking : undefined, previewUrl: await window.concertCompass.preview(id) });
      }
      const freshAssets = new Map(restored.map((clip) => [clip.asset.path, clip.asset]));
      const savedAudio = "audioSelections" in result.snapshot ? result.snapshot.audioSelections : null;
      const restoredAudio = savedAudio?.map((selection) => {
        const asset = freshAssets.get(selection.asset.path);
        if (!asset || !asset.hasAudio || selection.end > asset.duration + 0.05) {
          throw new Error(`Could not restore the soundtrack section from ${selection.asset.name}.`);
        }
        return { ...selection, asset };
      }) ?? null;
      const savedBriefDirty = "briefDirty" in result.snapshot && result.snapshot.briefDirty === true;
      setClips(restored); setUndoStack([]); setChoosingSubject(null);
      visualAnalysisCache.current.clear();
      for (const clip of restored) if (clip.visualAnalysis) visualAnalysisCache.current.set(visualKey(clip), clip.visualAnalysis);
      setAudioSelections(restoredAudio);
      setBriefDirty(savedBriefDirty);
      applyOptions(result.snapshot.options);
      setBriefInput(result.snapshot.briefInput);
      setLengthText(result.snapshot.briefInput.targetSeconds ? lengthClock(result.snapshot.briefInput.targetSeconds) : "");
      setLengthFollowsDescription(false);
      setReviewBrief(null); setStoryError(null); setStage(restoredAudio && !savedBriefDirty ? "cut" : "describe");
      setDraftUrl(null); setDraftSignature(null); audioSuggestions.current.clear(); audioBins.current = {};
      soundReviewCache.current = null; setSoundReview(null); setAcceptedSoundSignature(null);
      setMessage(savedBriefDirty ?
        "Project opened. Your new description is saved; review the plan and make a first cut before exporting." :
        restoredAudio ? "Project opened. Your picture and soundtrack are ready to preview or adjust." :
        "Project opened. Your sections and protected moments are ready.");
    } catch (error) { setMessage(`Could not open project: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  function reviewPlan() {
    const targetSeconds = parseLength(lengthText);
    if (targetSeconds !== undefined && (!Number.isFinite(targetSeconds) || targetSeconds < 0.1)) {
      setMessage("Enter a length like 2:00 for two minutes, or leave it blank."); return;
    }
    try {
      const input = { ...briefInput, targetSeconds };
      const interpreted = interpretCreativeBrief(input, clips, options);
      setBriefInput(input); setReviewBrief(interpreted); setStoryError(null); setStage("review");
      setMessage("Review the plan before Concert Compass changes your edit.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  async function firstCut(resolution?: "extend" | "keep-marked") {
    if (!reviewBrief) return;
    setBusy(true);
    try {
      const candidates = clips.map((clip) => ({ ...clip }));
      let result: { clips: Chosen[]; options: ExportOptions; plannedSeconds: number; notes: string[]; audioSelections?: AudioSelection[] };
      if (reviewBrief.soundtrackIntent) {
        if (reviewBrief.conflict) throw new Error(reviewBrief.conflict.message);
        const binsByPath: Record<string, AudioBin[]> = {};
        for (const clip of candidates) {
          if (clip.excludedByUser || clip.soundExcludedByUser || !clip.asset.hasAudio) continue;
          const key = audioBinKey(clip.asset.path, reviewBrief.options.reduceRumble);
          if (!audioBins.current[key]) {
            setMessage(`Checking sound in ${clip.asset.name}…`);
            audioBins.current[key] = await window.concertCompass.analyzeAudio(clip.asset, reviewBrief.options.reduceRumble);
          }
          binsByPath[clip.asset.path] = audioBins.current[key];
        }
        result = planAudioStory(candidates, reviewBrief, binsByPath);
      } else {
        if (reviewBrief.selectionMode !== "use-my-sections" && !reviewBrief.keepWholePerformance && resolution !== "keep-marked") {
          for (let index = 0; index < candidates.length; index++) {
            const clip = candidates[index];
            if (reviewBrief.videoType === "one-song" && index !== candidates.findIndex((candidate) => candidate.included && !candidate.excludedByUser)) continue;
            if (clip.excludedByUser || clip.locked || clip.selectionSource === "manual") continue;
            try {
              setMessage(`Finding a starting moment in ${clip.asset.name}…`);
              const key = suggestionKey(clip.asset.path, reviewBrief.options.highlightFocus);
              let suggestion = audioSuggestions.current.get(key);
              if (!suggestion) {
                suggestion = await window.concertCompass.suggest(clip.asset, reviewBrief.options.highlightFocus);
                audioSuggestions.current.set(key, suggestion);
              }
              candidates[index] = { ...clip, start: suggestion.start, end: suggestion.end };
            } catch { /* The current section remains a valid fallback. */ }
          }
        }
        result = makeFirstCut(candidates, reviewBrief, resolution);
      }
      remember(); setClips(result.clips.map(clip => refreshTracking(clip, result.options.smartFraming ?? "off", result.options.aspect)));
      setChoosingSubject(null); setAudioSelections(result.audioSelections ?? null); setStoryError(null); setBriefDirty(false);
      // An intact performance resolves the guided default to its original sound.
      // Store that confirmed choice so preview/export also work after reopening.
      if (reviewBrief.keepWholePerformance && !reviewBrief.soundtrackIntent) {
        setBriefInput((old) => ({ ...old, separatePicture: false,
          soundMomentCount: undefined, pictureSourceCount: undefined, tempoArc: false }));
      }
      applyOptions(result.options);
      setStage("cut");
      const checked = await checkSelectedSound(result.clips.filter(clip => clip.included && !clip.excludedByUser), result.audioSelections ?? null, result.options);
      const checkNote = !checked ? "Sound check stopped; your cut is still ready." : soundReviewNeedsDecision(checked) ?
        "The sound check found something to review before export. See Automatic sound check below." : "Sound check finished; see the coverage notes below.";
      setMessage(`First cut ready: ${clock(result.plannedSeconds)}. ${result.notes.join(" ")} ${checkNote} Watch the first cut, adjust anything, then export.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (reviewBrief.soundtrackIntent) setStoryError(detail);
      setMessage(detail);
    }
    finally { setBusy(false); }
  }

  function refine(request: Refinement) {
    try {
      if (audioSelections && (request.kind === "fewer-cuts" || request.kind === "more-from-clip")) {
        throw new Error("Those changes would alter the picture length. Review your plan to rebuild the picture around this soundtrack.");
      }
      const result = refineCut(clips, request, reviewBrief ?? interpretCreativeBrief(briefInput, clips, options));
      changeClips(result.clips); setMessage(result.notes.join(" "));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  async function refineSoundMoment(index: number) {
    if (!audioSelections) return;
    if (briefDirty || storyNeedsRebuild) { setMessage("Review your updated plan before changing a soundtrack moment."); return; }
    const current = audioSelections[index];
    if (!current || current.locked) { setMessage("This sound moment is protected and will stay where you marked it."); return; }
    setBusy(true);
    try {
      const key = audioBinKey(current.asset.path, reduceRumble);
      if (!audioBins.current[key]) {
        setMessage(`Checking sound in ${current.asset.name}…`);
        audioBins.current[key] = await window.concertCompass.analyzeAudio(current.asset, reduceRumble);
      }
      const next = refineAudioStory(audioSelections, index, { [current.asset.path]: audioBins.current[key] }, highlightFocus);
      remember(); setAudioSelections(next);
      const checked = await checkSelectedSound(selected, next, options);
      setMessage(`Chose another sound moment from ${current.asset.name}. The other sound and picture sections stayed the same. ${!checked ? "Sound check stopped; your new section is still here." : soundReviewNeedsDecision(checked) ? "Review the possible sound interruptions below." : "Sound check finished."} Watch the updated preview before exporting.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function listenSoundMoment(selection: AudioSelection) {
    const player = players.current.get(selection.asset.path);
    if (!player) { setMessage(`Could not open the original recording for ${selection.asset.name}.`); return; }
    for (const other of players.current.values()) if (other !== player) other.pause();
    document.querySelector<HTMLVideoElement>(".draft-player")?.pause();
    player.scrollIntoView({ behavior: "smooth", block: "center" });
    player.currentTime = selection.start;
    try { await player.play(); setMessage(`Playing ${selection.asset.name} near ${clock(selection.start)}. Watch first cut to hear it in the finished soundtrack.`); }
    catch { setMessage(`The recording is ready at ${clock(selection.start)}. Press play on that recording to listen.`); }
  }

  function move(index: number, offset: number) {
    const next = [...clips], target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [
      { ...next[target], orderLocked: true }, { ...next[index], orderLocked: true },
    ];
    changeClips(next);
  }
  function seek(clip: Chosen, seconds: number) {
    const player = players.current.get(clip.asset.path);
    if (!player || !Number.isFinite(player.duration)) return;
    if (choosingSubject === clip.asset.path) setChoosingSubject(null);
    player.currentTime = Math.max(0, Math.min(player.duration, seconds));
    setPositions((old) => ({ ...old, [clip.asset.path]: player.currentTime }));
  }
  function mark(index: number, side: "start" | "end") {
    const clip = clips[index], current = players.current.get(clip.asset.path)?.currentTime;
    if (current === undefined || !Number.isFinite(current)) return;
    const time = Math.round(current * 100) / 100;
    if ((side === "start" && time >= clip.end - 0.1) || (side === "end" && time <= clip.start + 0.1)) {
      setMessage("Choose an end point after the start point, leaving at least a tenth of a second."); return;
    }
    changeClip(index, { [side]: Math.max(0, Math.min(clip.asset.duration, time)) }, true);
  }
  async function suggest(index: number) {
    const clip = clips[index];
    if (clip.locked) { setMessage("This section is protected. Unlock it before asking for another suggestion."); return; }
    setBusy(true); setMessage(`Finding a musical moment in ${clip.asset.name}…`);
    try {
      const suggestion = await window.concertCompass.suggest(clip.asset, highlightFocus);
      audioSuggestions.current.set(suggestionKey(clip.asset.path, highlightFocus), suggestion);
      changeClip(index, { start: suggestion.start, end: suggestion.end, selectionSource: "suggested" });
      seek(clip, suggestion.start); setMessage(suggestion.reason);
    } catch { setMessage("Couldn't analyze this recording's sound. Your selection is unchanged; you can still choose the moment yourself."); }
    finally { setBusy(false); }
  }
  async function exportReel(confirmedSignature?: string) {
    if (!selected.length) return;
    if (guidedCutPending) { setMessage("Review the guided plan and make your first cut before exporting, or choose Edit sections myself."); return; }
    if (briefDirty) { setMessage("Your new description has not been made yet. Review the plan and make a first cut before exporting."); return; }
    if (storyNeedsRebuild) { setMessage(`${storyRebuildMessage} Make a first cut before exporting.`); return; }
    setBusy(true); setProgress(0);
    try {
      const checked = await checkSelectedSound(selected, audioSelections, options);
      if (!checked) { setMessage("Sound check stopped. Export has not started; your selections are unchanged."); return; }
      if (soundReviewNeedsDecision(checked) && confirmedSignature !== checked.signature && acceptedSoundSignature !== checked.signature) {
        setMessage("Review the sound check before saving. Listen to a flagged moment, adjust it, or choose Export with this sound to keep your selection.");
        window.setTimeout(() => document.getElementById("sound-check")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
        return;
      }
      if (confirmedSignature === checked.signature) setAcceptedSoundSignature(checked.signature);
      setExporting(true); setMessage("Choose where to save your MP4…");
      const result = await window.concertCompass.render(selected, options, audioSelections ?? undefined);
      setMessage(result.cancelled ? "Export cancelled. Your original recordings were not changed." : `Finished MP4: ${result.output}${result.cleanupWarning ? " The video is saved, but a temporary folder could not be removed." : ""}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail.includes("Export stopped.") ? "Export stopped. Your selections are still here." : `Export failed. Your originals are safe. ${detail}`);
    } finally { setBusy(false); setExporting(false); }
  }
  async function previewFirstCut() {
    if (!selected.length) return;
    if (guidedCutPending) { setMessage("Make your guided first cut before previewing, or choose Edit sections myself."); return; }
    if (briefDirty) { setMessage("Your new description has not been made yet. Review the plan and make a first cut before previewing."); return; }
    if (storyNeedsRebuild) { setMessage(`${storyRebuildMessage} Make a first cut before previewing.`); return; }
    const signature = cutSignature;
    setBusy(true); setProgress(0);
    try {
      const checked = await checkSelectedSound(selected, audioSelections, options);
      if (!checked) { setMessage("Sound check stopped. Preview has not started; your edit is still here."); return; }
      setPreviewing(true); setMessage("Preparing a watchable draft with your current sections and look…");
      const result = await window.concertCompass.previewCut(selected, options, audioSelections ?? undefined);
      setDraftUrl(result.url); setDraftSignature(signature);
      setMessage(soundReviewNeedsDecision(checked) ? "Draft preview is ready. The sound check has moments to review below; listen before exporting." : "Draft preview is ready. Watch it through, then adjust or export.");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail.includes("stopped") || detail.includes("cancel") ? "Preview stopped. Your edit is still here." : `Could not make the preview: ${detail}`);
    } finally { setBusy(false); setPreviewing(false); }
  }
  function chooseOneSong(path: string) {
    changeClips(clips.map((clip) => {
      if (clip.asset.path === path) return { ...clip, included: true, excludedByUser: false };
      if (clip.excludedByUser) return clip;
      return { ...clip, included: false, excludedByUser: clip.locked || clip.selectionSource === "manual" };
    }));
    setReviewBrief(null); setStage("describe");
    setMessage("Recording chosen. Review the plan once more before making the cut.");
  }
  function useWholePerformance() {
    const marked = clips.find((clip) => clip.included && !clip.excludedByUser && (clip.locked || clip.selectionSource === "manual") && (clip.start > 0.05 || clip.end < clip.asset.duration - 0.05));
    if (!marked) return;
    changeClips(clips.map((clip) => clip.asset.path === marked.asset.path ? { ...clip, start: 0, end: clip.asset.duration, locked: true, selectionSource: "manual" as const } : clip));
    setReviewBrief(null); setStage("describe");
    setMessage(`Using all of ${marked.asset.name}. Review the plan again.`);
  }

  return <main className={clips.length ? "has-clips" : undefined}>
    <header><div><p className="eyebrow">VIBE CAPSULE BY CONCERT COMPASS <span className="build-label">WINDOWS TEST BUILD</span></p><h1>Keep what the night felt like.</h1><p className="subhead">Turn your concert recordings into a video shaped around the moments you love.</p></div><div className="header-actions"><button disabled={busy} onClick={openProject}>Open project</button><button className="primary" disabled={busy} onClick={importVideos}>Import videos</button></div></header>
    <nav className="workflow" aria-label="Video creation steps"><span className={clips.length ? "done" : "current"}>1 Import</span><span className={stage === "describe" && clips.length ? "current" : clips.length ? "done" : ""}>2 Describe</span><span className={stage === "review" ? "current" : stage === "cut" ? "done" : ""}>3 Review</span><span className={stage === "cut" ? "current" : ""}>4 Watch & adjust</span><span>5 Export</span></nav>
    <section className="status" aria-live="polite"><span>{message}</span>{busy && (analyzingVisuals ? <><progress aria-label="Checking this recording’s picture" /><button className="stop" onClick={stopVisualAnalysis}>Stop after this recording</button></> : checkingSound ? <><progress aria-label="Checking selected sound" /><button className="stop" onClick={stopSoundCheck}>Stop sound check</button></> : (exporting || previewing) ? <><progress max="1" value={progress} aria-label={exporting ? "Export progress" : "Preview progress"} /><button className="stop" onClick={async () => { if (await window.concertCompass.cancelRender()) setMessage(exporting ? "Stopping export…" : "Stopping preview…"); }}>{exporting ? "Stop export" : "Stop preview"}</button></> : importing ? <><progress max="1" value={progress} aria-label="Preparing video progress" /><button className="stop" onClick={stopImport}>Stop import</button></> : <progress aria-label="Preparing videos" />)}</section>
    {!clips.length ? <section className="empty"><h2>Start with your recordings</h2><p>Choose videos from a synced iCloud Drive folder or this PC. Your original recordings stay untouched.</p><button className="primary" disabled={busy} onClick={importVideos}>Choose videos</button></section> : <>
      <section className="brief" aria-label="What are we making?">
        <div className="section-heading"><div><p className="eyebrow">YOUR VIDEO, YOUR FEELING</p><h2>What are we making?</h2><p>Tell us what you want. Your marked moments and video settings are already part of this plan.</p></div><button disabled={busy || !undoStack.length} onClick={undo}>Undo</button></div>
        {stage !== "review" ? <>
          <label className="brief-description">Describe your video<textarea disabled={busy} value={briefInput.description} onFocus={remember} onChange={(event) => changeBrief({ description: event.target.value })} placeholder="A 90-second recap: slower music first, mid-tempo in the middle, an upbeat finale, and picture from several recordings." rows={3} /></label>
          <label className="video-title-field">Video title <span>(optional; shown briefly at the start)</span><input disabled={busy} aria-label="Video title (optional)" maxLength={80} value={eventTitle} placeholder="For example, a concert or night to remember" onFocus={remember} onChange={(event) => { setEventTitle(event.target.value); setBriefInput((old) => ({ ...old, eventTitle: event.target.value })); }} /></label>
          <div className="brief-quick-choice">
            <label className="brief-picture-toggle"><input type="checkbox" disabled={busy} checked={briefInput.separatePicture === true} onChange={(event) => changeBrief(event.target.checked ? { separatePicture: true } : { separatePicture: undefined, soundMomentCount: undefined, pictureSourceCount: undefined, tempoArc: false })} /> Use separate soundtrack and picture</label>
            <p>Play sound moments over footage from your recordings. Kept sections retain their own picture and sound.</p>
            {briefInput.separatePicture === true && <><div className="brief-counts">
              <div className="count-field"><label>Sound moments <small>Separate parts of the soundtrack</small><input type="number" min="1" max="12" step="1" disabled={busy} aria-label="Number of sound moments" value={soundCountDraft ?? briefInput.soundMomentCount ?? suggestedSoundCount} onFocus={(event) => { remember(); setSoundCountDraft(event.currentTarget.value); }} onChange={(event) => { const raw = event.currentTarget.value; setSoundCountDraft(raw); const count = Number(raw); if (raw === "") changeBrief({ soundMomentCount: undefined }); else if (Number.isInteger(count) && count >= 1 && count <= 12) changeBrief({ soundMomentCount: count }); }} onBlur={(event) => { const count = Number(event.currentTarget.value); if (event.currentTarget.value && Number.isFinite(count) && (!Number.isInteger(count) || count < 1 || count > 12)) changeBrief({ soundMomentCount: Math.max(1, Math.min(12, Math.round(count))) }); setSoundCountDraft(null); }} /></label>{briefInput.soundMomentCount !== undefined && <button type="button" disabled={busy} onClick={() => { remember(); setSoundCountDraft(null); changeBrief({ soundMomentCount: undefined }); }}>Use suggested</button>}</div>
              <div className="count-field"><label>Videos to show <small>Distinct imported recordings, not repeated shots</small><input type="number" min="1" max={Math.max(1, availableRecordings)} step="1" disabled={busy} aria-label="Number of videos to show" value={pictureCountDraft ?? briefInput.pictureSourceCount ?? suggestedPictureCount} onFocus={(event) => { remember(); setPictureCountDraft(event.currentTarget.value); }} onChange={(event) => { const raw = event.currentTarget.value; setPictureCountDraft(raw); const count = Number(raw); if (raw === "") changeBrief({ pictureSourceCount: undefined }); else if (Number.isInteger(count) && count >= 1 && count <= availableRecordings) changeBrief({ pictureSourceCount: count }); }} onBlur={(event) => { const count = Number(event.currentTarget.value); if (event.currentTarget.value && Number.isFinite(count) && (!Number.isInteger(count) || count < 1 || count > availableRecordings)) changeBrief({ pictureSourceCount: Math.max(1, Math.min(availableRecordings, Math.round(count))) }); setPictureCountDraft(null); }} /></label>{briefInput.pictureSourceCount !== undefined && <button type="button" disabled={busy} onClick={() => { remember(); setPictureCountDraft(null); changeBrief({ pictureSourceCount: undefined }); }}>Use suggested</button>}</div>
            </div><p className="brief-count-help">New videos start at 1:30 with three sound moments of 0:30 each, where recordings allow. Your description can set a different length or count until you change those controls.</p><label><input aria-label="Build from slower to upbeat" type="checkbox" disabled={busy} checked={briefInput.tempoArc === true} onChange={(event) => { remember(); changeBrief({ tempoArc: event.target.checked }); }} /> Build from slower to upbeat</label><p className="brief-count-help">Aim for a slow opening, a mid-tempo middle, and an upbeat finale. Kept sections come first; the first cut will explain if reliable rhythm or suitable footage is missing.</p>{availableRecordings < 2 && <p className="brief-count-help">Only one recording is available. Use it, or import another for more picture variety.</p>}</>}
          </div>
          <details className="fine-tune"><summary>Fine-tune the plan <span>optional</span></summary><div className="choice-grid">
            <fieldset><legend>Video type</legend><div className="choices">{videoTypes.map(({ value, label }) => <button type="button" key={value} aria-pressed={briefInput.videoType === value} disabled={busy} onClick={() => changeBrief({ videoType: briefInput.videoType === value ? undefined : value })}>{label}</button>)}</div></fieldset>
            <fieldset><legend>Vibe</legend><div className="choices">{vibes.map(({ value, label }) => <button type="button" key={value} aria-pressed={briefInput.vibe === value} disabled={busy} onClick={() => changeBrief({ vibe: briefInput.vibe === value ? undefined : value })}>{label}</button>)}</div>{briefInput.vibe === "custom" && <><input aria-label="Custom vibe" disabled={busy} placeholder="Describe your custom vibe" value={briefInput.customVibe ?? ""} onChange={(event) => changeBrief({ customVibe: event.target.value })} /><p className="helper">If we cannot match it with the current tools, the plan will tell you before editing.</p></>}</fieldset>
          </div>
          <fieldset><legend>Which moments?</legend><div className="choices">{modes.map(({ value, label }) => <button type="button" key={value} aria-pressed={briefInput.selectionMode === value} disabled={busy} onClick={() => changeBrief({ selectionMode: briefInput.selectionMode === value ? undefined : value })}>{label}</button>)}</div><p className="helper">Want a section kept exactly? Use “Keep this section” on its recording below.</p></fieldset></details>
          <div className="brief-bottom"><label>Length <span>(minutes or m:ss; blank lets the plan choose)</span><input disabled={busy} aria-label="Target length" value={lengthText} onFocus={remember} onChange={(event) => { setLengthText(event.target.value); setLengthFollowsDescription(false); setBriefDirty(true); setReviewBrief(null); setMessage("Your new length is saved here. Review the plan and make a first cut before exporting it."); }} placeholder={`Current edit ${clock(totalSeconds)}`} /></label><div className="brief-buttons"><button disabled={busy} onClick={editSectionsManually}>Edit sections myself (original sound)</button><button className="primary" disabled={busy} onClick={reviewPlan}>Review my plan</button></div></div>
        </> : reviewBrief && <div className="brief-review"><p className="eyebrow">HERE’S YOUR PLAN</p><h3>{reviewBrief.summary}</h3>
          {reviewBrief.soundtrackIntent ? <>
            <div className="story-plan">
              <div><strong>Soundtrack</strong><p>{reviewBrief.soundtrackIntent.segmentCount} separate sound moments from your recordings{reviewBrief.soundtrackIntent.tempoArc ? ", aiming to move from slower music to an upbeat finale" : reviewBrief.soundtrackIntent.buildEnding ? ", aiming for a stronger-sounding ending where your kept sections allow" : ""}. {reviewBrief.options.reduceRumble ? "Low-rumble reduction will be on." : "Original live sound stays."}</p></div>
              <div><strong>Picture</strong><p>{reviewBrief.soundtrackIntent.separatePicture ? `${reviewBrief.pictureSourceCount ?? suggestedPictureCount} imported ${(reviewBrief.pictureSourceCount ?? suggestedPictureCount) === 1 ? "recording" : "recordings"} will provide picture over that soundtrack. Sound from picture-only sections will not be mixed in.` : "Your selected picture will play over the separate soundtrack; source sound from other shots will not be mixed in."} {clips.some((clip) => clip.included && (clip.locked || clip.selectionSource === "manual")) ? "Your kept sections retain their picture and original sound." : "You can change picture suggestions after the first cut."}</p></div>
            </div>
            <p className="story-caution">{reviewBrief.soundtrackIntent.tempoArc ? "Tempo is assessed from reliable rhythm, not volume alone. The app cannot verify who is singing; listen to each choice before exporting." : "Recordings can differ in volume. The app cannot verify who is singing; listen to the assembled preview before exporting."}</p>
          </> : <p>{reviewBrief.selectionMode === "use-my-sections" ? "Only the sections you marked will be used." : reviewBrief.keepWholePerformance ? "We’ll keep the chosen performance continuous. Your timing remains yours to decide." : "We’ll suggest moments from unprotected recordings, then fit them to your length. You can change any suggestion."}</p>}
          <p>Look: {reviewBrief.options.finish ?? "natural"} · Picture transitions: {pictureTransitionName(reviewBrief.options.transition)} · Sound transitions: {soundTransitionName(reviewBrief.options)}. Kept sections retain their timing and original sound.</p>
          {reviewBrief.limitations.map((item) => <p className="limit" key={item}>{item}</p>)}
          {reviewBrief.conflict && <div className="conflict" role="alert"><strong>{reviewBrief.conflict.message}</strong>
            {(reviewBrief.conflict.kind === "one-song-multiple-sections" || reviewBrief.conflict.kind === "one-song-choose-recording") && <div className="choices">{clips.filter((clip) => clip.included && !clip.excludedByUser).map((clip) => <button disabled={busy} key={clip.asset.path} onClick={() => chooseOneSong(clip.asset.path)}>Use {clip.label || clip.asset.name}</button>)}</div>}
            {reviewBrief.conflict.kind === "intact-vs-marked" && <div className="choices"><button disabled={busy} onClick={() => firstCut("keep-marked")}>Keep my marked section</button><button disabled={busy} onClick={useWholePerformance}>Use whole recording</button></div>}
            {reviewBrief.conflict.kind === "insufficient-footage" && <button disabled={busy} onClick={() => { const seconds = reviewBrief.conflict?.availableSeconds; if (seconds) { setLengthText(clock(seconds)); changeBrief({ targetSeconds: seconds }); } }}>Use available length</button>}
          </div>}
          {storyError && <div className="conflict" role="alert"><strong>We could not make that audio story yet.</strong><p>{storyError}</p><p>Adjust your recordings or protected sections, then review the plan again.</p></div>}
          <div className="brief-buttons"><button disabled={busy} onClick={() => setStage("describe")}>Adjust</button>{reviewBrief.conflict?.kind === "protected-over-target" && !reviewBrief.soundtrackIntent ? <button className="primary" disabled={busy} onClick={() => firstCut("extend")}>Keep all and extend</button> : reviewBrief.conflict?.kind === "protected-over-target" ? <button className="primary" disabled={busy} onClick={() => { setStage("describe"); setTimeout(() => document.querySelector<HTMLInputElement>('input[aria-label="Target length"]')?.focus(), 0); }}>Change length</button> : <button className="primary" disabled={busy || !!reviewBrief.conflict} onClick={() => firstCut()}>Make my first cut</button>}</div>
        </div>}
      </section>
      {stage === "cut" && <section id="watch-first-cut" className="draft" aria-label="Watch first cut">
        <div className="draft-heading"><div><p className="eyebrow">FIRST CUT READY</p><h2>Watch your video</h2><p>{audioSelections ? `Hear ${audioSelections.length} sound moments with picture from ${reviewBrief?.pictureSourceCount ?? selected.length} imported ${(reviewBrief?.pictureSourceCount ?? selected.length) === 1 ? "recording" : "recordings"}. The assembled preview uses the new soundtrack; source previews below still play their original sound.` : "See the selected sections together with the chosen framing, color, sound, and joins."} This local draft is for review; Export MP4 saves the finished file.</p></div><button className="primary" disabled={busy || !selected.length || briefDirty || storyNeedsRebuild || guidedCutPending} onClick={previewFirstCut}>{draftUrl && draftSignature !== cutSignature ? "Update preview" : draftUrl ? "Make preview again" : "Watch first cut"}</button></div>
        {briefDirty && <p className="draft-stale" role="alert">Your new request has not been made yet. Review the plan and make a first cut.</p>}
        {storyNeedsRebuild && <p className="draft-stale" role="alert">{storyRebuildMessage}</p>}
        {previewing && <progress className="draft-progress" max="1" value={progress} aria-label="Preparing first-cut preview" />}
        {draftUrl && draftSignature === cutSignature && !briefDirty && !storyNeedsRebuild && <video className="draft-player" src={draftUrl} controls preload="metadata" aria-label="Assembled first-cut preview" />}
        {draftUrl && draftSignature !== cutSignature && !briefDirty && !storyNeedsRebuild && <p className="draft-stale">Your edit changed. Update the preview to see the latest version.</p>}
      </section>}
      {!guidedCutPending && selected.length > 0 && <section id="sound-check" className="sound-check" aria-label="Automatic sound check"
        data-sound-check={currentSoundReview ? "complete" : checkingSound ? "checking" : "pending"}
        data-checked-sections={currentSoundReview?.items.length ?? 0}>
        <h2>Automatic sound check</h2>
        {!currentSoundReview ? <p>{checkingSound ? "Checking each selected sound section, including the sound used in overlaps…" : "Sound will be checked across each selected section before preview or export. Changing a section updates this check."}</p> : <>
          <p>{!currentSoundReview.items.length ? "These selections have no recorded sound to check." :
            currentSoundReview.items.every(item => item.report.status === "checked") ? "Sound checked across every selected section, including overlaps." :
            "Sound checked with some gaps in coverage. Unchecked sound is not confirmed clear."}</p>
          {soundWarnings.map(item => <div className="sound-check-source" key={`${item.selection.asset.path}-${item.index}`}>
            <strong>Sound {item.index + 1} · {item.selection.asset.name}</strong>
            {item.report.status === "unavailable" ? <p>The automatic check is unavailable for this section. Listen to it before keeping the sound.</p> :
              item.report.status === "partial" && <p>About {Math.min(99, Math.floor(item.report.analyzedFraction * 100))}% of this section could be checked. Unchecked edges or gaps still need a listen.</p>}
            {!!item.report.intervals.length && <ul>{item.report.intervals.map((interval, index) => <li key={`${interval.start}-${index}`}>
              <span>Possible {interval.kind === "speech" ? "speech or shout" : "crowd interruption"} · {clock(interval.start)}–{clock(interval.end)} in the recording</span>
              <button disabled={busy} aria-label={`Listen near ${clock(interval.start)} in ${item.selection.asset.name}`}
                onClick={() => listenSoundMoment({ ...item.selection, start: Math.max(0, interval.start - 0.5) })}>Listen here</button>
            </li>)}</ul>}
          </div>)}
          {!soundWarnings.length && currentSoundReview.items.length > 0 && <p>No likely crowd or speech interruptions were found in the checked sound.</p>}
          <p className="sound-check-limit">This check can miss an interruption or flag the artist speaking. It never removes a kept moment or changes your sound by itself.</p>
          {soundDecisionNeeded && <div className="sound-check-actions"><p>Listen to the flagged moments, choose another section, or keep this sound if it belongs in your video.</p>
            <button className="primary" disabled={busy || briefDirty || storyNeedsRebuild}
              onClick={() => exportReel(currentSoundReview.signature)}>Export with this sound</button>
          </div>}
        </>}
      </section>}
      {stage === "cut" && audioSelections && <section className="soundtrack" aria-label="Soundtrack moments">
        <div className="soundtrack-heading"><p className="eyebrow">YOUR SOUNDTRACK</p><h2>{audioSelections.length} sound moments, one video</h2><p>These moments play in order while the selected imported recordings provide the picture. Listen to the assembled preview to judge how the ending feels.</p></div>
        <ol className="soundtrack-list">{audioSelections.map((sound, index) => <li key={`${sound.asset.path}-${index}`}>
          <div><span className="sound-number">Sound {index + 1}</span><strong>{sound.asset.name}</strong><small>{clock(sound.start)}–{clock(sound.end)} · {clock(sound.end - sound.start)}</small>{sound.locked && <span className="sound-locked">Kept by you</span>}</div>
          <div className="sound-actions"><button disabled={busy} aria-label={`Listen to sound ${index + 1} in ${sound.asset.name}`} onClick={() => listenSoundMoment(sound)}>Listen to source audio</button><button disabled={busy || !!sound.locked || briefDirty || storyNeedsRebuild} aria-label={sound.locked ? `Sound ${index + 1} is protected` : `Choose another moment for sound ${index + 1}`} onClick={() => refineSoundMoment(index)}>{sound.locked ? "Protected sound" : "Choose another sound moment"}</button></div>
        </li>)}</ol>
        <p className="soundtrack-note">{reduceRumble ? "Very low rumble will be reduced." : "Live sound stays as recorded."} This does not remove crowd sound or fix mic distortion.</p>
      </section>}
      {stage === "cut" && <section className="refine"><div><h2>Make it yours</h2><p>{audioSelections ? "Try another sound moment above or choose a different picture section below. To change the total length, review your plan again." : "Change one thing at a time. Everything else stays where it is."}</p></div>{!audioSelections && <button disabled={busy} onClick={() => refine({ kind: "fewer-cuts" })}>Fewer cuts</button>}</section>}
      <section className="toolbar"><div><b>{audioSelections ? `${selected.length} videos to show · ${audioSelections.length} sound moments` : `${selected.length} selected`}</b><span>{clock(totalSeconds)} planned output · recordings play from top to bottom</span>{guidedCutPending && <span className="pending-badge">Make a first cut or choose manual editing before export</span>}{briefDirty && <span className="pending-badge">Make your new request before export</span>}{!briefDirty && storyNeedsRebuild && <span className="pending-badge">Rebuild the picture and soundtrack before export</span>}</div><div className="toolbar-actions"><button disabled={busy} onClick={saveProject}>Save project</button><button className="primary" disabled={busy || !selected.length || briefDirty || storyNeedsRebuild || guidedCutPending} onClick={() => exportReel()}>Export MP4</button></div></section>
      <section className="visual-studio" aria-label="Visual direction">
        <div className="visual-studio-heading"><div><p className="eyebrow">THE VISUAL PASS</p><h2>Give the night its look</h2><p>Follow the stage, keep the picture clean, and add a little neon when the music calls for it. Your soundtrack and kept sections stay yours.</p></div><span className="local-badge">On this PC · originals unchanged</span></div>
        <div className="visual-controls">
          <fieldset><legend>Smart framing</legend><div className="choices">{([
            ["off", "Off · manual"], ["balanced", "Balanced"], ["follow-performer", "Follow performer"], ["group-performance", "Group performance"],
          ] as const).map(([value, label]) => <button key={value} disabled={busy} aria-pressed={smartFraming === value} onClick={() => changeSmartFraming(value)}>{label}</button>)}</div><p>{smartFraming === "off" ? "Use the framing and crop aim on each recording below." : "Uses checked people and continuity to plan a smooth crop. If a crop would lose too much, the full frame stays over a soft background. Analyze visuals first; you can choose a performer below."}</p></fieldset>
          <fieldset><legend>Video enhancement</legend><div className="choices">{([
            ["original", "Original"], ["clean", "Clean"], ["enhanced", "Enhanced"], ["maximum", "Maximum"],
          ] as const).map(([value, label]) => <button key={value} disabled={busy} aria-pressed={videoEnhancement === value && !enhance} onClick={() => { remember(); setVideoEnhancement(value); setEnhance(false); invalidateReview(); }}>{label}</button>)}</div><p>{enhance ? "This saved project uses the earlier gentle cleanup. Choose a level to replace it." : videoEnhancement === "original" ? "Keeps the recorded picture before your chosen color look and effects." : videoEnhancement === "clean" ? "Light, consistent grain cleanup with restrained sharpening." : videoEnhancement === "enhanced" ? "More grain cleanup and measured low-light correction, with gentle sharpening." : "Stronger grain cleanup for difficult footage. Compare with Clean; it cannot recover missing detail or repair faces."}</p></fieldset>
          <fieldset><legend>Effects</legend><div className="choices effect-choices">{([
            ["none", "None"], ["subtle", "Subtle glow"], ["neon-pop", "Neon Pop"], ["full-y2k", "Full Y2K"],
          ] as const).map(([value, label]) => <button key={value} disabled={busy} aria-pressed={effects === value} onClick={() => { remember(); setEffects(value); invalidateReview(); }}>{label}</button>)}</div><p>{effects === "none" ? "A clean performance edit, with no added graphics." : effects === "subtle" ? "A soft bloom around bright source lights. No added text." : effects === "neon-pop" ? "Pink, cyan and purple light trails with occasional starbursts. No added text." : "Neon trails, starbursts and a few holographic accents, with clean performance shots between them. No added text."} {effects !== "none" && "Music accents use confident timing when available; otherwise opening and closing accents are used."}</p><label className="reduced-flash"><input disabled={busy} type="checkbox" checked={reducedFlash} onChange={event => { remember(); setReducedFlash(event.target.checked); invalidateReview(); }} /> Gentler effects · fewer, softer accents</label><p className="visual-limit">Concert lights in the original footage may still flash.</p></fieldset>
          <div className="visual-analysis"><h3>Find stronger pictures</h3><p>Check available recordings for visible people, stable shots and lighting. Chosen performers receive a closer check around your point in the selected section. This does not recognize the artist, songs, or facial identity.</p><div className="clip-actions"><button disabled={busy || !clips.some(clip => !clip.excludedByUser)} onClick={analyzeVisuals}>{analyzedVisualCount ? "Check new or changed pictures" : "Analyze visuals"}</button>{analyzingVisuals && <button onClick={stopVisualAnalysis}>Stop after this recording</button>}<button disabled={busy || !analyzedVisualCount || !audioSelections || briefDirty || storyNeedsRebuild} onClick={choosePictureMoments}>Choose picture moments</button></div>{analyzingVisuals && <progress max="1" value={visualProgress} aria-label="Recordings checked for visual suggestions" />}<p className="visual-status" aria-live="polite">{analyzedVisualCount} of {availableRecordings} available recordings checked{fittedVisualCount ? ` · ${fittedVisualCount} selected ${fittedVisualCount === 1 ? "shot keeps" : "shots keep"} the whole frame` : ""}.</p><p className="visual-limit">Picture suggestions need a first cut with a separate soundtrack. They keep its length, sound, manual choices and selected subjects. Watch the assembled preview to judge tracking and effects; source players below show the original picture.</p></div>
        </div>
      </section>
      <section className="options" aria-label="Export options">
        <div><b>Video shape</b><div className="clip-actions">
          <button disabled={busy} aria-pressed={aspect === "vertical"} onClick={() => setShape("vertical")}>Phone 9:16 · default</button>
          <button disabled={busy} aria-pressed={aspect === "portrait913"} onClick={() => setShape("portrait913")}>Portrait 9:13</button>
          <button disabled={busy} aria-pressed={aspect === "landscape"} onClick={() => setShape("landscape")}>Widescreen 16:9</button>
        </div><p>{smartFraming === "off" ? "Aim the crop on each recording below, or choose Show whole frame to keep every edge visible." : "Checked pictures use the selected smart framing. Unchecked pictures keep their saved framing; analyze visuals to plan their crops."}</p></div>
        <div><b>Export quality</b><div className="clip-actions">
          <button disabled={busy} aria-pressed={quality === "high"} onClick={() => { remember(); setQuality("high"); invalidateReview(); }}>Best available · up to 1080p</button>
          <button disabled={busy} aria-pressed={quality === "standard"} onClick={() => { remember(); setQuality("standard"); invalidateReview(); }}>Standard · smaller file</button>
        </div><p>Best available preserves source detail with less compression. Exports take longer and use more space; the review preview stays smaller.</p></div>
        <div><b>Picture transitions</b><div className="clip-actions">
          <button disabled={busy} aria-pressed={transition === "cut"} onClick={() => changePictureTransition("cut")}>Straight cut</button>
          <button disabled={busy} aria-pressed={transition === "dissolve"} onClick={() => changePictureTransition("dissolve")}>Dissolve</button>
          <button disabled={busy} aria-pressed={transition === "smoothslide"} onClick={() => changePictureTransition("smoothslide")}>Smooth slide</button>
          <button disabled={busy} aria-pressed={transition === "fade"} onClick={() => changePictureTransition("fade")}>Brief fade to black</button>
        </div><p>Dissolves and slides blend nearby footage where there is room. Your kept sections and total length stay intact.</p></div>
        <div><b>Sound transitions</b><div className="clip-actions">
          <button disabled={busy} aria-pressed={audioTransition === "crossfade"} onClick={() => { remember(); setAudioTransition("crossfade"); invalidateReview(); }}>Blend sound</button>
          <button disabled={busy} aria-pressed={audioTransition === "cut"} onClick={() => { remember(); setAudioTransition("cut"); invalidateReview(); }}>Direct join</button>
        </div>{audioTransition === "crossfade" && <div className="focus-control">
          <label htmlFor="audio-overlap">Sound overlap <span>up to {audioCrossfadeSeconds.toFixed(1)} seconds</span></label>
          <input id="audio-overlap" aria-label="Sound overlap seconds" disabled={busy} type="range" min="0.1" max="5" step="0.1" value={audioCrossfadeSeconds}
            onPointerDown={() => { remember(); audioCrossfadeDragging.current = true; }} onPointerUp={() => { audioCrossfadeDragging.current = false; }}
            onPointerCancel={() => { audioCrossfadeDragging.current = false; }} onBlur={() => { audioCrossfadeDragging.current = false; }}
            onChange={(event) => changeAudioCrossfade(Number(event.target.value))} />
        </div>}<p>{audioTransition === "crossfade" ? "Blends nearby source audio where there is room, without changing kept moments." : "Keeps each recording’s sound separate at the join."} Listen to the assembled preview to check the song changes.</p></div>
        <div><b>Music-led timing</b><label><input aria-label="Follow the beat" disabled={busy} type="checkbox" checked={beatSync} onChange={(event) => changeMusicPreferences({ beatSync: event.target.checked })} /> Follow the beat</label><p>With a separate soundtrack, aligns song changes and picture cuts to clear, compatible beats without changing song speed. Uncertain rhythm keeps the existing timing; your kept sections stay protected.</p></div>
        <div><b>Highlight choices</b><label><input aria-label="Favor the performance" disabled={busy} type="checkbox" checked={highlightFocus === "performance"} onChange={(event) => changeMusicPreferences({ highlightFocus: event.target.checked ? "performance" : "balanced" })} /> Favor the performance</label><p>Looks across each candidate for likely singing and possible crowd or speech interruptions. It works on this PC; it cannot tell the artist from a singing crowd or guarantee a big vocal moment. Your chosen sound is checked again before export.</p></div>
        <div><b>Finishing look</b><div className="clip-actions">{(["natural", "vivid", "cinematic", "warm"] as const).map((look) => <button key={look} disabled={busy} aria-pressed={finish === look} onClick={() => { remember(); setFinish(look); invalidateReview(); }}>{look}</button>)}</div><p>Subtle color treatment; it does not detect scenes or moods.</p></div>
        <label><input disabled={busy} type="checkbox" checked={reduceRumble} onChange={(event) => { remember(); setReduceRumble(event.target.checked); setBriefInput((old) => ({ ...old, reduceRumble: event.target.checked })); invalidateReview(); if (audioSelections) { setBriefDirty(true); setMessage("Low-rumble processing changes how sound moments are chosen. Review your plan and make a new first cut before exporting."); } }} /> Reduce low rumble <small>Gently lowers very low bass. It does not remove crowd voices.</small></label>
        <div><b>On-screen details · optional</b><label><input aria-label="Show my named moments on video" disabled={busy || !!audioSelections} type="checkbox" checked={showClipLabels && !audioSelections} onChange={(event) => { remember(); setShowClipLabels(event.target.checked); setBriefInput((old) => ({ ...old, showClipLabels: event.target.checked })); invalidateReview(); }} /> Show my named moments on video</label><p>Off by default. Uses only names you enter below; separate soundtracks keep these labels off.</p></div>
      </section>
      <section className="clips" id="clip-editor" aria-label="Clip editor">{clips.map((clip, index) => <article className={!clip.included || clip.excludedByUser ? "off" : ""} key={clip.asset.path}>
        <div className="clip-title"><label><input type="checkbox" disabled={busy} checked={clip.included && !clip.excludedByUser} onChange={(event) => changeClip(index, { included: event.target.checked, excludedByUser: !event.target.checked }, event.target.checked)} /> Include</label><h2>{index + 1}. {clip.asset.name}</h2>{(!clip.included || clip.excludedByUser) && <span className="excluded-badge">Excluded from video</span>}<p>{clock(clip.asset.duration)} · {audioSelections ? "Picture source; finished sound follows the soundtrack" : clip.asset.hasAudio ? "Original audio" : "Silent video"}</p><label className="moment-label">Song or moment name <input disabled={busy} value={clip.label ?? ""} maxLength={100} placeholder="Optional, supplied by you" onChange={(event) => changeClip(index, { label: event.target.value })} /></label><div className="clip-actions"><button disabled={busy || index === 0} aria-label={`Move ${clip.asset.name} earlier`} onClick={() => move(index, -1)}>↑ Earlier</button><button disabled={busy || index === clips.length - 1} aria-label={`Move ${clip.asset.name} later`} onClick={() => move(index, 1)}>↓ Later</button></div></div>
        <div className="preview">
          {(briefInput.separatePicture || audioSelections) && clip.asset.hasAudio && <label><input type="checkbox"
            aria-label={`Use picture only from ${clip.asset.name}`} checked={clip.soundExcludedByUser ?? false}
            disabled={busy || (!clip.soundExcludedByUser && (clip.locked || clip.selectionSource === "manual"))}
            onChange={(event) => changeSoundAvailability(index, event.target.checked)} /> Picture only · skip this recording’s sound</label>}
          <p className="preview-label">{choosingSubject === clip.asset.path ? "Choose the performer in this full original frame" : smartFraming === "off" && showsCropGuide(aspect, clip.asset, clip.framing, quality) ? "Manual framing guide with original sound" : "Original picture and sound · smart framing appears in the assembled preview"} · selected part is {clock(clip.start)}–{clock(clip.end)}</p>
          <div className={choosingSubject === clip.asset.path ? "preview-screen subject-picking" : smartFraming === "off" && showsCropGuide(aspect, clip.asset, clip.framing, quality) ? "preview-screen crop-preview" : "preview-screen"} style={choosingSubject === clip.asset.path ? { aspectRatio: `${clip.asset.width} / ${clip.asset.height}` } : smartFraming === "off" && showsCropGuide(aspect, clip.asset, clip.framing, quality) ? { aspectRatio: `${shapeRatio(aspect)}` } : undefined}>
            <video style={smartFraming === "off" && choosingSubject !== clip.asset.path && showsCropGuide(aspect, clip.asset, clip.framing, quality) ? { objectPosition: `${Math.round((clip.focus ?? 0.5) * 100)}% center` } : undefined} ref={(element) => { if (element) players.current.set(clip.asset.path, element); else players.current.delete(clip.asset.path); }} onTimeUpdate={(event) => { const time = event.currentTarget.currentTime; setPositions((old) => ({ ...old, [clip.asset.path]: time })); }} onClick={event => { if (choosingSubject === clip.asset.path) void chooseSubject(index, event); }} controls={choosingSubject !== clip.asset.path} preload="auto" crossOrigin="anonymous" src={clip.previewUrl} aria-label={choosingSubject === clip.asset.path ? `Click the performer in the original frame of ${clip.asset.name}` : `Preview ${clip.asset.name}`} />
            {choosingSubject === clip.asset.path && clip.subject && <span className="subject-point" aria-hidden="true" style={{ left: `${clip.subject.x * 100}%`, top: `${clip.subject.y * 100}%` }} />}
          </div>
          <div className="clip-actions subject-actions">{choosingSubject === clip.asset.path ? <><button disabled={busy} onClick={() => setChoosingSubject(null)}>Cancel performer choice</button><button disabled={busy} onClick={() => void saveSubject(index, 0.5, 0.5)}>Use center point</button></> : <button disabled={busy || clip.excludedByUser} onClick={() => beginSubjectChoice(clip)}>{clip.subject ? "Change performer" : "Choose performer"}</button>}{clip.subject && <button disabled={busy} onClick={() => clearSubject(index)}>Clear performer choice</button>}</div>
          {choosingSubject === clip.asset.path && <p className="subject-instruction">The source is paused at your section’s start. Click the person to keep in frame, or use the center point. No match means the app holds the picture rather than switching people.</p>}
          <div className="seek"><button disabled={busy} aria-label={`Back five seconds in ${clip.asset.name}`} onClick={() => seek(clip, (positions[clip.asset.path] ?? 0) - 5)}>−5s</button><input disabled={busy} aria-label={`Move through ${clip.asset.name}`} type="range" min="0" max={clip.asset.duration} step="0.1" value={Math.min(clip.asset.duration, positions[clip.asset.path] ?? 0)} onChange={(event) => seek(clip, Number(event.target.value))} /><button disabled={busy} aria-label={`Forward five seconds in ${clip.asset.name}`} onClick={() => seek(clip, (positions[clip.asset.path] ?? 0) + 5)}>+5s</button></div><small>{clock(positions[clip.asset.path] ?? 0)} / {clock(clip.asset.duration)}</small>
        </div>
        <div className="trim"><div className="frame-choice">
          <strong>Framing in the finished video</strong>
          {smartFraming !== "off" && <div className="tracking-status"><span className="tracking-badge">{clip.subject ? "Your performer choice" : "Smart framing"}{clip.visualAnalysis?.analysisRegion ? " · closer check around your point" : ""}</span><p>{clip.tracking ? `${Math.round(clip.tracking.coverage * 100)}% of checked frames have a subject match. ${clip.tracking.suggestedFraming === "fit" ? "The whole frame is kept over a soft background for this section." : "The crop follows the planned subject smoothly."}` : "Analyze visuals to plan this section. Until then, its saved framing is used."}</p>{clip.tracking?.notes.slice(0, 2).map(note => <p key={note}>{note}</p>)}<p>Turn Smart framing Off above to use the manual controls below. Check the assembled preview for missed people, obstructions, and awkward crops.</p></div>}
          <div className="choices"><button disabled={busy || smartFraming !== "off"} aria-pressed={clip.framing === undefined} onClick={() => changeClip(index, { framing: undefined })}>Automatic</button><button disabled={busy || smartFraming !== "off"} aria-pressed={clip.framing === "fit"} onClick={() => changeClip(index, { framing: "fit" })}>Show whole frame</button><button disabled={busy || smartFraming !== "off"} aria-pressed={clip.framing === "fill"} onClick={() => changeClip(index, { framing: "fill" })}>Fill screen</button></div>
          {hasSideCrop(aspect, clip.asset, clip.framing, quality) ? <div className="focus-control">
            <label htmlFor={`focus-${index}`}>Aim the crop <span>{Math.round((clip.focus ?? 0.5) * 100) === 50 ? "Center" : Math.round((clip.focus ?? 0.5) * 100) < 50 ? "Toward left" : "Toward right"}</span></label>
            <input id={`focus-${index}`} disabled={busy || smartFraming !== "off"} type="range" min="0" max="100" step="1" value={Math.round((clip.focus ?? 0.5) * 100)} aria-label={`Aim portrait crop for ${clip.asset.name}`} onPointerDown={() => { remember(); focusDragging.current = true; }} onPointerUp={() => { focusDragging.current = false; }} onPointerCancel={() => { focusDragging.current = false; }} onBlur={() => { focusDragging.current = false; }} onChange={(event) => changeFocus(index, Number(event.target.value) / 100)} />
            <div className="focus-scale"><span>Left</span><span>Center</span><span>Right</span></div>
            <p>{smartFraming === "off" ? "Play the manual crop guide above, then aim toward the stage, performer, or crowd. Manual Automatic starts in the center." : "Your manual aim is saved for when Smart framing is Off."}</p>
          </div> : <p>{clip.framing === "fit" ? "The whole original frame stays visible over a soft background. Watch the first cut to check the finished look." : showsCropGuide(aspect, clip.asset, clip.framing, quality) ? "This shape fills the frame; it may crop the top and bottom. Watch the first cut to check the finished look." : "Automatic fills similar shapes and uses a soft background for very different shapes. Watch the first cut to check the finished look."}</p>}
        </div><div className="trim-heading"><div><b>{clip.locked ? "Kept by you" : clip.selectionSource === "manual" ? "Selected by you" : "Suggested section"}</b><p>Pause the preview where you want to start or end.</p></div><label><input type="checkbox" disabled={busy} checked={clip.locked} onChange={(event) => changeClip(index, { locked: event.target.checked, selectionSource: event.target.checked ? "manual" : "suggested" })} /> Keep this section</label></div><div className="clip-actions"><button disabled={busy} onClick={() => mark(index, "start")}>Set start here</button><button disabled={busy} onClick={() => mark(index, "end")}>Set end here</button><button disabled={busy} onClick={() => changeClip(index, { start: 0, end: clip.asset.duration }, true)}>Use whole clip</button><button disabled={busy || clip.locked} onClick={() => suggest(index)}>Suggest a moment</button></div><p>Suggestions use sound measurements and, when available, local singing estimates. Song and performer identities are not recognized.</p><label>Start (seconds) <input disabled={busy} aria-label={`${clip.asset.name} start`} type="number" min="0" max={clip.asset.duration} step="0.1" value={Math.round(clip.start * 100) / 100} onChange={(event) => changeClip(index, { start: Math.max(0, Math.min(Number(event.target.value), clip.end - 0.1)) }, true)} /></label><label>End (seconds) <input disabled={busy} aria-label={`${clip.asset.name} end`} type="number" min="0.1" max={clip.asset.duration} step="0.1" value={Math.round(clip.end * 100) / 100} onChange={(event) => changeClip(index, { end: Math.min(clip.asset.duration, Math.max(Number(event.target.value), clip.start + 0.1)) }, true)} /></label></div>
        {stage === "cut" && <div className="clip-actions refine-actions">{!audioSelections && <button disabled={busy || clip.excludedByUser || clip.locked} onClick={() => refine({ kind: "more-from-clip", path: clip.asset.path })}>More from this clip</button>}<button disabled={busy} onClick={() => refine({ kind: "keep-section", path: clip.asset.path })}>Keep that section</button><button disabled={busy || clip.excludedByUser || clip.locked} onClick={() => refine({ kind: "choose-another", path: clip.asset.path })}>Choose something else</button></div>}
        <p className="note">Selected range: {clock(clip.start)}–{clock(clip.end)} ({(clip.end - clip.start).toFixed(1)} seconds){clip.label ? ` · ${clip.label} (named by you)` : ""}</p>
      </article>)}</section>
    </>}
    <footer><b>Your recordings, your choices.</b> Music-led suggestions, optional finishing, and local MP4 export. The app does not identify songs or singers. Review the assembled video before sharing.</footer>
  </main>;
}
