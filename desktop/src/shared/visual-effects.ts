/** Bounded FFmpeg styling. All cue/box positions are relative to this output shot.
 * Person rectangles are not segmentation masks: their optional accent is an
 * orbit, never a claimed silhouette/body outline. No filter text comes from UI. */
export type EffectStyle = "none" | "subtle" | "neon-pop" | "full-y2k";
export type VideoEnhancement = "original" | "clean" | "enhanced" | "maximum";
export type VisualEffectCue = { seconds: number; confidence: number; strength?: number };
export type VisualLightAnchor = { x: number; y: number; strength?: number };
export type VisualSubjectBox = { seconds: number; x: number; y: number; width: number; height: number; confidence: number };
export type VisualFinishOptions = { effects?: EffectStyle; videoEnhancement?: VideoEnhancement; reducedFlash?: boolean };
export type VisualFinishContext = {
  duration: number;
  namespace?: string;
  pixelFormat?: "yuv420p" | "yuv444p";
  cues?: readonly VisualEffectCue[];
  lightAnchors?: readonly VisualLightAnchor[];
  /** Smoothed, output-space boxes. Do not pass original coordinates after cropping. */
  subjectBoxes?: readonly VisualSubjectBox[];
  metrics?: { luma?: number; noise?: number; sharpness?: number; motion?: number };
};
export type VisualFinishPlan = {
  filters: string[];
  applied: string[];
  warnings: string[];
  musicalCueCount: number;
  editorialCueCount: number;
};

const styles: readonly EffectStyle[] = ["none", "subtle", "neon-pop", "full-y2k"];
const enhancements: readonly VideoEnhancement[] = ["original", "clean", "enhanced", "maximum"];
const fixed = (n: number) => n.toFixed(5).replace(/\.?0+$/, "") || "0";
const unit = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const label = (name: string, input = false) => {
  if (typeof name !== "string" || !(input ? /^(?:\d+:[va](?::\d+)?|[A-Za-z][A-Za-z0-9_]*)$/ : /^[A-Za-z][A-Za-z0-9_]*$/).test(name)) {
    throw new Error("Choose a valid internal picture label.");
  }
  return `[${name}]`;
};

export function validateVisualFinishOptions(options: VisualFinishOptions): void {
  if (!options || (options.effects !== undefined && !styles.includes(options.effects)) ||
    (options.videoEnhancement !== undefined && !enhancements.includes(options.videoEnhancement)) ||
    (options.reducedFlash !== undefined && typeof options.reducedFlash !== "boolean")) {
    throw new Error("Choose valid visual effect and enhancement settings.");
  }
}

function validateContext(context: VisualFinishContext, width: number, height: number): void {
  if (!Number.isFinite(context.duration) || context.duration < 0.1 || context.duration > 86400 ||
    !Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 8192 || height > 8192 ||
    (context.namespace !== undefined && !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(context.namespace)) ||
    (context.pixelFormat !== undefined && !["yuv420p", "yuv444p"].includes(context.pixelFormat))) {
    throw new Error("Choose valid picture dimensions and visual timing.");
  }
  if (context.cues && (context.cues.length > 20000 || context.cues.some(c => !Number.isFinite(c.seconds) ||
    c.seconds < 0 || c.seconds > context.duration || !unit(c.confidence) || (c.strength !== undefined && !unit(c.strength))))) {
    throw new Error("The visual accents contain an invalid music cue.");
  }
  if (context.lightAnchors && (context.lightAnchors.length > 32 || context.lightAnchors.some(a => !unit(a.x) || !unit(a.y) ||
    (a.strength !== undefined && !unit(a.strength))))) throw new Error("Choose valid light positions.");
  if (context.subjectBoxes && (context.subjectBoxes.length > 40000 || context.subjectBoxes.some(b => !Number.isFinite(b.seconds) ||
    b.seconds < 0 || b.seconds > context.duration || !unit(b.x) || !unit(b.y) || !unit(b.width) || !unit(b.height) ||
    b.width <= 0 || b.height <= 0 || b.x + b.width > 1.00001 || b.y + b.height > 1.00001 || !unit(b.confidence)))) {
    throw new Error("The subject accent contains an invalid tracked position.");
  }
  if (context.metrics && Object.values(context.metrics).some(v => v !== undefined && !unit(v))) {
    throw new Error("Choose normalized picture-quality measurements.");
  }
}

