// src/lib/editmodes.ts
// STEP C (2.0) — EDIT MODES (replaces "vibes").
//
// A mode is a full editing directive chosen up-front: pacing profile +
// transition policy/whitelist + numeric EditorialBias + modeTargetAvg + theme
// suggestion + category lean. The 5 Plan modes (Cinematic / Hype / Memory /
// Music Video / Surprise Me) replace the old 4 vibes (auto/dance/ballad/bigshow).
//
// HONESTY: these are creative/editorial presets — a human-curated mapping of
// "the show's character" to pacing/transition/theme choices. They are NOT an ML
// genre classifier. Surprise Me auto-picks a mode from the footage's pooled
// stats by a simple rule (below) and the UI says exactly that.

import type { EditorialBias, TransitionPolicy } from "./editorial";
import { densityForPace, HARD_CUT_ONLY_POLICY } from "./editorial";
import type { ThemeId } from "./theme";
import type { EditModeId } from "./selection";
import type { ClipSegmentResult } from "./segments";
import type { TransitionType } from "./transitions";

/** Calm modes (Cinematic, Memory): dissolve (+ rare flash), density 1/6. */
function calmPolicy(pace: "cool" | "standard"): TransitionPolicy {
  const allowed: TransitionType[] = ["DISSOLVE", "FLASH"];
  return { allowed, density: densityForPace(pace) };
}
/** Hot modes (Hype, Music Video): whip + beat-cut (+ flash), density 1/4. */
function hotPolicy(): TransitionPolicy {
  const allowed: TransitionType[] = ["WHIP", "BEAT_CUT", "FLASH"];
  return { allowed, density: densityForPace("hot") };
}

export interface EditMode {
  id: EditModeId;
  label: string;
  tagline: string;
  emoji: string;
  themeSuggestion: ThemeId;
  bias: EditorialBias;
  transitions: TransitionPolicy;
  modeTargetAvg: number;
  desc: string; // short UI description of the editing feel
}

export const EDIT_MODES: Record<EditModeId, EditMode> = {
  cinematic: {
    id: "cinematic",
    label: "Cinematic",
    tagline: "Long hero moments, atmosphere, stage production.",
    emoji: "🎬",
    themeSuggestion: "noir",
    bias: { pace: "cool", durationScale: 1.25, whippiness: -0.6, motion: "gentle" },
    transitions: calmPolicy("cool"),
    modeTargetAvg: 2.9,
    desc: "Fewer, longer shots; wide + lighting + close performer; one big hero at the peak; dissolves only between calm cuts.",
  },
  hype: {
    id: "hype",
    label: "Hype",
    tagline: "Fast cuts, crowd energy, beat sync, dramatic lighting.",
    emoji: "🔥",
    themeSuggestion: "neon",
    bias: { pace: "hot", durationScale: 0.8, whippiness: 0.8, motion: "lively" },
    transitions: hotPolicy(),
    modeTargetAvg: 1.6,
    desc: "Rapid cuts dominate; the HOOK is the biggest drop; whips + flashes + beat-cuts; the most cuts.",
  },
  memory: {
    id: "memory",
    label: "Memory",
    tagline: "Balanced; emotional moments, friends/crowd, performer, atmosphere.",
    emoji: "💛",
    themeSuggestion: "warm",
    bias: { pace: "standard", durationScale: 1, whippiness: 0.1, motion: "standard" },
    transitions: calmPolicy("standard"),
    modeTargetAvg: 2.2,
    desc: "Balanced NORMAL mix with occasional HERO for quiet-cinematic; held crowd/friends PAYOFF/END; dissolves only.",
  },
  "music-video": {
    id: "music-video",
    label: "Music Video",
    tagline: "Strongest beat sync, visual variety, motion matching.",
    emoji: "🎵",
    themeSuggestion: "stage",
    bias: { pace: "hot", durationScale: 0.9, whippiness: 0.35, motion: "lively" },
    transitions: hotPolicy(true),
    modeTargetAvg: 1.8,
    desc: "Rapid cuts snapped to onsets; wide↔close↔lighting variety; every cut may be beat-locked.",
  },
  "surprise-me": {
    id: "surprise-me",
    label: "Surprise Me",
    tagline: "We pick the best fit for your footage.",
    emoji: "🎲",
    themeSuggestion: "warm",
    bias: { pace: "standard", durationScale: 1, whippiness: 0, motion: "standard" },
    transitions: HARD_CUT_ONLY_POLICY, // resolved at runtime to the chosen mode's policy
    modeTargetAvg: 2.2,
    desc: "We analyse your footage's energy/beat/crowd/lighting and auto-select the best mode for it.",
  },
};

