type Stream = { codec_type?: unknown; codec_name?: unknown; duration?: unknown };
type Probe = { streams?: Stream[]; format?: { duration?: unknown } };

// The container duration can be correct even when its audio track ends early.
// Check the actual audio stream before showing a draft or committing an export.
export function validateRenderedOutput(data: unknown, expectedSeconds: number, kind: "preview" | "export"): void {
  const probe = data as Probe;
  const video = Array.isArray(probe?.streams) ? probe.streams.find((stream) =>
    stream.codec_type === "video" && stream.codec_name === "h264") : undefined;
  const audio = Array.isArray(probe?.streams) ? probe.streams.find((stream) =>
    stream.codec_type === "audio" && stream.codec_name === "aac") : undefined;
  const containerSeconds = Number(probe?.format?.duration);
  const audioSeconds = Number(audio?.duration);
  if (!video || !audio || !Number.isFinite(expectedSeconds) || !Number.isFinite(containerSeconds) ||
    Math.abs(containerSeconds - expectedSeconds) > Math.max(0.25, expectedSeconds * 0.01)) {
    throw new Error(kind === "preview" ?
      "The preview did not pass its checks. Try again or export the video." :
      "The exported video did not pass its checks. Please try again.");
  }
  if (!Number.isFinite(audioSeconds) || audioSeconds < expectedSeconds - 0.15) {
    throw new Error("The selected sound ends before the picture. Shorten that sound section or choose another recording.");
  }
}
