// src/lib/edl.ts
// STEP D of the Concert Compass 2.0 pivot — USER EDITING CONTROL on the exposed
// Edit Decision List (EDL).
//
// STEP B (selection.ts) produces an ordered EditDecision[] (the Plan's EDV:
// segmentId/sourceFile/startTime/endTime/duration/score/reasonSelected/crop/
// transition/audioBehavior/flags/locked). STEP C adds Edit Modes + selection
// lean. This module adds the PHASE 9 user-control layer on top as PURE,
// deterministic, harness-testable operations over that EDL:
//
//   • regenerate   — a genuinely different (new seed + different priorities) but
//                    still-good edit; LOCKED rows survive.
//   • replace      — swap one non-locked slot for the next-best unused candidate
//                    that fits the same arc role + the duration budget.
//   • lock/unlock  — pin a row so it survives regenerate / replace / re-bias.
//   • reorder      — move a row up/down without breaking the budget.
//   • choose hook / choose ending — reassign the HOOK / END slot from strong
//                    alternative candidates.
//   • energy       — re-bias selection/scoring (0 calm … 1 hype) via the
//                    selection `energy` seam; LOCKED rows survive.
//   • shorten/lengthen — remap to a new 15/30/45/60 budget (re-select + trim).
//   • mute source audio — set per-row or global audioBehavior (keep_source|mute).
//
// The EDL is the single source of truth: the create.tsx UI renders these rows,
// calls these operations, and feeds the result back into the SAME client-side
// render/export pipeline via `edlToSegments` (reel.Segment[]). Everything is
// pure and deterministic given its inputs, so the no-browser harness can pin it.

import type { ClipSegmentResult, EditDecision, SegmentAnalysis } from "./segments";
import {
  categoryOf,
  consecutivelySimilar,
  MIN_SEL,
  pickSegments,
  roleForIndex,
  ROLE_DUR,
  selectSegmentEditions,
  unusable,
  type ArcRole,
  type EditModeId,
} from "./selection";
import type { Segment } from "./reel";

/** The full, serialisable editing state for the segment path. Persisted to
 *  sessiondb so user edits (rows + locks + mode + energy) survive a reload and
 *  the analyzed clips can be looked up again by `segmentById`. */
export interface EdlState {
  rows: EditDecision[];
  seed: number; // the selection seed this EDL was (re)generated with
  targetSeconds: number;
  mode: EditModeId;
  energy: number; // 0 calm … 1 hype (0.5 neutral)
  /** signature of the analyzed segment pool this EDL was built against, so a
   *  re-analysis (new clips) forces a rebuild even when target/mode/energy match */
  clipKey: string;
}

