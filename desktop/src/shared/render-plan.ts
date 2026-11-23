import { assFilter } from "./visual-design.js";
import { planSourceCrossfades } from "./audio-crossfade.js";

export type MediaAsset = { path: string; name: string; duration: number; width: number; height: number; hasAudio: boolean; audioDuration?: number };
export type RenderSelection = { asset: MediaAsset; start: number; end: number; locked?: boolean; selectionSource?: "suggested" | "manual"; framing?: "fill" | "fit"; focus?: number; label?: string };
export type AudioSelection = { asset: MediaAsset; start: number; end: number; locked?: boolean };
export type ExportOptions = {
  aspect: "portrait913" | "vertical" | "landscape";
  reduceRumble: boolean;
  finish?: "natural" | "vivid" | "cinematic" | "warm";
  transition?: "cut" | "fade" | "dissolve" | "smoothslide";
  quality?: "standard" | "high";
  enhance?: boolean;
  audioTransition?: "cut" | "crossfade";
  audioCrossfadeSeconds?: number;
  beatSync?: boolean;
  highlightFocus?: "balanced" | "performance";
  eventTitle?: string;
  showClipLabels?: boolean;
};

const fixed = (value: number) => value.toFixed(3);
const looks: Record<NonNullable<ExportOptions["finish"]>, string> = {
  natural: "",
  vivid: ",eq=contrast=1.02:saturation=1.08:brightness=0",
  cinematic: ",eq=contrast=1.07:saturation=0.90:gamma=0.98",
  warm: ",eq=contrast=1.03:saturation=0.97:gamma=1.01,colorchannelmixer=rr=1.025:gg=1.0:bb=0.975",
};

function appendVideoFilters(filters: string[], selection: RenderSelection, index: number, fileInput: number,
  width: number, height: number, aspect: ExportOptions["aspect"], look: string, videoFades: string, options?: ExportOptions): void {
  const smoothing = options?.enhance ? "hqdn3d=1:1:2:2," : "";
  const clarity = options?.enhance ? ",unsharp=5:5:0.25:3:3:0" : "";
  const scaling = options?.quality === "high" ? ":flags=lanczos" : "";
  const sourceRatio = selection.asset.width / selection.asset.height;
  const outputRatio = width / height;
  const strongMismatch = Number.isFinite(sourceRatio) && sourceRatio > 0 &&
    Math.max(sourceRatio / outputRatio, outputRatio / sourceRatio) >= 1.45;
  const frameMode = selection.framing ?? (aspect === "portrait913" ? "fill" : strongMismatch ? "fit" : "fill");
  if (frameMode === "fit") {
    // Blur at quarter resolution before enlarging; the source itself stays fully visible on top.
    const backgroundWidth = Math.round(width / 8) * 2;
    const backgroundHeight = Math.round(height / 8) * 2;
    filters.push(`[${fileInput}:v]${smoothing}split=2[bgsource${index}][fgsource${index}]`);
    filters.push(`[bgsource${index}]scale=${backgroundWidth}:${backgroundHeight}:force_original_aspect_ratio=increase,crop=${backgroundWidth}:${backgroundHeight},boxblur=10:1${look},colorchannelmixer=rr=0.24:gg=0.24:bb=0.24,scale=${width}:${height},setsar=1[bg${index}]`);
    filters.push(`[fgsource${index}]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2${scaling},setsar=1${look}${clarity}[fg${index}]`);
    filters.push(`[bg${index}][fg${index}]overlay=(W-w)/2:(H-h)/2:shortest=1,fps=30,setsar=1,format=yuv420p${videoFades}[v${index}]`);
  } else {
    // A fixed focal position avoids distracting pans. FFmpeg and the source preview use the
    // same percentage of the excess horizontal width; portrait sources still crop vertically.
    const focus = fixed(selection.focus ?? 0.5);
    filters.push(`[${fileInput}:v]${smoothing}scale=${width}:${height}:force_original_aspect_ratio=increase${scaling},crop=${width}:${height}:(iw-ow)*${focus}:(ih-oh)/2,fps=30,setsar=1,format=yuv420p${look}${clarity}${videoFades}[v${index}]`);
  }
}

