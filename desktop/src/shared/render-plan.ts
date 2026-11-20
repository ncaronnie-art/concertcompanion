export type MediaAsset = { path: string; name: string; duration: number; width: number; height: number; hasAudio: boolean };
export type RenderSelection = { asset: MediaAsset; start: number; end: number; locked?: boolean };
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

export function buildRenderCommand(selections: RenderSelection[], output: string, options: ExportOptions = { aspect: "vertical", reduceRumble: false }) {
  if (!selections.length) throw new Error("Choose at least one clip for the reel.");
  if (!options || !["vertical", "landscape"].includes(options.aspect) || typeof options.reduceRumble !== "boolean"
    || (options.finish !== undefined && !["natural", "vivid", "cinematic", "warm"].includes(options.finish))
    || (options.transition !== undefined && !["cut", "fade"].includes(options.transition))) throw new Error("Choose valid export settings.");
  const [width, height] = options.aspect === "landscape" ? [1280, 720] : [720, 1280];
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
    args.push("-ss", fixed(selection.start), "-t", fixed(duration), "-i", selection.asset.path);
    const fileInput = inputIndex++;
    let audioInput = fileInput;
    if (!selection.asset.hasAudio) {
      args.push("-f", "lavfi", "-t", fixed(duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      audioInput = inputIndex++;
    }
    // A locked moment skips the automatic color grade and boundary fades.
    // Fades do not overlap, duplicate, or shorten selected footage.
    const fadeIn = options.transition === "fade" && index > 0 && !selection.locked && !selections[index - 1].locked && duration >= 0.5 && selections[index - 1].end - selections[index - 1].start >= 0.5;
    const fadeOut = options.transition === "fade" && index < selections.length - 1 && !selection.locked && !selections[index + 1].locked && duration >= 0.5 && selections[index + 1].end - selections[index + 1].start >= 0.5;
    const fadeSeconds = Math.min(0.12, duration / 5);
    const videoFades = `${fadeIn ? `,fade=t=in:st=0:d=${fixed(fadeSeconds)}` : ""}${fadeOut ? `,fade=t=out:st=${fixed(duration - fadeSeconds)}:d=${fixed(fadeSeconds)}` : ""}`;
    const audioFades = `${fadeIn ? `,afade=t=in:st=0:d=${fixed(fadeSeconds)}` : ""}${fadeOut ? `,afade=t=out:st=${fixed(duration - fadeSeconds)}:d=${fixed(fadeSeconds)}` : ""}`;
    filters.push(`[${fileInput}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,setsar=1,format=yuv420p${selection.locked ? "" : looks[options.finish ?? "natural"]}${videoFades}[v${index}]`);
    filters.push(`[${audioInput}:a]aresample=48000,aformat=channel_layouts=stereo${options.reduceRumble ? ",highpass=f=80" : ""}${audioFades}[a${index}]`);
    joins.push(`[v${index}][a${index}]`);
    totalSeconds += duration;
  }
  filters.push(`${joins.join("")}concat=n=${selections.length}:v=1:a=1[vout][aout]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "192k", "-progress", "pipe:1", "-nostats", output);
  return { args, totalSeconds };
}