export interface EdlOpts {
  targetSeconds?: number;
  seed?: number;
  mode?: EditModeId;
  energy?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function clipKeyOf(allClips: ClipSegmentResult[]): string {
  return allClips.map((r) => `${r.clipId}:${r.segments.length}`).join("|");
}

export function segmentById(allClips: ClipSegmentResult[], id: string): SegmentAnalysis | null {
  for (const r of allClips) {
    const s = r.segments.find((x) => x.id === id);
    if (s) return s;
  }
  return null;
}

function totalOf(rows: EditDecision[]): number {
  return rows.reduce((s, r) => s + r.duration, 0);
}

function roleFor(i: number, n: number): ArcRole {
  return roleForIndex(i, n);
}

// ---------------------------------------------------------------------------
// (Re)generation
// ---------------------------------------------------------------------------

/** Fresh rows from the selection opts (no locks). */
export function buildBaseRows(allClips: ClipSegmentResult[], opts: EdlOpts = {}): EditDecision[] {
  return selectSegmentEditions(allClips, {
    targetSeconds: opts.targetSeconds ?? 30,
    seed: opts.seed ?? 1,
    mode: opts.mode,
    energy: opts.energy,
  }).map((r) => ({ ...r, locked: false }));
}

/** Ensure total duration ≤ target. Locked rows are trimmed only as a last
 *  resort and never dropped; non-locked rows are trimmed largest-first, then
 *  trailing non-locked rows are dropped if still over. */
function clampToBudget(rows: EditDecision[], allClips: ClipSegmentResult[], target: number): EditDecision[] {
  let out = rows.map((r) => ({ ...r }));
  let total = totalOf(out);
  if (total <= target) return out;

  const bySize = (xs: { i: number; r: EditDecision }[]) => xs.slice().sort((a, b) => b.r.duration - a.r.duration);
  const trimTo = (list: { i: number; r: EditDecision }[]) => {
    for (const o of list) {
      if (total <= target) break;
      const maxTrim = o.r.duration - MIN_SEL;
      const trim = Math.min(maxTrim, total - target);
      if (trim > 0) {
        const nd = +(o.r.duration - trim).toFixed(2);
        out[o.i] = { ...o.r, duration: nd, endTime: +(o.r.startTime + nd).toFixed(2) };
        total -= trim;
      }
    }
  };

  trimTo(bySize(out.map((r, i) => ({ i, r })).filter((x) => !x.r.locked)));
  if (total > target) trimTo(bySize(out.map((r, i) => ({ i, r })).filter((x) => x.r.locked)));
  if (total > target) {
    for (let i = out.length - 1; i >= 0 && total > target; i--) {
      if (out[i].locked) continue;
      total -= out[i].duration;
      out.splice(i, 1);
    }
  }
  void allClips;
  return out;
}

/** Core rebuild used by regenerate / re-bias / shorten: run a fresh selection
 *  for the requested opts, then keep every LOCKED row from `prev` (re-inserting
 *  any that the fresh set didn't pick), and clamp the whole thing to budget. */
export function reSelectPreserving(
  prev: EdlState | null,
  allClips: ClipSegmentResult[],
  opts: EdlOpts
): EdlState {
  const target = opts.targetSeconds ?? prev?.targetSeconds ?? 30;
  const seed = opts.seed ?? prev?.seed ?? 1;
  const mode = opts.mode ?? prev?.mode ?? "surprise-me";
  const energy = opts.energy ?? prev?.energy ?? 0.5;
  const clipKey = clipKeyOf(allClips);

  let out = buildBaseRows(allClips, { targetSeconds: target, seed, mode, energy });
  const lockedPins = (prev?.rows ?? [])
    .map((r, i) => ({ index: i, row: r }))
    .filter((x) => x.row.locked);

  for (const pin of lockedPins) {
    if (!segmentById(allClips, pin.row.segmentId)) continue; // clips changed — drop
    const idx = out.findIndex((r) => r.segmentId === pin.row.segmentId);
    if (idx >= 0) {
      out[idx] = { ...out[idx], locked: true };
      continue;
    }
    // not picked by the fresh selection — re-insert it near its old position.
    const at = Math.min(pin.index, out.length);
    const slot = { ...pin.row, locked: true };
    // don't clobber another locked row; push elsewhere if the target is locked.
    if (at < out.length && !out[at].locked) out[at] = slot;
    else out.push(slot);
  }

  out = clampToBudget(out, allClips, target);
  // refresh arc role labels so the UI shows the true role at each position
  out = out.map((r, i) => ({ ...r, reasonSelected: refreshReason(r, roleFor(i, out.length)) }));
  return { rows: out, seed, targetSeconds: target, mode, energy, clipKey };
}

/** Re-stamp the role prefix of a row's reason (the part before the first `|`)
 *  so reordered/re-slotted rows show their CURRENT arc role. */
function refreshReason(r: EditDecision, role: ArcRole): string {
  const after = r.reasonSelected.includes("|") ? r.reasonSelected.split("|").slice(1).join("|") : r.reasonSelected;
  return `${role}|${after}`;
}

// ---------------------------------------------------------------------------
// Per-segment editing operations
// ---------------------------------------------------------------------------

/** Replace a slot with the next-best unused candidate that fits the same arc
 *  role + the duration budget. Locked slots are never replaced. */
export function replaceSlot(allClips: ClipSegmentResult[], state: EdlState, index: number): EdlState {
  const rows = state.rows;
  if (index < 0 || index >= rows.length || rows[index].locked) return state;
  const cur = rows[index];
  const used = new Set(rows.map((r) => r.segmentId));
  const prevSeg = index > 0 ? segmentById(allClips, rows[index - 1].segmentId) : null;
  const nextSeg = index < rows.length - 1 ? segmentById(allClips, rows[index + 1].segmentId) : null;
  const role = roleFor(index, rows.length);
  const [rmin, rmax] = ROLE_DUR[role];
  const target = state.targetSeconds;
  const baseTotal = totalOf(rows);

  const cands: { s: SegmentAnalysis; dur: number }[] = [];
  for (const r of allClips) {
    for (const s of r.segments) {
      if (unusable(s.flags)) continue;
      if (s.id === cur.segmentId || used.has(s.id)) continue;
      let dur = Math.min(s.duration, rmax);
      if (baseTotal - cur.duration + dur > target) {
        dur = Math.max(rmin, dur - (baseTotal - cur.duration + dur - target));
      }
      if (dur < MIN_SEL) continue;
      if (baseTotal - cur.duration + dur > target) continue;
      if (prevSeg && consecutivelySimilar(s, prevSeg)) continue;
      if (nextSeg && consecutivelySimilar(s, nextSeg)) continue;
      cands.push({ s, dur: +dur.toFixed(2) });
    }
  }
  if (cands.length === 0) return state;

  // "next-best for the same arc slot": prefer the same category (keeps the role's
  // intended variety), then the highest-scoring candidate overall.
  const curSeg = segmentById(allClips, cur.segmentId);
  const curCat = curSeg ? categoryOf(curSeg) : null;
  cands.sort((a, b) => {
    const ac = curCat != null && categoryOf(a.s) === curCat ? 1 : 0;
    const bc = curCat != null && categoryOf(b.s) === curCat ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return b.s.highlightScore - a.s.highlightScore;
  });
  const pick = cands[0];
  const nrows = rows.slice();
  const n = {
    ...cur,
    segmentId: pick.s.id,
    sourceFile: pick.s.clipName ?? cur.sourceFile,
    clipId: pick.s.clipId,
    startTime: pick.s.start,
    endTime: +(pick.s.start + pick.dur).toFixed(2),
    duration: pick.dur,
    score: pick.s.highlightScore,
    reasonSelected: `${role}|${categoryOf(pick.s)}|replaced`,
    flags: pick.s.flags,
  };
  nrows[index] = n;
  return { ...state, rows: nrows };
}

export function lockRow(state: EdlState, index: number): EdlState {
  const rows = state.rows.slice();
  if (index >= 0 && index < rows.length) rows[index] = { ...rows[index], locked: true };
  return { ...state, rows };
}

export function unlockRow(state: EdlState, index: number): EdlState {
  const rows = state.rows.slice();
  if (index >= 0 && index < rows.length) rows[index] = { ...rows[index], locked: false };
  return { ...state, rows };
}

/** Move a row from → to (0-based), preserving every row's data and the budget
 *  (durations don't change, so total duration is invariant under reorder). */
export function reorderRows(state: EdlState, from: number, to: number): EdlState {
  const rows = state.rows.slice();
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length || from === to) return state;
  const [x] = rows.splice(from, 1);
  rows.splice(to, 0, x);
  // re-stamp roles after the user's reorder
  return { ...state, rows: rows.map((r, i) => ({ ...r, reasonSelected: refreshReason(r, roleFor(i, rows.length)) })) };
}

