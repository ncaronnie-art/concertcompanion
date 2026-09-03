// src/lib/editorial.ts
// STEP C (2.0) — EDITORIAL: pacing classes + hard-cut-default transitions.
//
// Reverses the just-shipped "long ranges + varied transitions everywhere"
// editorial look per the 2.0 Plan (PHASES 3, 4, 6) + the STEP C spec (§2, §3).
// This layer owns "how the reel actually reads":
//   * Pacing classes tightened to the Plan: RAPID 0.5–1.5s / NORMAL 1.5–3s /
//     HERO 3–5s (rare) / OPENING_HIT 1.5–2.5s, tied to the HOOK→ESTABLISH→BUILD→
//     PEAK→PAYOFF→END arc.
//   * Transitions default to HARD_CUT; a non-hard transition is an EXCEPTION
//     earned only via the §2.2 attribute-trigger table, capped by the mode's
//     whitelist + a hard density cap. Song changes just hard-cut (the old
//     SONG_HANDOFF chip/swell/dip is removed).
//   * Signal source is seamless: a segment cut carries `attrs` (STEP A/B full
//     fidelity); a legacy coverage cut falls back to the coarse-field mapping
//     (§6.4: beatLock→onsetBeat, avgEnergy→audioEnergy, avgVocal→performer).
//
// Pure + deterministic for a given seed/target, so the no-browser harness pins it.

import type { Segment } from "./reel";
import type { TransitionType } from "./transitions";
import {
  DENSITY_CALM,
  DENSITY_HOT,
  DISSOLVE_DUR,
  FLASH_DUR,
  WHIP_DUR,
} from "./transitions";

// ---- EDITORIAL BIAS (mode override) ----
// A mode is a full editing directive expressed as OVERRIDES over the neutral
// base below: lean the pacing-class gates, the transition decisions and the
// motion feel. `editmodes.ts` maps each mode → a bias (+ a validated transition
// policy). Honest framing: modes are a CREATIVE / STYLISTIC mapping, not an ML
// genre classifier.
export interface EditorialBias {
  pace: "hot" | "standard" | "cool"; // hot = more RAPID, cool = more HERO/NORMAL
  durationScale: number; // multiplier on each cut's desired slot length (tighter <1 .. looser >1)
  whippiness: number; // -1 (prefer dissolves) .. +1 (prefer whip/beat-cut)
  motion: "lively" | "standard" | "gentle"; // favored NORMAL-cut motion feel
}

/** The neutral bias — the base editorial behavior (no regression for Surprise Me
 * before footage resolves). */
export const NEUTRAL_BIAS: EditorialBias = {
  pace: "standard",
  durationScale: 1,
  whippiness: 0,
  motion: "standard",
};

export type CutStyle = "RAPID" | "NORMAL" | "HERO" | "OPENING_HIT";
export type MotionStyle =
  | "gentle"
  | "standard"
  | "lively"
  | "wide-guard"
  | "match-orientation";

export interface PacedCut {
  seg: Segment;
  style: CutStyle;
  dur: number; // final playback duration (seconds) for THIS cut's slot
}

// ---- §3 pacing-class duration ranges (lo, hi, preferred) ----
const RANGE: Record<CutStyle, [number, number, number]> = {
  RAPID: [0.5, 1.5, 1.0],
  NORMAL: [1.5, 3.0, 2.2],
  HERO: [3.0, 5.0, 4.0],
  OPENING_HIT: [1.5, 2.5, 2.2],
};

export function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/*** §6.4 — one normalised signal view over a cut. If the cut carries the full
 * `attrs` set (segment path, STEP A/B) use it verbatim; otherwise map the legacy
 * coarse fields (beatLock→onsetBeat, avgEnergy→audioEnergy, avgVocal→performer)
 * and default the visual fields (not measured on the audio-first coverage path). */
type Sig = {
  onsetBeat: number;
  audioEnergy: number;
  performer: number;
  sharpness: number;
  stability: number;
  framing: number;
  visualMotion: number;
  lightChange: number;
  score: number;
};
export function attrsOf(seg: Segment): Sig {
  const a = seg.attrs;
  if (a) {
    return {
      onsetBeat: a.onsetBeat,
      audioEnergy: a.audioEnergy,
      performer: a.performer,
      sharpness: a.sharpness,
      stability: a.stability,
      framing: a.framing,
      visualMotion: a.visualMotion,
      lightChange: a.lightChange,
      score: seg.score ?? 0,
    };
  }
  return {
    onsetBeat: seg.beatLock ?? 0,
    audioEnergy: seg.avgEnergy ?? 0,
    performer: seg.avgVocal ?? 0.5,
    sharpness: 0.6,
    stability: 0.6,
    framing: 0.5,
    visualMotion: 0.3,
    lightChange: 0.2,
    score: seg.score ?? 0,
  };
}

