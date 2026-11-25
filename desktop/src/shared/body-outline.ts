import type { VisualEffectCue } from "./visual-effects.js";

export type BodyOutlineStyle = "off" | "subtle" | "electric";
export type BodyOutlineOptions = { bodyOutline?: BodyOutlineStyle; reducedFlash?: boolean };
export type BodyOutlineContext = {
  duration: number;
  namespace?: string;
  pixelFormat?: "yuv420p" | "yuv444p";
  /** Confident music times in shot-local seconds; never inferred from a mask. */
  cues?: readonly VisualEffectCue[];
  /** Editorial visibility only, in shot-local seconds. These are not beats. */
  accentWindows?: readonly { start: number; end: number }[];
};
export type BodyOutlinePlan = {
  filters: string[];
  applied: string[];
  warnings: string[];
  musicalCueCount: number;
  maskRequired: boolean;
};

const fixed = (value: number) => value.toFixed(5).replace(/\.?0+$/, "") || "0";
const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const internalLabel = (value: string, input = false) => {
  if (typeof value !== "string" || value.length > 90 ||
    !(input ? /^(?:\d+:v(?::\d+)?|[A-Za-z][A-Za-z0-9_]*)$/ : /^[A-Za-z][A-Za-z0-9_]*$/).test(value)) {
    throw Error("Choose a valid internal body-outline label.");
  }
  return `[${value}]`;
};

export function validateBodyOutlineOptions(options: BodyOutlineOptions): void {
  if (!options || (options.bodyOutline !== undefined && !["off", "subtle", "electric"].includes(options.bodyOutline)) ||
    (options.reducedFlash !== undefined && typeof options.reducedFlash !== "boolean")) {
    throw Error("Choose a supported body-outline style.");
  }
}

function validateContext(context: BodyOutlineContext, width: number, height: number): void {
  if (!context || !Number.isFinite(context.duration) || context.duration < 0.1 || context.duration > 86400 ||
    !Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 8192 || height > 8192 ||
    (context.namespace !== undefined && !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(context.namespace)) ||
    (context.pixelFormat !== undefined && !["yuv420p", "yuv444p"].includes(context.pixelFormat)) ||
    (context.cues !== undefined && (!Array.isArray(context.cues) || context.cues.length > 20000 || context.cues.some(cue =>
      !Number.isFinite(cue.seconds) || cue.seconds < 0 || cue.seconds > context.duration || !unit(cue.confidence) ||
      (cue.strength !== undefined && !unit(cue.strength))))) ||
    (context.accentWindows !== undefined && (!Array.isArray(context.accentWindows) || context.accentWindows.length > 16 || context.accentWindows.some(window =>
      !Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start < 0 || window.end > context.duration || window.end <= window.start)))) {
    throw Error("Choose valid body-outline dimensions and music timing.");
  }
}

function selectMusicCues(context: BodyOutlineContext, reduced: boolean): VisualEffectCue[] {
  const cues: VisualEffectCue[] = [], gap = reduced ? 2.5 : 1.5;
  for (const cue of [...(context.cues ?? [])].filter(cue => cue.confidence >= 0.65 && cue.seconds < context.duration - 0.15 &&
    (context.accentWindows === undefined || context.accentWindows.some(window => cue.seconds + 0.62 > window.start && Math.max(0,cue.seconds-0.12) < window.end)))
    .sort((a,b) => a.seconds - b.seconds)) {
    if (cues.length >= 24) break;
    if (!cues.length || cue.seconds - cues[cues.length - 1].seconds >= gap) cues.push(cue);
  }
  return cues;
}

// A smooth raised-cosine rise and fall has no hard on/off contour flash. Cues
// are well separated, so only one cosine branch is evaluated for each frame.
function envelope(cues: readonly VisualEffectCue[], duration: number, base: number, boost: number): string {
  let expression = fixed(base);
  for (let index = cues.length - 1; index >= 0; index--) {
    const cue = cues[index], start = Math.max(0, cue.seconds - 0.12), peak = Math.max(start + 0.04, cue.seconds);
    const end = Math.min(duration, cue.seconds + 0.62), strength = 0.65 + (cue.strength ?? 0.65) * 0.35;
    const attack = `(0.5-0.5*cos(PI*clip((T-${fixed(start)})/${fixed(peak-start)},0,1)))`;
    const release = `(0.5+0.5*cos(PI*clip((T-${fixed(peak)})/${fixed(end-peak)},0,1)))`;
    const pulse = `if(lt(T,${fixed(peak)}),${attack},${release})`;
    expression = `if(between(T,${fixed(start)},${fixed(end)}),${fixed(base)}+${fixed(boost*strength)}*${pulse},${expression})`;
  }
  return expression;
}