function enhancementFilters(mode: VideoEnhancement, context: VisualFinishContext): { filters: string[]; applied: string[] } {
  if (mode === "original") return { filters: [], applied: [] };
  const metrics = context.metrics;
  const noisy = metrics?.noise === undefined ? 0.3 : metrics.noise;
  const highMotion = (metrics?.motion ?? 0) >= 0.6;
  // Stable shot-level decisions plus temporal hqdn3d avoid independently
  // lifting each frame's exposure. None of these modes generates face detail.
  const strength = mode === "clean" ? 0.55 + noisy * 0.35 : mode === "enhanced" ? 0.8 + noisy * 0.6 : 1.1 + noisy * 0.8;
  const temporal = strength * (highMotion ? 1.0 : 1.5);
  const filters = [`hqdn3d=${fixed(strength)}:${fixed(strength)}:${fixed(temporal)}:${fixed(temporal)}`];
  const applied = [mode === "maximum" ? "Bounded stronger temporal cleanup" : "Gentle temporal cleanup"];
  if (mode !== "clean") {
    const sharp = (metrics?.sharpness ?? 0.4) < 0.75 ? (highMotion ? 0.08 : mode === "maximum" ? 0.22 : 0.15) : 0;
    if (sharp) { filters.push(`unsharp=5:5:${fixed(sharp)}:3:3:0`); applied.push("Restrained edge clarity"); }
    if (metrics?.luma !== undefined && metrics.luma < 0.16) {
      filters.push("eq=gamma=1.045:contrast=1.01:saturation=1");
      applied.push("Small, temporally constant low-light lift");
    }
  }
  return { filters, applied };
}

type TimedCue = { seconds: number; strength: number; musical: boolean };
function selectCues(style: EffectStyle, reduced: boolean, context: VisualFinishContext): TimedCue[] {
  if (style === "none" || style === "subtle") return [];
  const gap = reduced ? 2.5 : style === "full-y2k" ? 1.4 : 2;
  const limit = Math.min(24, Math.max(1, Math.ceil(context.duration / gap)));
  const selected: TimedCue[] = [];
  for (const cue of [...(context.cues ?? [])].filter(c => c.confidence >= 0.65 && c.seconds <= context.duration - 0.12).sort((a, b) => a.seconds - b.seconds)) {
    if (selected.length >= limit) break;
    if (selected.length && cue.seconds - selected.at(-1)!.seconds < gap) continue;
    selected.push({ seconds: cue.seconds, strength: cue.strength ?? 0.65, musical: true });
  }
  if (!selected.length && context.duration >= 0.8) {
    selected.push({ seconds: Math.min(0.12, context.duration / 5), strength: 0.65, musical: false });
    if (style === "full-y2k" && context.duration > 5) selected.push({ seconds: context.duration - 1.2, strength: 0.55, musical: false });
  }
  return selected;
}

/** Appendable graph clauses: input/output labels are names WITHOUT brackets.
 * Always preserves input timestamps, frame count and geometry. Generated RGBA
 * accents have bounded durations; overlay never ends or pads the base video. */
