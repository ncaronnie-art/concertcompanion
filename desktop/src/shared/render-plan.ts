export type MediaAsset = { path: string; name: string; duration: number; width: number; height: number; hasAudio: boolean };
export type RenderSelection = { asset: MediaAsset; start: number; end: number; locked?: boolean; framing?: "fill" | "fit" };
export type ExportOptions = {
  aspect: "vertical" | "landscape";
  reduceRumble: boolean;
  finish?: "natural" | "vivid" | "cinematic" | "warm";
  transition?: "cut" | "fade";
};

const fixed = (value: number) => value.toFixed(3);

export function suggestedRange(asset: MediaAsset, maxSeconds = 12): Pick<RenderSelection, "start" | "end"> {
  const duration = Math.max(0, asset.duration);
  const length = Math.min(maxSeconds, duration);
  return { start: Math.max(0, (duration - length) / 2), end: Math.min(duration, (duration + length) / 2) };
}

export function buildRenderCommand(selections: RenderSelection[], output: string, options: ExportOptions = { aspect: "vertical", reduceRumble: false }, profile: "export" | "draft" = "export") {
  if (!selections.length) throw new Error("Choose at least one clip for the reel.");
  if (!["export", "draft"].includes(profile)) throw new Error("Choose a valid render profile.");
  if (!options || !["vertical", "landscape"].includes(options.aspect) || typeof options.reduceRumble !== "boolean"
    || (options.finish !== undefined && !["natural", "vivid", "cinematic", "warm"].includes(options.finish))
    || (options.transition !== undefined && !["cut", "fade"].includes(options.transition))) throw new Error("Choose valid export settings.");
  const [width, height] = options.aspect === "landscape" ?
    (profile === "draft" ? [640, 360] : [1280, 720]) :
    (profile === "draft" ? [360, 640] : [720, 1280]);
  const looks: Record<NonNullable<ExportOptions["finish"]>, string> = {
    natural: "",
    vivid: ",eq=contrast=1.06:saturation=1.10:brightness=0.006",
    cinematic: ",eq=contrast=1.07:saturation=0.90:gamma=0.98",
    warm: ",eq=contrast=1.03:saturation=0.97:gamma=1.01,colorchannelmixer=rr=1.025:gg=1.0:bb=0.975",
  };
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
    const sourceRatio = selection.asset.width / selection.asset.height;
    const outputRatio = width / height;
    const strongMismatch = Number.isFinite(sourceRatio) && sourceRatio > 0 &&
      Math.max(sourceRatio / outputRatio, outputRatio / sourceRatio) >= 1.45;
    const frameMode = selection.framing ?? (strongMismatch ? "fit" : "fill");
    const look = looks[options.finish ?? "natural"];
    if (frameMode === "fit") {
      // Blur at quarter resolution before enlarging; the source itself stays fully visible on top.
      const backgroundWidth = Math.round(width / 8) * 2;
      const backgroundHeight = Math.round(height / 8) * 2;
      filters.push(`[${fileInput}:v]split=2[bgsource${index}][fgsource${index}]`);
      filters.push(`[bgsource${index}]scale=${backgroundWidth}:${backgroundHeight}:force_original_aspect_ratio=increase,crop=${backgroundWidth}:${backgroundHeight},boxblur=10:1${look},colorchannelmixer=rr=0.24:gg=0.24:bb=0.24,scale=${width}:${height},setsar=1[bg${index}]`);
      filters.push(`[fgsource${index}]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1${look}[fg${index}]`);
      filters.push(`[bg${index}][fg${index}]overlay=(W-w)/2:(H-h)/2:shortest=1,fps=30,setsar=1,format=yuv420p${videoFades}[v${index}]`);
    } else {
      filters.push(`[${fileInput}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,setsar=1,format=yuv420p${look}${videoFades}[v${index}]`);
    }
    filters.push(`[${audioInput}:a]aresample=48000,aformat=channel_layouts=stereo${options.reduceRumble ? ",highpass=f=80" : ""}${audioFades}[a${index}]`);
    joins.push(`[v${index}][a${index}]`);
    totalSeconds += duration;
  }
  filters.push(`${joins.join("")}concat=n=${selections.length}:v=1:a=1[vout][aout]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", profile === "draft" ? "ultrafast" : "medium", "-crf", profile === "draft" ? "30" : "20", "-movflags", "+faststart", "-c:a", "aac", "-b:a", profile === "draft" ? "96k" : "192k", "-progress", "pipe:1", "-nostats", output);
  return { args, totalSeconds };
}
