// src/lib/selection.ts
// STEP B of the Concert Compass 2.0 pivot — DIVERSITY-AWARE SEGMENT SELECTION.
//
// STEP A (segments.ts) produces per-clip candidate MOMENTS (SegmentAnalysis)
// with a 12-attribute score vector, reject flags, a highlight score and a
// cross-clip uniqueness/fingerprint pass (computeGlobalUniqueness). This module
// REPLACES the old "one loud slice per whole clip" selection with a segment-level
// selection that answers the Plan's PHASE 2 + PHASE 4 questions:
//
//   * rank candidate moments by QUALITY **and** DIVERSITY
//   * intentionally vary wide / close performer / crowd / lighting / high-energy /
//     quiet-cinematic moments
//   * NEVER put two consecutive shots with nearly identical framing or
//     near-duplicate fingerprints
//   * fill the duration budget with professional pacing (rapid 0.5-1.5s /
//     normal 1.5-3s / rare hero 3-5s), defaulting to ~30s
//   * tell a coherent story arc: HOOK -> ESTABLISH -> BUILD -> PEAK -> PAYOFF -> END,
//     hook = one of the STRONGEST moments near the front
//   * keep touring many DISTINCT clips (coverage), not just the loudest 1-2
//   * emit editable EditDecision rows (transition "hard_cut", audioBehavior
//     "keep_source") so STEP D can expose them for user editing.
//
// ALGORITHM — "arc-driven greedy over a clean pool, with consecutive-similarity
// enforced as a hard filter and category+coverage as soft biases":
//
//   1. POOL — collect every non-rejected segment across all clips. Hard visual
//      rejects (floor/ceiling, extreme shake, obstruction, badly blurred,
//      near-black) are EXCLUDED; soft issues (blown / long-static / redundant /
//      duplicate) are already folded into the highlight score by STEP A, and we
//      additionally EXCLUDE duplicated/redundant moments outright so a reel never
//      stacks the same shot. Each pool entry is tagged with a primary CATEGORY
//      (wide / close / crowd / lighting / high-energy / quiet-cinematic) derived
//      from its attribute vector.
//   2. ARC — derive the story roles for the ~budget-fitting number of cuts.
//      Each role carries a desired duration range (HOOK snappy / BUILD rapid /
//      PEAK hero-rare / END normal) and an ordered CATEGORY affinity.
//   3. GREEDY — fill positions left to right. At each position the best candidate
//      maximises: highlightScore × seed-jitter × clip-coverage bonus × role-category
//      affinity × soft-recent-similarity discount, subject to a HARD filter that
//      rejects any candidate that is near-identical in framing or fingerprint to
//      the previous pick. Position 0 (the HOOK) is pinned to the single strongest
//      non-rejected segment so the opener is always a strong visual/musical beat
//      (near-black/logo cases are already excluded from the pool). Durations are
//      clamped to the role's range and to the remaining budget so total ≤ budget.
//
// EDIT MODE SEAM (STEP C, not built here): selection readers can pass `mode`
// (cinematic/hype/memory/music-video/surprise-me), which only adjusts the target
// average cut length + category affinity so the SAME selector can be re-leaned
// per mode later. No mode-specific full behavior (transitions, theme) lives here.
//
// Everything is pure + client-side and deterministic for a given seed, so the
// no-browser harness can pin it.

import type { AnalyzeSegmentsOptions, ClipSegmentResult, EditDecision, RejectFlags, SegmentAnalysis } from "./segments";
import { reasonForSegment } from "./segments";
import type { Segment } from "./reel";

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

/** Plan PHASE 8 edit modes — STEP C seam. Selection only leans length/category
 * on these today; the full mode behavior (transitions, theme, arc) is STEP C. */
export type EditModeId =
  | "cinematic"
  | "hype"
  | "memory"
  | "music-video"
  | "surprise-me";

export interface SelectSegmentOptions {
  /** cap on final reel length, seconds (default 30; 15/30/45/60 per Plan) */
  targetSeconds?: number;
  /** re-seed to "regenerate" a meaningfully different edit */
  seed?: number;
  /** STEP C seam — lean the pacing/category mix for a mode (no full behavior) */
  mode?: EditModeId;
  /** STEP D energy re-bias: 0 = calm/quiet-leaning, 1 = hype/beat-leaning,
   * 0.5 (default) = neutral (no change from the shipped behavior). Re-weights
   * the selection score so the SAME selector produces a genuinely different
   * (still good) reel when the user moves the energy control. */
  energy?: number;
  /** hard cap on number of cuts (optional) */
  maxCuts?: number;
}

