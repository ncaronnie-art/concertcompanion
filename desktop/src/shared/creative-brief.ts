import type { ExportOptions, RenderSelection } from "./render-plan.js";

export type VideoType = "highlight" | "one-song" | "recap" | "compilation";
export type Vibe = "energetic" | "cinematic" | "nostalgic" | "intimate" | "clean-live" | "custom";
export type SelectionMode = "use-my-sections" | "choose-for-me" | "keep-and-choose";
export type CreativeClip = RenderSelection & {
  included: boolean;
  selectionSource: "suggested" | "manual";
  locked: boolean;
  excludedByUser: boolean;
  label?: string;
};

export type CreativeBriefInput = {
  description: string;
  videoType?: VideoType;
  vibe?: Vibe;
  selectionMode?: SelectionMode;
  targetSeconds?: number | null;
  aspect?: ExportOptions["aspect"];
  customVibe?: string;
};

export type BriefConflict = {
  kind: "protected-over-target" | "one-song-multiple-sections" | "insufficient-footage" | "no-marked-sections";
  message: string;
  requestedSeconds?: number;
  availableSeconds?: number;
};

export type CreativeBrief = {
  description: string;
  videoType: VideoType;
  vibe: Vibe;
  selectionMode: SelectionMode;
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
  if (/\b(one|single)[\s-]*song\b|\bjust this song\b|\bfull performance\b/i.test(text)) return "one-song";
  if (/\brecap\b|\bwhole night\b/i.test(text)) return "recap";
  if (/\bcompilation\b|\bmontage\b/i.test(text)) return "compilation";
  if (/\bhighlights?\b/i.test(text)) return "highlight";
}

function parsedVibe(text: string): Vibe | undefined {
  if (/\benergetic\b|\bhigh.energy\b|\bfast.paced\b/i.test(text)) return "energetic";
  if (/\bcinematic\b|\bfilm.like\b/i.test(text)) return "cinematic";
  if (/\bnostalgic\b|\bmemory\b/i.test(text)) return "nostalgic";
  if (/\bintimate\b|\bquiet\b/i.test(text)) return "intimate";
  if (/\bclean\b|\blive\b|\bnatural\b/i.test(text)) return "clean-live";
}

function parsedSelection(text: string): SelectionMode | undefined {
  if (/\b(keep|include|preserve).{0,45}\b(marked|selected|my section|my moment)/i.test(text) && /\b(choose|pick|find).{0,25}\b(rest|other)/i.test(text)) return "keep-and-choose";
  if (/\b(use my|only my|just my|keep my)[\s\w-]{0,20}\b(sections?|selections?|moments?)\b/i.test(text)) return "use-my-sections";
  if (/\b(choose|pick|select) for me\b|\b(choose|pick|select) the rest\b/i.test(text)) return "choose-for-me";
  if (/\b(keep|include|preserve).{0,45}\b(marked|selected|my section|my moment)/i.test(text)) return "keep-and-choose";
}

function styleFor(vibe: Vibe): Pick<ExportOptions, "finish" | "transition"> {
  switch (vibe) {
    case "energetic": return { finish: "vivid", transition: "cut" };
    case "cinematic": return { finish: "cinematic", transition: "fade" };
    case "nostalgic": return { finish: "warm", transition: "fade" };
    case "intimate": return { finish: "warm", transition: "cut" };
    default: return { finish: "natural", transition: "cut" };
  }
}

function supportedLimits(text: string, type: VideoType, vibe: Vibe, customVibe: string, labeledSongs: number): string[] {
  const notes: string[] = [];
  if (type === "one-song" || /\b(several|multiple|different|many) songs?\b/i.test(text)) notes.push(labeledSongs > 1 ? "Song names come from your labels; the app has not detected or verified them." : "Songs are not identified automatically. The cut can use different recordings; mark or name song sections yourself if needed.");
  if (/\b(lyrics?|captions?|subtitles?|text overlay|title card|logo)\b/i.test(text)) notes.push("Text overlays and captions are not available yet. The closest supported choice is a clean video with a preset look.");
  if (/\b(beat.sync|slow.motion|speed ramp|stabiliz|camera tracking|face tracking|swipe transition)\b/i.test(text)) notes.push("Beat syncing, speed changes, stabilization, and tracking are not available yet. The cut uses real-time footage and cuts or short fades.");
  if (/\b(clean (up )?(the )?(audio|sound)|remove (the )?(crowd|voices|noise))\b/i.test(text)) notes.push("Full sound cleanup is not available. The existing optional control only reduces very low rumble.");
  if (/\b(filters?|visual effects?|special effects?|animation)\b/i.test(text)) notes.push("Custom effects are not available. The closest supported choices are natural, vivid, cinematic, and warm looks.");
  if (vibe === "custom") notes.push(`${customVibe.trim() ? "That custom vibe" : "A custom vibe"} cannot be translated reliably yet; this cut starts with natural color and straightforward cuts.`);
  return [...new Set(notes)];
}