const NEXT: Record<CutStyle, CutStyle> = {
  RAPID: "NORMAL",
  NORMAL: "HERO",
  HERO: "NORMAL",
  OPENING_HIT: "NORMAL",
};

/** §3 — pick a cut's class from its own signals (priority order per spec):
 * 1 idx0 → OPENING_HIT; 2 last two → NORMAL; 3 high-energy → RAPID (hot) /
 * NORMAL (cool); 4 quiet-cinematic → HERO(cool)/NORMAL; 5 strong close-performer
 * + top-decile score → HERO (the money shot); else NORMAL. */
function styleFromSignals(
  seg: Segment,
  idx: number,
  n: number,
  bias: EditorialBias,
  topDecile: number
): CutStyle {
  if (idx === 0) return "OPENING_HIT";
  if (idx >= n - 2) return "NORMAL"; // land on the last two + end brand
  const a = attrsOf(seg);
  const hot = bias.pace === "hot";
  if (a.audioEnergy >= 0.62 && a.onsetBeat >= 0.55) return hot ? "RAPID" : "NORMAL";
  if (a.audioEnergy <= 0.35 && a.sharpness >= 0.6 && a.stability >= 0.6)
    return bias.pace === "cool" ? "HERO" : "NORMAL";
  if (a.performer >= 0.6 && a.framing >= 0.68 && a.score >= topDecile) return "HERO";
  return "NORMAL";
}

/** §3 — the story arc HOOK→ESTABLISH→BUILD→PEAK→PAYOFF→END as a class shape.
 * HOOK(0)=OPENING_HIT; build run = NORMAL (escalation, allowed to repeat);
 * close+end run = NORMAL (land); the PEAK middle carries 1–2 isolated HERO(money
 * shots) and varied classes. Yields the peak window for the pace bias. */
function applyArcAndNoRepeat(styles: CutStyle[], selected: Segment[]): { peakLo: number; peakHi: number } {
  const n = styles.length;
  if (n === 0) return { peakLo: 0, peakHi: 0 };
  styles[0] = "OPENING_HIT";
  const buildCount = Math.max(1, Math.round(n * 0.18));
  const closeCount = buildCount;
  for (let i = 1; i < Math.min(n, buildCount + 1); i++) styles[i] = "NORMAL"; // build
  for (let i = Math.max(n - closeCount, 1); i < n; i++) styles[i] = "NORMAL"; // close + end

  const peakLo = Math.min(buildCount + 1, n);
  const peakHi = Math.max(peakLo, n - closeCount);

  // HERO money-shots: the 1–2 strongest moments in the peak window (rare 3–5s).
  const heroWindow = Math.min(2, Math.max(0, peakHi - peakLo));
  if (heroWindow > 0) {
    const indices = [];
    for (let i = peakLo; i < peakHi; i++) indices.push(i);
    indices.sort((a, b) => (selected[b].score ?? 0) - (selected[a].score ?? 0));
    const heroCount = n >= 10 ? 2 : 1;
    let placed = 0;
    let lastHero = -10;
    for (const idx of indices) {
      if (placed >= heroCount) break;
      if (idx - lastHero < 3) continue; // keep heroes spaced (isolated-ish)
      styles[idx] = "HERO";
      lastHero = idx;
      placed++;
    }
  }

  // enforce no-repeat INSIDE the peak (variety is the point there): a shared
  // class breaks via an alternative; a deliberate RAPID run is capped at
  // 2-in-a-row; HERO is always isolated.
  for (let i = peakLo; i < peakHi; i++) {
    if (i > 0 && styles[i] === styles[i - 1]) {
      if (styles[i] === "RAPID" && !(i >= 2 && styles[i - 2] === "RAPID")) continue; // allow 2-in-a-row
      const prev = styles[i - 1];
      const next = i + 1 < styles.length ? styles[i + 1] : undefined;
      let alt: CutStyle | null = null;
      for (const cand of (["NORMAL", "HERO", "RAPID"] as CutStyle[])) {
        if (cand === styles[i] || cand === prev || cand === next) continue;
        if (cand === "HERO" && prev === "HERO") continue; // never HERO right after HERO
        alt = cand;
        break;
      }
      styles[i] = alt ?? (styles[i] === "HERO" ? "NORMAL" : "HERO");
    }
  }
  return { peakLo, peakHi };
}

/** §3 — the mode's RHYTHM pass: hot converts ~1/3 of the body's NORMAL cuts to
 * RAPID (beat energy), cool converts ~1/4 to HERO (cinematic air). Respects
 * no-3-in-a-row and never breeds adjacent HERO. */
