import type { ExportOptions, RenderSelection } from "./render-plan.js";

export type VideoType = "highlight" | "one-song" | "recap" | "compilation";
export type Vibe = "energetic" | "cinematic" | "nostalgic" | "intimate" | "clean-live" | "custom";
export type SelectionMode = "use-my-sections" | "choose-for-me" | "keep-and-choose";
export type SoundtrackIntent = {
  segmentCount: number;
  buildEnding: boolean;
  separatePicture: boolean;
  cleanupRequested: boolean;
  tempoArc?: boolean;
};
export type CreativeClip = RenderSelection & {
  included: boolean;
  selectionSource: "suggested" | "manual";
  locked: boolean;
  orderLocked?: boolean;
  excludedByUser: boolean;
  soundExcludedByUser?: boolean;
  label?: string;
};

export type CreativeBriefInput = {
  description: string;
  videoType?: VideoType;
  vibe?: Vibe;
  selectionMode?: SelectionMode;
  targetSeconds?: number | null;
  aspect?: ExportOptions["aspect"];
  reduceRumble?: boolean;
  eventTitle?: string;
  showClipLabels?: boolean;
  transition?: ExportOptions["transition"];
  beatSync?: boolean;
  highlightFocus?: "balanced" | "performance";
  separatePicture?: boolean;
  soundMomentCount?: number;
  tempoArc?: boolean;
  pictureSourceCount?: number;
  customVibe?: string;
};

export type BriefConflict = {
  kind: "protected-over-target" | "one-song-multiple-sections" | "one-song-choose-recording" |
    "intact-vs-marked" | "intact-vs-soundtrack" | "insufficient-footage" | "no-marked-sections" |
    "audio-story-no-sound" | "audio-story-picture-variety" | "audio-story-picture-count" |
    "audio-story-all-picture-protected" | "audio-story-picture-mode" | "audio-story-locked-count" |
    "audio-story-silent-lock" | "audio-story-insufficient-audio" | "audio-story-short-target" | "audio-story-picture-only-lock";
  message: string;
  requestedSeconds?: number;
  availableSeconds?: number;
};

export type CreativeBrief = {
  description: string;
  videoType: VideoType;
  vibe: Vibe;
  selectionMode: SelectionMode;
  keepWholePerformance: boolean;
  soundtrackIntent: SoundtrackIntent | null;
  pictureSourceCount: number | null;
  targetSeconds: number | null;
  aspect: ExportOptions["aspect"];
  customVibe: string;
  summary: string;
  limitations: string[];
  conflict: BriefConflict | null;
  options: ExportOptions;
};

export type CutResult<T extends CreativeClip> = { clips: T[]; options: ExportOptions; plannedSeconds: number; notes: string[] };
export type Refinement = { kind: "fewer-cuts" | "more-from-clip" | "keep-section" | "choose-another"; path?: string };

