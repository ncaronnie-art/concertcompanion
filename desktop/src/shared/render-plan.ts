export type MediaAsset = { path: string; name: string; duration: number; width: number; height: number; hasAudio: boolean };
export type RenderSelection = { asset: MediaAsset; start: number; end: number; locked?: boolean; framing?: "fill" | "fit"; focus?: number };
export type AudioSelection = { asset: MediaAsset; start: number; end: number; locked?: boolean };
export type ExportOptions = {
  aspect: "portrait913" | "vertical" | "landscape";
  reduceRumble: boolean;
  finish?: "natural" | "vivid" | "cinematic" | "warm";
  transition?: "cut" | "fade";
};

const fixed = (value: number) => value.toFixed(3);
const looks: Record<NonNullable<ExportOptions["finish"]>, string> = {
  natural: "",
  vivid: ",eq=contrast=1.06:saturation=1.10:brightness=0.006",
  cinematic: ",eq=contrast=1.07:saturation=0.90:gamma=0.98",
  warm: ",eq=contrast=1.03:saturation=0.97:gamma=1.01,colorchannelmixer=rr=1.025:gg=1.0:bb=0.975",
};

function appendVideoFilters(filters: string[], selection: RenderSelection, index: number, fileInput: number,
  width: number, height: number, aspect: ExportOptions["aspect"], look: string, videoFades: string): void {
  const sourceRatio = selection.asset.width / selection.asset.height;
  const outputRatio = width / height;
  const strongMismatch = Number.isFinite(sourceRatio) && sourceRatio > 0 &&
    Math.max(sourceRatio / outputRatio, outputRatio / sourceRatio) >= 1.45;
  const frameMode = selection.framing ?? (aspect === "portrait913" ? "fill" : strongMismatch ? "fit" : "fill");
  if (frameMode === "fit") {
    // Blur at quarter resolution before enlarging; the source itself stays fully visible on top.
    const backgroundWidth = Math.round(width / 8) * 2;
    const backgroundHeight = Math.round(height / 8) * 2;
    filters.push(`[${fileInput}:v]split=2[bgsource${index}][fgsource${index}]`);
    filters.push(`[bgsource${index}]scale=${backgroundWidth}:${backgroundHeight}:force_original_aspect_ratio=increase,crop=${backgroundWidth}:${backgroundHeight},boxblur=10:1${look},colorchannelmixer=rr=0.24:gg=0.24:bb=0.24,scale=${width}:${height},setsar=1[bg${index}]`);
    filters.push(`[fgsource${index}]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1${look}[fg${index}]`);
    filters.push(`[bg${index}][fg${index}]overlay=(W-w)/2:(H-h)/2:shortest=1,fps=30,setsar=1,format=yuv420p${videoFades}[v${index}]`);
  } else {
    // A fixed focal position avoids distracting pans. FFmpeg and the source preview use the
    // same percentage of the excess horizontal width; portrait sources still crop vertically.
    const focus = fixed(selection.focus ?? 0.5);
    filters.push(`[${fileInput}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-ow)*${focus}:(ih-oh)/2,fps=30,setsar=1,format=yuv420p${look}${videoFades}[v${index}]`);
  }
}

function outputSettings(options: ExportOptions, profile: "export" | "draft") {
  if (!["export", "draft"].includes(profile)) throw new Error("Choose a valid render profile.");
  if (!options || !["portrait913", "vertical", "landscape"].includes(options.aspect) || typeof options.reduceRumble !== "boolean"
    || (options.finish !== undefined && !["natural", "vivid", "cinematic", "warm"].includes(options.finish))
    || (options.transition !== undefined && !["cut", "fade"].includes(options.transition))) throw new Error("Choose valid export settings.");
  const [width, height] = options.aspect === "landscape" ?
    (profile === "draft" ? [640, 360] : [1280, 720]) :
    options.aspect === "portrait913" ?
      (profile === "draft" ? [360, 520] : [720, 1040]) :
      (profile === "draft" ? [360, 640] : [720, 1280]);
  return { width, height, look: looks[options.finish ?? "natural"] };
}

function appendEncoding(args: string[], filters: string[], output: string, profile: "export" | "draft") {
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", profile === "draft" ? "ultrafast" : "medium", "-crf", profile === "draft" ? "30" : "20", "-movflags", "+faststart", "-c:a", "aac", "-b:a", profile === "draft" ? "96k" : "192k", "-progress", "pipe:1", "-nostats", output);
}

export function suggestedRange(asset: MediaAsset, maxSeconds = 12): Pick<RenderSelection, "start" | "end"> {
  const duration = Math.max(0, asset.duration);
  const length = Math.min(maxSeconds, duration);
  return { start: Math.max(0, (duration - length) / 2), end: Math.min(duration, (duration + length) / 2) };
}

