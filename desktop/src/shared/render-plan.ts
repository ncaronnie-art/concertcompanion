export type MediaAsset = { path: string; name: string; duration: number; width: number; height: number; hasAudio: boolean };
export type RenderSelection = { asset: MediaAsset; start: number; end: number };

const fixed = (value: number) => value.toFixed(3);

export function suggestedRange(asset: MediaAsset, maxSeconds = 12): Pick<RenderSelection, "start" | "end"> {
  const duration = Math.max(0, asset.duration);
  const length = Math.min(maxSeconds, duration);
  return { start: Math.max(0, (duration - length) / 2), end: Math.min(duration, (duration + length) / 2) };
}

export function buildRenderCommand(selections: RenderSelection[], output: string) {
  if (!selections.length) throw new Error("Choose at least one clip for the reel.");
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
    filters.push(`[${fileInput}:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,setsar=1,format=yuv420p[v${index}]`);
    filters.push(`[${audioInput}:a]aresample=48000,aformat=channel_layouts=stereo[a${index}]`);
    joins.push(`[v${index}][a${index}]`);
    totalSeconds += duration;
  }
  filters.push(`${joins.join("")}concat=n=${selections.length}:v=1:a=1[vout][aout]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "192k", "-progress", "pipe:1", "-nostats", output);
  return { args, totalSeconds };
}
