// src/lib/theme.ts
// STEP C (2.0) — the visual THEME SYSTEM, no opening brand.
//
// Reverses the "open with a title card" look per the 2.0 Plan (PHASE 3) + the
// STEP C spec §1. One theme is applied to every frame (preview == export): a
// subtle color grade (vertical lift) → a faint top glow → a soft vignette.
// There is NO opening treatment — the reel's very first frame is the HOOK
// footage, picture visible from t=0. The ONLY brand is a small bottom-center
// "Concert Compass" wordmark that fades in over the still-playing final footage
// for the last 1.2s (no card, no fade-to-black, no tagline).
//
// HONESTY: the theme is a stylistic choice, not a clever analysis — we say so in
// the UI. The grade is a neutral screen-space overlay; there is no ML "mood
// detection" here.

import { END_BRAND_S, clamp01, smoothstep } from "./transitions";

export type ThemeId = "noir" | "warm" | "neon" | "daylight" | "stage";

export interface Theme {
  id: ThemeId;
  label: string;
  hint: string;
  gradeTop: string; // rgba
  gradeBottom: string; // rgba
  gradeAlpha: number; // 0..1 strength multiplier for the grade
  accent: string; // detail accent color
  vignette: number; // 0..1 darkness of the edge vignette
  topGlow: string | null;
}

export const THEMES: Record<ThemeId, Theme> = {
  noir: {
    id: "noir",
    label: "Noir",
    hint: "cool, cinematic, neutral",
    gradeTop: "rgba(12, 22, 48, 1)",
    gradeBottom: "rgba(24, 12, 38, 1)",
    gradeAlpha: 0.12,
    accent: "rgba(226, 232, 255, 1)",
    vignette: 0.34,
    topGlow: "rgba(150, 175, 255, 0.05)",
  },
  warm: {
    id: "warm",
    label: "Warm",
    hint: "golden-hour post-show glow",
    gradeTop: "rgba(96, 48, 12, 1)",
    gradeBottom: "rgba(50, 20, 9, 1)",
    gradeAlpha: 0.15,
    accent: "rgba(255, 218, 168, 1)",
    vignette: 0.3,
    topGlow: "rgba(255, 196, 120, 0.07)",
  },
  neon: {
    id: "neon",
    label: "Neon",
    hint: "live stage lights, punchy",
    gradeTop: "rgba(70, 14, 104, 1)",
    gradeBottom: "rgba(8, 28, 86, 1)",
    gradeAlpha: 0.14,
    accent: "rgba(236, 121, 249, 1)",
    vignette: 0.3,
    topGlow: "rgba(217, 70, 239, 0.08)",
  },
  daylight: {
    id: "daylight",
    label: "Daylight",
    hint: "clean, bright fan-cam",
    gradeTop: "rgba(18, 24, 16, 1)",
    gradeBottom: "rgba(34, 30, 22, 1)",
    gradeAlpha: 0.06,
    accent: "rgba(255, 255, 255, 1)",
    vignette: 0.22,
    topGlow: "rgba(255, 255, 255, 0.04)",
  },
  stage: {
    id: "stage",
    label: "Stage",
    hint: "big-show stage glow, punchy lights",
    gradeTop: "rgba(70, 10, 96, 1)",
    gradeBottom: "rgba(120, 58, 10, 1)",
    gradeAlpha: 0.15,
    accent: "rgba(255, 200, 110, 1)",
    vignette: 0.3,
    topGlow: "rgba(255, 180, 90, 0.09)",
  },
};

const THEME_IDS: ThemeId[] = ["noir", "warm", "neon", "daylight", "stage"];
export const DEFAULT_THEME: ThemeId = "warm";

export function themeIds(): ThemeId[] {
  return THEME_IDS;
}

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && THEME_IDS.includes(v as ThemeId);
}