function outputSettings(options: ExportOptions, profile: "export" | "draft", sources?: MediaAsset[]) {
  if (!["export", "draft"].includes(profile)) throw new Error("Choose a valid render profile.");
  if (!options || !["portrait913", "vertical", "landscape"].includes(options.aspect) || typeof options.reduceRumble !== "boolean"
    || (options.finish !== undefined && !["natural", "vivid", "cinematic", "warm"].includes(options.finish))
    || (options.transition !== undefined && !["cut", "fade", "dissolve", "smoothslide"].includes(options.transition))
    || (options.quality !== undefined && !["standard", "high"].includes(options.quality))
    || (options.enhance !== undefined && typeof options.enhance !== "boolean")
    || (options.beatSync !== undefined && typeof options.beatSync !== "boolean")
    || (options.highlightFocus !== undefined && !["balanced", "performance"].includes(options.highlightFocus))
    || (options.audioTransition !== undefined && !["cut", "crossfade"].includes(options.audioTransition))
    || (options.audioCrossfadeSeconds !== undefined && (!Number.isFinite(options.audioCrossfadeSeconds) || options.audioCrossfadeSeconds < 0.1 || options.audioCrossfadeSeconds > 5))
    || (options.eventTitle !== undefined && (typeof options.eventTitle !== "string" || options.eventTitle.length > 80 || /[\r\n\x00-\x1f]/.test(options.eventTitle)))
    || (options.showClipLabels !== undefined && typeof options.showClipLabels !== "boolean")) throw new Error("Choose valid export settings.");
  // Keep native 720p sources at 720p; a larger file cannot recover missing detail.
  // Mixed projects retain the best supplied short edge, capped at Full HD.
  const native = sources?.length ? Math.max(...sources.map(asset => Math.min(asset.width, asset.height))) : 1080;
  if (!Number.isFinite(native) || native <= 0) throw new Error("Choose videos with valid picture dimensions.");
  const edge = profile === "draft" ? 360 : options.quality === "high" ?
    Math.max(180, Math.floor(Math.min(1080, native) / 18) * 18) : 720;
  const [width, height] = options.aspect === "landscape" ? [edge / 9 * 16, edge] :
    options.aspect === "portrait913" ? [edge, edge / 9 * 13] : [edge, edge / 9 * 16];
  return { width, height, look: looks[options.finish ?? "natural"] };
}

export function renderDimensions(options: ExportOptions, profile: "export" | "draft" = "export", sources?: MediaAsset[]) {
  const { width, height } = outputSettings(options, profile, sources);
  return { width, height };
}

function appendEncoding(args: string[], filters: string[], output: string, profile: "export" | "draft", options?: ExportOptions) {
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", profile === "draft" ? "ultrafast" : "medium", "-crf", profile === "draft" ? "30" : options?.quality === "high" ? "17" : "20", "-movflags", "+faststart", "-c:a", "aac", "-b:a", profile === "draft" ? "96k" : options?.quality === "high" ? "256k" : "192k", "-progress", "pipe:1", "-nostats", output);
}

export function suggestedRange(asset: MediaAsset, maxSeconds = 12): Pick<RenderSelection, "start" | "end"> {
  const duration = Math.max(0, asset.duration);
  const length = Math.min(maxSeconds, duration);
  return { start: Math.max(0, (duration - length) / 2), end: Math.min(duration, (duration + length) / 2) };
}

