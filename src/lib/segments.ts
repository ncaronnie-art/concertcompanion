// src/lib/segments.ts
// STEP A of the Concert Compass 2.0 pivot — SEGMENT-LEVEL MEDIA ANALYSIS.
//
// The shipped reel treats each whole clip as one unit (one loud slice per
// source). This module breaks each clip into candidate MOMENTS/SEGMENTS driven
// by meaningful visual + audio change, scores each on the attribute set from
// the 2.0 Plan (sharpness, stability, exposure, performer visibility, framing,
// visual motion, stage-light change, crowd, audio energy, applause/cheer,
// onset/beat activity, uniqueness), and flags the reject classes the Plan
// calls out (floor/ceiling, extreme shake, prolonged obstruction, badly blurred,
// near-black, blown, duplicate moments, long visually static, redundant same
// composition). A 60s clip that contains one usable 1.8s hero moment should
// produce that moment as a high-scoring, unflagged candidate — not "the whole
// clip".
//
// HONESTY NOTE (mirrored in the Plan): this is a CLIENT-SIDE HEURISTIC analyzer.
// "Performer visibility" and "framing" are luminance/saliency PROXIES derived
// from down-sampled video frames (centre-of-frame saliency, foreground coverage)
// — they are NOT ML person/face detection. Visual flags therefore only fire
// when real per-window visual features are supplied (see sampleVideoFeatures
// below); when a clip is analysed audio-only the visual fields default to
// neutral so the shipped audio-first pipeline never false-rejects.
//
// The module is deliberately pure on the PER-WINDOW feature stream so it runs
// identically in the browser and in a no-browser harness (bun). The harness
// synthesises per-window features that model a shaky intro / near-black stretch
// / blurry section / static ceiling shot / a good hero moment and asserts the
// segmenter flags exactly those parts and ranks the hero highest.

import type { AnalyzedClip, Window } from "./reel";

// ---------------------------------------------------------------------------
// Per-window feature model (the atomic unit consumed by the segmenter)
// ---------------------------------------------------------------------------

export interface SegVisual {
  brightness: number; // mean luma 0 (black) .. 1 (white)
  sharpness: number; // blur estimate — high = sharp
  motion: number; // visual motion magnitude 0..1
  stability: number; // camera stability — high = stable (low frame-to-frame jitter)
  subject: number; // performer visibility / centre saliency proxy 0..1
  framing: number; // 0 wide shot .. 1 tight/close shot
  lightVar: number; // stage-light change / flash variance 0..1
  crowd: number; // crowd visibility (texture richness) 0..1
}

/** A fully-materialised feature window for ONE analysis step. Audio fields come
 * straight from the shipped reel Window; visual fields are optional and default
 * to neutral when absent (so audio-only clips still segment + score). */
export interface SegWindow extends SegVisual {
  t: number; // start time (seconds into the clip)
  // audio (0..1 unless noted)
  rms: number;
  energy: number;
  onset: number; // normalised positive energy rise (beat/onset activity)
  vocal: number;
  beatLock: number;
  centroid: number; // 0..1 spectral centroid
}

export const NEUTRAL_VISUAL: SegVisual = {
  brightness: 0.5,
  sharpness: 0.6,
  motion: 0.3,
  stability: 0.7,
  subject: 0.5,
  framing: 0.5,
  lightVar: 0.2,
  crowd: 0.5,
};

/** Convert a shipped reel Window + (optional) visual vector into a SegWindow. */
export function toSegWindow(w: Window, vis?: Partial<SegVisual>): SegWindow {
  const v: SegVisual = { ...NEUTRAL_VISUAL, ...(vis ?? {}) };
  return {
    t: w.start,
    rms: w.rms,
    energy: w.energy,
    onset: w.onset ?? 0,
    vocal: w.vocal,
    beatLock: w.beatLock,
    centroid: w.centroid ?? 0,
    ...v,
  };
}

/** Build a full SegWindow stream from a shipped AnalyzedClip, binding a per-window
 * visual vector (default: neutral visuals for the audio-first pipeline). */
