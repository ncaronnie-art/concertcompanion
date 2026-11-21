export type OverlayStyle = "natural" | "vivid" | "cinematic" | "warm";
export type OverlayLabel = { text: string; start: number; duration: number };
export type OverlayBrief = {
  eventTitle?: string;
  labels?: OverlayLabel[];
  width: number;
  height: number;
  style: OverlayStyle;
};

const time = (seconds: number) => {
  const ticks = Math.round(seconds * 100);
  const hours = Math.floor(ticks / 360000);
  const minutes = Math.floor(ticks / 6000) % 60;
  const whole = Math.floor(ticks / 100) % 60;
  const fraction = ticks % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
};

// ASS treats braces as formatting instructions and backslashes as control sequences.
// Keep names visible while making user-supplied text incapable of changing the script.
function safeText(value: string, maximum: number): string {
  if (typeof value !== "string") throw new Error("Use text for a video title or moment name.");
  const clean = value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\s+/g, " ").trim();
  if (Array.from(clean).length > maximum) throw new Error(`Keep overlay text under ${maximum + 1} characters.`);
  return clean;
}

function wrap(text: string, limit: number): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const chunks: string[] = [];
    const chars = Array.from(word);
    while (chars.length > limit) chunks.push(chars.splice(0, limit).join(""));
    chunks.push(chars.join(""));
    for (const chunk of chunks) {
      if (!chunk) continue;
      if (!line) line = chunk;
      else if (Array.from(line).length + 1 + Array.from(chunk).length <= limit) line += ` ${chunk}`;
      else { lines.push(line); line = chunk; }
    }
  }
  if (line) lines.push(line);
  return lines.join("\\N");
}

const assColor = (red: number, green: number, blue: number, alpha = 0) =>
  `&H${[alpha, blue, green, red].map((part) => Math.round(part).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

const palette: Record<OverlayStyle, { accent: string; white: string }> = {
  natural: { accent: assColor(229, 225, 220), white: assColor(250, 248, 246) },
  vivid: { accent: assColor(235, 91, 183), white: assColor(255, 250, 253) },
  cinematic: { accent: assColor(216, 174, 115), white: assColor(249, 244, 237) },
  warm: { accent: assColor(235, 189, 130), white: assColor(255, 246, 228) },
};

function dialogue(start: number, end: number, style: string, body: string): string {
  return `Dialogue: 0,${time(start)},${time(end)},${style},,0,0,0,,${body}`;
}

export function buildOverlayAss({ eventTitle, labels = [], width, height, style }: OverlayBrief): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 160 || height < 160 ||
    width > 7680 || height > 7680 || !Object.hasOwn(palette, style) ||
    !Array.isArray(labels) || labels.length > 500) throw new Error("Choose valid title overlay settings.");
  const title = eventTitle === undefined ? "" : safeText(eventTitle, 80);
  const cues = labels.map((label) => {
    if (!Number.isFinite(label.start) || !Number.isFinite(label.duration) ||
      label.start < 0 || label.duration < 0 || label.start + label.duration > 86400) {
      throw new Error("A moment label is outside the video.");
    }
    return { ...label, text: safeText(label.text, 100) };
  }).filter((label) => label.text && label.duration >= 0.35);
  if (!title && !cues.length) return null;
  const portrait = width / height < 1;
  const titleSize = Math.round(Math.max(18, Math.min(width * 0.052, height * 0.045)));
  const labelSize = Math.max(14, Math.round(titleSize * 0.72));
  const left = Math.round(width * (portrait ? 0.075 : 0.06));
  const top = Math.round(height * 0.125);
  const bottom = Math.round(height * (portrait ? 0.18 : 0.16));
  const accent = palette[style].accent;
  const white = palette[style].white;
  const shadow = assColor(0, 0, 0, 95);
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "WrapStyle: 2", "ScaledBorderAndShadow: yes",
    `PlayResX: ${width}`, `PlayResY: ${height}`, "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Title,Segoe UI,${titleSize},${white},${white},${shadow},${shadow},-1,0,0,0,100,100,0,0,1,2,1,7,${left},${left},${top},1`,
    `Style: Label,Segoe UI,${labelSize},${white},${white},${shadow},${shadow},-1,0,0,0,100,100,0,0,1,2,1,1,${left},${left},${bottom},1`,
    `Style: Accent,Segoe UI,${titleSize},${accent},${accent},${shadow},${shadow},0,0,0,0,100,100,0,0,1,0,0,7,${left},${left},${top},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (title) {
    const titleEnd = 2.4;
    const fade = "{\\fad(260,400)}";
    // A single thin accent line gives the title a deliberate position without
    // obscuring the performer or adding a branded watermark.
    const accentY = top - Math.round(titleSize * 0.48);
    const lineWidth = Math.round(titleSize * 1.1);
    lines.push(dialogue(0, titleEnd, "Accent",
      `{\\an7\\pos(${left},${accentY})\\fad(260,400)\\p1}m 0 0 l ${lineWidth} 0 l ${lineWidth} 3 l 0 3{\\p0}`));
    lines.push(dialogue(0, titleEnd, "Title", `${fade}${wrap(title, portrait ? 30 : 45)}`));
  }
  for (const cue of cues) {
    const start = title && cue.start < 2.4 ? 2.4 : cue.start;
    const end = Math.min(cue.start + cue.duration, start + 2.1);
    if (end - start < 0.35) continue;
    const fade = Math.min(240, Math.round((end - start) * 220));
    lines.push(dialogue(start, end, "Label", `{\\fad(${fade},${fade})}${wrap(cue.text, portrait ? 38 : 62)}`));
  }
  return `${lines.join("\n")}\n`;
}

// The returned expression can follow a video pad in a filter graph: `[v]${assFilter(path)}[out]`.
export function assFilter(filePath: string): string {
  if (typeof filePath !== "string" || !filePath || /[\u0000-\u001f\u007f]/.test(filePath)) {
    throw new Error("Choose a valid title overlay file.");
  }
  const normalized = filePath.replace(/\\/g, "/");
  if (!/^(?:[A-Za-z]:\/|\/)/.test(normalized)) throw new Error("The title overlay file must have a full path.");
  // FFmpeg parses filter-option punctuation first, then filtergraph punctuation.
  // The argument is passed to spawn directly, so shell escaping is unnecessary.
  const option = normalized.replace(/([\\':])/g, "\\$1");
  const graph = option.replace(/([\\'\[\],;])/g, "\\$1");
  return `ass=filename=${graph}`;
}