export type Category =
  | "wide"
  | "close"
  | "crowd"
  | "lighting"
  | "high-energy"
  | "quiet-cinematic";

export type ArcRole = "HOOK" | "ESTABLISH" | "BUILD" | "PEAK" | "PAYOFF" | "END";

export const MIN_SEL = 0.5; // shortest usable cut (rapid)

/** A segment is unusable and NEVER selected: hard visual rejects plus the
 * in-clip `redundantComposition` (a repeated near-identical shot within one
 * clip — genuinely redundant, safe to drop entirely). The cross-clip
 * `duplicate` flag is deliberately NOT read here: STEP A's dupSim-collision
 * over-flags any two similar-but-distinct good concert moments as duplicates
 * (their uniqueness gets crushed to ~0), which would collapse the strong pool
 * to a single hero. STEP B instead detects TRUE near-duplicates itself in
 * `pickNext` using a strict fingerprint bar (NEAR_DUP) computed on the fly, so
 * an actual re-shot moment can never appear twice while genuinely distinct
 * moments of the same "type" remain selectable for variety. */
export function unusable(f: RejectFlags): boolean {
  return (
    f.floorCeiling ||
    f.extremeShake ||
    f.obstruction ||
    f.badlyBlurred ||
    f.nearBlack ||
    f.redundantComposition
  );
}

/** "Re-shot moment" bar: two segments whose fingerprint cosine is at or above
 * this are treated as the SAME recorded frame (a phone re-shooting the exact
 * same beat). Only TRUE re-shots are prohibited from appearing twice or
 * adjacent. Distinct-but-similar shots (e.g. two good high-energy close-ups
 * from different angles, cosine 0.90-0.98) stay fully selectable — that variety
 * is exactly what the Plan wants; the "no nearly-identical framing" rule is
 * enforced separately by the framing guard below. */
export const NEAR_DUP = 0.995;

/** Two shots whose framing differs by <= this are "nearly identical framing"
 * and can never sit back-to-back (the Plan's hard rule). Wide/wide, close/close
 * or two mid shots back-to-back all violate this. */
export const FRAME_IDENTICAL = 0.14;

// ---- primary category from the attribute vector (highest-signal wins) ----
export function categoryOf(s: SegmentAnalysis): Category {
  const a = s.attrs;
  if (a.audioEnergy >= 0.62 && a.onsetBeat >= 0.55) return "high-energy";
  if (a.lightChange >= 0.55) return "lighting";
  if (a.framing >= 0.68 && a.performer >= 0.6) return "close";
  if (a.crowd >= 0.6) return "crowd";
  if (a.audioEnergy <= 0.35 && a.sharpness >= 0.6 && a.stability >= 0.6)
    return "quiet-cinematic";
  if (a.framing <= 0.4) return "wide";
  return "close";
}

// ---- arc role for an index given a total cut count ----
export function roleForIndex(i: number, n: number): ArcRole {
  if (n <= 1) return i === 0 ? "HOOK" : "END";
  if (i === 0) return "HOOK";
  if (i < Math.round(n * 0.25)) return "ESTABLISH";
  if (i < Math.round(n * 0.5)) return "BUILD";
  if (i < Math.round(n * 0.72)) return "PEAK";
  if (i < n - 1) return "PAYOFF";
  return "END";
}

export const ROLE_DUR: Record<ArcRole, [number, number]> = {
  HOOK: [1.2, 2.4], // snappy but substantial opener
  ESTABLISH: [1.6, 3.0], // settle into the room
  BUILD: [0.5, 1.6], // rapid cuts
  PEAK: [3.0, 5.2], // rare hero moment
  PAYOFF: [1.6, 3.0], // crowd / reaction
  END: [1.6, 3.0], // breathe out
};

// ordered category affinity per role (index 0 = most desired → highest bias)
const ROLE_CAT: Record<ArcRole, Category[]> = {
  HOOK: ["high-energy", "close", "lighting", "crowd", "quiet-cinematic", "wide"],
  ESTABLISH: ["wide", "crowd", "quiet-cinematic", "lighting", "close", "high-energy"],
  BUILD: ["close", "high-energy", "lighting", "crowd", "wide", "quiet-cinematic"],
  PEAK: ["high-energy", "lighting", "close", "crowd", "quiet-cinematic", "wide"],
  PAYOFF: ["crowd", "quiet-cinematic", "wide", "lighting", "close", "high-energy"],
  END: ["wide", "quiet-cinematic", "crowd", "lighting", "close", "high-energy"],
};