function visibilityEnvelope(windows: BodyOutlineContext["accentWindows"], delay = 0): string | undefined {
  if (windows === undefined) return undefined;
  const clock = delay ? `(T+${fixed(delay)})` : "T";
  let expression = "0";
  for (const window of windows) {
    const fade = Math.min(0.1,(window.end-window.start)/2);
    const attack = `(0.5-0.5*cos(PI*clip((${clock}-${fixed(window.start)})/${fixed(fade)},0,1)))`;
    const release = `(0.5-0.5*cos(PI*clip((${fixed(window.end)}-${clock})/${fixed(fade)},0,1)))`;
    const value = `if(between(${clock},${fixed(window.start)},${fixed(window.end)}),min(${attack},${release}),0)`;
    expression = `max(${value},${expression})`;
  }
  return expression;
}

/** Signature cyan/pink contour from a REAL silhouette matte.
 *
 * videoLabel and maskLabel must already have identical output geometry and
 * shot-local PTS. White means the selected person's body; black means absent
 * or uncertain. This module never detects a person, creates a mask from a box,
 * follows full-frame edges, or changes any audio. The base picture controls
 * frame count and duration. A missing/ended mask produces no frozen outline.
 */
export function buildBodyOutline(videoLabel: string, maskLabel: string | null | undefined, outputLabel: string,
  width: number, height: number, options: BodyOutlineOptions, context: BodyOutlineContext): BodyOutlinePlan {
  validateBodyOutlineOptions(options); validateContext(context, width, height);
  const video = internalLabel(videoLabel, true), output = internalLabel(outputLabel);
  const mask = maskLabel == null ? undefined : internalLabel(maskLabel, true);
  if (video === output || mask === output || mask === video) throw Error("Use separate picture, silhouette and output labels.");
  const style = options.bodyOutline ?? "off", filters: string[] = [], applied: string[] = [], warnings: string[] = [];
  if (style === "off") {
    if (mask) filters.push(`${mask}nullsink`);
    filters.push(`${video}null${output}`);
    return { filters, applied, warnings, musicalCueCount:0, maskRequired:false };
  }
  if (!mask) throw Error("A real aligned silhouette mask is required for body tracing. Keep this option Off when no reliable mask is available.");
  const ns = context.namespace ?? "body", format = context.pixelFormat ?? "yuv420p";
  const reduced = options.reducedFlash !== false, cues = selectMusicCues(context, reduced);
  if (!cues.length) warnings.push(context.accentWindows === undefined ?
    "No confident music cues were supplied; the body contour stays steady without claimed beat pulses." :
    "No confident music cues were supplied; planned visibility accents use editorial timing, not detected beats.");
  warnings.push("Outline accuracy depends on the supplied silhouette. Review moving limbs, occlusions and stage-light changes.");
  const electric = style === "electric", radius = Math.max(1, Math.min(4, Math.round(width / (electric ? 360 : 540))));
  const sigma = Math.max(0.8, width * (electric ? 0.006 : 0.004));
  const echo = electric && cues.length > 0;
  const branchCount = echo ? 5 : 3;
  // Compress uncertain matte edges gently. Confident body interiors stay fully
  // excluded from both the crisp contour and the blurred exterior glow.
  filters.push(`${mask}format=gray,lut=y='255*clip((val-96)/64,0,1)',split=${branchCount}[${ns}_seed][${ns}_inside][${ns}_guard]${echo ? `[${ns}_echoGuard][${ns}_presenceSeed]` : ""}`);
  filters.push(`[${ns}_seed]${Array.from({length:radius},()=>"dilation=coordinates=255").join(",")}[${ns}_expanded]`);
  // Saturating subtraction and multiplication use FFmpeg's optimized matte
  // kernels instead of evaluating equivalent expressions over every pixel.
  filters.push(`[${ns}_expanded][${ns}_inside]blend=all_mode=subtract:shortest=1[${ns}_edge]`);
  filters.push(`[${ns}_edge]split=${echo ? 3 : 2}[${ns}_coreSeed][${ns}_glowSeed]${echo ? `[${ns}_echoSeed]` : ""}`);
  filters.push(`[${ns}_glowSeed]gblur=sigma=${fixed(sigma)}:steps=2[${ns}_soft]`);
  filters.push(`[${ns}_guard]negate[${ns}_guard_inverse]`);
  filters.push(`[${ns}_soft][${ns}_guard_inverse]blend=all_mode=multiply:shortest=1[${ns}_outsideGlow]`);

  const alpha = (input: string, target: string, base: number, boost: number, visibilityDelay = 0) => {
    const visibility = visibilityEnvelope(context.accentWindows,visibilityDelay);
    if (visibility === "0") filters.push(`[${input}]lut=y=0[${target}]`);
    else if ((!cues.length || !boost) && visibility === undefined) filters.push(`[${input}]lut=y='val*${fixed(base)}'[${target}]`);
    else {
      const level = cues.length && boost ? envelope(cues,context.duration,base,boost) : fixed(base);
      const opacity = visibility === undefined ? level : `(${level})*(${visibility})`;
      filters.push(`[${input}]split=2[${target}_a][${target}_b]`);
      // Most matte pixels are black. Avoid evaluating the pulse trigonometry
      // over the untouched stage and crowd at full export resolution.
      filters.push(`[${target}_a][${target}_b]blend=all_expr='if(eq(A,0),0,A*(${opacity}))':shortest=1[${target}]`);
    }
  };
  const tint = (input: string, target: string, rgb: readonly number[]) => {
    filters.push(`[${input}]split=2[${target}_paint][${target}_alpha]`);
    filters.push(`[${target}_paint]format=rgb24,lutrgb=r=${rgb[0]}:g=${rgb[1]}:b=${rgb[2]}[${target}_color]`);
    filters.push(`[${target}_color][${target}_alpha]alphamerge=shortest=1:repeatlast=0[${target}]`);
  };
  alpha(`${ns}_outsideGlow`,`${ns}_pinkAlpha`,electric ? (cues.length ? 0.12 : 0.32) : 0.18,electric ? 0.44 : 0.08);
  tint(`${ns}_pinkAlpha`,`${ns}_pink`,[255,38,174]);
  let picture = `${ns}_pinkPicture`;
  // Match the already-normalized picture format. An all-black matte must not
  // round-trip the base through RGB and change an otherwise untouched frame.
  const overlay = `overlay=format=${format === "yuv444p" ? "yuv444" : "yuv420"}:alpha=straight:eof_action=pass:repeatlast=0:shortest=0`;
  filters.push(`${video}[${ns}_pink]${overlay}[${picture}]`);
  if (echo) {
    alpha(`${ns}_echoSeed`,`${ns}_echoAlpha`,0,reduced ? 0.2 : 0.28,0.06667);
    // An intentional two-frame motion echo, never a claimed extra silhouette
    // prediction. The current body matte cuts it out of the live performer.
    filters.push(`[${ns}_echoAlpha]gblur=sigma=${fixed(Math.max(0.6,width/1000))},setpts=PTS+0.06667/TB[${ns}_late]`);
    filters.push(`[${ns}_echoGuard]negate[${ns}_echoGuard_inverse]`);
    filters.push(`[${ns}_late][${ns}_echoGuard_inverse]blend=all_mode=multiply:shortest=1[${ns}_echoOutside]`);
    // A currently black/uncertain frame also cancels a delayed echo. Without
    // this gate, a previous contour could briefly remain behind an occluder.
    filters.push(`[${ns}_presenceSeed]scale=1:1:flags=area,lut=y='if(gt(val,0),255,0)',scale=${width}:${height}:flags=neighbor[${ns}_presence]`);
    filters.push(`[${ns}_echoOutside][${ns}_presence]blend=all_mode=multiply:shortest=1[${ns}_safeEcho]`);
    tint(`${ns}_safeEcho`,`${ns}_echo`,[166,79,255]);
    filters.push(`[${picture}][${ns}_echo]${overlay}[${ns}_echoPicture]`);
    picture = `${ns}_echoPicture`; applied.push("A short exterior motion echo on confident musical accents");
  }
  alpha(`${ns}_coreSeed`,`${ns}_cyanAlpha`,electric ? (cues.length ? 0.24 : 0.6) : 0.36,electric ? 0.7 : 0.16);
  tint(`${ns}_cyanAlpha`,`${ns}_cyan`,[35,238,255]);
  filters.push(`[${picture}][${ns}_cyan]${overlay},format=${format}${output}`);
  applied.unshift(electric ? "Electric cyan silhouette core with pink exterior glow" : "Fine cyan silhouette with restrained pink exterior glow");
  if (cues.length) applied.push("Smooth contour-only music pulses; the body interior stays clear");
  if (context.accentWindows?.length) applied.push("Editorial visibility accents with soft one-tenth-second edges");
  return { filters, applied, warnings, musicalCueCount:cues.length, maskRequired:true };
}