export function buildRenderCommand(selections: RenderSelection[], output: string, options: ExportOptions = { aspect: "portrait913", reduceRumble: false }, profile: "export" | "draft" = "export", overlayAssPath?: string) {
  if (!selections.length) throw new Error("Choose at least one clip for the reel.");
  if (["dissolve", "smoothslide"].includes(options.transition ?? "") || options.audioTransition === "crossfade") {
    const protectedRanges = selections.map(s => ({ ...s, locked: s.locked || s.selectionSource === "manual" }));
    return buildIndependentTracks(protectedRanges, protectedRanges, output, options, profile, overlayAssPath, true);
  }
  const { width, height, look } = outputSettings(options, profile, selections.map(s => s.asset));
  const args = ["-hide_banner", "-y"];
  const filters: string[] = [];
  const joins: string[] = [];
  let inputIndex = 0;
  let totalSeconds = 0;
  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    const duration = selection.end - selection.start;
    if (!Number.isFinite(duration) || duration < 0.1 || selection.start < 0 || selection.end > selection.asset.duration + 0.05) throw new Error(`Invalid range for ${selection.asset.name}.`);
    if (selection.framing !== undefined && !["fill", "fit"].includes(selection.framing)) throw new Error(`Choose valid framing for ${selection.asset.name}.`);
    if (selection.focus !== undefined && (typeof selection.focus !== "number" || !Number.isFinite(selection.focus) || selection.focus < 0 || selection.focus > 1)) throw new Error(`Choose a valid focal position for ${selection.asset.name}.`);
    if (selection.label !== undefined && (typeof selection.label !== "string" || selection.label.length > 100 || /[\r\n\x00-\x1f]/.test(selection.label))) throw new Error(`Choose a valid moment name for ${selection.asset.name}.`);
    args.push("-ss", fixed(selection.start), "-t", fixed(duration), "-i", selection.asset.path);
    const fileInput = inputIndex++;
    let audioInput = fileInput;
    if (!selection.asset.hasAudio) {
      args.push("-f", "lavfi", "-t", fixed(duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      audioInput = inputIndex++;
    }
    // A visual fade briefly dips to black within the chosen ranges; it does not overlap or shorten footage.
    // Locks preserve timing and inclusion, while framing and finishing still apply to the whole video.
    const fadeIn = options.transition === "fade" && index > 0 && duration >= 0.5 && selections[index - 1].end - selections[index - 1].start >= 0.5;
    const fadeOut = options.transition === "fade" && index < selections.length - 1 && duration >= 0.5 && selections[index + 1].end - selections[index + 1].start >= 0.5;
    const fadeSeconds = Math.min(0.12, duration / 5);
    const videoFades = `${fadeIn ? `,fade=t=in:st=0:d=${fixed(fadeSeconds)}` : ""}${fadeOut ? `,fade=t=out:st=${fixed(duration - fadeSeconds)}:d=${fixed(fadeSeconds)}` : ""}`;
    const audioInSeconds = fadeIn ? fadeSeconds : 0.008;
    const audioOutSeconds = fadeOut ? fadeSeconds : 0.008;
    const audioFades = `,afade=t=in:st=0:d=${fixed(audioInSeconds)},afade=t=out:st=${fixed(duration - audioOutSeconds)}:d=${fixed(audioOutSeconds)}`;
    appendVideoFilters(filters, selection, index, fileInput, width, height, options.aspect, look, videoFades, options);
    filters.push(`[${audioInput}:a]aresample=48000,aformat=channel_layouts=stereo${options.reduceRumble ? ",highpass=f=80" : ""}${audioFades}[a${index}]`);
    joins.push(`[v${index}][a${index}]`);
    totalSeconds += duration;
  }
  filters.push(`${joins.join("")}concat=n=${selections.length}:v=1:a=1${overlayAssPath ? "[vcat][aout]" : "[vout][aout]"}`);
  if (overlayAssPath) filters.push(`[vcat]${assFilter(overlayAssPath)}[vout]`);
  appendEncoding(args, filters, output, profile, options);
  return { args, totalSeconds };
}

// An audio-led edit uses the same picture treatment and output codec as the standard
// reel, but none of the picture sources' sound reaches the final soundtrack.
export function buildAudioLedRenderCommand(videoSelections: RenderSelection[], audioSelections: AudioSelection[],
  output: string, options: ExportOptions = { aspect: "portrait913", reduceRumble: false },
  profile: "export" | "draft" = "export", overlayAssPath?: string) {
  return buildIndependentTracks(videoSelections, audioSelections, output, options, profile, overlayAssPath, false);
}

function buildIndependentTracks(videoSelections: RenderSelection[], audioSelections: AudioSelection[],
  output: string, options: ExportOptions, profile: "export" | "draft", overlayAssPath: string | undefined,
  allowSilent: boolean) {
  if (!Array.isArray(videoSelections) || !videoSelections.length) throw new Error("Choose at least one video section.");
  if (!Array.isArray(audioSelections) || !audioSelections.length) throw new Error("Choose at least one sound section.");
  const { width, height, look } = outputSettings(options, profile, videoSelections.map(s => s.asset));
  const animated = ["dissolve", "smoothslide"].includes(options.transition ?? "");
  const pictureBlend = animated ? planSourceCrossfades(videoSelections.map(s => ({ ...s,
    locked: s.locked || s.selectionSource === "manual" })), { desiredSeconds: 0.4, medium: "video" }) : null;
  const soundBlend = options.audioTransition === "crossfade" && audioSelections.length > 1 && audioSelections.every(s => s.asset.hasAudio) ?
    planSourceCrossfades(audioSelections, { desiredSeconds: options.audioCrossfadeSeconds ?? 2 }) : null;
  const args = ["-hide_banner", "-y", "-filter_complex_threads", "2"];
  const filters: string[] = [];
  const videoJoins: string[] = [];
  const audioJoins: string[] = [];
  let totalSeconds = 0;
  let audioSeconds = 0;

  for (let index = 0; index < videoSelections.length; index += 1) {
    const original = videoSelections[index];
    const selection = { ...original, ...(pictureBlend?.extendedSelections[index] ?? {}) };
    const duration = selection?.end - selection?.start;
    if (!selection?.asset?.path || !Number.isFinite(selection.asset.duration) || !Number.isFinite(duration) ||
      duration < 0.1 || selection.start < 0 || selection.end > selection.asset.duration + 0.05) {
      throw new Error(`Invalid picture range for ${selection?.asset?.name ?? "a recording"}.`);
    }
    if (selection.framing !== undefined && !["fill", "fit"].includes(selection.framing)) {
      throw new Error(`Choose valid framing for ${selection.asset.name}.`);
    }
    if (selection.focus !== undefined && (typeof selection.focus !== "number" || !Number.isFinite(selection.focus) || selection.focus < 0 || selection.focus > 1)) {
      throw new Error(`Choose a valid focal position for ${selection.asset.name}.`);
    }
    if (selection.label !== undefined && (typeof selection.label !== "string" || selection.label.length > 100 || /[\r\n\x00-\x1f]/.test(selection.label))) {
      throw new Error(`Choose a valid moment name for ${selection.asset.name}.`);
    }
    args.push("-ss", fixed(selection.start), "-t", fixed(duration), "-i", selection.asset.path);
    const previous = index > 0 ? videoSelections[index - 1].end - videoSelections[index - 1].start : 0;
    const next = index < videoSelections.length - 1 ? videoSelections[index + 1].end - videoSelections[index + 1].start : 0;
    const fadeIn = options.transition === "fade" && index > 0 && duration >= 0.5 && previous >= 0.5;
    const fadeOut = options.transition === "fade" && index < videoSelections.length - 1 && duration >= 0.5 && next >= 0.5;
    const fadeSeconds = Math.min(0.12, duration / 5);
    const videoFades = `${fadeIn ? `,fade=t=in:st=0:d=${fixed(fadeSeconds)}` : ""}${fadeOut ? `,fade=t=out:st=${fixed(duration - fadeSeconds)}:d=${fixed(fadeSeconds)}` : ""}`;
    appendVideoFilters(filters, selection, index, index, width, height, options.aspect, look,
      `${videoFades},settb=AVTB,setpts=PTS-STARTPTS${animated ? ",format=yuv444p" : ""}`, options);
    videoJoins.push(`[v${index}]`);
    totalSeconds += original.end - original.start;
  }

  for (let index = 0; index < audioSelections.length; index += 1) {
    const original = audioSelections[index];
    const selection = soundBlend?.extendedSelections[index] ?? original;
    const duration = selection?.end - selection?.start;
    if (!selection?.asset?.path || (!selection.asset.hasAudio && !allowSilent) || !Number.isFinite(selection.asset.duration) ||
      !Number.isFinite(duration) || duration < 0.1 || selection.start < 0 ||
      selection.end > selection.asset.duration + 0.05 ||
      (selection.locked !== undefined && typeof selection.locked !== "boolean")) {
      throw new Error(`Choose an audible range from ${selection?.asset?.name ?? "a recording"}.`);
    }
    const input = videoSelections.length + index;
    if (selection.asset.hasAudio) args.push("-ss", fixed(selection.start), "-t", fixed(duration), "-i", selection.asset.path);
    else args.push("-f", "lavfi", "-t", fixed(duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    const previous = index > 0 ? audioSelections[index - 1].end - audioSelections[index - 1].start : 0;
    const next = index < audioSelections.length - 1 ? audioSelections[index + 1].end - audioSelections[index + 1].start : 0;
    const fadeIn = options.transition === "fade" && index > 0 && duration >= 0.5 && previous >= 0.5;
    const fadeOut = options.transition === "fade" && index < audioSelections.length - 1 && duration >= 0.5 && next >= 0.5;
    const edge = Math.min(0.12, duration / 5);
    const audioInSeconds = fadeIn ? edge : 0.008;
    const audioOutSeconds = fadeOut ? edge : 0.008;
    const edgeIn = soundBlend?.boundaries[index - 1]?.overlapSeconds ? "" : `,afade=t=in:st=0:d=${fixed(audioInSeconds)}`;
    const edgeOut = soundBlend?.boundaries[index]?.overlapSeconds ? "" : `,afade=t=out:st=${fixed(duration - audioOutSeconds)}:d=${fixed(audioOutSeconds)}`;
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo${options.reduceRumble ? ",highpass=f=80" : ""},atrim=duration=${fixed(duration)},asetpts=PTS-STARTPTS${edgeIn}${edgeOut}[a${index}]`);
    audioJoins.push(`[a${index}]`);
    audioSeconds += original.end - original.start;
  }

  if (Math.abs(totalSeconds - audioSeconds) > 0.05) {
    throw new Error("The picture and soundtrack have different lengths. Adjust the sections before exporting.");
  }
  if (!animated && !soundBlend) {
    // Keep the established concat path for existing saved projects.
    filters.push(`${videoJoins.join("")}concat=n=${videoSelections.length}:v=1:a=0${overlayAssPath ? "[vcat]" : "[vout]"}`);
    if (overlayAssPath) filters.push(`[vcat]${assFilter(overlayAssPath)}[vout]`);
    filters.push(`${audioJoins.join("")}concat=n=${audioSelections.length}:v=0:a=1[acat]`);
    filters.push(`[acat]atrim=duration=${fixed(totalSeconds)}[aout]`);
    appendEncoding(args, filters, output, profile, options);
    return { args, totalSeconds, warnings: [] as string[] };
  }
  let picture = videoJoins[0];
  let accumulated = (pictureBlend?.extendedSelections[0] ?? videoSelections[0]).end -
    (pictureBlend?.extendedSelections[0] ?? videoSelections[0]).start;
  for (let index = 1; index < videoSelections.length; index++) {
    const boundary = pictureBlend?.boundaries[index - 1];
    const overlap = boundary?.overlapSeconds ?? 0;
    const next = `[picturejoin${index}]`;
    if (overlap >= 1 / 30) {
      // A moving transition is deliberately occasional; dissolve the other joins.
      const effect = options.transition === "smoothslide" && (index === 1 || index === Math.ceil(videoSelections.length / 2)) ? "smoothleft" : "fade";
      filters.push(`${picture}${videoJoins[index]}xfade=transition=${effect}:duration=${fixed(overlap)}:offset=${fixed(accumulated - overlap)}${next}`);
    } else filters.push(`${picture}${videoJoins[index]}concat=n=2:v=1:a=0${next}`);
    const source = pictureBlend?.extendedSelections[index] ?? videoSelections[index];
    accumulated += source.end - source.start - overlap;
    picture = next;
  }
  filters.push(`${picture}trim=duration=${fixed(totalSeconds)},setpts=PTS-STARTPTS,format=yuv420p${overlayAssPath ? `[vcat]` : `[vout]`}`);
  if (overlayAssPath) filters.push(`[vcat]${assFilter(overlayAssPath)}[vout]`);
  let sound = audioJoins[0];
  for (let index = 1; index < audioSelections.length; index++) {
    const overlap = soundBlend?.boundaries[index - 1]?.overlapSeconds ?? 0;
    const next = `[soundjoin${index}]`;
    // Complementary linear gains avoid the correlated-signal peak boost of
    // equal-power curves. This blends recordings; it does not detect beats.
    filters.push(overlap > 0 ? `${sound}${audioJoins[index]}acrossfade=d=${fixed(overlap)}:c1=tri:c2=tri${next}` :
      `${sound}${audioJoins[index]}concat=n=2:v=0:a=1${next}`);
    sound = next;
  }
  // Trim packet-edge excess; never synthesize seconds of silence when a source's sound ends early.
  filters.push(`${sound}atrim=duration=${fixed(totalSeconds)},asetpts=PTS-STARTPTS[aout]`);
  appendEncoding(args, filters, output, profile, options);
  return { args, totalSeconds, warnings: [...(pictureBlend?.warnings ?? []), ...(soundBlend?.warnings ?? [])] };
}