/** Choose a DIFFERENT opening HOOK from the strongest unused candidates. Locked
 *  hooks are not changed. */
export function setHook(allClips: ClipSegmentResult[], state: EdlState): EdlState {
  return setSlotFromCandidates(allClips, state, 0, "HOOK");
}

/** Choose a DIFFERENT ending (END slot) from strong unused candidates biased to
 *  the closing feel (crowd/wide/quiet). Locked END slots are not changed. */
export function setEnding(allClips: ClipSegmentResult[], state: EdlState): EdlState {
  return setSlotFromCandidates(allClips, state, state.rows.length - 1, "END");
}

function setSlotFromCandidates(allClips: ClipSegmentResult[], state: EdlState, index: number, role: ArcRole): EdlState {
  const rows = state.rows;
  if (rows.length === 0 || index < 0 || index >= rows.length || rows[index].locked) return state;
  const cur = rows[index];
  const used = new Set(rows.map((r) => r.segmentId));
  const target = state.targetSeconds;
  const baseTotal = totalOf(rows);
  const [rmin, rmax] = ROLE_DUR[role];

  const cands: { s: SegmentAnalysis; dur: number }[] = [];
  for (const r of allClips) {
    for (const s of r.segments) {
      if (unusable(s.flags)) continue;
      if (s.id === cur.segmentId || used.has(s.id)) continue;
      let dur = Math.min(s.duration, rmax);
      if (baseTotal - cur.duration + dur > target) {
        dur = Math.max(rmin, dur - (baseTotal - cur.duration + dur - target));
      }
      if (dur < MIN_SEL) continue;
      if (baseTotal - cur.duration + dur > target) continue;
      cands.push({ s, dur: +dur.toFixed(2) });
    }
  }
  if (cands.length === 0) return state;

  // rank: highest score, but for END bias the closing categories forward.
  const endCats = ["crowd", "wide", "quiet-cinematic"];
  cands.sort((a, b) => {
    const ac = role === "END" && endCats.includes(categoryOf(a.s)) ? 1 : 0;
    const bc = role === "END" && endCats.includes(categoryOf(b.s)) ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return b.s.highlightScore - a.s.highlightScore;
  });
  const pick = cands[0];
  const nrows = rows.slice();
  nrows[index] = {
    ...cur,
    segmentId: pick.s.id,
    sourceFile: pick.s.clipName ?? cur.sourceFile,
    clipId: pick.s.clipId,
    startTime: pick.s.start,
    endTime: +(pick.s.start + pick.dur).toFixed(2),
    duration: pick.dur,
    score: pick.s.highlightScore,
    reasonSelected: `${role}|${categoryOf(pick.s)}|${role === "HOOK" ? "hook" : "ending"}`,
    flags: pick.s.flags,
  };
  return { ...state, rows: nrows };
}