export function segWindowsFromClip(
  clip: AnalyzedClip,
  visuals?: SegVisual[]
): SegWindow[] {
  return clip.windows.map((w, i) => toSegWindow(w, visuals?.[i]));
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** Per-segment 0..1 attribute scores (the "metadata" columns from the Plan). */
export interface SegmentAttributes {
  sharpness: number;
  stability: number;
  exposure: number;
  performer: number; // performer visibility
  framing: number; // 0 wide .. 1 close
  visualMotion: number;
  lightChange: number; // stage-light change
  crowd: number;
  audioEnergy: number;
  applause: number; // applause/cheer intensity
  onsetBeat: number; // musical onset / beat activity
  uniqueness: number; // 1 = unique vs other footage, low = redundant/duplicate
}

/** Boolean / penalty flags for the reject classes the Plan calls out. */
export interface RejectFlags {
  floorCeiling: boolean; // accidental floor/ceiling
  extremeShake: boolean; // extreme camera shake
  obstruction: boolean; // prolonged obstruction
  badlyBlurred: boolean; // badly blurred
  nearBlack: boolean; // near-black footage
  blown: boolean; // blown-out / overexposed
  longStatic: boolean; // long visually static recording
  redundantComposition: boolean; // redundant shot of the SAME composition (within a clip)
  duplicate: boolean; // near-duplicate MOMENT across other footage (step-D pass)
}

export interface SegmentAnalysis {
  id: string;
  clipId: number;
  clipName?: string;
  start: number; // seconds
  end: number; // seconds
  duration: number;
  winRange: [number, number]; // [first,last] window index for debugging/UIs
  attrs: SegmentAttributes;
  flags: RejectFlags;
  highlightScore: number; // overall highlight score 0..1
  fingerprint: number[]; // compact feature vector for cross-clip duplicate detection
  // EDV fields are filled by STEP B (selection) — the shape exists now.
  reasonSelected?: string;
  crop?: string; // reframe directive, e.g. "center:0.46-0.75 | subject:x center"
  transition?: string; // e.g. "hard_cut" (Plan: hard cut is the default)
  audioBehavior?: string; // e.g. "keep_source" | "mute | bed_x"
}

export interface AnalyzeSegmentsOptions {
  /** min candidate segment length, seconds (default 1.2) */
  minDur?: number;
  /** max candidate segment length, seconds (default 6.0) */
  maxDur?: number;
  /** cross-clip similarity at/above which a segment is a duplicate (0..1, default 0.90) */
  duplicateSim?: number;
}

// ---------------------------------------------------------------------------
// Small stat helpers
// ---------------------------------------------------------------------------

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function movAvg(a: number[], k: number): number[] {
  const n = a.length;
  const out = new Array(n).fill(0);
  if (k <= 1) return a.slice();
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - k);
    const hi = Math.min(n - 1, i + k);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += a[j];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Change-driven segmentation (cover the whole clip in candidate moments)
// ---------------------------------------------------------------------------

const SEG_DEFAULT_MIN = 1.2;
const SEG_DEFAULT_MAX = 6.0;

/** Per-window "novelty" = how much meaningful multi-modal change happened here.
 * Drives where candidate boundaries go: cuts land on real visual/audio change so
 * a long clip is decomposed into moments, not one flat unit. */
function novelty(wins: SegWindow[]): number[] {
  const n = wins.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const p = wins[Math.max(0, i - 1)];
    const c = wins[i];
    const dE = Math.abs(c.energy - p.energy);
    const dOn = Math.abs(c.onset - p.onset);
    const dL = Math.abs(c.brightness - p.brightness);
    const dM = Math.abs(c.motion - p.motion);
    const dS = Math.abs(c.subject - p.subject);
    const dB = Math.abs(c.beatLock - p.beatLock);
    const dLj = Math.abs(c.lightVar - p.lightVar);
    // novelty = how much is CHANGING here, NOT the absolute level — a uniform
    // but loud/on-beat hero stays cohesive (its beat activity is scored later),
    // whereas the boundaries between shots of different kind fire high.
    const val =
      0.4 * dE +
      0.3 * dOn +
      0.32 * dL +
      0.3 * dM +
      0.24 * dS +
      0.2 * dB +
      0.28 * dLj;
    out[i] = clamp01(val);
  }
  return movAvg(out, 1);
}

function meanAndSd(a: number[]): [number, number] {
  const m = mean(a);
  const sd = Math.sqrt(mean(a.map((v) => (v - m) * (v - m))));
  return [m, sd];
}

/** Produce [startIdx, endIdx] spans covering the whole window stream, split at
 * the strongest change points (adaptive threshold, min separation) with
 * sub-max splits and sub-min merges so every moment is a usable candidate. */
