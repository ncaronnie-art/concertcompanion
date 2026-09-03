// Smart reframing (zoom-and-pan / "Ken Burns") for Concert Compass.
//
// Today the studio drew each clip's frames with a blind CENTER-CROP to the
// chosen output ratio. That wastes the frame on landscape source pushed into a
// 9:16 vertical reel: it keeps a static vertical strip down the middle, often
// missing the performer/action.
//
// This replaces the center crop with a lightweight, honest heuristic that
// reframes into the IMPORTANT part of the frame. We deliberately ship NO face /
// person-detection ML in this pass (that would need a heavy model). Instead the
// crop window tracks the horizontal/vertical *energy of motion* — a real
// frame-to-frame saliency proxy — blended toward the frame center so it stays
// conservative and never wanders off into empty space. A slow, subtle push-in
// (Ken Burns zoom) adds life across a cut without being gimmicky.
//
// Rules:
//   * Only reframe when there is actually slack in the "needs more width
//     (or height) than we have" direction — i.e. landscape source -> 9:16/4:5
//     output pan horizontally; portrait source -> 16:9 output pans vertically.
//   * When the source orientation already matches the output ratio, keep it
//     simple: no unnecessary re-crop (full-frame centered).
//   * Motion that is too weak/noisy falls back to a centered crop rather than
//     an awkward wandering frame.

export interface ReframeRect {
  sx: number; // source-x of the crop (px)
  sy: number; // source-y of the crop (px)
  sw: number; // source width of the crop (px)
  sh: number; // source height of the crop (px)
  zoom: number; // 1 = no zoom, >1 = pushed in
}

// Downsampling width for motion measurement. Small = cheap; ~40 cols is plenty
// to localize "which side of the frame the action is on".
const GRID = 40;
// Blend of pure frame-center vs the measured motion focus. 0.5 = center and
// motion weighted equally; keeps the crop honest when motion is diffuse.
const CENTER_BIAS = 0.5;
// Minimum per-pixel luminance change (0..255 scale) before we trust the motion
// profile at all — below this the "action" signal is just noise, so center.
const MOTION_FLOOR = 5;

// EDITORIAL (Build #2) — per-cut motion style (§5), each with its own Ken-Burns
// push (ZOOM_STEP / MAX_ZOOM) and pan drift. The pacing pass chooses a style
// per cut (QUICK→lively, HOLD→gentle, MID/OPENING_HIT→standard; wide-guard for
// 16:9→9:16; match-orientation when the source already fills the output ratio).
export type MotionStyle =
  | "gentle"
  | "standard"
  | "lively"
  | "wide-guard"
  | "match-orientation";

interface MotionConfig {
  zoomStep: number;
  maxZoom: number;
  drift: number; // 0 = stay centred (no pan)
}

const MOTION: Record<MotionStyle, MotionConfig> = {
  gentle: { zoomStep: 0.002, maxZoom: 1.08, drift: 0.03 },
  standard: { zoomStep: 0.0025, maxZoom: 1.12, drift: 0.045 },
  lively: { zoomStep: 0.004, maxZoom: 1.16, drift: 0.06 },
  "wide-guard": { zoomStep: 0.0025, maxZoom: 1.08, drift: 0.045 },
  "match-orientation": { zoomStep: 0.002, maxZoom: 1.06, drift: 0 },
};