export function buildVisualEffects(inputLabel: string, outputLabel: string, width: number, height: number,
  options: VisualFinishOptions, context: VisualFinishContext): VisualFinishPlan {
  validateVisualFinishOptions(options); validateContext(context, width, height);
  const input = label(inputLabel, true), output = label(outputLabel);
  if (input === output) throw new Error("Use separate input and output picture labels.");
  const ns = context.namespace ?? "vfx", style = options.effects ?? "none", mode = options.videoEnhancement ?? "original";
  const reduced = options.reducedFlash !== false, format = context.pixelFormat ?? "yuv420p";
  const filters: string[] = [], applied: string[] = [], warnings: string[] = [];
  const cleanup = enhancementFilters(mode, context);
  const basic = [...cleanup.filters]; applied.push(...cleanup.applied);
  if (style !== "none") {
    basic.push(style === "subtle" ? "eq=contrast=1.01:saturation=1.015" : "eq=contrast=1.025:saturation=1.045");
    applied.push(style === "subtle" ? "Subtle concert-light finish" : "Neon concert color finish");
  }
  let current = `${ns}_base`;
  filters.push(`${input}${basic.length ? basic.join(",") : "null"}[${current}]`);
  if (style !== "none") {
    const opacity = style === "subtle" ? 0.055 : style === "neon-pop" ? 0.095 : 0.135;
    filters.push(`[${current}]format=gbrp,split=2[${ns}_sharp][${ns}_lights]`);
    filters.push(`[${ns}_lights]lutrgb=r='max(val-190,0)*3.9':g='max(val-190,0)*3.9':b='max(val-190,0)*3.9',gblur=sigma=${fixed(Math.max(1, width / 160))}:steps=2[${ns}_glow]`);
    current = `${ns}_bloom`;
    filters.push(`[${ns}_sharp][${ns}_glow]blend=all_mode=screen:all_opacity=${opacity}[${current}]`);
    applied.push("Controlled bloom from the source lights");
  }
  const cues = selectCues(style, reduced, context);
  const musicalCueCount = cues.filter(c => c.musical).length, editorialCueCount = cues.length - musicalCueCount;
  if (editorialCueCount) warnings.push("Music timing was unavailable; opening/ending accents use editorial timing.");
  if (mode !== "original" && !context.metrics) warnings.push("Conservative cleanup used without measured picture-quality metrics.");
  const anchors = context.lightAnchors?.length ? context.lightAnchors : [{ x: 0.15, y: 0.15 }, { x: 0.84, y: 0.23 }, { x: 0.77, y: 0.75 }];
  if (cues.length && !context.lightAnchors?.length) warnings.push("Sparkle positions are decorative edge accents, not detected stage lights.");
  const palette = [[255, 42, 186], [38, 235, 255], [184, 100, 255], [192, 255, 54]];
  const tile = Math.max(24, Math.min(96, Math.round(width / 9 / 2) * 2));
  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index], [r, g, b] = palette[index % palette.length], anchor = anchors[index % anchors.length];
    const endRoom = context.duration - cue.seconds;
    if (endRoom < 0.12) continue;
    const life = Math.min(style === "full-y2k" ? 0.8 : 0.65, endRoom);
    const alpha = (reduced ? 150 : 205) * (0.65 + cue.strength * 0.35) * (anchor.strength ?? 1);
    // An analytic four-point starburst, not a proprietary logo or template.
    const core = "max(exp(-pow((X-W/2)/(W*0.32),2)-pow((Y-H/2)/(H*0.025),2)),exp(-pow((X-W/2)/(W*0.025),2)-pow((Y-H/2)/(H*0.32),2)))";
    const star = `${ns}_star${index}`, layer = `${ns}_layer${index}`;
    filters.push(`color=c=black@0:s=${tile}x${tile}:r=30:d=${fixed(life)},format=rgba,geq=r=${r}:g=${g}:b=${b}:a='${fixed(alpha)}*${core}',format=rgba,fade=t=in:st=0:d=${fixed(Math.min(0.1, life / 4))}:alpha=1,fade=t=out:st=${fixed(life * 0.3)}:d=${fixed(life * 0.7)}:alpha=1,setpts=PTS-STARTPTS+${fixed(cue.seconds)}/TB[${star}]`);
    filters.push(`[${current}][${star}]overlay=x='W*${fixed(anchor.x)}-w/2':y='H*${fixed(anchor.y)}-h/2-${fixed(height * 0.012)}*(t-${fixed(cue.seconds)})':eof_action=pass:repeatlast=0:shortest=0[${layer}]`);
    current = layer;
    if (style === "full-y2k" || index % 2 === 0) {
      const sw = Math.max(48, Math.round(width * 0.38 / 2) * 2), sh = Math.max(24, Math.round(height * 0.06 / 2) * 2);
      const trail = `${ns}_trail${index}`, trailLayer = `${ns}_trailLayer${index}`;
      const trailAlpha = reduced ? 58 : 95;
      // A luminous curved ribbon with a transparent body; sweeps across a
      // peripheral band rather than masking the performer's central frame.
      const arc = `exp(-pow((Y-H/2-H*0.24*sin(PI*X/W))/(H*0.055),2))*sin(PI*X/W)`;
      filters.push(`color=c=black@0:s=${sw}x${sh}:r=30:d=${fixed(life)},format=rgba,geq=r='${r}':g='${g}':b='${b}':a='${trailAlpha}*${arc}',format=rgba,gblur=sigma=1.1,fade=t=in:st=0:d=${fixed(Math.min(0.1, life / 4))}:alpha=1,fade=t=out:st=${fixed(life * 0.55)}:d=${fixed(life * 0.45)}:alpha=1,setpts=PTS-STARTPTS+${fixed(cue.seconds)}/TB[${trail}]`);
      filters.push(`[${current}][${trail}]overlay=x='-w+(W+w)*min(max((t-${fixed(cue.seconds)})/${fixed(life)},0),1)':y='H*${index % 2 ? "0.78" : "0.12"}':eof_action=pass:repeatlast=0:shortest=0[${trailLayer}]`);
      current = trailLayer;
    }
  }
  if (cues.length) applied.push("Timed neon starbursts and curved light trails");
  if (style === "full-y2k" && cues.length) {
    const cue = cues[Math.min(1, cues.length - 1)], life = Math.min(0.95, context.duration - cue.seconds);
    if (life >= 0.2) {
      const s = Math.max(24, Math.round(width * 0.09 / 2) * 2), holo = `${ns}_holo`, next = `${ns}_holoLayer`;
      // Tiny holographic reflective diamond, intentionally at an edge.
      const shape = "if(lt(abs(X-W/2)/(W*0.45)+abs(Y-H/2)/(H*0.45),1),1,0)";
      filters.push(`color=c=black@0:s=${s}x${s}:r=30:d=${fixed(life)},format=rgba,geq=r='150+85*sin(6.28*(X/W+T*0.3))':g='175+70*sin(6.28*(Y/H+T*0.3)+2)':b='200+55*sin(6.28*(X/W+T*0.3)+4)':a='${reduced ? 88 : 125}*${shape}',format=rgba,fade=t=in:st=0:d=0.1:alpha=1,fade=t=out:st=${fixed(life * 0.5)}:d=${fixed(life * 0.5)}:alpha=1,setpts=PTS-STARTPTS+${fixed(cue.seconds)}/TB[${holo}]`);
      filters.push(`[${current}][${holo}]overlay=x='W*0.88-w/2':y='H*0.17-h/2':eof_action=pass:repeatlast=0:shortest=0[${next}]`);
      current = next; applied.push("Brief holographic edge accent");
    }
  }
  if (context.subjectBoxes?.length && style === "full-y2k") {
    warnings.push("Person boxes are available, but silhouette neon outlines require segmentation masks; no false body outline was drawn.");
  }
  filters.push(`[${current}]format=${format},setsar=1${output}`);
  return { filters, applied, warnings, musicalCueCount, editorialCueCount };
}