const duration = (clip: RenderSelection) => clip.end - clip.start;
const total = (clips: CreativeClip[]) => clips.filter((clip) => clip.included && !clip.excludedByUser).reduce((sum, clip) => sum + duration(clip), 0);
const time = (seconds: number) => { const rounded = Math.round(seconds); return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`; };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

function validateClips(clips: CreativeClip[]) {
  if (!clips.length) throw new Error("Import a video before making a cut.");
  for (const clip of clips) {
    if (!clip.asset?.path || !Number.isFinite(clip.asset.duration) || clip.asset.duration < 0.1 ||
      !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 ||
      clip.end > clip.asset.duration + 0.05 || duration(clip) < 0.1 ||
      !["manual", "suggested"].includes(clip.selectionSource) ||
      typeof clip.included !== "boolean" || typeof clip.locked !== "boolean" || typeof clip.excludedByUser !== "boolean" ||
      (clip.soundExcludedByUser !== undefined && typeof clip.soundExcludedByUser !== "boolean") ||
      (clip.label !== undefined && (typeof clip.label !== "string" || clip.label.length > 100))) {
      throw new Error(`Invalid section for ${clip.asset?.name || "a recording"}.`);
    }
  }
  if (new Set(clips.map((clip) => clip.asset.path)).size !== clips.length) {
    throw new Error("Each recording can appear only once in this editor.");
  }
}

function parseSeconds(description: string): number | null {
  const timestamp = description.match(/\b(\d{1,2}):([0-5]\d)\b/);
  if (timestamp) return Number(timestamp[1]) * 60 + Number(timestamp[2]);
  const wordNumbers: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const minutes = description.match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*(?:minutes?|mins?)\b/i);
  if (minutes) return (wordNumbers[minutes[1].toLowerCase()] ?? Number(minutes[1])) * 60;
  const seconds = description.match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*(?:seconds?|secs?)\b/i);
  return seconds ? wordNumbers[seconds[1].toLowerCase()] ?? Number(seconds[1]) : null;
}

function parsedType(text: string): VideoType | undefined {
  if (/\b(one|single)[\s-]*song\b|\bjust this song\b|\bfull performance\b|\bkeep (?:this|the) performance intact\b/i.test(text)) return "one-song";
  if (/\brecap\b|\bwhole night\b/i.test(text)) return "recap";
  if (/\bcompilation\b|\bmontage\b/i.test(text)) return "compilation";
  if (/\bhighlights?\b/i.test(text)) return "highlight";
}

function asksForWholePerformance(text: string): boolean {
  return /\b(?:keep|leave) (?:this|the) (?:song|performance) (?:fully )?intact\b|\b(?:full|entire|whole) (?:song|performance)\b|\bkeep (?:this|the) (?:song|performance) whole\b/i.test(text);
}

// A starting choice for a new wizard only. Saved projects and explicit length
// controls do not call this helper, so reopening never replaces their timing.
export function freshWizardTargetSeconds(description: string): number | null {
  return parseSeconds(description) ?? (asksForWholePerformance(description) ||
    parsedSelection(description) === "use-my-sections" ? null : 90);
}

function parsedVibe(text: string): Vibe | undefined {
  if (/\benergetic\b|\bhigh.energy\b|\bfast.paced\b/i.test(text)) return "energetic";
  if (/\bcinematic\b|\bfilm.like\b/i.test(text)) return "cinematic";
  if (/\bnostalgic\b|\bmemory\b/i.test(text)) return "nostalgic";
  if (/\bintimate\b|\bquiet\b/i.test(text)) return "intimate";
  // Cleaning sound is an audio request, not a request to change the picture's vibe.
  const withoutAudio = text.replace(/\bclean(?:ed|er|ing)?\s+(?:up\s+)?(?:the\s+)?(?:audio|sound)\b/gi, "")
    .replace(/\b(?:audio|sound)\s+clean(?:ed|er|ing|up)?\b/gi, "");
  if (/\bclean\b|\blive\b|\bnatural\b/i.test(withoutAudio)) return "clean-live";
}

function requestsCleanup(text: string): boolean {
  return /\b(?:clean|cleaner|cleaning|cleaned|tidy|improve|fix|enhance|polish)(?:\s+up)?\s+(?:the\s+)?(?:audio|sound)\b|\b(?:audio|sound)\s+clean(?:ed|er|ing|up)?\b|\breduce\s+(?:low\s+)?rumble\b|\bremove\s+(?:the\s+)?(?:crowd|voices|noise)\b/i.test(text);
}

function parsedSoundMomentCount(text: string, soundMomentOverride?: number): number | null {
  const number = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";
  const unit = "(?:clips?|moments?|segments?|sections?|pieces?|parts?|recordings?)";
  const sound = "(?:audio|sound|soundtrack)";
  const countPatterns = [
    `\\b${number}[\\s-]+${sound}[\\s-]+${unit}\\b`,
    `\\b${number}[\\s-]+${unit}[\\s-]+(?:of|for|from)[\\s-]+(?:the[\\s-]+)?${sound}\\b`,
    `\\b${sound}[\\s-]+(?:from|across|using)[\\s-]+${number}[\\s-]+(?:clips?|recordings?|videos?|sources?)\\b`,
    `\\b(?:use|feature|include|choose|select)[\\s-]+${number}[\\s-]+${unit}[\\s-]+(?:for|as)[\\s-]+(?:the[\\s-]+)?${sound}\\b`,
  ];
  const spoken: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const countText = countPatterns.map((pattern) => text.match(new RegExp(pattern, "i"))?.[1])
    .find((match) => match !== undefined)?.toLowerCase();
  const requestedCount = soundMomentOverride ?? (countText === undefined ? null : spoken[countText] ?? Number(countText));
  if (requestedCount !== null && (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 12)) {
    throw new Error("Choose between one and twelve sound moments.");
  }
  return requestedCount;
}

function parsedSoundtrackIntent(text: string, cleanupRequested: boolean,
  separatePictureOverride?: boolean, soundMomentOverride?: number, tempoArcOverride?: boolean): SoundtrackIntent | null {
  const requestedCount = parsedSoundMomentCount(text, soundMomentOverride);
  const tempoArc = tempoArcOverride ?? (/\b(?:slow(?:er)?|gentle|ballad)\b.{0,100}\b(?:upbeat|up[ -]tempo|fast(?:er)?|lively)\b|\b(?:build|progress)\b.{0,35}\btempo\b/i.test(text) &&
    !/\b(?:no|without|don't|do not)\b.{0,25}\b(?:tempo (?:arc|build)|slow[ -]to[ -]upbeat)\b/i.test(text));
  const buildEnding = /\bcrescendo\b|\bbuild(?:ing|s)?\s+(?:up\s+)?(?:to|toward|into)\s+(?:a\s+)?(?:strong|big|loud|energetic|climax)|\b(?:stronger|strongest|louder|loudest|bigger|biggest|more energetic)\s+(?:ending|finish|finale)|\bend(?:ing)?\s+(?:on|with)\s+(?:the\s+)?(?:strongest|loudest|biggest|most energetic|a build)|\bbuild(?:ing)?\s+(?:up\s+)?(?:at|in)\s+the\s+end/i.test(text);
  const visualBeforeSources = /\b(?:video|footage|shots?|visuals?)\b.{0,90}\b(?:multiple|several|different|various)\s+(?:(?:video|visual)\s+)?(?:clips?|recordings?|videos?|shots?)\b/i.test(text);
  const sourcesBeforeVisual = /\b(?:multiple|several|different|various)\s+(?:(?:video|visual)\s+)?(?:clips?|recordings?|videos?|shots?)\b.{0,60}\b(?:video|footage|visuals?|shots?)\b/i.test(text);
  const videoClips = /\b(?:multiple|several|different|various)\s+(?:video|visual)\s+(?:clips?|recordings?|shots?)\b/i.test(text);
  const showingSources = /\b(?:show|use|mix|overlay|cut between|pull from)\b.{0,50}\b(?:multiple|several|different|various)\s+(?:video\s+)?(?:clips?|recordings?|videos?|shots?)\b/i.test(text);
  const multiplePictures = visualBeforeSources || sourcesBeforeVisual || videoClips || showingSources ||
    /\b(?:video|footage|picture|visuals?)\b.{0,45}\b(?:from|across|using)\s+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:different\s+)?(?:videos?|clips?|recordings?|sources?)\b/i.test(text) ||
    /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:different\s+)?(?:video\s+clips?|videos?|recordings?)\b.{0,45}\b(?:picture|footage|video|visuals?)\b/i.test(text);
  const layeredWithSound = /\b(?:over|under|beneath|on top of)\s+(?:the\s+)?(?:audio|sound|soundtrack|music)\b|\b(?:audio|sound|soundtrack|music)\s+(?:under|beneath)\s+(?:the\s+)?(?:video|footage|visuals?)\b|\bwhile\s+(?:the\s+)?(?:audio|sound|soundtrack|music)\s+plays\b/i.test(text);
  const bRollWithSound = /\b(?:b-roll|cutaways?)\b.{0,60}\b(?:over|on top|soundtrack|audio|sound)\b/i.test(text);
  const separatePicture = separatePictureOverride ??
    ((multiplePictures && (requestedCount !== null || layeredWithSound)) || bRollWithSound);
  if (requestedCount === null && !buildEnding && !separatePicture && !tempoArc) return null;
  return { segmentCount: requestedCount ?? (buildEnding || separatePicture || tempoArc ? 3 : 1),
    buildEnding, separatePicture, cleanupRequested,
    ...(tempoArcOverride === undefined && !tempoArc ? {} : { tempoArc }) };
}

function parsedPictureSourceCount(text: string): number | null {
  const number = "(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)";
  const patterns = [
    `\\b(?:video|footage|picture|visuals?)\\b.{0,45}\\b(?:from|across|using)\\s+${number}\\s+(?:different\\s+)?(?:videos?|clips?|recordings?|sources?)\\b`,
    `\\b${number}\\s+(?:different\\s+)?(?:video\\s+clips?|videos?|recordings?|picture\\s+sources?)\\b`,
  ];
  const found = patterns.map((pattern) => text.match(new RegExp(pattern, "i"))?.[1]).find(Boolean);
  if (!found) return null;
  const spoken: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  return spoken[found.toLowerCase()] ?? Number(found);
}

function parsedSelection(text: string): SelectionMode | undefined {
  if (/\b(keep|include|preserve).{0,45}\b(marked|selected|my section|my moment)/i.test(text) && /\b(choose|pick|find).{0,25}\b(rest|other)/i.test(text)) return "keep-and-choose";
  if (/\b(use my|only my|just my|keep my)[\s\w-]{0,20}\b(sections?|selections?|moments?)\b/i.test(text)) return "use-my-sections";
  if (/\b(choose|pick|select) for me\b|\b(choose|pick|select) the rest\b/i.test(text)) return "choose-for-me";
  if (/\b(keep|include|preserve).{0,45}\b(marked|selected|my section|my moment)/i.test(text)) return "keep-and-choose";
}

function styleFor(vibe: Vibe): Pick<ExportOptions, "finish" | "transition" | "showClipLabels"> {
  switch (vibe) {
    case "energetic": return { finish: "vivid", transition: "cut", showClipLabels: false };
    case "cinematic": return { finish: "cinematic", transition: "fade", showClipLabels: false };
    case "nostalgic": return { finish: "warm", transition: "fade", showClipLabels: false };
    case "intimate": return { finish: "warm", transition: "cut", showClipLabels: false };
    default: return { finish: "natural", transition: "cut", showClipLabels: false };
  }
}

function supportedLimits(text: string, type: VideoType, vibe: Vibe, customVibe: string, labeledSongs: number, cleanupRequested: boolean, rumbleEnabled: boolean, soundtrackIntent: SoundtrackIntent | null): string[] {
  const notes: string[] = [];
  if (type === "one-song" || /\b(several|multiple|different|many) songs?\b/i.test(text)) notes.push(labeledSongs > 1 ? "Song names come from your labels; the app has not detected or verified them." : "Songs are not identified automatically. The cut can use different recordings; mark or name song sections yourself if needed.");
  if (/\b(lyrics?|captions?|subtitles?|logo|title card)\b/i.test(text)) notes.push("Opening event titles and your named moments are supported. Lyrics, automatic captions, logos, and full-screen title cards are not available yet.");
  if (/\b(slow.motion|speed ramp|stabiliz|camera tracking|face tracking)\b/i.test(text)) notes.push("Speed changes, stabilization, and tracking are not available yet.");
  if (/\b(?:auto(?:matic(?:ally)?)?|find|follow|track|center|focus|crop|frame)\b[^.!?\n]{0,55}\b(?:performer|singer|stage|crowd|face)\b|\b(?:performer|singer|stage|crowd|face)\b[^.!?\n]{0,55}\b(?:auto(?:matic(?:ally)?)?|follow|track|center|focus|crop|frame)\b/i.test(text)) notes.push("Portrait cropping starts centered; it cannot identify or follow a performer, stage, or crowd. Use Aim the crop on each recording to place the picture where you want it.");
  if (cleanupRequested) notes.push(rumbleEnabled ?
    "Sound cleanup here means reducing very low rumble. It cannot remove crowd voices, repair clipping, or fully denoise music." :
    "Low-rumble reduction is off by your choice. Full sound cleaning is not available; crowd voices, clipping, and music noise are not removed.");
  if (soundtrackIntent?.tempoArc) notes.push("The plan aims for slower music first and an upbeat finish using reliable rhythm measurements. If the recordings cannot support that progression, the first-cut notes will say so; song speed stays unchanged.");
  else if (soundtrackIntent?.buildEnding) notes.push("The ending is ordered by measured sound energy, not recognition of a musical crescendo. Listen before exporting.");
  if (/\b(filters?|visual effects?|special effects?|animation)\b/i.test(text)) notes.push("Natural, vivid, cinematic, and warm looks, dissolves, and occasional glide transitions are available. Custom animation and generated effects are not supported.");
  if (vibe === "custom") notes.push(`${customVibe.trim() ? "That custom vibe" : "A custom vibe"} cannot be translated reliably yet; this cut starts with natural color and straightforward cuts.`);
  return [...new Set(notes)];
}

export function interpretCreativeBrief(input: CreativeBriefInput, clips: CreativeClip[], current: ExportOptions): CreativeBrief {
  validateClips(clips);
  if (input.beatSync !== undefined && typeof input.beatSync !== "boolean" ||
    input.tempoArc !== undefined && typeof input.tempoArc !== "boolean" ||
    input.highlightFocus !== undefined && !["balanced", "performance"].includes(input.highlightFocus)) {
    throw new Error("Choose valid music and highlight preferences.");
  }
  if (input.separatePicture !== undefined && typeof input.separatePicture !== "boolean") {
    throw new Error("Choose a valid separate soundtrack and picture setting.");
  }
  if (input.soundMomentCount !== undefined && (!Number.isInteger(input.soundMomentCount) ||
    input.soundMomentCount < 1 || input.soundMomentCount > 12)) throw new Error("Choose between one and twelve sound moments.");
  if (input.pictureSourceCount !== undefined && (!Number.isInteger(input.pictureSourceCount) ||
    input.pictureSourceCount < 1)) throw new Error("Choose a whole number of picture recordings.");
  const description = (input.description || "").trim();
  if (input.transition !== undefined && !["cut", "fade", "dissolve", "smoothslide"].includes(input.transition)) {
    throw new Error("Choose a supported picture transition.");
  }
  const cleanupRequested = requestsCleanup(description);
  const requestedSoundtrack = parsedSoundtrackIntent(description, cleanupRequested, input.separatePicture, input.soundMomentCount, input.tempoArc);
  const videoType = input.videoType ?? parsedType(description) ?? "highlight";
  const requestedVibe = input.vibe ?? parsedVibe(description);
  const vibe = requestedVibe ?? "clean-live";
  const selectionMode = input.selectionMode ?? parsedSelection(description) ??
    (clips.some((clip) => clip.included && (clip.locked || clip.selectionSource === "manual")) ? "keep-and-choose" : "choose-for-me");
  const keepWholePerformance = videoType === "one-song" && asksForWholePerformance(description);
  const independentSoundWording = description.replace(/\b(?:no|without|(?:do not|don't|never)\s+(?:use|add|include|choose))\s+(?:an?\s+)?(?:separate|independent|different|replacement)\s+(?:audio|soundtrack|sound)\b/gi, "");
  // The guided editor starts with separatePicture enabled. That default must not
  // turn an explicit intact performance into several independently chosen moments.
  // Counts or separate-track wording are genuine conflicting instructions to review.
  const intactSoundtrackConflict = keepWholePerformance && (
    (parsedSoundMomentCount(description, input.soundMomentCount) ?? 1) > 1 ||
    (input.pictureSourceCount ?? parsedPictureSourceCount(description) ?? 1) > 1 ||
    /\b(?:separate|independent|different|replacement)\s+(?:audio|soundtrack|sound)\b/i.test(independentSoundWording) ||
    input.separatePicture !== false && parsedSoundtrackIntent(description, cleanupRequested, undefined, input.soundMomentCount)?.separatePicture === true
  );
  const soundtrackIntent = keepWholePerformance && !intactSoundtrackConflict ? null : requestedSoundtrack;
  if (!["highlight", "one-song", "recap", "compilation"].includes(videoType) ||
    !["energetic", "cinematic", "nostalgic", "intimate", "clean-live", "custom"].includes(vibe) ||
    !["use-my-sections", "choose-for-me", "keep-and-choose"].includes(selectionMode)) {
    throw new Error("Choose supported video, vibe, and section options.");
  }
  let targetSeconds = input.targetSeconds === undefined ? parseSeconds(description) : input.targetSeconds;
  if (targetSeconds !== null && (!Number.isFinite(targetSeconds) || targetSeconds < 0.1 || targetSeconds > 86400)) throw new Error("Choose a length between one second and 24 hours.");
  const aspect = input.aspect ?? (/\b(horizontal|widescreen|landscape|16:9)\b/i.test(description) ? "landscape" : /\b9:16\b/i.test(description) ? "vertical" : /\b(vertical|portrait|9:13)\b/i.test(description) ? "portrait913" : current.aspect);
  if (!["portrait913", "vertical", "landscape"].includes(aspect)) throw new Error("Choose a valid video shape.");
  const customVibe = input.customVibe?.trim() ?? "";
  const noText = /\b(?:no|without|don't add|do not add)\s+(?:(?:any|additional|added)\s+)*(?:text|titles?|overlays?|captions?|labels?)\b/i.test(description);
  const eventTitle = noText ? "" : (input.eventTitle ?? current.eventTitle ?? "").trim();
  if (eventTitle.length > 80 || /[\r\n\x00-\x1f]/.test(eventTitle)) throw new Error("Keep the video title under 81 characters.");
  const style = cleanupRequested && !requestedVibe ?
    { finish: current.finish ?? "natural", transition: current.transition ?? "cut", showClipLabels: current.showClipLabels ?? false } : styleFor(vibe);
  const options: ExportOptions = { ...current, aspect, ...style,
    reduceRumble: input.reduceRumble ?? (cleanupRequested ? true : current.reduceRumble),
    eventTitle, showClipLabels: noText || soundtrackIntent?.separatePicture ? false : input.showClipLabels ?? current.showClipLabels ?? false };
  const noBeat = /\b(?:no|without|don't|do not)\s+(?:(?:use|add|apply)\s+)?beat[- ]?(?:matching|sync(?:ing)?|alignment)\b/i.test(description);
  const asksBeat = /\bbeat[- ]?(?:match(?:ing)?|sync(?:ing)?|align(?:ment)?)\b|\b(?:cuts?|pictures?|video)\b.{0,30}\b(?:follow|to|on) (?:the )?(?:music|beat|rhythm)\b/i.test(description);
  const noPerformance = /\b(?:don't|do not|never)\s+(?:favor|prefer|prioritize)\s+(?:the )?(?:performance|vocals?|singer|artist)\b|\bfavor (?:the )?crowd\b/i.test(description);
  const asksPerformance = /\b(?:big|strong|best|powerful) vocal moments?\b|\b(?:favor|prefer|prioritize|feature|focus on)\b.{0,45}\b(?:vocals?|singer|artist|performance)\b|\b(?:vocals?|singer|artist)\b.{0,30}\b(?:over|instead of|rather than)\b.{0,20}\bcrowd\b/i.test(description);
  const beatSync = input.beatSync ?? (noBeat ? false : asksBeat ? true : current.beatSync);
  const highlightFocus = input.highlightFocus ?? (noPerformance ? "balanced" : asksPerformance ? "performance" : current.highlightFocus);
  if (beatSync !== undefined) options.beatSync = beatSync;
  if (highlightFocus !== undefined) options.highlightFocus = highlightFocus;
  if (asksBeat && !noBeat && options.audioTransition === undefined) {
    options.audioTransition = "crossfade"; options.audioCrossfadeSeconds ??= 2;
  }
  const describedTransition = /\b(glide|sliding|animated (?:visual )?transitions?)\b/i.test(description) ? "smoothslide" :
    /\b(?:cross[- ]?)?dissolves?\b/i.test(description) ? "dissolve" : undefined;
  options.transition = input.transition ?? describedTransition ?? (current.quality === "high" && requestedVibe ?
    vibe === "energetic" ? "smoothslide" : ["cinematic", "nostalgic", "intimate"].includes(vibe) ? "dissolve" : "cut" :
    current.quality === "high" ? current.transition ?? "dissolve" : style.transition);
  const protectedClips = clips.filter((clip) => clip.included && !clip.excludedByUser && (clip.locked || clip.selectionSource === "manual" || selectionMode === "use-my-sections"));
  const markedClips = clips.filter((clip) => clip.included && !clip.excludedByUser && (clip.locked || clip.selectionSource === "manual"));
  const eligible = clips.filter((clip) => !clip.excludedByUser);
  const active = eligible.filter((clip) => clip.included);
  const pictureSourceCount = soundtrackIntent?.separatePicture ?
    input.pictureSourceCount ?? parsedPictureSourceCount(description) ?? Math.min(3, eligible.length) : null;
  const naturalMultiplePictures = /\b(?:multiple|several|different|various)\s+(?:(?:video|visual)\s+)?(?:clips?|recordings?|videos?|shots?)\b/i.test(description) &&
    /\b(?:video|footage|picture|visuals?|shots?)\b/i.test(description);
  const oneSongChoice = markedClips[0] ?? active[0] ?? eligible[0];
  const markedPartial = keepWholePerformance && markedClips.length === 1 &&
    (markedClips[0].start > 0.05 || markedClips[0].end < markedClips[0].asset.duration - 0.05);
  const protectedSeconds = selectionMode === "use-my-sections" ? total(markedClips) :
    keepWholePerformance && oneSongChoice ? oneSongChoice.asset.duration : total(protectedClips);
  if (targetSeconds === null && soundtrackIntent?.separatePicture && pictureSourceCount !== null) {
    const unmarkedCount = Math.max(0, pictureSourceCount - markedClips.length);
    const pictureCapacity = protectedSeconds + eligible.filter((clip) => !markedClips.includes(clip))
      .map((clip) => clip.asset.duration).sort((a, b) => b - a).slice(0, unmarkedCount)
      .reduce((sum, seconds) => sum + seconds, 0);
    const suggestedTarget = selectionMode === "use-my-sections" ? protectedSeconds :
      Math.max(protectedSeconds, Math.min(total(clips), pictureCapacity));
    if (suggestedTarget >= 0.1) targetSeconds = suggestedTarget;
  }
  const availableSeconds = selectionMode === "use-my-sections" ? total(markedClips) : videoType === "one-song" ?
    (keepWholePerformance ? oneSongChoice?.asset.duration ?? 0 : markedClips.length ? protectedSeconds : oneSongChoice?.asset.duration ?? 0) :
    protectedSeconds + eligible.filter((clip) => !protectedClips.includes(clip)).reduce((sum, clip) => sum + clip.asset.duration, 0);
  let conflict: BriefConflict | null = null;
  if (selectionMode === "use-my-sections" && markedClips.length === 0) {
    conflict = { kind: "no-marked-sections", message: "No sections are marked yet. Mark a section, or let Concert Compass choose for you." };
  } else if (videoType === "one-song" && markedClips.length > 1) {
    conflict = { kind: "one-song-multiple-sections", message: "Several marked recordings are protected. Which one belongs in this one-song video?" };
  } else if (videoType === "one-song" && markedClips.length === 0 && eligible.length > 1 && active.length !== 1) {
    conflict = { kind: "one-song-choose-recording", message: "Which recording contains this song? Choose one recording before making the cut." };
  } else if (intactSoundtrackConflict) {
    conflict = { kind: "intact-vs-soundtrack", message: "Keep the whole performance with its original picture and sound together, or make a separate soundtrack and picture edit? Adjust the brief to choose one." };
  } else if (markedPartial) {
    conflict = { kind: "intact-vs-marked", message: `You marked ${time(total(markedClips))} of ${markedClips[0].asset.name}, but asked to keep the whole performance. Keep your marked section or use the whole recording?` };
  } else if (targetSeconds !== null && protectedSeconds > targetSeconds + 0.05) {
    const message = soundtrackIntent ?
      `Your marked picture and original sound total ${time(protectedSeconds)}, longer than ${time(targetSeconds)}. Choose a longer length with room for ${Math.max(0, soundtrackIntent.segmentCount - markedClips.length)} other sound moments, or adjust your marked sections.` : keepWholePerformance ?
      `The whole recording is ${time(protectedSeconds)}, longer than ${time(targetSeconds)}. Keep it intact and extend the video, or choose a shorter section?` :
      `Your marked sections total ${time(protectedSeconds)}, longer than ${time(targetSeconds)}. Keep them all and extend the video, or adjust the sections?`;
    conflict = { kind: "protected-over-target", message, requestedSeconds: targetSeconds, availableSeconds: protectedSeconds };
  } else if (targetSeconds !== null && availableSeconds + 0.05 < targetSeconds) {
    const message = selectionMode === "use-my-sections" ?
      `Your marked sections total ${time(availableSeconds)}, less than ${time(targetSeconds)}. Mark more footage or choose a shorter length.` :
      videoType === "one-song" && markedClips.length ?
      `Your protected section is ${time(availableSeconds)}, less than ${time(targetSeconds)}. Extend that section yourself or choose a shorter length.` :
      `There is ${time(availableSeconds)} available without changing marked sections or repeating footage, less than ${time(targetSeconds)}. Choose a shorter length or add recordings.`;
    conflict = { kind: "insufficient-footage", message, requestedSeconds: targetSeconds, availableSeconds };
  }
  if (!conflict && input.pictureSourceCount !== undefined && !soundtrackIntent?.separatePicture && !keepWholePerformance) {
    conflict = { kind: "audio-story-picture-mode", message: "A picture recording count needs a separate picture-over-sound edit. Turn that on, or clear the picture count." };
  }
  if (!conflict && soundtrackIntent) {
    const audioClips = eligible.filter((clip) => clip.asset.hasAudio && !clip.soundExcludedByUser);
    const locked = markedClips;
    const requiredSeconds = targetSeconds ?? total(clips);
    const audioSeconds = audioClips.reduce((sum, clip) => sum + clip.asset.duration, 0);
    if (locked.some(clip => clip.soundExcludedByUser)) {
      conflict = { kind: "audio-story-picture-only-lock", message: "A kept section also has its sound excluded. Allow its sound, or unlock the section before making the separate soundtrack." };
    } else if (!audioClips.length) {
      conflict = { kind: "audio-story-no-sound", message: "No recordings are available for the soundtrack. Allow sound from a picture-only recording, add a recording with audio, or use the standard edit." };
    } else if (soundtrackIntent.separatePicture && pictureSourceCount !== null &&
      (pictureSourceCount > eligible.length || pictureSourceCount < locked.length)) {
      conflict = { kind: "audio-story-picture-count", message: pictureSourceCount > eligible.length ?
        `You asked for ${pictureSourceCount} picture recordings, but only ${eligible.length} are available. Import more videos, lower the count, or include an excluded recording.` :
        `${locked.length} recordings have protected picture and original sound, more than the ${pictureSourceCount} picture recordings requested. Raise the picture count or unlock a marked section.` };
    } else if (soundtrackIntent.separatePicture && active.length > 0 &&
      active.every((clip) => clip.locked || clip.selectionSource === "manual") &&
      requiredSeconds <= total(active) + 0.05) {
      conflict = { kind: "audio-story-all-picture-protected", message:
        "Every picture section in this cut is protected with its original sound, leaving no room for different footage over the soundtrack. Unlock a section, or import an unmarked video and extend the length, then review the plan." };
    } else if (soundtrackIntent.separatePicture && input.pictureSourceCount === undefined &&
      naturalMultiplePictures && eligible.length < 2) {
      conflict = { kind: "audio-story-picture-variety", message: "To show footage from multiple recordings over the sound, import or include at least two videos." };
    } else if (soundtrackIntent.separatePicture && pictureSourceCount !== null &&
      requiredSeconds + 0.05 < protectedSeconds + Math.max(0, pictureSourceCount - locked.length) * 0.1) {
      conflict = { kind: "audio-story-picture-count", message: `There is not enough time for ${pictureSourceCount} picture recordings while keeping your marked sections. Choose a longer video or fewer picture recordings.` };
    } else if (soundtrackIntent.separatePicture && pictureSourceCount !== null &&
      requiredSeconds > protectedSeconds + eligible.filter((clip) => !locked.includes(clip))
        .map((clip) => clip.asset.duration).sort((a, b) => b - a)
        .slice(0, Math.max(0, pictureSourceCount - locked.length)).reduce((sum, seconds) => sum + seconds, 0) + 0.05) {
      conflict = { kind: "audio-story-picture-count", message: `The chosen ${pictureSourceCount} picture recordings cannot fill ${time(requiredSeconds)} without repeating footage. Use more picture recordings or choose a shorter video.` };
    } else if (locked.some((clip) => !clip.asset.hasAudio)) {
      conflict = { kind: "audio-story-silent-lock", message: "A protected section has no original sound. Unlock it or use the standard edit before making this soundtrack-led cut." };
    } else if (locked.length > soundtrackIntent.segmentCount ||
      (selectionMode === "use-my-sections" && locked.length !== soundtrackIntent.segmentCount)) {
      conflict = { kind: "audio-story-locked-count", message: `You asked for ${soundtrackIntent.segmentCount} sound moments, but your protected sections require ${locked.length}. Keep the marked moments with a different count, or adjust your selections.` };
    } else if (requiredSeconds + 0.05 < soundtrackIntent.segmentCount * 0.1) {
      conflict = { kind: "audio-story-short-target", message: `There is not enough time for ${soundtrackIntent.segmentCount} separate sound moments. Choose a longer video or fewer sound moments.` };
    } else if (audioSeconds + 0.05 < requiredSeconds) {
      conflict = { kind: "audio-story-insufficient-audio", message: `There is only ${time(audioSeconds)} of nonrepeating sound for a ${time(requiredSeconds)} soundtrack. Add recordings or choose a shorter video.`, requestedSeconds: requiredSeconds, availableSeconds: audioSeconds };
    }
  }
  const typeLabel: Record<VideoType, string> = { highlight: "highlight", "one-song": "one-recording performance", recap: "recap", compilation: "compilation" };
  const preserved = markedClips.length ? "your marked sections stay" : keepWholePerformance ? "the whole performance stays" : "you can adjust every section";
  const labelPool = selectionMode === "use-my-sections" ? markedClips : eligible;
  const labeledSongs = new Set(labelPool.map((clip) => clip.label?.trim().toLowerCase()).filter(Boolean)).size;
  const variety = /\b(several|multiple|different|many) songs?\b/i.test(description) ? labeledSongs > 1 ? " · your labeled songs" : " · several recordings" : "";
  const naturalSeconds = keepWholePerformance && oneSongChoice ? oneSongChoice.asset.duration :
    selectionMode === "use-my-sections" || videoType === "one-song" && markedClips.length ? protectedSeconds : total(clips);
  const equalSoundSeconds = soundtrackIntent?.tempoArc && targetSeconds !== null && !markedClips.length ? targetSeconds / soundtrackIntent.segmentCount : null;
  const arcSummary = soundtrackIntent?.tempoArc ? soundtrackIntent.segmentCount === 3 ?
    " · aiming for a slow opening, mid-tempo middle, upbeat finale" : " · aiming for slower music first and an upbeat finish" :
    soundtrackIntent?.buildEnding ? " · aiming for a sound-energy build toward the strongest measured ending" : "";
  const soundSummary = soundtrackIntent ? ` · ${soundtrackIntent.segmentCount} audio moments${equalSoundSeconds === null ? "" : ` · ${time(equalSoundSeconds)} each where source length allows`}${cleanupRequested ? options.reduceRumble ? " with low-rumble reduction" : " with low-rumble reduction off" : ""}${arcSummary}${soundtrackIntent.separatePicture ? ` · picture from ${pictureSourceCount} recording${pictureSourceCount === 1 ? "" : "s"} over the soundtrack` : ""}` : "";
  const shape = aspect === "landscape" ? "horizontal 16:9" : aspect === "vertical" ? "tall 9:16" : "portrait 9:13";
  const graphics = `${eventTitle ? ` · opening title “${eventTitle}”` : ""}${options.showClipLabels && !soundtrackIntent?.separatePicture && clips.some((clip) => clip.label?.trim()) ? " · your named moments on video" : ""}`;
  const joins = ({ cut: "direct cuts", fade: "soft joins", dissolve: "dissolves", smoothslide: "dissolves with occasional glides" })[options.transition ?? "cut"];
  const soundJoins = options.audioTransition === "crossfade" ? ` · sound overlaps up to ${options.audioCrossfadeSeconds ?? 2}s where spare sound is available` : "";
  const musicSummary = `${options.beatSync && soundtrackIntent ? " · follow clear beats where possible" : ""}${options.highlightFocus === "performance" && !keepWholePerformance && selectionMode !== "use-my-sections" ? " · favor clearer performance sound" : ""}`;
  const summary = `${time(targetSeconds ?? naturalSeconds)} ${typeLabel[videoType]}${variety} · ${vibe === "clean-live" ? "clean/live" : vibe} pacing · ${options.finish} look · ${joins} · ${shape} · ${preserved}${graphics}${soundSummary}${soundJoins}${musicSummary}.`;
  const limitations = supportedLimits(description, videoType, vibe, customVibe, labeledSongs, cleanupRequested, options.reduceRumble, soundtrackIntent);
  if (options.beatSync) limitations.push(soundtrackIntent?.separatePicture ?
    "Confident beats can guide picture timing and align compatible song transitions. Uncertain or different tempos keep their existing blend; song speed and protected moments stay unchanged." :
    "Independent picture timing needs a separate soundtrack. This edit keeps the original performance and sound together.");
  if (options.highlightFocus === "performance") limitations.push("Local singing estimates help avoid speech, cheering, and instrumental lead-ins when available. They cannot identify the singer, distinguish the artist from a singing crowd, verify a big vocal moment, or remove crowd voices. Listen before keeping a suggestion.");
  if (keepWholePerformance && !intactSoundtrackConflict && requestedSoundtrack?.buildEnding) limitations.push("Keeping the performance intact preserves its original sound and order; the app will not rearrange it to create a stronger ending.");
  if (soundtrackIntent?.buildEnding && markedClips.length) limitations.push("Your marked sections keep their place and original sound; they may limit how steadily the energy rises.");
  if (soundtrackIntent?.tempoArc && markedClips.length) limitations.push("Your marked sections keep their length, place, and original sound. Those choices take priority over equal sound moments or a tempo progression.");
  if (vibe === "energetic" && eligible.length < 2) limitations.push("Quicker cuts need multiple recordings; this cut keeps the available footage continuous.");
  return { description, videoType, vibe, selectionMode, keepWholePerformance, soundtrackIntent, pictureSourceCount, targetSeconds, aspect, customVibe, summary, limitations, conflict, options };
}

function pace(vibe: Vibe): number {
  switch (vibe) {
    case "energetic": return 8;
    case "cinematic": return 30;
    case "nostalgic": return 24;
    case "intimate": return 35;
    case "clean-live": return 45;
    default: return 16;
  }
}

function centeredRange(clip: CreativeClip, length: number) {
  const center = (clip.start + clip.end) / 2;
  const start = clamp(center - length / 2, 0, clip.asset.duration - length);
  return { start, end: start + length };
}

function outcome<T extends CreativeClip>(clips: T[], options: ExportOptions, notes: string[]): CutResult<T> {
  return { clips, options, plannedSeconds: total(clips), notes };
}

export function makeFirstCut<T extends CreativeClip>(clips: T[], brief: CreativeBrief, resolution?: "extend" | "keep-marked"): CutResult<T> {
  if (brief.soundtrackIntent) throw new Error("This brief needs its separate soundtrack plan before rendering.");
  validateClips(clips);
  if (brief.conflict && !(brief.conflict.kind === "protected-over-target" && resolution === "extend") &&
    !(brief.conflict.kind === "intact-vs-marked" && resolution === "keep-marked")) throw new Error(brief.conflict.message);
  if (resolution === "keep-marked") {
    const next = clips.map((clip) => ({ ...clip, included: clip.included && !clip.excludedByUser &&
      (clip.locked || clip.selectionSource === "manual") }));
    return outcome(next, brief.options, ["Kept your marked section at its exact start and end points. The whole recording was not added."]);
  }
  if (brief.selectionMode === "use-my-sections") return outcome(clips.map((clip) => ({ ...clip, included: clip.included && !clip.excludedByUser && (clip.locked || clip.selectionSource === "manual") })), brief.options, ["Kept your marked sections unchanged and left unmarked suggestions out."]);
  if (brief.videoType === "one-song" && brief.keepWholePerformance) {
    const chosenIndex = clips.findIndex((clip) => clip.included && !clip.excludedByUser &&
      (clip.locked || clip.selectionSource === "manual"));
    const index = chosenIndex >= 0 ? chosenIndex : clips.findIndex((clip) => clip.included && !clip.excludedByUser);
    if (index < 0) throw new Error("Choose a recording to keep intact.");
    const next = clips.map((clip, current) => current === index ?
      { ...clip, start: 0, end: clip.asset.duration, included: true, locked: true, selectionSource: "manual" as const } :
      { ...clip, included: false });
    const notes = [`Kept ${clips[index].asset.name} from beginning to end without changing its speed.`];
    if (resolution === "extend" && brief.targetSeconds !== null && clips[index].asset.duration > brief.targetSeconds) {
      notes.push(`Extended the output to ${time(clips[index].asset.duration)} to keep the full performance.`);
    }
    return outcome(next, brief.options, notes);
  }
  const protectedIndices = clips.flatMap((clip, index) => clip.included && !clip.excludedByUser && (clip.locked || clip.selectionSource === "manual") ? [index] : []);
  const protectedSeconds = protectedIndices.reduce((sum, index) => sum + duration(clips[index]), 0);
  const requested = brief.targetSeconds ?? (brief.videoType === "one-song" && protectedIndices.length ? protectedSeconds : total(clips));
  const target = Math.max(requested, protectedSeconds);
  const protectedSet = new Set(protectedIndices);
  const candidates = clips.flatMap((clip, index) => !clip.excludedByUser && !protectedSet.has(index) ? [index] : []);
  let available = candidates;
  if (brief.videoType === "one-song") {
    const chosen = protectedIndices[0] ?? candidates.find((index) => clips[index].included) ?? candidates[0];
    available = chosen === undefined ? [] : [chosen];
  }
  const remaining = Math.max(0, target - protectedSeconds);
  const wantsSeveralSongs = /\b(several|multiple|different|many) songs?\b/i.test(brief.description);
  const minimumVariety = wantsSeveralSongs ? Math.max(0, 2 - protectedIndices.length) : 0;
  const desired = Math.max(0, Math.min(available.length, Math.floor((remaining + 0.0001) / 0.1), Math.max(minimumVariety, Math.ceil(remaining / pace(brief.vibe)))));
  const ranking = [...available].sort((a, b) => brief.vibe === "energetic" ? a - b :
    Number(clips[b].included) - Number(clips[a].included) || clips[b].asset.duration - clips[a].asset.duration || a - b);
  if (wantsSeveralSongs) {
    const protectedLabels = new Set(protectedIndices.map((index) => clips[index].label?.trim().toLowerCase()).filter(Boolean));
    const firstPerLabel: number[] = [], rest: number[] = [];
    const seen = new Set(protectedLabels);
    for (const index of ranking) {
      const label = clips[index].label?.trim().toLowerCase();
      if (label && !seen.has(label)) { firstPerLabel.push(index); seen.add(label); }
      else rest.push(index);
    }
    ranking.splice(0, ranking.length, ...firstPerLabel, ...rest);
  }
  const picked = ranking.slice(0, desired);
  for (const index of ranking.slice(desired)) {
    if (picked.reduce((sum, current) => sum + clips[current].asset.duration, 0) >= remaining - 0.05) break;
    picked.push(index);
  }
  const allocations = new Map<number, number>(picked.map((index) => [index, 0]));
  let unfilled = remaining;
  let active = [...picked];
  while (unfilled > 0.001 && active.length) {
    const share = unfilled / active.length;
    const next: number[] = [];
    let added = 0;
    for (const index of active) {
      const capacity = clips[index].asset.duration - (allocations.get(index) ?? 0);
      const portion = Math.min(share, capacity);
      allocations.set(index, (allocations.get(index) ?? 0) + portion);
      added += portion;
      if (capacity - portion > 0.001) next.push(index);
    }
    if (added < 0.001) break;
    unfilled -= added;
    active = next;
  }
  if (unfilled > 0.05) throw new Error(`The available recordings cannot fill ${time(target)} without repeating footage. Add recordings or choose a shorter length.`);
  const next = clips.map((clip, index) => {
    if (clip.excludedByUser) return { ...clip, included: false };
    if (protectedSet.has(index)) return { ...clip };
    const allocation = allocations.get(index) ?? 0;
    if (allocation < 0.1) return { ...clip, included: false };
    return { ...clip, ...centeredRange(clip, allocation), included: true, selectionSource: "suggested" as const, locked: false };
  });
  const notes = [`Used ${next.filter((clip) => clip.included).length} recording${next.filter((clip) => clip.included).length === 1 ? "" : "s"} without repeating a section.`];
  if (resolution === "extend" && target > requested) notes.push(`Extended the video to ${time(target)} so every marked section stays.`);
  return outcome(next, brief.options, notes);
}

export function refineCut<T extends CreativeClip>(clips: T[], request: Refinement, brief: CreativeBrief): CutResult<T> {
  validateClips(clips);
  const index = request.path ? clips.findIndex((clip) => clip.asset.path === request.path) : -1;
  if (request.kind !== "fewer-cuts" && index < 0) throw new Error("Choose a recording for this adjustment.");
  const next = clips.map((clip) => ({ ...clip }));
  let note: string;
  if (request.kind === "fewer-cuts") {
    const removable = next.filter((clip) => clip.included && !clip.locked && clip.selectionSource !== "manual").sort((a, b) => duration(a) - duration(b));
    if (removable.length < 1 || next.filter((clip) => clip.included).length < 2) return outcome(next, brief.options, ["Every remaining section is needed or protected; no cut was removed."]);
    const remove = next.find((clip) => clip.asset.path === removable[0].asset.path)!;
    remove.included = false;
    note = `Removed the shortest unprotected section, ${remove.asset.name}. Other sections stayed the same; the video is now shorter.`;
  } else {
    const clip = next[index];
    if (clip.excludedByUser) throw new Error("This recording was excluded. Include it yourself before changing its section.");
    if (request.kind === "keep-section") {
      clip.locked = true;
      clip.selectionSource = "manual";
      clip.included = true;
      note = `Kept ${clip.asset.name} at its current start and end points.`;
    } else {
      if (clip.locked || clip.selectionSource === "manual") throw new Error("This section is protected. Unlock it before changing its range.");
      if (request.kind === "more-from-clip") {
        const extra = Math.min(10, clip.asset.duration - duration(clip));
        if (extra < 0.1) return outcome(next, brief.options, ["This section already uses the whole recording."]);
        const range = centeredRange(clip, duration(clip) + extra);
        clip.start = range.start; clip.end = range.end; clip.included = true;
        note = `Added ${Math.round(extra)} seconds from ${clip.asset.name}. Other sections stayed the same.`;
      } else {
        const length = duration(clip);
        const after = clip.end + 0.25;
        const before = clip.start - length - 0.25;
        const start = after + length <= clip.asset.duration ? after : before >= 0 ? before : null;
        if (start === null) return outcome(next, brief.options, ["There is no separate section of this recording at the current length. Shorten this section first."]);
        clip.start = start; clip.end = start + length; clip.included = true;
        note = `Chose a different, nonoverlapping part of ${clip.asset.name}. Listen before exporting.`;
      }
    }
  }
  return outcome(next, brief.options, [note]);
}