function applyPaceBias(styles: CutStyle[], bias: EditorialBias, ranges: { peakLo: number; peakHi: number }): void {
  if (bias.pace === "standard") return;
  const { peakLo, peakHi } = ranges;
  const hot = bias.pace === "hot";
  const to = hot ? "RAPID" : "HERO";
  const budget = hot
    ? Math.max(1, Math.floor((peakHi - peakLo) * 0.32))
    : Math.max(1, Math.floor((peakHi - peakLo) * 0.24));
  let converted = 0;
  for (let i = peakLo; i < peakHi && converted < budget; i++) {
    if (styles[i] !== "NORMAL") continue;
    const p1 = styles[i - 1];
    const p2 = i >= 2 ? styles[i - 2] : null;
    const n1 = styles[i + 1];
    if (p1 === to && p2 === to) continue; // no 3-in-a-row
    if (p1 === to && n1 === to) continue; // would close a 3-gap
    if (to === "HERO" && (p1 === "HERO" || n1 === "HERO")) continue; // HERO isolated
    styles[i] = to;
    converted++;
  }
}

/** §3 — set each cut's final slot duration from its class, kept within the class
 * range AND never exceeding what its segment actually holds (plus a small HERO
 * grace extension so a hero can breathe — reading a touch more of the SAME clip,
 * never different footage). Sub-0.8s RAPID is only allowed for hot modes (Hype /
 * Music Video). Then enforce the total ≤ target. */
function finalizeDurations(
  selected: Segment[],
  styles: CutStyle[],
  target: number,
  bias: EditorialBias
): PacedCut[] {
  const scale = bias.durationScale || 1;
  const hot = bias.pace === "hot";
  const desired: { d: number; floor: number }[] = [];
  for (let i = 0; i < selected.length; i++) {
    const [, hi] = RANGE[styles[i]];
    const ext = styles[i] === "HERO" ? 2.0 : 0;
    let floor: number;
    if (styles[i] === "RAPID") floor = hot ? 0.5 : 0.8; // sub-0.8 only hot
    else if (styles[i] === "OPENING_HIT") floor = 1.5;
    else if (styles[i] === "HERO") floor = 3.0;
    else floor = 1.5; // NORMAL
    let d = Math.min(hi, (selected[i].duration + ext) * scale);
    d = Math.max(d, Math.min(floor, selected[i].duration + ext)); // don't pad past footage
    desired.push({ d: Math.max(0.5, d), floor });
  }

  let total = desired.reduce((s, x) => s + x.d, 0);
  let excess = total - target;
  let guard = 0;
  while (excess > 0.05 && guard++ < 100) {
    let bi = -1;
    let room = 0;
    for (let i = 0; i < desired.length; i++) {
      const r = desired[i].d - desired[i].floor;
      if (r > room) {
        room = r;
        bi = i;
      }
    }
    if (bi < 0 || room <= 0) break;
    const cut = Math.min(room, excess, desired[bi].d - 0.5);
    if (cut <= 0) break;
    desired[bi].d -= cut;
    excess -= cut;
    total -= cut;
  }

  return selected.map((s, i) => ({ seg: s, style: styles[i], dur: desired[i].d }));
}

/**
 * §3 — Pace an already-selected set of cuts: assign each a class (signals + the
 * arc), apply the mode's pace bias, and give each a concrete slot duration that
 * fits the max-duration cap. Preview and export both consume the returned
 * PacedCut[] so the pacing is identical in both. `bias` leans class gates + slot
 * lengths; null reproduces the base behavior.
 */
export function planPacing(
  selected: Segment[],
  targetSeconds: number,
  bias: EditorialBias | null = NEUTRAL_BIAS
): PacedCut[] {
  const n = selected.length;
  if (n === 0) return [];
  const b = bias ?? NEUTRAL_BIAS;
  const scores = selected.map((s) => s.score ?? 0).sort((x, y) => x - y);
  const topDecile = scores[Math.max(0, Math.floor(scores.length * 0.9))];
  const styles: CutStyle[] = selected.map((s, i) => styleFromSignals(s, i, n, b, topDecile));
  const ranges = applyArcAndNoRepeat(styles, selected);
  applyPaceBias(styles, b, ranges);
  return finalizeDurations(selected, styles, targetSeconds, b);
}

/** Map a §3 class to its reframe motion style. A hot/cool mode leans the NORMAL
 * feel (lively for hot, gentle for cool). */
export function motionStyleFor(style: CutStyle, bias: EditorialBias | null = NEUTRAL_BIAS): MotionStyle {
  const b = bias ?? NEUTRAL_BIAS;
  switch (style) {
    case "RAPID":
      return "lively";
    case "HERO":
      return "gentle"; // breathe — don't bounce
    case "OPENING_HIT":
      return "standard"; // strong hook, steady push
    case "NORMAL":
    default:
      return b.motion === "lively" ? "lively" : b.motion === "gentle" ? "gentle" : "standard";
  }
}

