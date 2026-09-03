// src/lib/transitions.ts
// STEP C (2.0) — transition LANGUAGE, hard-cut default.
//
// Reverses the just-shipped "varied transitions everywhere" look per the 2.0 Plan
// (PHASE 6) + the STEP C spec §2. Default is HARD_CUT. A non-hard transition is
// an EXCEPTION that must earn its way in via the attribute-trigger table in
// editorial.ts — "nearly invisible", capped durations, hard density caps, no
// motion-graphics (the former SONG_HANDOFF chip/swell/dip is removed entirely:
// song changes just hard-cut, audio bed carries the continuity).
//
// Timeline model (kept tiny and honest): each selected cut occupies its own reel
// slot. At a boundary with duration D>0, the outgoing tail and incoming head
// overlap for D seconds and play the transition INSIDE the already-scheduled
// slots — a transition never adds reel time (preview == export via the single
// shared renderer).

/** Transition set — re-named to the EDL/plan vocabulary. */
export type TransitionType =
  | "HARD_CUT" // rename of STRAIGHT — instant swap, 0s, THE default
  | "BEAT_CUT" // rename of CUT_ON_BEAT — instant swap snapped to an onset, 0s
  | "DISSOLVE" // short even equal-power crossfade, 0.30s (calm only)
  | "WHIP" // shorter motion slide+scale streak, 0.28s (motion only)
  | "FLASH"; // NEW — quick white bloom on the incoming head, 0.15s (lighting only)

// ---- per-transition max durations (hard "nearly invisible" cap ≤ 0.35s) ----
export const HARD_CUT_DUR = 0;
export const BEAT_CUT_DUR = 0;
export const DISSOLVE_DUR = 0.3;
export const WHIP_DUR = 0.28;
export const FLASH_DUR = 0.15;

export const TRANSITION_DUR: Record<TransitionType, number> = {
  HARD_CUT: HARD_CUT_DUR,
  BEAT_CUT: BEAT_CUT_DUR,
  DISSOLVE: DISSOLVE_DUR,
  WHIP: WHIP_DUR,
  FLASH: FLASH_DUR,
};

// ---- density caps (§2.3): allowed non-hard boundaries are rare by construction.
// calm modes ≤ floor(boundaries/6) → 12-cut reel (11 boundaries) gets ≤ 1;
// hot modes ≤ floor(boundaries/4) → ≤ 2. ----
export const DENSITY_CALM = 1 / 6;
export const DENSITY_HOT = 1 / 4;

/** End-brand overlay window (the ONLY brand): over the last END_BRAND_S of the
 * final cut, over live footage (no card, no fade-to-black). */
export const END_BRAND_S = 1.2;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Hermite smoothstep, 0..1 in, 0..1 out. */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Double-smoothstep ease-in-out, 0..1 in, 0..1 out (used by motion + whip). */
export function easeInOut(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/**
 * Equal-power gains for the AUDIO bed (and the visual cross-dissolve): squares
 * sum to 1 (constant power) so there is no dip or click as one side hands over
 * to the next. t: 0 = fully old/outgoing, 1 = fully new/incoming.
 */
export function equalPower(t: number): [number, number] {
  const c = clamp01(t);
  return [Math.cos((c * Math.PI) / 2), Math.sin((c * Math.PI) / 2)];
}

/**
 * VISUAL dissolve alphas — strictly equal-power (cos/sin), per §2.3: never a
 * linear overlay that darkens mid-frame, never mid-transition black.
 * Returns [outgoing alpha, incoming alpha] whose squares sum to 1.
 */
export function dissolveAlpha(t: number): [number, number] {
  return equalPower(t);
}

/**
 * Render one transition onto the output canvas, given two filled LAYER canvases
 * (`outgoing` = the cut we're leaving, `incoming` = the cut we're entering) and
 * the normalized boundary time t ∈ [0,1]. Called by BOTH preview and export
 * (single shared render pipeline), so what you preview is what you export.
 *
 * HARD_CUT / BEAT_CUT — instant swap (dur 0 → the loop short-circuits these;
 * this branch is just a safety net).
 * DISSOLVE  — equal-power crossfade.
 * WHIP      — outgoing scales ~1→0.88 & slides off left, incoming slides in from
 *   the right & scale 1.14→1, both strong ease-out; a faint white leading-edge
 *   streak during only the first ~20% (≤ 0.45 alpha — allowed by the spec).
 * FLASH     — instant swap to the incoming head plus a quick white bloom whose
 *   peak opacity is ≤ 0.5, fading out — reads as a stage-light pop, no graphic.
 */
export function composeTransition(
  c2d: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  outgoing: HTMLCanvasElement,
  incoming: HTMLCanvasElement,
  type: TransitionType,
  t: number
): void {
  c2d.clearRect(0, 0, cw, ch);
  if (type === "HARD_CUT" || type === "BEAT_CUT") {
    c2d.globalAlpha = 1;
    c2d.drawImage(t < 0.5 ? outgoing : incoming, 0, 0);
    c2d.globalAlpha = 1;
    return;
  }

  if (type === "WHIP") {
    const e = easeInOut(t);
    const oScale = 1 - 0.12 * e;
    const oX = -cw * 0.9 * e;
    const oA = 1 - e;
    const iScale = 1.14 - 0.14 * e;
    const iX = cw * 0.9 * (1 - easeInOut(t));
    const iA = e;
    c2d.save();
    c2d.globalAlpha = oA;
    c2d.translate(oX + cw / 2, ch / 2);
    c2d.scale(oScale, oScale);
    c2d.drawImage(outgoing, -cw / 2, -ch / 2, cw, ch);
    c2d.restore();
    c2d.save();
    c2d.globalAlpha = iA;
    c2d.translate(iX + cw / 2, ch / 2);
    c2d.scale(iScale, iScale);
    c2d.drawImage(incoming, -cw / 2, -ch / 2, cw, ch);
    c2d.restore();
    // faint leading-edge streak during only the first ~20% (≤ 0.45 alpha)
    if (t < 0.2) {
      const streak = (1 - t / 0.2) * 0.45;
      const gx = iX + cw * 0.3;
      const sg = c2d.createLinearGradient(gx, 0, gx + cw * 0.18, 0);
      sg.addColorStop(0, "rgba(255,255,255,0)");
      sg.addColorStop(0.5, `rgba(255,255,255,${streak})`);
      sg.addColorStop(1, "rgba(255,255,255,0)");
      c2d.save();
      c2d.globalAlpha = iA;
      c2d.fillStyle = sg;
      c2d.fillRect(0, 0, cw, ch);
      c2d.restore();
    }
    c2d.globalAlpha = 1;
    return;
  }

  if (type === "FLASH") {
    // instant swap to the incoming head, plus a quick white bloom that fades.
    c2d.globalAlpha = 1;
    c2d.drawImage(incoming, 0, 0);
    // peak opacity 0.5 at t=0, gone by t=0.4 of the 0.15s window — a light pop,
    // never a solid white frame.
    const bloom = 0.5 * (1 - clamp01(t / 0.4));
    if (bloom > 0.001) {
      c2d.globalAlpha = bloom;
      c2d.fillStyle = "#ffffff";
      c2d.fillRect(0, 0, cw, ch);
    }
    c2d.globalAlpha = 1;
    return;
  }

  // DISSOLVE — even equal-power crossfade
  const [aA, aB] = dissolveAlpha(t);
  c2d.globalAlpha = aA;
  c2d.drawImage(outgoing, 0, 0);
  c2d.globalAlpha = aB;
  c2d.drawImage(incoming, 0, 0);
  c2d.globalAlpha = 1;
}