export function buildRenderCommand(selections: RenderSelection[], output: string, options: ExportOptions = { aspect: "portrait913", reduceRumble: false }, profile: "export" | "draft" = "export") {
  if (!selections.length) throw new Error("Choose at least one clip for the reel.");
  const { width, height, look } = outputSettings(options, profile);
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
    appendVideoFilters(filters, selection, index, fileInput, width, height, options.aspect, look, videoFades);
    filters.push(`[${audioInput}:a]aresample=48000,aformat=channel_layouts=stereo${options.reduceRumble ? ",highpass=f=80" : ""}${audioFades}[a${index}]`);
    joins.push(`[v${index}][a${index}]`);
    totalSeconds += duration;
  }
  filters.push(`${joins.join("")}concat=n=${selections.length}:v=1:a=1[vout][aout]`);
  appendEncoding(args, filters, output, profile);
  return { args, totalSeconds };
}

// An audio-led edit uses the same picture treatment and output codec as the standard
// reel, but none of the picture sources' sound reaches the final soundtrack.
export function buildAudioLedRenderCommand(videoSelections: RenderSelection[], audioSelections: AudioSelection[],
  output: string, options: ExportOptions = { aspect: "portrait913", reduceRumble: false },
  profile: "export" | "draft" = "export") {
  if (!Array.isArray(videoSelections) || !videoSelections.length) throw new Error("Choose at least one video section.");
  if (!Array.isArray(audioSelections) || !audioSelections.length) throw new Error("Choose at least one sound section.");
  const { width, height, look } = outputSettings(options, profile);
  const args = ["-hide_banner", "-y"];
  const filters: string[] = [];
  const videoJoins: string[] = [];
  const audioJoins: string[] = [];
  let totalSeconds = 0;
  let audioSeconds = 0;

  for (let index = 0; index < videoSelections.length; index += 1) {
    const selection = videoSelections[index];
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
    args.push("-ss", fixed(selection.start), "-t", fixed(duration), "-i", selection.asset.path);
    const previous = index > 0 ? videoSelections[index - 1].end - videoSelections[index - 1].start : 0;
    const next = index < videoSelections.length - 1 ? videoSelections[index + 1].end - videoSelections[index + 1].start : 0;
    const fadeIn = options.transition === "fade" && index > 0 && duration >= 0.5 && previous >= 0.5;
    const fadeOut = options.transition === "fade" && index < videoSelections.length - 1 && duration >= 0.5 && next >= 0.5;
    const fadeSeconds = Math.min(0.12, duration / 5);
    const videoFades = `${fadeIn ? `,fade=t=in:st=0:d=${fixed(fadeSeconds)}` : ""}${fadeOut ? `,fade=t=out:st=${fixed(duration - fadeSeconds)}:d=${fixed(fadeSeconds)}` : ""}`;
    appendVideoFilters(filters, selection, index, index, width, height, options.aspect, look, videoFades);
    videoJoins.push(`[v${index}]`);
    totalSeconds += duration;
  }

  for (let index = 0; index < audioSelections.length; index += 1) {
    const selection = audioSelections[index];
    const duration = selection?.end - selection?.start;
    if (!selection?.asset?.path || !selection.asset.hasAudio || !Number.isFinite(selection.asset.duration) ||
      !Number.isFinite(duration) || duration < 0.1 || selection.start < 0 ||
      selection.end > selection.asset.duration + 0.05 ||
      (selection.locked !== undefined && typeof selection.locked !== "boolean")) {
      throw new Error(`Choose an audible range from ${selection?.asset?.name ?? "a recording"}.`);
    }
    const input = videoSelections.length + index;
    args.push("-ss", fixed(selection.start), "-t", fixed(duration), "-i", selection.asset.path);
    const previous = index > 0 ? audioSelections[index - 1].end - audioSelections[index - 1].start : 0;
    const next = index < audioSelections.length - 1 ? audioSelections[index + 1].end - audioSelections[index + 1].start : 0;
    const fadeIn = options.transition === "fade" && index > 0 && duration >= 0.5 && previous >= 0.5;
    const fadeOut = options.transition === "fade" && index < audioSelections.length - 1 && duration >= 0.5 && next >= 0.5;
    const edge = Math.min(0.12, duration / 5);
    const audioInSeconds = fadeIn ? edge : 0.008;
    const audioOutSeconds = fadeOut ? edge : 0.008;
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo${options.reduceRumble ? ",highpass=f=80" : ""},atrim=duration=${fixed(duration)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fixed(audioInSeconds)},afade=t=out:st=${fixed(duration - audioOutSeconds)}:d=${fixed(audioOutSeconds)}[a${index}]`);
    audioJoins.push(`[a${index}]`);
    audioSeconds += duration;
  }

  if (Math.abs(totalSeconds - audioSeconds) > 0.05) {
    throw new Error("The picture and soundtrack have different lengths. Adjust the sections before exporting.");
  }
  filters.push(`${videoJoins.join("")}concat=n=${videoSelections.length}:v=1:a=0[vout]`);
  filters.push(`${audioJoins.join("")}concat=n=${audioSelections.length}:v=0:a=1[acat]`);
  // Trim packet-edge excess; never synthesize seconds of silence when a source's sound ends early.
  filters.push(`[acat]atrim=duration=${fixed(totalSeconds)}[aout]`);
  appendEncoding(args, filters, output, profile);
  return { args, totalSeconds };
}