export function interpretCreativeBrief(input: CreativeBriefInput, clips: CreativeClip[], current: ExportOptions): CreativeBrief {
  validateClips(clips);
  const description = (input.description || "").trim();
  const videoType = input.videoType ?? parsedType(description) ?? "highlight";
  const vibe = input.vibe ?? parsedVibe(description) ?? "clean-live";
  const selectionMode = input.selectionMode ?? parsedSelection(description) ??
    (clips.some((clip) => clip.included && (clip.locked || clip.selectionSource === "manual")) ? "keep-and-choose" : "choose-for-me");
  if (!["highlight", "one-song", "recap", "compilation"].includes(videoType) ||
    !["energetic", "cinematic", "nostalgic", "intimate", "clean-live", "custom"].includes(vibe) ||
    !["use-my-sections", "choose-for-me", "keep-and-choose"].includes(selectionMode)) {
    throw new Error("Choose supported video, vibe, and section options.");
  }
  const targetSeconds = input.targetSeconds === undefined ? parseSeconds(description) : input.targetSeconds;
  if (targetSeconds !== null && (!Number.isFinite(targetSeconds) || targetSeconds < 0.1 || targetSeconds > 86400)) throw new Error("Choose a length between one second and 24 hours.");
  const aspect = input.aspect ?? (/\b(horizontal|widescreen|landscape|16:9)\b/i.test(description) ? "landscape" : /\b(vertical|portrait|9:16)\b/i.test(description) ? "vertical" : current.aspect);
  if (!["vertical", "landscape"].includes(aspect)) throw new Error("Choose a valid video shape.");
  const customVibe = input.customVibe?.trim() ?? "";
  const options: ExportOptions = { ...current, aspect, ...styleFor(vibe) };
  const protectedClips = clips.filter((clip) => clip.included && !clip.excludedByUser && (clip.locked || clip.selectionSource === "manual" || selectionMode === "use-my-sections"));
  const markedClips = clips.filter((clip) => clip.included && !clip.excludedByUser && (clip.locked || clip.selectionSource === "manual"));
  const protectedSeconds = selectionMode === "use-my-sections" ? total(markedClips) : total(protectedClips);
  const eligible = clips.filter((clip) => !clip.excludedByUser);
  const oneSongChoice = markedClips[0] ?? eligible.find((clip) => clip.included) ?? eligible[0];
  const availableSeconds = selectionMode === "use-my-sections" ? total(markedClips) : videoType === "one-song" ?
    (markedClips.length ? protectedSeconds : oneSongChoice?.asset.duration ?? 0) :
    protectedSeconds + eligible.filter((clip) => !protectedClips.includes(clip)).reduce((sum, clip) => sum + clip.asset.duration, 0);
  let conflict: BriefConflict | null = null;
  if (selectionMode === "use-my-sections" && markedClips.length === 0) {
    conflict = { kind: "no-marked-sections", message: "No sections are marked yet. Mark a section, or let Concert Compass choose for you." };
  } else if (videoType === "one-song" && markedClips.length > 1) {
    conflict = { kind: "one-song-multiple-sections", message: "Several marked recordings are protected. Which one belongs in this one-song video?" };
  } else if (targetSeconds !== null && protectedSeconds > targetSeconds + 0.05) {
    conflict = { kind: "protected-over-target", message: `Your marked sections total ${time(protectedSeconds)}, longer than ${time(targetSeconds)}. Keep them all and extend the video, or adjust the sections?`, requestedSeconds: targetSeconds, availableSeconds: protectedSeconds };
  } else if (targetSeconds !== null && availableSeconds + 0.05 < targetSeconds) {
    const message = selectionMode === "use-my-sections" ?
      `Your marked sections total ${time(availableSeconds)}, less than ${time(targetSeconds)}. Mark more footage or choose a shorter length.` :
      videoType === "one-song" && markedClips.length ?
      `Your protected section is ${time(availableSeconds)}, less than ${time(targetSeconds)}. Extend that section yourself or choose a shorter length.` :
      `There is ${time(availableSeconds)} available without changing marked sections or repeating footage, less than ${time(targetSeconds)}. Choose a shorter length or add recordings.`;
    conflict = { kind: "insufficient-footage", message, requestedSeconds: targetSeconds, availableSeconds };
  }
  const typeLabel: Record<VideoType, string> = { highlight: "highlight", "one-song": "one-recording performance", recap: "recap", compilation: "compilation" };
  const preserved = markedClips.length ? "your marked sections stay" : "you can adjust every section";
  const labelPool = selectionMode === "use-my-sections" ? markedClips : eligible;
  const labeledSongs = new Set(labelPool.map((clip) => clip.label?.trim().toLowerCase()).filter(Boolean)).size;
  const variety = /\b(several|multiple|different|many) songs?\b/i.test(description) ? labeledSongs > 1 ? " · your labeled songs" : " · several recordings" : "";
  const naturalSeconds = selectionMode === "use-my-sections" || videoType === "one-song" && markedClips.length ? protectedSeconds : total(clips);
  const summary = `${time(targetSeconds ?? naturalSeconds)} ${typeLabel[videoType]}${variety} · ${vibe === "clean-live" ? "clean/live" : vibe} pacing · ${options.finish} look · ${options.transition === "fade" ? "soft joins" : "direct cuts"} · ${aspect === "landscape" ? "horizontal" : "vertical"} · ${preserved}.`;
  const limitations = supportedLimits(description, videoType, vibe, customVibe, labeledSongs);
  if (vibe === "energetic" && eligible.length < 2) limitations.push("Quicker cuts need multiple recordings; this cut keeps the available footage continuous.");
  return { description, videoType, vibe, selectionMode, targetSeconds, aspect, customVibe, summary, limitations, conflict, options };
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

export function makeFirstCut<T extends CreativeClip>(clips: T[], brief: CreativeBrief, resolution?: "extend"): CutResult<T> {
  validateClips(clips);
  if (brief.conflict && !(brief.conflict.kind === "protected-over-target" && resolution === "extend")) throw new Error(brief.conflict.message);
  if (brief.selectionMode === "use-my-sections") return outcome(clips.map((clip) => ({ ...clip, included: clip.included && !clip.excludedByUser && (clip.locked || clip.selectionSource === "manual") })), brief.options, ["Kept your marked sections unchanged and left unmarked suggestions out."]);
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