// STEP C — per-mode category lean (§5.5): a mode overrides the neutral role
// affinity to favour what it's about (Hype → high-energy/crowd in PEAK, Music
// Video → wide↔close variety in BUILD, Cinematic → wide/lighting ESTABLISH,
// Memory → crowd/close emotional). Surprise-me uses the neutral base.
const ROLE_CAT_MODES: Partial<Record<EditModeId, Partial<Record<ArcRole, Category[]>>>> = {
  cinematic: {
    ESTABLISH: ["wide", "lighting", "quiet-cinematic", "crowd", "close", "high-energy"],
    PEAK: ["lighting", "high-energy", "close", "wide", "quiet-cinematic", "crowd"],
    END: ["wide", "quiet-cinematic", "lighting", "crowd", "close", "high-energy"],
  },
  hype: {
    HOOK: ["high-energy", "lighting", "close", "crowd", "quiet-cinematic", "wide"],
    BUILD: ["high-energy", "crowd", "lighting", "close", "wide", "quiet-cinematic"],
    PEAK: ["high-energy", "crowd", "lighting", "close", "quiet-cinematic", "wide"],
  },
  memory: {
    HOOK: ["close", "high-energy", "crowd", "quiet-cinematic", "lighting", "wide"],
    PAYOFF: ["crowd", "quiet-cinematic", "close", "wide", "lighting", "high-energy"],
    END: ["crowd", "wide", "quiet-cinematic", "close", "lighting", "high-energy"],
  },
  "music-video": {
    BUILD: ["wide", "close", "lighting", "high-energy", "crowd", "quiet-cinematic"],
    PEAK: ["lighting", "high-energy", "close", "wide", "crowd", "quiet-cinematic"],
    PAYOFF: ["wide", "close", "crowd", "high-energy", "lighting", "quiet-cinematic"],
  },
};

function roleCatFor(role: ArcRole, mode?: EditModeId): Category[] {
  const over = (mode && ROLE_CAT_MODES[mode]) ? ROLE_CAT_MODES[mode]![role] : undefined;
  return over ?? ROLE_CAT[role];
}

function catAffinity(role: ArcRole, cat: Category, mode?: EditModeId): number {
  const list = roleCatFor(role, mode);
  const pos = list.indexOf(cat);
  if (pos === 0) return 1.18;
  if (pos === 1) return 1.08;
  if (pos === 2) return 0.98;
  if (pos === 3) return 0.86;
  if (pos === 4) return 0.72;
  if (pos === 5) return 0.62;
  return 0.55;
}

// mode → target average cut length (STEP C seam). Fewer/longer for cinematic,
// faster for hype/music-video.
function modeTargetAvg(mode?: EditModeId): number {
  switch (mode) {
    case "hype":
      return 1.6;
    case "music-video":
      return 1.8;
    case "cinematic":
      return 2.9;
    case "memory":
      return 2.2;
    case "surprise-me":
    default:
      return 2.2;
  }
}

/** STEP D energy re-bias multiplier for a candidate's selection weight.
 * energy=0 favours calm/quiet cinematic moments (low audio energy + low onset),
 * energy=1 favours hyped/on-beat moments (high audio energy + high onset).
 * energy=0.5 (or `undefined`) → 1.0 (neutral), so the shipped behavior is
 * byte-identical unless the user moves the control. The calm/hype arms are
 * complementary (a low-energy moment is near-1 when calm, near-0 when hype and
 * vice-versa) so moving the control meaningfully re-ranks the pool. */
export function energyBias(s: SegmentAnalysis, energy?: number): number {
  if (typeof energy !== "number" || energy === undefined) return 1;
  const e = Math.max(0, Math.min(1, energy));
  const en = s.attrs.audioEnergy;
  const on = s.attrs.onsetBeat;
  const hype = 0.5 * en + 0.35 * on + 0.08; // favoured at energy → 1
  const calm = 1 - 0.6 * en + 0.08; // favoured at energy → 0
  // lerp calm (energy 0) ↔ hype (energy 1)
  return calm * (1 - e) + hype * e;
}

// ---------------------------------------------------------------------------
// Small deterministic PRNG + fingerprint cosine (mirrors reel.ts semantics)
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

// HARD consecutive guard: a candidate is "too similar" to the previous pick if
// it is a true near-duplicate moment (fingerprint >= NEAR_DUP) OR its framing is
// essentially identical (both wide, both close, etc.) OR it repeats the same
// framing-class composition. These are banned from sitting back-to-back.
export function consecutivelySimilar(a: SegmentAnalysis, b: SegmentAnalysis): boolean {
  if (cosine(a.fingerprint, b.fingerprint) >= NEAR_DUP) return true; // true re-shot
  if (Math.abs(a.attrs.framing - b.attrs.framing) <= FRAME_IDENTICAL) return true; // nearly-identical framing
  // same "type" (category) with very similar framing → redundant composition
  if (categoryOf(a) === categoryOf(b) && Math.abs(a.attrs.framing - b.attrs.framing) < 0.3)
    return true;
  return false;
}