// ---------------------------------------------------------------------------
// Whole-reel editing operations
// ---------------------------------------------------------------------------

/** Set per-row (or all rows when `index < 0`) audioBehavior — "mute" mutes the
 *  source audio for that cut, "keep_source" keeps it. */
export function setAudible(
  state: EdlState,
  index: number,
  behavior: "keep_source" | "mute"
): EdlState {
  const rows = state.rows.map((r, i) => (index < 0 || i === index ? { ...r, audioBehavior: behavior } : r));
  return { ...state, rows };
}

/** Mute ALL rows (or just one when `index >= 0`). */
export function muteAll(state: EdlState, index = -1): EdlState {
  return setAudible(state, index, "mute");
}

/** Un->keep source audio for one row (or all). */
export function keepSourceAll(state: EdlState, index = -1): EdlState {
  return setAudible(state, index, "keep_source");
}

/** Re-bias the edit's energy (0 calm … 1 hype). LOCKED rows survive. */
export function setEnergy(allClips: ClipSegmentResult[], state: EdlState, energy: number): EdlState {
  const e = Math.max(0, Math.min(1, energy));
  return reSelectPreserving(state, allClips, { energy: e, targetSeconds: state.targetSeconds, seed: state.seed, mode: state.mode });
}

/** Change the Edit Mode style (re-selects with the mode's pacing/category lean;
 *  LOCKED rows survive). */
export function setMode(allClips: ClipSegmentResult[], state: EdlState, mode: EditModeId): EdlState {
  return reSelectPreserving(state, allClips, { mode, targetSeconds: state.targetSeconds, seed: state.seed, energy: state.energy });
}

/** Shorten/lengthen to a new 15/30/45/60 budget (re-select + trim-to-fit;
 *  LOCKED rows survive). Returns the new state. */
export function shortenLengthen(allClips: ClipSegmentResult[], state: EdlState, targetSeconds: number): EdlState {
  return reSelectPreserving(state, allClips, { targetSeconds, seed: state.seed, mode: state.mode, energy: state.energy });
}

/** Regenerate the whole edit with a new seed — a genuinely different (but
 *  still-good) selection/pacing, not a re-rolled transition. LOCKED rows
 *  survive wherever they still fit. */
export function regenerate(allClips: ClipSegmentResult[], state: EdlState): EdlState {
  return reSelectPreserving(state, allClips, {
    seed: (state.seed + 1) % 1_000_000,
    targetSeconds: state.targetSeconds,
    mode: state.mode,
    energy: state.energy,
  });
}

// ---------------------------------------------------------------------------
// Output for the existing render pipeline
// ---------------------------------------------------------------------------

/** Convert the editable EDL back into the shipped reel.Segment[] so the existing
 *  pacing (planPacing) + preview/export pipeline consumes the user's edits
 *  unchanged. Each row resolves to its SegmentAnalysis for attrs/fingerprint;
 *  the row's own startTime/endTime/duration drive what plays. */
export function edlToSegments(rows: EditDecision[], allClips: ClipSegmentResult[]): Segment[] {
  return rows.map((r) => {
    const s = segmentById(allClips, r.segmentId);
    const a = s?.attrs;
    const name = s?.clipName ?? r.sourceFile ?? "";
    return {
      id: r.segmentId,
      clipId: r.clipId,
      name,
      start: r.startTime,
      end: r.endTime,
      duration: r.duration,
      avgEnergy: a?.audioEnergy ?? 0.5,
      peakEnergy: a ? Math.min(1, a.audioEnergy * 1.12) : 0.5,
      avgVocal: 0.5,
      beatLock: a?.onsetBeat ?? 0.5,
      score: r.score,
      isDanceBreak: a ? a.onsetBeat > 0.6 : false,
      tags: s ? [categoryOf(s)] : [],
      songIndex: -1,
      songLabel: "",
      fingerprint: s ? [...s.fingerprint] : [],
      cutStyle: undefined,
      bpm: 0,
      attrs: a ? { ...a } : undefined,
      audioBehavior: r.audioBehavior,
    };
  });
}

// keep the import referenced for downstream callers
export type { EditDecision };
export { pickSegments };