/** Ease-in/out used to make each push start slow and settle, per §5 rules. */
function easeInOut(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalized (0..1) center of a motion profile, or -1 if there's no signal. */
function weightedCenter(profile: Float32Array): number {
  let w = 0;
  let acc = 0;
  let peak = 0;
  for (let i = 0; i < profile.length; i++) {
    w += profile[i];
    acc += profile[i] * i;
    if (profile[i] > peak) peak = profile[i];
  }
  if (w < 1e-6 || peak < MOTION_FLOOR) return -1;
  const norm = (acc / w + 0.5) / profile.length; // 0..1
  return norm;
}

/**
 * Per-run controller that keeps the crop state (smooth pan position + the Ken
 * Burns zoom) across an entire preview/export playback. Call `startCut()` at the
 * top of each clip so each cut begins wide and pushes in gently, then call
 * `update(el, cw, ch)` once per animation frame to get the exact source rect to
 * draw.
 */
export class ReframeController {
  private off: HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | null = null;
  private gridW = 0;
  private gridH = 0;
  private prev: Float32Array | null = null;
  private sx = 0;
  private sy = 0;
  private zoom = 1;
  private init = false;
  private cfg: MotionConfig = MOTION.standard;

  /** Convenience: pick a style for a source given the output size. Falls back to
   * the requested style for every case except two explicit overrides:
   *  * source ratio ≈ output ratio  → match-orientation (no pan, gentle push)
   *  * landscape source into a tall 9:16/4:5 output → wide-guard (let PAN work,
   *    restrain the zoom so we don't blow up a narrow vertical slice)
   * Call this at cut start with the segment's own motion style; it returns the
   * style to actually apply for this source/orientation.
   */
  static styleForSource(style: MotionStyle, vw: number, vh: number, ow: number, oh: number): MotionStyle {
    if (vw <= 0 || vh <= 0) return style;
    const srcRatio = vw / vh;
    const outRatio = ow / oh;
    if (Math.abs(srcRatio - outRatio) < 0.05) return "match-orientation";
    if (srcRatio > outRatio + 0.8) return "wide-guard";
    return style;
  }

  /** Called when beginning a new clip's playback: wide + relaxed, using the
   * handed style's push rate / max / drift. */
  startCut(style: MotionStyle = "standard") {
    this.cfg = MOTION[style] ?? MOTION.standard;
    this.init = false;
    this.zoom = 1;
    this.prev = null; // no frame-diff across a hard cut
  }

  /**
   * Given the current video frame and the output canvas size, return the source
   * rectangle to draw onto the canvas (0,0,cw,ch). Always a full "cover" fill;
   * when the source orientation matches the output it returns the simple
   * centered full frame.
   */
  update(el: HTMLVideoElement, cw: number, ch: number): ReframeRect {
    const vw = el.videoWidth || cw;
    const vh = el.videoHeight || ch;
    if (vw <= 0 || vh <= 0) {
      return { sx: 0, sy: 0, sw: vw || cw, sh: vh || ch, zoom: 1 };
    }

    // Natural cover crop (what a naive center-crop would do).
    const scale0 = Math.max(cw / vw, ch / vh);
    const sw0 = cw / scale0;
    const sh0 = ch / scale0;
    const hSlack = vw - sw0; // horizontal room we could pan into (>= 0)
    const vSlack = vh - sh0; // vertical room we could pan into (>= 0)
    const { maxZoom, zoomStep, drift } = this.cfg;

    // No slack anywhere -> source orientation matches output. Keep it centered
    // (never a wandering pan) but allow the style's gentle push (match-orientation
    // max 1.06) — checked by QA as "matching-orientation doesn't over-zoom".
    if (hSlack <= 1 && vSlack <= 1) {
      this.sx = (vw - sw0) / 2;
      this.sy = (vh - sh0) / 2;
      this.zoom = Math.min(maxZoom, this.zoom + zoomStep);
      const z = this.easedZoom();
      const sw = Math.min(sw0, sw0 / z);
      const sh = Math.min(sh0, sh0 / z);
      const outSx = (vw - sw) / 2;
      const outSy = (vh - sh) / 2;
      return { sx: outSx, sy: outSy, sw, sh, zoom: z };
    }

    // We have slack in one axis — reframe along the dominant (largest) axis.
    const horizontal = hSlack >= vSlack;
    const focus = this.measureMotion(el, vw, vh);

    let tx: number;
    let ty: number;
    if (horizontal) {
      // Vertical is fully covered (landscape -> 9:16/4:5), so the crop's height
      // spans the source; we only need to pick where horizontally.
      ty = (vh - sh0) / 2;
      const fx = focus.x > 0 ? focus.x : vw / 2; // center if no action signal
      tx = clamp(fx - sw0 / 2, 0, vw - sw0);
    } else {
      // Portrait source -> landscape output: pick where vertically.
      tx = (vw - sw0) / 2;
      const fy = focus.y > 0 ? focus.y : vh / 2;
      ty = clamp(fy - sh0 / 2, 0, vh - sh0);
    }

    // Ease the crop toward the target (the pan) instead of snapping. A
    // match-orientation/center style drifts toward the center.
    if (!this.init) {
      this.sx = tx;
      this.sy = ty;
      this.init = true;
    } else {
      this.sx += (tx - this.sx) * drift;
      this.sy += (ty - this.sy) * drift;
    }

    // Gentle push-in (Ken Burns), eased in/out, capped per style.
    this.zoom = Math.min(maxZoom, this.zoom + zoomStep);
    const z = this.easedZoom();

    // Apply the zoom: a smaller (more zoomed) source rect, recentred on the
    // current view so we push INTO what we're already showing, then clamp.
    const sw = Math.min(sw0, sw0 / z);
    const sh = Math.min(sh0, sh0 / z);
    const cx = clamp(this.sx + sw0 / 2, 0, vw - 1);
    const cy = clamp(this.sy + sh0 / 2, 0, vh - 1);
    const outSx = clamp(cx - sw / 2, 0, vw - sw);
    const outSy = clamp(cy - sh / 2, 0, vh - sh);
    return { sx: outSx, sy: outSy, sw, sh, zoom: z };
  }

  /** Eased zoom: `zoom` climbs ~linearly toward max, but we DISPLAY an in/out
   * eased version so the push starts slow and settles instead of a hard ramp. */
  private easedZoom(): number {
    const p = (this.zoom - 1) / Math.max(1e-6, this.cfg.maxZoom - 1);
    return 1 + (this.cfg.maxZoom - 1) * easeInOut(clamp(p, 0, 1));
  }

  /**
   * Downsample the frame to a small luminance grid and build per-column /
   * per-row motion profiles from the difference with the previous frame. The
   * weighted centers (blended toward frame-center) are our "where is the
   * action" proxy. Returns source-pixel focus points, or 0 to mean "no signal,
   * use center".
   */
  private measureMotion(
    el: HTMLVideoElement,
    vw: number,
    vh: number
  ): { x: number; y: number } {
    const gridH = Math.max(4, Math.round((GRID * vh) / vw));
    if (this.gridW !== GRID || this.gridH !== gridH) {
      this.gridW = GRID;
      this.gridH = gridH;
      this.prev = null;
    }
    if (!this.off) {
      this.off = document.createElement("canvas");
    }
    if (this.off.width !== GRID || this.off.height !== gridH) {
      this.off.width = GRID;
      this.off.height = gridH;
    }
    if (!this.offCtx) {
      this.offCtx = this.off.getContext("2d", { willReadFrequently: true });
    }
    if (!this.offCtx) return { x: 0, y: 0 };
    let data: Uint8ClampedArray;
    try {
      this.offCtx.drawImage(el, 0, 0, GRID, gridH);
      data = this.offCtx.getImageData(0, 0, GRID, gridH).data;
    } catch {
      return { x: 0, y: 0 };
    }
    const lum = new Float32Array(GRID * gridH);
    for (let i = 0; i < GRID * gridH; i++) {
      lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    const prev = this.prev;
    this.prev = lum;

    const colSum = new Float32Array(GRID);
    const rowSum = new Float32Array(gridH);
    if (prev) {
      for (let j = 0; j < GRID; j++) {
        let s = 0;
        for (let i = 0; i < gridH; i++) {
          const d = lum[i * GRID + j] - prev[i * GRID + j];
          s += d * d;
        }
        colSum[j] = Math.sqrt(s / gridH);
      }
      for (let i = 0; i < gridH; i++) {
        let s = 0;
        for (let j = 0; j < GRID; j++) {
          const d = lum[i * GRID + j] - prev[i * GRID + j];
          s += d * d;
        }
        rowSum[i] = Math.sqrt(s / GRID);
      }
    }

    let x = 0;
    let y = 0;
    const cx = weightedCenter(colSum);
    const cy = weightedCenter(rowSum);
    if (cx >= 0) {
      // Blend toward the frame center so we never chase pure noise.
      x = vw * (0.5 + (cx - 0.5) * (1 - CENTER_BIAS));
    } else {
      x = vw / 2;
    }
    if (cy >= 0) {
      y = vh * (0.5 + (cy - 0.5) * (1 - CENTER_BIAS));
    } else {
      y = vh / 2;
    }
    return { x, y };
  }
}
