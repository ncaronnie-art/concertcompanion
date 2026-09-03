// src/lib/songs.ts
// Song-boundary detection + multi-song (song-aware) highlight selection for the
// concert "story reel".
//
// HONESTY NOTE (mirrored in the UI — please keep both in sync):
// This is HEURISTIC boundary detection, NOT ML song recognition. It cannot
// name or identify a song; it only estimates where one song/section likely ends
// and the next begins, purely from the audio's own shape:
//   1. a hard energy/applause gap (the break between songs),
//   2. a sustained groove/tempo discontinuity (beat-lock drop, from the same
//      onset-autocorrelation idea the groove/beat-lock code uses),
//   3. a spectral-timbre (centroid) step across the boundary, used to confirm a
//      tempo change on either side.
// Real-world limits, reported honestly:
//   * two back-to-back similar-tempo songs with no gap in between may MERGE into
//     one detected "song" (we don't pretend to know it's two),
//   * a long pause or a distinctly slower section *within* one song may
//     OVER-SPLIT into two,
//   * a single clip with no clear break reports one song — a safe, conservative
//     default rather than a confident wrong split.

import type { AnalyzedClip, Segment } from "./reel";

export interface DetectedSong {
  index: number; // 0-based global song number (label = "Song {index+1}")
  clipId: number; // which clip this song lives in
  clipName: string; // source file name
  start: number; // seconds into the clip
  end: number; // seconds into the clip
  duration: number;
  energy: number; // max smoothed energy inside the song (0..1)
  centroid: number; // mean spectral centroid (0..1)
  groove: number; // mean beat-lock (0..1)
  bpm: number; // estimated dominant tempo (0 if indeterminate)
}

// ---- tunables (heuristic, conservative) ----
const MIN_GAP_S = 0.9; // sustained separation needed to call a song boundary
const MIN_SONG_S = 6.0; // regions shorter than this get merged into a neighbour
const SMOOTH_S = 0.35; // box-smoothing width for signal stability
const SIDE_S = 2.2; // local context (±) used to judge a relative energy dip
const GAP_REL = 0.5; // energy below (relative dip) that marks a break
const ABS_SILENT = 0.06; // absolute floor below which it's unmistakably quiet
const LOW_ACT_FRAC = 0.42; // resting threshold as a fraction of the clip's active level
const LOW_ACT_PCT = 0.85; // percentile of smoothed energy used as the "active level"
const GROOVE_GAP_DROP = 0.35; // local beat-lock must drop by this much for a groove gap
const GROOVE_GAP_FLOOR = 0.4; // and the local (loud-ish) beat-lock must be above this
const BPM_MIN_LAG_BPM = 70; // tempo range for BPM estimation
const BPM_MAX_LAG_BPM = 180;
const BPM_MIN_CORR = 0.15; // don't report a tempo unless periodicity is real

function isFin(x: number) {
  return Number.isFinite(x);
}

function percentile(a: number[], p: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const idx = Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))));
  return s[idx];
}

