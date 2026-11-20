type VideoStream = {
  width?: unknown;
  height?: unknown;
  tags?: { rotate?: unknown };
  side_data_list?: { rotation?: unknown }[];
};

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// FFmpeg applies a video's display matrix when decoding. Use the resulting
// displayed proportions when deciding whether an export should fit or fill.
export function displayDimensions(stream: VideoStream): { width: number; height: number } {
  const width = numeric(stream.width) ?? 0;
  const height = numeric(stream.height) ?? 0;
  const matrixRotation = stream.side_data_list?.map((item) => numeric(item.rotation)).find((value) => value !== null);
  const rotation = matrixRotation ?? numeric(stream.tags?.rotate) ?? 0;
  const normalized = ((rotation % 360) + 360) % 360;
  const sideways = Math.abs(normalized - 90) < 0.5 || Math.abs(normalized - 270) < 0.5;
  return sideways ? { width: height, height: width } : { width, height };
}