// ---------------------------------------------------------------------------
// §2 — per-boundary transition DECISION TABLE (hard-cut default)
// ---------------------------------------------------------------------------

export interface Boundary {
  type: TransitionType;
  dur: number;
}

/** What a mode allows + how many non-hard boundaries it tolerates. */
export interface TransitionPolicy {
  allowed: TransitionType[]; // non-HARD_CUT transitions this mode permits
  density: number; // max fraction of boundaries that may be non-hard (0 = none)
}

export function makeTransition(type: TransitionType, dur: number): Boundary {
  return { type, dur };
}

/** Policy that never transitions (default when a mode doesn't opt in). */
export const HARD_CUT_ONLY_POLICY: TransitionPolicy = { allowed: [], density: 0 };

/** §2.2 — pick a transition by the trigger table, ALSO gated by the mode's
 * whitelist. First matching trigger wins; a trigger whose type the mode doesn't
 * allow falls back to HARD_CUT (hard rule 6). Song changes are NOT special —
 * they hard-cut (audio bed carries continuity). */
export function computeBoundary(
  prev: PacedCut,
  cur: PacedCut,
  policy: TransitionPolicy = HARD_CUT_ONLY_POLICY
): Boundary {
  const aP = attrsOf(prev.seg);
  const aC = attrsOf(cur.seg);
  const beatSync = policy.allowed.includes("BEAT_CUT");
  const allowDissolve = policy.allowed.includes("DISSOLVE");

  let bd: Boundary;
  // 2. WHIP — outgoing genuinely moving directionally (stability kills shake)
  if (aP.visualMotion >= 0.7 && aP.stability >= 0.55 && aC.visualMotion >= 0.5) {
    bd = makeTransition("WHIP", WHIP_DUR);
  }
  // 3. FLASH — a stage light pops on the incoming head
  else if (aC.lightChange >= 0.72) {
    bd = makeTransition("FLASH", FLASH_DUR);
  }
  // 4. BEAT_CUT — incoming starts on a strong onset (beat-sync modes only)
  else if (beatSync && aC.onsetBeat >= 0.6) {
    bd = makeTransition("BEAT_CUT", 0);
  }
  // 5. DISSOLVE — BOTH sides calm/quiet (Cinematic / Memory only)
  else if (allowDissolve && aP.visualMotion <= 0.35 && aC.visualMotion <= 0.35 && aC.audioEnergy <= 0.35) {
    bd = makeTransition("DISSOLVE", DISSOLVE_DUR);
  }
  // 1/6/7 (DEFAULT / match-cut / motion-cut) → hard cut
  else {
    bd = makeTransition("HARD_CUT", 0);
  }

  // hard rule 6 + 5: a fired type the mode doesn't allow → hard cut
  if (bd.type !== "HARD_CUT" && !policy.allowed.includes(bd.type)) {
    bd = makeTransition("HARD_CUT", 0);
  }
  return bd;
}

/**
 * §2 — compute the full boundary list for a paced reel. Returns an array of
 * length `paced.length` where index i is the transition INTO cut i (index 0 is
 * always null — no transition into the first cut). Applies the hard rules:
 * density cap, no-two-identical-effect back-to-back, and whip never into/out of
 * a HERO (calm) cutoff. So a 12-cut (11-boundary) reel runs ≤ 1 calm / ≤ 2 hot
 * non-hard transitions, and the DEFAULT is hard cut.
 */
export function computeBoundaries(
  paced: PacedCut[],
  policy: TransitionPolicy = HARD_CUT_ONLY_POLICY
): (Boundary | null)[] {
  const out: (Boundary | null)[] = [null];
  const n = paced.length;
  if (n <= 1) return out;
  const boundaryCount = n - 1;
  const cap = policy.density > 0 ? Math.floor(boundaryCount * policy.density) : 0;
  let nonHard = 0;
  let prevEffectType: TransitionType | null = null;
  for (let i = 1; i < n; i++) {
    let bd = computeBoundary(paced[i - 1], paced[i], policy);
    if (bd.type !== "HARD_CUT") {
      if (bd.type === prevEffectType) bd = makeTransition("HARD_CUT", 0); // no-repeat
      else if (nonHard >= cap) bd = makeTransition("HARD_CUT", 0); // density cap
      else if (bd.type === "WHIP" && (paced[i - 1].style === "HERO" || paced[i].style === "HERO"))
        bd = makeTransition("HARD_CUT", 0); // whip never into/out of a HERO
    }
    if (bd.type !== "HARD_CUT") {
      nonHard++;
      prevEffectType = bd.type;
    }
    out.push(bd);
  }
  return out;
}

/** Convenience density value for a mode's pace (hot → 1/4, else → 1/6). */
export function densityForPace(pace: "hot" | "standard" | "cool"): number {
  return pace === "hot" ? DENSITY_HOT : DENSITY_CALM;
}