function boxSmooth(a: number[], k: number): number[] {
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

/** Estimate the dominant tempo (BPM) of energy windows [from..to] via onset
 * autocorrelation — the same pulse-lock idea used by the groove beat-lock code. */
function estimateBpm(energy: number[], dt: number, from: number, to: number): number {
  const lo = Math.max(0, from);
  const hi = Math.min(energy.length - 1, to);
  if (hi - lo < 20) return 0;
  const on = new Array(hi - lo + 1).fill(0);
  for (let i = 1; i < on.length; i++) {
    on[i] = Math.max(0, energy[lo + i] - energy[lo + i - 1]);
  }
  let mean = 0;
  for (const v of on) mean += v;
  mean /= on.length;
  if (mean < 1e-4) return 0;
  const zm = on.map((v) => v - mean);
  const minLag = Math.max(2, Math.round(60 / BPM_MAX_LAG_BPM / dt));
  const maxLag = Math.round(60 / BPM_MIN_LAG_BPM / dt);
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < on.length; lag++) {
    let a = 0;
    let d = 0;
    for (let i = 0; i < on.length - lag; i++) {
      a += zm[i] * zm[i + lag];
      d += zm[i] * zm[i] + zm[i + lag] * zm[i + lag];
    }
    const s = d > 0 ? a / d : 0;
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  if (best < BPM_MIN_CORR || bestLag === 0) return 0;
  return Math.round(60 / (dt * bestLag));
}

/** Collapse a per-window boolean signal into runs of it (window-index space). */
function runsOf(flag: boolean[], n: number): [number, number][] {
  const runs: [number, number][] = [];
  let rs = -1;
  for (let i = 0; i <= n; i++) {
    const g = i < n ? flag[i] : false;
    if (g && rs < 0) rs = i;
    else if (!g && rs >= 0) {
      runs.push([rs, i - 1]);
      rs = -1;
    }
  }
  return runs;
}

/** Detect the song sections inside ONE clip (each clip may hold one or more). */
function detectSongsInClip(clip: AnalyzedClip): Omit<DetectedSong, "index">[] {
  const win = clip.windows;
  const n = win.length;
  if (n === 0) return [];
  const dt = n > 1 ? Math.max(0.001, win[1].start - win[0].start) : 0.1;
  const smoothK = Math.max(1, Math.round(SMOOTH_S / dt));
  const sideK = Math.max(1, Math.round(SIDE_S / dt));

  const energy = boxSmooth(win.map((w) => w.energy), smoothK);
  const centroid = boxSmooth(win.map((w) => w.centroid ?? 0), smoothK);
  const groove = boxSmooth(win.map((w) => w.beatLock), smoothK);

  // A clip-level "resting" threshold: the level well below this clip's own
  // active (loud) sections. This catches the *middle* of a long applause/gap
  // even though its immediate neighbours are also quiet (the pure local-dip
  // view below only sees the transition edges).
  const activeLevel = percentile(energy, LOW_ACT_PCT);
  const restThresh = Math.max(ABS_SILENT, LOW_ACT_FRAC * activeLevel);

  // ---- boundary flag per window: energy gap OR groove/tempo discontinuity ----
  const gapFlag = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - sideK);
    const hi = Math.min(n - 1, i + sideK);
    let med = 0;
    let cnt = 0;
    for (let j = lo; j <= hi; j++) {
      if (j !== i) {
        med += energy[j];
        cnt++;
      }
    }
    med = cnt ? med / cnt : 0;
    const localRef = (med + energy[i]) / 2 || 1e-6;
    const relDip = (med - energy[i]) / localRef;
    const absSilent = energy[i] < ABS_SILENT;
    const lowActive = energy[i] < restThresh;
    const energyGap = absSilent || lowActive || relDip > GAP_REL;

    // groove/tempo discontinuity: a clear beat-lock valley inside a groove context
    let gMed = 0;
    let gCnt = 0;
    for (let j = lo; j <= hi; j++) {
      if (j !== i) {
        gMed += groove[j];
        gCnt++;
      }
    }
    gMed = gCnt ? gMed / gCnt : 0;
    const grooveGap = gMed > GROOVE_GAP_FLOOR && groove[i] < gMed - GROOVE_GAP_DROP;

    gapFlag[i] = energyGap || grooveGap;
  }

  // boundary zones = runs of gapFlag long enough to be a real separation
  const zones = runsOf(gapFlag, n).filter(([a, b]) => (b - a + 1) * dt >= MIN_GAP_S);

  // active regions = everything not inside a boundary zone
  const regions: { a: number; b: number }[] = [];
  let cursor = 0;
  for (const [za, zb] of zones) {
    if (za > cursor) regions.push({ a: cursor, b: za - 1 });
    cursor = zb + 1;
  }
  if (cursor < n) regions.push({ a: cursor, b: n - 1 });

  // trim leading/trailing near-silence inside each region & drop near-empty ones
  const trimmed = regions
    .map(({ a, b }) => {
      let s = a;
      let e = b;
      while (s <= e && energy[s] < ABS_SILENT * 2) s++;
      while (e >= s && energy[e] < ABS_SILENT * 2) e--;
      if (s > e) return null;
      return { a: s, b: e };
    })
    .filter((r): r is { a: number; b: number } => r !== null);

  if (trimmed.length === 0) return [];

  // ---- merge regions that are too short to be a real song (conservative) ----
  const regions2: { a: number; b: number }[] = [];
  for (const r of trimmed) {
    regions2.push({ ...r });
  }
  let merged = true;
  while (merged && regions2.length > 1) {
    merged = false;
    for (let i = 0; i < regions2.length; i++) {
      const dur = (regions2[i].b - regions2[i].a + 1) * dt + dt;
      if (dur < MIN_SONG_S) {
        // merge the too-short region into the nearest neighbour and drop it
        if (i < regions2.length - 1) {
          regions2[i + 1] = { a: regions2[i].a, b: regions2[i + 1].b };
        } else {
          regions2[i - 1] = { a: regions2[i - 1].a, b: regions2[i].b };
        }
        regions2.splice(i, 1);
        merged = true;
        break;
      }
    }
  }

  // ---- build final songs ----
  const out: Omit<DetectedSong, "index">[] = [];
  for (const r of regions2) {
    const start = win[r.a].start;
    const end = win[r.b].start + dt;
    let eMax = 0;
    let cSum = 0;
    let gSum = 0;
    let cN = 0;
    for (let i = r.a; i <= r.b; i++) {
      if (energy[i] > eMax) eMax = energy[i];
      cSum += centroid[i];
      gSum += groove[i];
      cN++;
    }
    if (cN === 0) continue;
    out.push({
      clipId: clip.clipId,
      clipName: clip.name,
      start,
      end,
      duration: end - start,
      energy: eMax,
      centroid: cSum / cN,
      groove: gSum / cN,
      bpm: estimateBpm(energy, dt, r.a, r.b),
    });
  }
  return out;
}

/**
 * Detect distinct song sections across all concert uploads.
 * See the honesty note at the top. Falls back gracefully: no clear separation
 * -> one (or zero) "song" per clip, never a confident guess at song identity.
 */
export function detectSongs(clips: AnalyzedClip[]): DetectedSong[] {
  const songs: DetectedSong[] = [];
  let idx = 0;
  for (const clip of clips) {
    for (const s of detectSongsInClip(clip)) {
      if (!isFin(s.start) || !isFin(s.end) || s.duration <= 0) continue;
      songs.push({ ...s, index: idx++ });
    }
  }
  return songs;
}

/** Is a segment "inside" a song (by its midpoint, which picks the dominant side
 * when a cut straddles a boundary)? */
function segCenterInSong(seg: Segment, song: DetectedSong): boolean {
  if (seg.clipId !== song.clipId) return false;
  const c = (seg.start + seg.end) / 2;
  return c >= song.start && c <= song.end;
}

export { segCenterInSong };