export const MODE_ORDER: EditModeId[] = [
  "cinematic",
  "hype",
  "memory",
  "music-video",
  "surprise-me",
];

export const DEFAULT_MODE: EditModeId = "surprise-me";

export function editModeIds(): EditModeId[] {
  return MODE_ORDER;
}

export function isEditModeId(v: unknown): v is EditModeId {
  return typeof v === "string" && (MODE_ORDER as string[]).includes(v);
}

/** The EditorialBias a mode applies. */
export function biasFor(mode: EditModeId): EditorialBias {
  return (EDIT_MODES[mode] ?? EDIT_MODES["surprise-me"]).bias;
}

/** The TransitionPolicy a mode applies (its whitelist + density). */
export function transitionsFor(mode: EditModeId): TransitionPolicy {
  return (EDIT_MODES[mode] ?? EDIT_MODES["surprise-me"]).transitions;
}

/** Theme suggestion for a mode (user stays free to override). */
export function themeFor(mode: EditModeId): ThemeId {
  return (EDIT_MODES[mode] ?? EDIT_MODES["surprise-me"]).themeSuggestion;
}

/** Target average cut length a mode aims for. */
export function targetAvgFor(mode: EditModeId): number {
  return (EDIT_MODES[mode] ?? EDIT_MODES["surprise-me"]).modeTargetAvg;
}

/** §4 legacy vibe → mode mapping (guide only; old session `vibe` migrates this
 * way so the intent isn't lost). */
export function modeFromLegacyVibe(vibe: string): EditModeId {
  switch (vibe) {
    case "dance":
      return "music-video";
    case "bigshow":
      return "hype";
    case "ballad":
      return "memory";
    case "auto":
    default:
      return "surprise-me";
  }
}

/**
 * §4 ⑤ — Surprise Me auto-choose. Compute pooled stats across all analysed
 * footage and pick the best-fit mode:
 *   mean energy ≥ 0.6 AND onsetBeat ≥ 0.55 → music-video
 *   else high crowd + high energy                              → hype
 *   else low energy (≤0.35) + high stability + low shake       → cinematic
 *   else                                                       → memory
 * Returns one of the four concrete modes (never "surprise-me" itself).
 */
export function surpriseModeFromClips(clipResults: ClipSegmentResult[] | null | undefined): EditModeId {
  const all = (clipResults ?? []).flatMap((r) => r.segments);
  if (all.length === 0) return "memory";
  const mean = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const energy = mean(all.map((s) => s.attrs.audioEnergy));
  const onset = mean(all.map((s) => s.attrs.onsetBeat));
  const crowd = mean(all.map((s) => s.attrs.crowd));
  const stability = mean(all.map((s) => s.attrs.stability));
  const visualMotion = mean(all.map((s) => s.attrs.visualMotion));
  const lightShare = all.filter((s) => s.attrs.lightChange >= 0.72).length / all.length;
  const shake = visualMotion; // low visual motion ≈ low shake proxy

  if (energy >= 0.6 && onset >= 0.55) return "music-video";
  if (crowd >= 0.6 && energy >= 0.55) return "hype";
  if (energy <= 0.35 && stability >= 0.6 && shake <= 0.35 && lightShare < 0.5) return "cinematic";
  return "memory";
}

/** Resolve an effective mode: Surprise Me collapses to the footage-determined
 * mode; every other mode returns itself. */
export function resolvedMode(mode: EditModeId, clipResults: ClipSegmentResult[] | null | undefined): EditModeId {
  return mode === "surprise-me" ? surpriseModeFromClips(clipResults) : mode;
}