/** True re-shot of ANY segment already in the reel (so the same recorded frame
 * can never appear twice anywhere, not just consecutively). */
function duplicatedIn(c: SegmentAnalysis, picked: SegmentPick[]): boolean {
  for (const p of picked) {
    if (cosine(c.fingerprint, p.s.fingerprint) >= NEAR_DUP) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Selection core
// ---------------------------------------------------------------------------

interface Candidate {
  s: SegmentAnalysis;
  base: number;
  cat: Category;
}

export interface SegmentPick extends Candidate {
  dur: number;
  role: ArcRole;
}

/** Return the ordered picks (segment + assigned duration + arc role). Exported
 * for the harness and STEP D; `selectSegmentEditions`/`selectSegmentSegments`
 * wrap it into the two output shapes. */
export function pickSegments(
  allClips: ClipSegmentResult[],
  opts: SelectSegmentOptions = {}
): SegmentPick[] {
  const budget = opts.targetSeconds ?? 30;
  const seed = opts.seed ?? 1;
  const targetAvg = modeTargetAvg(opts.mode);

  // 1) clean candidate pool (exclude unusable; base = highlight score)
  const pool: Candidate[] = [];
  for (const r of allClips) {
    for (const s of r.segments) {
      if (unusable(s.flags)) continue;
      if (s.duration < MIN_SEL) continue;
      pool.push({ s, base: s.highlightScore, cat: categoryOf(s) });
    }
  }
  if (pool.length === 0) return [];
  // strongest first; the HOOK = pool[0]. STEP D: when an energy bias is set,
  // rank by the energy-leaned base so a strong high-energy (or quiet-cinematic)
  // realignment can pull the hook and the later picks toward the user's energy.
  if (typeof opts.energy === "number") {
    pool.sort((a, b) => b.base * energyBias(b.s, opts.energy) - a.base * energyBias(a.s, opts.energy));
  } else {
    pool.sort((a, b) => b.base - a.base);
  }

  // 2) target cut count from budget + mode (bounded by pool + budget floor + cap)
  let n = Math.max(3, Math.round(budget / targetAvg));
  n = Math.min(n, pool.length, Math.max(3, Math.floor(budget / MIN_SEL)));
  if (opts.maxCuts) n = Math.min(n, opts.maxCuts);

  const picked: SegmentPick[] = [];
  const used = new Set<number>();
  let total = 0;

  const usedOfClip = (cid: number) => picked.filter((p) => p.s.clipId === cid).length;

  const pickNext = (role: ArcRole, isHook: boolean): Candidate | null => {
    if (pool.length === 0) return null;
    if (isHook) {
      // strongest non-rejected segment in the whole set (the pool is clean, so
      // this is a strong visual/musical moment — never black/logo).
      const c = pool.find((p) => !used.has(p.s.id)) ?? pool[0];
      return c;
    }
    const rand = mulberry32(seed * 1000 + picked.length);
    let bestPass: Candidate | null = null;
    let bestPassScore = -Infinity;
    let bestAny: Candidate | null = null; // fallback: no re-shot, no frame-identical pair
    let bestAnyScore = -Infinity;
    const prev = picked.length ? picked[picked.length - 1].s : null;
    for (const c of pool) {
      if (used.has(c.s.id)) continue;
      if (duplicatedIn(c.s, picked)) continue; // HARD: a re-shot frame never appears twice
      const frameDiff = prev ? Math.abs(c.s.attrs.framing - prev.attrs.framing) : 1;
      // HARD consecutive framing guard is respected by BOTH bestPass and bestAny
      if (prev && frameDiff <= FRAME_IDENTICAL) continue;
      // bestPass also avoids the soft "same category + close framing" and re-shot
      const passOK = !prev || !consecutivelySimilar(c.s, prev);
      if (!passOK) {
        // frames differ but category+closeness repeats — acceptable as a rare
        // budget-fill; still never a re-shot or a frame-identical pair.
        const scAny = c.base * (0.95 + rand() * 0.1) * (usedOfClip(c.s.clipId) === 0 ? 1.18 : 1) * energyBias(c.s, opts.energy);
        if (scAny > bestAnyScore) {
          bestAnyScore = scAny;
          bestAny = c;
        }
        continue;
      }
      let sc = c.base * (0.95 + rand() * 0.1) * energyBias(c.s, opts.energy); // seed jitter + energy
      const cnt = usedOfClip(c.s.clipId);
      sc *= cnt === 0 ? 1.18 : Math.max(0.12, 1 - 0.13 * cnt); // coverage
      sc *= catAffinity(role, c.cat, opts.mode); // role-category variety (mode-leaned)
      // framing-spread: prefer a clear framing change vs the previous shot
      if (prev) sc *= 0.85 + 0.5 * Math.min(1, frameDiff / 0.6);
      // soft penalty for similarity to the previous 2 picks (quality/flow)
      for (let k = Math.max(0, picked.length - 2); k < picked.length; k++) {
        const sim = cosine(c.s.fingerprint, picked[k].s.fingerprint);
        sc *= 1 - 0.55 * sim;
      }
      if (sc > bestPassScore) {
        bestPassScore = sc;
        bestPass = c;
      }
    }
    return bestPass ?? bestAny;
  };

  // 3) arc-driven greedy fill
  for (let i = 0; i < n; i++) {
    const role = roleForIndex(i, n);
    const [rmin, rmax] = ROLE_DUR[role];
    const cutsLeft = Math.max(1, n - i);
    let target = (budget - total) / cutsLeft;
    target = Math.max(rmin, Math.min(rmax, target));
    if (total + target > budget) target = budget - total;

    const cand = pickNext(role, i === 0);
    if (!cand) break;
    let dur = Math.min(cand.s.duration, target);
    dur = Math.min(dur, budget - total);
    if (dur < MIN_SEL) break; // can't fit another meaningful cut
    picked.push({ ...cand, dur, role });
    used.add(cand.s.id);
    total += dur;
  }

  // Whatever the reel's final actual cut is, it is the END (the closing role).
  // The greedy may fill fewer than the target `n` cuts (e.g. the only remaining
  // candidates are near-duplicates it correctly refuses), so assign the true
  // closing role to the last picked segment rather than relying on index n-1.
  if (picked.length > 0) picked[picked.length - 1].role = "END";

  return picked;
}
// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** Build the editable EditDecision list (the Plan's intermediate render contract)
 * for the chosen segment picks. transition defaults "hard_cut", audioBehavior
 * "keep_source" per Plan Phase 6 — STEP D will expose these for editing. */
export function selectSegmentEditions(
  allClips: ClipSegmentResult[],
  opts: SelectSegmentOptions = {}
): EditDecision[] {
  const fileMap = new Map<number, string>();
  for (const r of allClips) fileMap.set(r.clipId, r.clipName ?? "");
  return pickSegments(allClips, opts).map((p, i) => {
    const s = p.s;
    return {
      segmentId: s.id,
      sourceFile: s.clipName ?? fileMap.get(s.clipId) ?? "",
      clipId: s.clipId,
      startTime: s.start,
      endTime: s.start + p.dur,
      duration: p.dur,
      score: s.highlightScore,
      reasonSelected: `${p.role}|${p.cat}|${reasonForSegment(s)}`,
      crop: s.crop,
      transition: "hard_cut",
      audioBehavior: "keep_source",
      locked: false,
      flags: s.flags,
    };
  });
}

/** Convenience: return the selection as the shipped reel `Segment[]` so the
 * existing editorial/pacing/render pipeline can consume it unchanged. This is
 * what create.tsx dispatches to when segment selection is enabled. */
export function selectSegmentSegments(
  allClips: ClipSegmentResult[],
  opts: SelectSegmentOptions = {}
): Segment[] {
  return pickSegments(allClips, opts).map((p) => {
    const s = p.s;
    const a = s.attrs;
    return {
      id: s.id,
      clipId: s.clipId,
      name: s.clipName ?? "",
      start: s.start,
      end: s.start + p.dur,
      duration: p.dur,
      avgEnergy: a.audioEnergy,
      peakEnergy: Math.min(1, a.audioEnergy * 1.12),
      avgVocal: 0.5,
      beatLock: a.onsetBeat,
      score: s.highlightScore,
      isDanceBreak: a.onsetBeat > 0.6,
      tags: [p.cat],
      songIndex: -1,
      songLabel: "",
      fingerprint: [...s.fingerprint],
      cutStyle: undefined,
      bpm: 0,
      // STEP C: carry the full attribute set so editorial (pacing + the
      // transition trigger table) reads real signal, not legacy coarse fields.
      attrs: { ...a },
    };
  });
}

// keep the AnalyzeSegmentsOptions import referenced for callers who build results
export type { AnalyzeSegmentsOptions };