/**
 * §1 — exact end-brand alpha for a given reel time (pure + deterministic so the
 * harness can pin it). Returns 0 everywhere except the final END_BRAND_S of the
 * reel, where the wordmark fades in via smoothstep to a peak alpha of 0.72 and
 * dwells to the final frame. `total` = reel length in seconds.
 */
export function endBrandAlpha(reelT: number, total: number): number {
  if (!(total > 0)) return 0;
  const win = total - END_BRAND_S;
  if (reelT < win || reelT > total) return 0;
  const a = smoothstep((reelT - win) / END_BRAND_S);
  return clamp01(a * 0.72);
}

/**
 * Apply the chosen theme over the composed frame. Called once per rendered frame
 * (after the footage has been drawn), by BOTH the live preview and the exporter,
 * so what you see is exactly what gets exported.
 *
 * STEP C: NO opening is ever drawn at the reel head (the 2.0 default). The grade/
 * vignette are applied to every frame, and the §1 end-brand lockup is drawn over
 * the final footage when a `total` is provided.
 *
 * @param reelT seconds into the reel
 * @param total total reel length in seconds (drives the end-brand window); pass
 *        undefined to skip the end brand
 * @param _opening legacy flag — STEP C forces 2.0 OFF (opening forbidden).
 *        Kept for signature compatibility but always treated as false.
 */
export function applyTheme(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  themeId: ThemeId,
  reelT: number,
  total?: number,
  _opening = false
): void {
  const th = THEMES[themeId] ?? THEMES.warm;

  // ---- 1) subtle vertical grade (color cast) ----
  const g = ctx.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, rgbaScale(th.gradeTop, th.gradeAlpha));
  g.addColorStop(1, rgbaScale(th.gradeBottom, th.gradeAlpha));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cw, ch);

  // ---- 1b) optional faint top glow ----
  if (th.topGlow) {
    const glow = ctx.createLinearGradient(0, 0, 0, ch * 0.55);
    glow.addColorStop(0, th.topGlow);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, cw, ch);
  }

  // ---- 2) soft vignette ----
  if (th.vignette > 0) {
    const r = Math.max(cw, ch) * 0.72;
    const v = ctx.createRadialGradient(cw / 2, ch / 2, r * 0.38, cw / 2, ch / 2, r);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, `rgba(0,0,0,${th.vignette})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, cw, ch);
  }

  // NO opening treatment — the reel opens on footage from frame one.

  if (typeof total === "number" && total > 0) {
    drawEndBrand(ctx, cw, ch, th.accent, reelT, total);
  }
}

/**
 * §1 — the ONLY brand in the reel: a small bottom-center "Concert Compass"
 * wordmark (700 weight, 0.030*cw, alpha 0.72 at peak) that fades in over the
 * still-playing final footage for the last 1.2s. Optional thin theme-accent rule
 * 0.16*cw × 2px centered just below. NO scrim, NO pill, NO tagline, NO
 * fade-to-black — the footage stays fully visible underneath, ended on energy.
 */
function drawEndBrand(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  accent: string,
  reelT: number,
  total: number
): void {
  const a = endBrandAlpha(reelT, total);
  if (a <= 0.005) return;

  const size = Math.round(cw * 0.03);
  const baselineY = ch * 0.9;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  ctx.fillText("Concert Compass", cw / 2, baselineY);
  // thin accent rule centered just below the baseline (no shadow, no scale)
  const ruleW = cw * 0.16;
  const ruleH = Math.max(2, Math.round(ch * 0.0015));
  ctx.fillStyle = accent;
  ctx.fillRect(cw / 2 - ruleW / 2, baselineY + cw * 0.036, ruleW, ruleH);
  ctx.restore();
}

/** Multiply the alpha of an "rgba(r, g, b, a)" string by factor. */
function rgbaScale(rgba: string, factor: number): string {
  const m = rgba.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (!m) return rgba;
  const a = parseFloat(m[4]) * factor;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a.toFixed(3)})`;
}