export function segmentBoundaries(wins: SegWindow[], minDur: number, maxDur: number): [number, number][] {
  const n = wins.length;
  if (n === 0) return [];
  const dt = n > 1 ? Math.max(0.001, wins[1].t - wins[0].t) : 0.1;
  const minW = Math.max(1, Math.round(minDur / dt));
  const maxW = Math.max(minW + 1, Math.round(maxDur / dt));

  const nov = novelty(wins);
  const [nm, nsd] = meanAndSd(nov);
  const thr = Math.max(0.06, nm + 0.5 * nsd); // adaptive change bar

  // strong change points = local maxima above the bar, min separation
  const sep = Math.max(minW, Math.round(1.2 / dt));
  const pts: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (nov[i] > thr && nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1]) {
      const last = pts.length ? pts[pts.length - 1] : -Infinity;
      if (i - last >= sep) pts.push(i);
    }
  }

  // SECONDARY boundary signal: a large jump in ANY single dominant dimension.
  // Cuts should also land where a shot's KIND changes (blurry→static ceiling,
  // dark hallway→lit stage, subject disappears) even if the composite novelty
  // stays moderate — otherwise two qualitatively different bad shots merge and
  // can't each be flagged. Require a genuine class change (one side clearly low).
  const JUMP = {
    sharpness: 0.3,
    subject: 0.3,
    brightness: 0.25,
    motion: 0.35,
    energy: 0.4,
    lightVar: 0.4,
  };
  for (let i = 1; i < n; i++) {
    const a = wins[i - 1];
    const b = wins[i];
    let jump = false;
    if (Math.abs(b.sharpness - a.sharpness) > JUMP.sharpness && (a.sharpness < 0.4 || b.sharpness < 0.4)) jump = true;
    if (!jump && Math.abs(b.subject - a.subject) > JUMP.subject && (a.subject < 0.35 || b.subject < 0.35)) jump = true;
    if (!jump && Math.abs(b.brightness - a.brightness) > JUMP.brightness) jump = true;
    if (!jump && Math.abs(b.motion - a.motion) > JUMP.motion) jump = true;
    if (!jump && Math.abs(b.energy - a.energy) > JUMP.energy) jump = true;
    if (!jump && Math.abs(b.lightVar - a.lightVar) > JUMP.lightVar) jump = true;
    if (jump) {
      const last = pts.length ? pts[pts.length - 1] : -Infinity;
      if (i - last >= Math.max(2, Math.round(0.8 / dt))) pts.push(i);
    }
  }
  pts.push(0, n - 1);
  pts.sort((a, b) => a - b);
  // dedupe
  const uniq: number[] = [];
  for (const p of pts) if (uniq[uniq.length - 1] !== p) uniq.push(p);
  pts.length = 0;
  pts.push(...uniq);

  // enforce max duration: split long spans at their highest-novelty interior pt
  let spans: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) spans.push([pts[i], pts[i + 1]]);
  let changed = true;
  while (changed) {
    changed = false;
    const next: [number, number][] = [];
    for (const [a, b] of spans) {
      const wspan = b - a; // inclusive count
      if (wspan + 1 > maxW) {
        // find max novelty inside (a,b) to split on
        let bi = -1;
        let bv = -Infinity;
        for (let i = a + 1; i < b; i++) {
          if (nov[i] > bv) {
            bv = nov[i];
            bi = i;
          }
        }
        if (bi > a && bi < b) {
          next.push([a, bi]);
          next.push([bi + 1, b]);
          changed = true;
          continue;
        }
      }
      next.push([a, b]);
    }
    spans = next;
  }

  // merge spans shorter than min (fewer than minW windows wide)
  let merged = true;
  while (merged && spans.length > 1) {
    merged = false;
    for (let i = 0; i < spans.length; i++) {
      const [a, b] = spans[i];
      if (b - a + 1 < minW) {
        // merge into the weaker neighbour (whichever keeps both >= min best)
        if (i < spans.length - 1) {
          spans[i + 1] = [a, spans[i + 1][1]];
        } else {
          spans[i - 1] = [spans[i - 1][0], b];
        }
        spans.splice(i, 1);
        merged = true;
        break;
      }
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Flag decision thresholds (heuristic — why per-flag, see analyseSegment)
// ---------------------------------------------------------------------------

export const FLAG_THRESHOLDS = {
  nearBlackBright: 0.08, // mean luma below this → near-black
  nearBlackFrac: 0.5, // ...or this fraction of windows below 0.06
  blownBright: 0.97,
  blurMean: 0.35, // mean sharpness below → badly blurred
  blurFrac: 0.6, // ...or this fraction below 0.3
  shakeStable: 0.32, // mean stability below → extreme shake
  floorCeilingSubject: 0.28, // subject below this + static + mid luma → floor/ceiling
  floorCeilingMotion: 0.22,
  obstructionSubject: 0.22, // mean subject below → prolonged obstruction
  obstructionFrac: 0.7,
  staticMotion: 0.12, // mean motion below + stable → long static
  staticStable: 0.5,
  staticFrac: 0.6, // fraction of windows this static
  duplicateSim: 0.9, // cross-clip fingerprint similarity → duplicate
};

// Reject-penalty multipliers folded into highlightScore (hard visual rejects
// crush the score; moderate issues damp it).
const PENALTY_HARD = 0.1; // any hard visual reject flag
const PENALTY_LONGSTATIC = 0.3;
const PENALTY_REDUNDANT = 0.35;
const PENALTY_DUPLICATE = 0.3;
const PENALTY_BLOWN = 0.45;

// ---------------------------------------------------------------------------
// Per-segment scoring
// ---------------------------------------------------------------------------

export function segmentFingerprint(wins: SegWindow[]): number[] {
  const a = mean(wins.map((w) => w.brightness));
  const sh = mean(wins.map((w) => w.sharpness));
  const mo = mean(wins.map((w) => w.motion));
  const su = mean(wins.map((w) => w.subject));
  const fr = mean(wins.map((w) => w.framing));
  const en = mean(wins.map((w) => w.energy));
  const on = mean(wins.map((w) => w.onset));
  const lv = mean(wins.map((w) => w.lightVar));
  const vf = [a, sh, mo, su, fr, en, on, lv, 0.5, 0.5];
  // keep per-clip identity out of the raw vector? No — we WANT near-identical
  // shots across clips to collide. L2-normalise so cosine compares shape.
  const norm = Math.sqrt(vf.reduce((s, x) => s + x * x, 0)) || 1;
  return vf.map((x) => x / norm);
}

/** Core attribute scoring for one candidate span. Pure + deterministic: given the
 * same windows it always yields the same flags/scores, so the harness can pin it. */
export function analyseSegment(
  wins: SegWindow[],
  clipId: number,
  opts: AnalyzeSegmentsOptions = {}
): SegmentAnalysis {
  const minDur = opts.minDur ?? SEG_DEFAULT_MIN;
  const n = wins.length;
  const start = wins[0].t;
  const rawEnd = wins[n - 1].t + (n > 1 ? Math.max(0.001, wins[1].t - wins[0].t) : 0.1);
  const end = Math.max(start + minDur, rawEnd);
  const duration = end - start;

  // --- aggregate raw fields ---
  const bright = mean(wins.map((w) => w.brightness));
  const sharp = mean(wins.map((w) => w.sharpness));
  const motion = mean(wins.map((w) => w.motion));
  const stable = mean(wins.map((w) => w.stability));
  const subject = mean(wins.map((w) => w.subject));
  const framing = mean(wins.map((w) => w.framing));
  const lightVar = mean(wins.map((w) => w.lightVar));
  const crowd = mean(wins.map((w) => w.crowd));
  const energy = mean(wins.map((w) => w.energy));
  const onset = mean(wins.map((w) => w.onset));
  const beat = mean(wins.map((w) => w.beatLock));
  const vocal = mean(wins.map((w) => w.vocal));
  const peakEnergy = Math.max(...wins.map((w) => w.energy), 0);

  // --- threshold-derived attribute scores (0..1) ---
  // exposure: triangle around a healthy ~0.55 mid-luma; near-black/below and
  // blown/bright both fall toward 0.
  const exposure = clamp01(1 - Math.abs(bright - 0.55) / 0.45);

  // applause/cheer = sustained broadband energy: loud (energy), not tonal (low
  // vocal), no steady pulse (low beatLock), and steady over time (low rel. MAD).
  const enM = mean(wins.map((w) => w.energy));
  const mad = mean(wins.map((w) => Math.abs(w.energy - enM))) || 1e-6;
  const sustained = clamp01(1 - (mad / (enM + 1e-6)) * 4);
  const applause = clamp01(energy * (1 - vocal) * (1 - 0.5 * beat) * (0.4 + 0.6 * sustained));

  const onsetBeat = clamp01(0.5 * onset + 0.3 * beat + 0.2 * peakEnergy);

  const flags: RejectFlags = {
    floorCeiling: false,
    extremeShake: false,
    obstruction: false,
    badlyBlurred: false,
    nearBlack: false,
    blown: false,
    longStatic: false,
    redundantComposition: false,
    duplicate: false,
  };

  // --- decision logic (why each threshold — see comments) ---
  // near-black: mean luma collapsed, OR > half the windows are essentially black
  flags.nearBlack =
    bright < FLAG_THRESHOLDS.nearBlackBright ||
    wins.filter((w) => w.brightness < 0.06).length / n > FLAG_THRESHOLDS.nearBlackFrac;
  // blown: mean luma pegged high or most windows pegged high
  flags.blown =
    bright > FLAG_THRESHOLDS.blownBright ||
    wins.filter((w) => w.brightness > 0.97).length / n > FLAG_THRESHOLDS.nearBlackFrac;
  // badly blurred: low mean sharpness or a long run of low sharpness
  flags.badlyBlurred =
    sharp < FLAG_THRESHOLDS.blurMean ||
    wins.filter((w) => w.sharpness < 0.3).length / n > FLAG_THRESHOLDS.blurFrac;
  // extreme shake: mean stability collapsed (low stability = high jitter)
  flags.extremeShake = stable < FLAG_THRESHOLDS.shakeStable;
  // floor/ceiling: a featureless, static, mid-exposure frame with no subject —
  // the classic accidental phone-pointed-at-floor/ceiling signature.
  flags.floorCeiling =
    subject < FLAG_THRESHOLDS.floorCeilingSubject &&
    motion < FLAG_THRESHOLDS.floorCeilingMotion &&
    bright > 0.12 &&
    bright < 0.88 &&
    stable > 0.3;
  // prolonged obstruction: subject basically absent (>70% of the windows) —
  // someone's back / a hand / a pole in front for the whole moment.
  flags.obstruction = wins.filter((w) => w.subject < 0.2).length / n > FLAG_THRESHOLDS.obstructionFrac;
  // long static: little visual motion AND the camera is stable (a locked-off
  // tripod recording nothing moving) for most of the segment.
  const staticFrac =
    wins.filter((w) => w.motion < FLAG_THRESHOLDS.staticMotion).length / n;
  flags.longStatic =
    motion < FLAG_THRESHOLDS.staticMotion && stable > FLAG_THRESHOLDS.staticStable && staticFrac > FLAG_THRESHOLDS.staticFrac;

  const attrs: SegmentAttributes = {
    sharpness: clamp01(sharp),
    stability: clamp01(stable),
    exposure,
    performer: clamp01(subject),
    framing: clamp01(framing),
    visualMotion: clamp01(motion),
    lightChange: clamp01(lightVar),
    crowd: clamp01(crowd),
    audioEnergy: clamp01(energy),
    applause,
    onsetBeat,
    uniqueness: 1, // filled by the cross-clip pass
  };

  // --- overall highlight score: weighted sum, then reject penalised ---
  // Weights deliberately rank "what a human editor sees": sharp + stable +
  // performer-visible moments carry the most. Audio energy/beat are real but
  // weighted so flat-crowd loudness alone can't win.
  let score =
    attrs.sharpness * 0.16 +
    attrs.stability * 0.14 +
    attrs.exposure * 0.1 +
    attrs.performer * 0.2 +
    attrs.framing * 0.04 +
    attrs.visualMotion * 0.08 +
    attrs.lightChange * 0.05 +
    attrs.crowd * 0.05 +
    attrs.audioEnergy * 0.08 +
    attrs.onsetBeat * 0.07 +
    attrs.applause * 0.03;
  score *= attrs.uniqueness;

  const hardReject =
    flags.floorCeiling ||
    flags.extremeShake ||
    flags.obstruction ||
    flags.badlyBlurred ||
    flags.nearBlack;
  if (hardReject) score *= PENALTY_HARD;
  if (flags.blown) score *= PENALTY_BLOWN;
  if (flags.longStatic) score *= PENALTY_LONGSTATIC;
  if (flags.redundantComposition) score *= PENALTY_REDUNDANT;
  if (flags.duplicate) score *= PENALTY_DUPLICATE;
  score = clamp01(score);

  const id = `s${clipId}-${Math.round(start * 10)}`;

  return {
    id,
    clipId,
    start,
    end,
    duration,
    winRange: [0, wins.length - 1],
    attrs,
    flags,
    highlightScore: score,
    fingerprint: segmentFingerprint(wins),
  };
}

// ---------------------------------------------------------------------------
// Top-level: analyze a whole clip into candidate segments
// ---------------------------------------------------------------------------

export interface ClipSegmentResult {
  clipId: number;
  clipName?: string;
  duration: number;
  segments: SegmentAnalysis[];
}

/** Break one clip's per-window stream into scored, flagged candidates. */
export function analyzeSegments(
  wins: SegWindow[],
  clipId: number,
  clipName?: string,
  opts: AnalyzeSegmentsOptions = {}
): ClipSegmentResult {
  const n = wins.length;
  const duration = n > 0 ? wins[n - 1].t + 0.1 : 0;
  if (n === 0) return { clipId, clipName, duration: 0, segments: [] };
  const minDur = opts.minDur ?? SEG_DEFAULT_MIN;
  const maxDur = opts.maxDur ?? SEG_DEFAULT_MAX;
  const spans = segmentBoundaries(wins, minDur, maxDur);
  const segments: SegmentAnalysis[] = spans.map(([a, b]) => {
    const seg = analyseSegment(wins.slice(a, b + 1), clipId, opts);
    seg.winRange = [a, b];
    seg.clipName = clipName;
    return seg;
  });
  return { clipId, clipName, duration, segments };
}

/**
 * STEP-D support (duplicate / redundant detection across the set).
 * Assigns `attrs.uniqueness` and the duplicate/redundant flags for every
 * segment given ALL clips' analyses, marking:
 *   * `duplicate` — a segment that is near-identical (by fingerprint) to a
 *     segment in ANOTHER clip (same moment re-shot), keeping the higher-scoring
 *     one as the "original".
 *   * `redundantComposition` — repeated near-identical SHOTS within the SAME
 *     clip (same framing + subject + luma), penalised so a reel doesn't stack
 *     "the same composition" twice.
 * Call once after all clips are analysed; leaves per-clip scores untouched
 * otherwise (it only fills uniqueness + these two flags, which the per-clip
 * pass left false).
 */
export function computeGlobalUniqueness(
  clipResults: ClipSegmentResult[],
  opts: AnalyzeSegmentsOptions = {}
): void {
  const dupSim = opts.duplicateSim ?? FLAG_THRESHOLDS.duplicateSim;
  const all: { r: ClipSegmentResult; s: SegmentAnalysis }[] = [];
  for (const r of clipResults) for (const s of r.segments) all.push({ r, s });

  // initialize uniqueness at 1 for every segment
  for (const e of all) {
    e.s.attrs.uniqueness = 1;
    e.s.flags.duplicate = false;
    e.s.flags.redundantComposition = false;
  }

  // redundant composition WITHIN a clip: near-identical framing+subject+luma
  // to an EARLIER segment of the SAME clip.
  for (const r of clipResults) {
    for (let i = 0; i < r.segments.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = r.segments[j];
        const b = r.segments[i];
        const framingSim = 1 - Math.abs(a.attrs.framing - b.attrs.framing);
        const subjectSim = 1 - Math.abs(a.attrs.performer - b.attrs.performer);
        const lightSim = 1 - Math.abs(a.attrs.lightChange - b.attrs.lightChange);
        if (framingSim > 0.82 && subjectSim > 0.82 && lightSim > 0.8) {
          b.flags.redundantComposition = true;
        }
      }
    }
  }

  // duplicate MOMENT across clips: fingerprint near-collision with a DIFFERENT
  // clip. The lower-scoring one is flagged; uniqueness decays with similarity.
  const cross: { e: (typeof all)[number]; used: boolean }[] = all.map((e) => ({ e, used: false }));
  for (let i = 0; i < cross.length; i++) {
    for (let j = i + 1; j < cross.length; j++) {
      const A = cross[i].e;
      const B = cross[j].e;
      if (A.s.clipId === B.s.clipId) continue; // handled by redundant-above
      const sim = cosine(A.s.fingerprint, B.s.fingerprint);
      if (sim >= dupSim) {
        // keep the higher-scoring one; flag the lower
        const loser = A.s.highlightScore <= B.s.highlightScore ? A.s : B.s;
        loser.flags.duplicate = true;
        loser.attrs.uniqueness = Math.min(loser.attrs.uniqueness, 1 - clamp01((sim - 0.7) / 0.3));
      } else {
        const uniq = 1 - clamp01((sim - 0.5) / 0.4);
        A.s.attrs.uniqueness = Math.min(A.s.attrs.uniqueness, uniq);
        B.s.attrs.uniqueness = Math.min(B.s.attrs.uniqueness, uniq);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Edit Decision List (EDV) — the Plan's intermediate render contract
// ---------------------------------------------------------------------------

/** A row of the editable edit decision list the Plan specifies. STEP B fills
 * these (selection + pacing + reframing + transitions); the shape exists now so
 * a later renderer can be written against it without reanalysis. */
export interface EditDecision {
  segmentId: string;
  sourceFile: string; // source_file
  clipId: number;
  startTime: number; // start_time (s)
  endTime: number; // end_time (s)
  duration: number; // end - start
  score: number; // overall highlight score used for ranking
  reasonSelected: string; // human/step-B reason: e.g. "hero:sharp+stable+performer"
  crop?: string; // crop/reframe directive
  transition: string; // "hard_cut" default per Plan Phase 6
  audioBehavior: string; // "keep_source" | "mute" | "bed:clip3"
  locked?: boolean; // STEP D — user locked this slot
  flags: RejectFlags; // why it might be swapped out on regenerate
}

/** Build an editable EDV from analyses + a set of chosen segments (STEP B will
 * drive this; today it defaults every chosen segment to hard-cut / keep-source
 * so the shape is complete and serialisable). */
export function buildEditDecisionList(
  allClips: ClipSegmentResult[],
  chosen: SegmentAnalysis[],
  opts: { defaultTransition?: string; defaultAudio?: string } = {}
): EditDecision[] {
  const defTrans = opts.defaultTransition ?? "hard_cut";
  const defAudio = opts.defaultAudio ?? "keep_source";
  const fileMap = new Map<number, string>();
  for (const r of allClips) fileMap.set(r.clipId, r.clipName ?? "");
  return chosen.map((s, i) => ({
    segmentId: s.id,
    sourceFile: s.clipName ?? fileMap.get(s.clipId) ?? "",
    clipId: s.clipId,
    startTime: s.start,
    endTime: s.end,
    duration: s.duration,
    score: s.highlightScore,
    reasonSelected: reasonForSegment(s),
    crop: s.crop,
    transition: s.transition ?? defTrans,
    audioBehavior: s.audioBehavior ?? defAudio,
    locked: false,
    flags: s.flags,
    // keep an index hint for ordering (STEP D reorder)
    ...{ _order: i },
  }));
}

/** Build a human-readable reason for a segment (used to pre-fill EDV rows and
 * for debugging "why did it pick this"). */
export function reasonForSegment(s: SegmentAnalysis): string {
  const a = s.attrs;
  const parts: string[] = [];
  if (a.performer >= 0.6) parts.push("performer");
  if (a.stability >= 0.6) parts.push("stable");
  if (a.sharpness >= 0.6) parts.push("sharp");
  if (a.exposure >= 0.7) parts.push("exposed");
  if (a.onsetBeat >= 0.6) parts.push("on-beat");
  if (a.applause >= 0.5) parts.push("applause");
  if (a.lightChange >= 0.5) parts.push("lighting");
  if (a.crowd >= 0.6) parts.push("crowd");
  if (parts.length === 0) parts.push("moderate");
  const flagged = Object.entries(s.flags)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return flagged.length ? `${parts.join("+")} (reject:${flagged.join(",")})` : parts.join("+");
}

// ---------------------------------------------------------------------------
// Optional browser visual sampler (video -> per-window SegVisual)
// ---------------------------------------------------------------------------
// This decodes frames in the browser with a hidden <video> + small canvas, so a
// clip's real visual features can feed the same attributes above. It is bounded
// (a stride caps how many times we seek/render, so a 10-min upload won't freeze
// the tab) and returns null for anything it can't render. Visual flags in the
// shipped audio-first pipeline stay neutral until this is wired into the live
// analyze loop — see the honesty note at the top and the STEP-A report.
//
// WHY NOT wired into the live analyze loop yet: it needs a real user-triggered
// decode (headless can't e2e it), it's the heavy part of STEP A's "visual"
// half, and STEP E (server render / object storage) is an open owner decision
// that may move this server-side anyway. The pure scorer is complete and
// harness-verified now; this sampler is exported so the browser path can be
// completed without touching the scorer.

export interface VisualSampleOptions {
  /** seconds between sample frames (default 0.5 — ~2 fps, plenty for blur/motion) */
  sampleInterval?: number;
  /** hard cap on frames drawn (default 600 → a 5-min clip at 0.5s stride stays under) */
  maxFrames?: number;
  /** thumbnail size (default 64) */
  size?: number;
}

/**
 * Sample visual features from a playable media element (or file URL).
 * Returns an array aligned to the clip's 0.1s windows (each window copies the
 * nearest sampled frame) or null on failure. Uses currentTime-seeking + a tiny
 * canvas; strictly bounded by maxFrames.
 */
export async function sampleVideoVisualFeatures(
  element: HTMLVideoElement | HTMLAudioElement | string,
  duration: number,
  opts: VisualSampleOptions = {}
): Promise<SegVisual[] | null> {
  const size = opts.size ?? 64;
  const sampleInterval = opts.sampleInterval ?? 0.5;
  const maxFrames = opts.maxFrames ?? 600;

  let el: HTMLVideoElement;
  if (typeof element === "string") {
    const v = document.createElement("video");
    v.src = element;
    v.muted = true;
    el = v;
  } else {
    el = element as HTMLVideoElement;
  }
  if (typeof el.videoWidth !== "number" || el.videoWidth === 0) {
    // wait for metadata briefly
    try {
      await new Promise<void>((res, rej) => {
        const done = () => res();
        el.onloadedmetadata = done;
        el.onerror = () => rej();
        setTimeout(() => rej(), 4000);
      });
    } catch {
      return null;
    }
  }
  if (!el.videoWidth || !el.videoHeight) return null;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = Math.max(1, Math.round((size * el.videoHeight) / el.videoWidth));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const C = canvas.width * canvas.height;

  const dt = Math.max(sampleInterval, 0.1, duration / maxFrames);
  const times: number[] = [];
  for (let t = 0; t <= duration - 0.001; t += dt) times.push(t);

  const frames: { b: number; sharp: number; frame: Uint8ClampedArray | null }[] = [];
  let prev: Uint8ClampedArray | null = null;

  for (const t of times) {
    try {
      el.currentTime = t;
      await new Promise<void>((resolve, reject) => {
        el.onseeked = () => resolve();
        el.onerror = () => reject();
        setTimeout(() => reject(), 2000);
      });
    } catch {
      break;
    }
    try {
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    } catch {
      break;
    }
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    let sum = 0;
    let grad = 0;
    let cnt = 0;
    const yArr = new Float32Array(C);
    for (let i = 0; i < C; i++) {
      const y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      yArr[i] = y;
      sum += y;
    }
    const b = sum / C / 255;
    // sharpness = mean |laplacian| (high on edges) — blurry images have low grad
    for (let yy = 1; yy < canvas.height - 1; yy++) {
      for (let xx = 1; xx < canvas.width - 1; xx++) {
        const i = yy * canvas.width + xx;
        const lap =
          -4 * yArr[i] +
          yArr[i - 1] +
          yArr[i + 1] +
          yArr[i - canvas.width] +
          yArr[i + canvas.width];
        grad += Math.abs(lap);
        cnt++;
      }
    }
    const sharp = clamp01((grad / Math.max(1, cnt) / 4) / 255 * 12);
    frames.push({ b, sharp, frame: new Uint8ClampedArray(d) });
    prev = d;
  }
  if (frames.length === 0) return null;

  // Derive the per-window surrogate features from consecutive sampled frames.
  const out: SegVisual[] = [];
  const nWin = Math.max(1, Math.round(duration / 0.1));
  for (let w = 0; w < nWin; w++) {
    const wallT = w * 0.1;
    // nearest sample index
    let si = Math.round(wallT / dt);
    si = Math.max(0, Math.min(frames.length - 1, si));
    const cur = frames[si];
    // motion: mean absolute diff vs the previous sample
    let motion = 0;
    if (si > 0 && cur.frame && frames[si - 1].frame && cur.frame.length === frames[si - 1].frame!.length) {
      const a = cur.frame;
      const bf = frames[si - 1].frame!;
      let s = 0;
      for (let i = 0; i < a.length; i += 40) s += Math.abs(a[i] - bf[i]);
      motion = clamp01((s / Math.ceil(a.length / 40) / 255) * 8);
    }
    // stability = inverse of frame-to-frame jitter; use low motion + smooth
    const stability = clamp01(1 - motion * 1.6);
    // subject proxy: centre-of-frame saliency (performers usually centre) —
    // fraction of central-luma energy vs the border.
    let centre = 0;
    let border = 0;
    let cc = 0;
    let bc = 0;
    const cw2 = Math.floor(canvas.width / 2);
    const ch2 = Math.floor(canvas.height / 2);
    for (let yy = 0; yy < canvas.height; yy++) {
      for (let xx = 0; xx < canvas.width; xx++) {
        const i = yy * canvas.width + xx;
        const lum = cur.frame![i * 4] / 255;
        const dx = xx - cw2;
        const dy = yy - ch2;
        if (dx * dx + dy * dy < (canvas.width / 4) ** 2) {
          centre += lum;
          cc++;
        } else {
          border += lum;
          bc++;
        }
      }
    }
    const subject = cc && bc ? clamp01((centre / cc) / (border / bc)) : 0.5;
    // framing proxy: fraction of bright/foreground pixels (tight shot = more
    // bright pixels dominate the frame).
    let brightPx = 0;
    for (let i = 0; i < C; i++) if (cur.frame![i * 4] > 140) brightPx++;
    const framing = clamp01((brightPx / C) * 3);
    // crowd proxy: local high-frequency texture richness (many small varying
    // specks) — approximated by the sharpness value when there are no big edges.
    const crowd = clamp01(sharp * 1.5);
    // lightVar: rolling variance of brightness around this window (stage flashes)
    let lvSum = 0;
    let lvN = 0;
    for (let k = Math.max(0, si - 3); k <= Math.min(frames.length - 1, si + 3); k++) {
      lvSum += Math.abs(frames[k].b - cur.b);
      lvN++;
    }
    const lightVar = lvN ? clamp01((lvSum / lvN) * 12) : 0;

    out.push({ brightness: b, sharpness: sharp, motion, stability, subject, framing, lightVar, crowd });
    void wallT;
  }
  return out;
}
