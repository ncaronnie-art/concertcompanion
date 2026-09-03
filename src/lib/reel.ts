// Client-side "reel engine" for Concert Compass.
// All analysis happens in the browser: we decode each uploaded clip with the
// Web Audio API, build a per-window feature profile (loudness, spectral
// vocal-presence, groove/beat-lock), find the high-energy "dance break" runs,
// score every candidate segment, and select the strongest slices into a rough
// cut. Nothing is sent to a server.
//
// HONESTY NOTE ON VOCAL DETECTION
// --------------------------------
// This ships with a **spectral heuristic vocal-presence estimator**, NOT a
// trained ML separation model. Running a real source-separation NN
// (e.g. Demucs/Spleeter) in-browser would need a large ONNX model and a lot of
// WASM/GPU compute that would blow up page load and the modest build machine,
// so we deliberately do not claim ML vocal separation here.
//
// What `estimateVocalScore` actually does:
//   * Framed FFT per 0.1s window -> power spectrum.
//   * Pitch/voicing detection via the autocorrelation of that spectrum
//     (Wiener-Khinchin): a clear peak in the lead-vocal lag range (f0 from
//     ~90 Hz to ~1000 Hz) indicates sustained, periodic (voiced) content.
//   * Spectral-flatness analysis: a tonal signal has low flatness; broadband
//     crowd noise has high flatness -> we discount broadband noise.
//   * Lead-vocal band energy ratio (energy concentrated in ~200-4000 Hz, the
//     speech/singing formant range) vs total energy.
//
// This reliably separates *broadband crowd/PA noise* from *sustained tonal
// lead content* (singing, melody, vocals), which is the "filters out audience
// noise" promise. It CANNOT tell a singing voice apart from a solo instrument
// (both are tonal) -- that genuinely needs ML and is honest roadmap territory.
// UI copy must reflect this.

import { segCenterInSong, type DetectedSong } from "./songs";
import {
  analyzeSegments,
  segWindowsFromClip,
  type ClipSegmentResult,
  type SegmentAttributes,
} from "./segments";

export interface Window {
  start: number; // seconds into the clip
  rms: number; // normalized loudness 0..1
  energy: number; // smoothed scored energy 0..1 (basis for ranking)
  onset: number; // normalized positive energy rise per window (beat/onset activity)
  peak: boolean; // above the rolling high-energy threshold
  vocal: number; // spectral vocal-presence estimate 0..1
  beatLock: number; // steady-groove regularity 0..1
  centroid: number; // normalized spectral centroid 0..1 (song-boundary signal)
}

export interface Segment {
  id: string;
  clipId: number; // index into the uploaded file list
  name: string; // source file name
  start: number;
  end: number;
  duration: number;
  avgEnergy: number;
  peakEnergy: number;
  avgVocal: number;
  beatLock: number;
  score: number;
  isDanceBreak: boolean;
  tags: string[]; // "vocals heavy" | "dance break" | "steady groove" | ...
  songIndex: number; // 0-based index of the detected song this cut belongs to (-1 if none)
  songLabel: string; // "Song 1" / "Song 2" / … ("" if none) — set by song-aware selection
  // coarse spectral fingerprint (normalized log band energies) used for
  // anti-repetition / near-duplicate detection across the reel
  fingerprint: number[];
  // EDITORIAL (Build #2): filled AFTER selection by the pacing pass — the beat
  // class / duration-class this cut will play under, and the estimated BPM of
  // the song it belongs to (for song-handoff magnitude decisions).
  cutStyle?: "QUICK" | "MID" | "HOLD" | "OPENING_HIT";
  bpm?: number; // 0 = indeterminate
  // STEP C (2.0, segment path): when this cut came from the segment-level
  // picker (STEP B) it carries the full SegmentAttributes set so editorial
  // (pacing + the transition trigger table) reads real signal, not just the
  // legacy avg/beatLock/averageVocal coarse fields. Undefined for the legacy
  // coverage path (falls back to the legacy field mapping).
  attrs?: SegmentAttributes;
  // STEP D (2.0, segment path): the EDL's per-cut audio override — "mute"
  // silences ONLY this cut's source audio in the exported/review audio bed;
  // "keep_source" (default) keeps it audible. Undefined for the legacy path.
  audioBehavior?: string;
}

export interface AnalyzedClip {
  clipId: number;
  name: string;
  duration: number;
  windows: Window[];
  segments: Segment[]; // candidate high-energy slices, not yet selected
  // STEP A (2.0 pivot): break each clip into change-driven candidate MOMENTS and
  // score each on the Plan's attribute set + reject flags. Audio-first (visual
  // fields neutral) — see segments.ts. STEP B will select against these.
  segmentAnalysis?: ClipSegmentResult;
}

const WINDOW_SECONDS = 0.1; // 100ms analysis windows (~loudness response)
const MERGE_GAP = 1.0; // merge peak runs separated by < 1s
// EDITORIAL reset (Build #2): the old 3.0s floor forced every cut to be a full
// "moment", so a 24-clip reel could never get the dense, varied rhythm the owner
// wanted. Segments may now be as short as 2.0s (selection can trim dance-break /
// peak slices down to the 1.5s QUICK floor); MID/HOLD stay ≥2.0s+ by the pacing
// pass (coverage MID keeps a 3s "substantial moment" bar — see MIN_CUT_FLOOR).
const MIN_CUT = 2.0; // shortest usable candidate segment, seconds
const MAX_CUT = 14.0; // longest single cut, seconds
// Cap on spectral windows computed (bounds CPU for very long clips; a stride
// covers the rest). ~1 FFT+IFFT per analyzed window.
const MAX_FEAT_WINDOWS = 2200;

function avg(a: number[]) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function stdev(a: number[]) {
  const m = avg(a);
  return Math.sqrt(avg(a.map((v) => (v - m) * (v - m))));
}

/** p-th percentile (0..1) of a numeric array (p=0.5 → median). Used by the
 * relaxed candidate gate below to guarantee every audible clip contributes
 * candidates. */
function percentileValue(a: number[], p: number): number {
  const n = a.length;
  if (n === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const idx = Math.max(0, Math.min(n - 1, Math.round(p * (n - 1))));
  return s[idx];
}

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Mix an AudioBuffer down to mono and return its samples. */
function monoData(buffer: AudioBuffer): Float32Array {
  const ch = Math.min(buffer.numberOfChannels, 2);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i];
  }
  if (ch > 1) for (let i = 0; i < out.length; i++) out[i] /= ch;
  return out;
}

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

// ---------------------------------------------------------------- FFT infra

/** Iterative radix-2 in-place FFT on a Float64Array. `inverse` for IFFT. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  if (n === 0 || (n & (n - 1)) !== 0) return;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len * (inverse ? 1 : -1);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const uR = re[i + k];
        const uI = im[i + k];
        const vR = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vI = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = uR + vR;
        im[i + k] = uI + vI;
        re[i + k + len / 2] = uR - vR;
        im[i + k + len / 2] = uI - vI;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) re[i] /= n;
}

// Audio-band edges for the coarse spectral fingerprint & vocal-band ratio.
const BANDS_HZ = [0, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const VOCAL_BAND_LO = 200; // Hz
const VOCAL_BAND_HI = 4000; // Hz
const F0_LO = 90; // Hz — lowest lead-vocal fundamental we track
const F0_HI = 1000; // Hz

interface SpectralFeatures {
  vocal: number;
  centroid: number; // normalized 0..1 spectral centroid
  fingerprint: number[]; // 8-dim normalized log band energies
}

/**
 * Spectral vocal-presence estimate for one window of samples.
 * See the honesty note at the top of the file.
 */
export function spectralFeatures(samples: Float32Array, sr: number): SpectralFeatures {
  const n = samples.length;
  if (n === 0) return { vocal: 0, centroid: 0, fingerprint: zeros(8) };
  // zero-pad to power of two
  let fftN = 1;
  while (fftN < n) fftN <<= 1;
  if (fftN < 256) fftN = 256;
  const re = new Float64Array(fftN);
  const im = new Float64Array(fftN);
  for (let i = 0; i < n; i++) re[i] = samples[i];

  // power spectrum via FFT
  fft(re, im, false);
  const mag = new Float64Array(fftN / 2);
  let totalEnergy = 0;
  for (let i = 0; i < fftN / 2; i++) {
    const p = re[i] * re[i] + im[i] * im[i];
    mag[i] = p;
    totalEnergy += p;
  }
  if (totalEnergy <= 1e-12)
    return { vocal: 0, centroid: 0, fingerprint: zeros(8) };

  // ---- band energies + fingerprint ----
  const binHz = sr / fftN;
  const bandE = new Array(BANDS_HZ.length - 1).fill(0);
  let vocalBandE = 0;
  let weightedFreq = 0;
  for (let b = 1; b < BANDS_HZ.length; b++) {
    const lo = Math.floor(BANDS_HZ[b - 1] / binHz);
    const hi = Math.min(mag.length - 1, Math.ceil(BANDS_HZ[b] / binHz));
    let e = 0;
    for (let k = lo; k < hi; k++) {
      e += mag[k];
      const f = k * binHz;
      if (b >= 2 && b <= 6) {
        // llama: use vocal formant band separately below
      }
      weightedFreq += mag[k] * f;
    }
    bandE[b - 1] = e;
    const fLo = BANDS_HZ[b - 1];
    const fHi = BANDS_HZ[b];
    if (fHi > VOCAL_BAND_LO && fLo < VOCAL_BAND_HI) {
      const loC = Math.max(fLo, VOCAL_BAND_LO) / binHz;
      const hiC = Math.min(fHi, VOCAL_BAND_HI) / binHz;
      const loK = Math.max(0, Math.floor(loC));
      const hiK = Math.min(mag.length - 1, Math.ceil(hiC));
      for (let k = loK; k < hiK; k++) vocalBandE += mag[k];
    }
  }
  const vocalBandRatio = totalEnergy > 0 ? vocalBandE / totalEnergy : 0;
  const centroidNorm = totalEnergy > 0 ? clamp01(weightedFreq / totalEnergy / (sr / 2)) : 0;

  // fingerprint: log band energies, L2-normalized
  const fp = bandE.map((e) => Math.log1p(e));
  const fpNorm = Math.sqrt(fp.reduce((s, v) => s + v * v, 0)) || 1;
  const fingerprint = fp.map((v) => v / fpNorm);

  // ---- spectral flatness (tonal vs noisy) ----
  // geometric mean / arithmetic mean over vocal band bins; noise -> ~1
  const loK = Math.max(1, Math.floor(VOCAL_BAND_LO / binHz));
  const hiK = Math.min(mag.length - 1, Math.ceil(VOCAL_BAND_HI / binHz));
  let logSum = 0;
  let arith = 0;
  let cnt = 0;
  for (let k = loK; k <= hiK; k++) {
    const p = mag[k] + 1e-14;
    logSum += Math.log(p);
    arith += p;
    cnt++;
  }
  const flatness =
    cnt > 0 ? Math.exp(logSum / cnt) / (arith / cnt + 1e-14) : 1;
  const tonal = clamp01(1 - flatness * 1.4); // low flatness -> tonal

  // ---- autocorrelation of the window via Wiener-Khinchin ----
  // Proper approach: IFFT of the FULL |X(f)|^2 spectrum (conjugate-symmetric
  // length-feftN array), which yields the true autocorrelation R[lag].
  const N = re.length;
  const pRe = new Float64Array(N);
  const pIm = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    pRe[i] = re[i] * re[i] + im[i] * im[i];
    pIm[i] = 0;
  }
  fft(pRe, pIm, true); // IFFT of power spectrum -> autocorrelation in pRe
  // search for a pitch peak over the vocal f0 lag range
  const lagLo = Math.max(1, Math.floor(sr / F0_HI)); // ~44 samples @44.1k
  const lagHi = Math.min(N - 1, Math.ceil(sr / F0_LO)); // ~490 samples
  let peakVal = 0;
  let peakSum = 0;
  let c = 0;
  for (let lag = lagLo; lag <= lagHi; lag++) {
    const v = pRe[lag];
    peakSum += v;
    c++;
    if (v > peakVal) peakVal = v;
  }
  const peakMean = c ? peakSum / c : 0;
  const ac0 = pRe[0];
  // prominence of the best pitch peak over the lag-range mean, normalized
  let prom = 0;
  if (ac0 > 1e-12 && peakVal > peakMean) {
    // peak prominence relative to the lag-floor, scaled by the total energy
    prom = clamp01(((peakVal - (peakMean * 1.15)) / (ac0 - (peakMean * 1.15))) * 1.6);
  }

  // ---- combine into vocal presence 0..1 ----
  // need: periodic (pitch prominence), tonal (low flatness), and content
  // concentrated in the lead-vocal band. Broadband crowd noise has almost no
  // spectral periodicity and near-flat spectrum, so it scores low.
  const vocal =
    prom * 0.62 +
    tonal * 0.22 +
    clamp01(vocalBandRatio * 1.5) * 0.16;
  const vocalScore = clamp01(vocal);
  return { vocal: vocalScore, centroid: centroidNorm, fingerprint };
}

function zeros(n: number) {
  return new Array(n).fill(0);
}

// ---------------------------------------------------------------------------
// Audio decode robustness
// ---------------------------------------------------------------------------
//
// decodeAudioData (Web Audio's file decoder) can't decode every real-world
// phone clip. Common failures:
//   * iPhone/Android HEVC (H.265) MOV/MP4 recordings: the Web Audio demuxer
//     only accepts a handful of well-formed containers/codecs and rejects the
//     rest with "The given ArrayBuffer is not supported".
//   * Safari: decodeAudioData famously fails to decode *audio out of a video
//     file* even when the same clip plays fine in a <video>/<audio> element.
//
// Primary path stays decodeAudioData (fast, off-main-thread decode). When it
// fails we fall back to letting the browser's native media engine play the
// clip through a hidden element and capture the PCM.
//
// FAST-FALLBACK RESET (major build): the old fallback captured in REALTIME
// (wall-clock == clip length) — a 5-min clip took ~5 min. That's the root-cause
// bottleneck this build fixes. Instead we capture at an elevated playbackRate
// (up to 8×: set el.playbackRate = rate before play) so a clip's audio rushes
// through the capture graph in `length/rate` wall-seconds, then we linearly
// re-time-stretch the captured PCM back to its original duration/tempo/pitch.
// Because the downstream analysis (RMS / vocal / groove) is duration-normalized
// (per-0.1s windows) and our stretch restores the original frequencies, the
// 0.1s windows and the vocal f0 search return to the same place they would have
// with a 1× capture. Net: seconds, not minutes, on typical clips.
//
// Why not OfflineAudioContext? An OfflineAudioContext would render faster than
// realtime, but it can only pull from a MediaElementAudioSourceNode / decoded
// buffer it already holds — it cannot grant decodeAudioData new codecs that the
// browser's file demuxer rejects, and it still needs the media element playing
// internally. Resampling a <video>-spawned MediaStream into an offline graph is
// not portable. The playbackRate capture covers every browser that can play the
// file at all, which is exactly the fallback's contract.

const FALLBACK_MAX_SECONDS = 1200; // with rate-up capture this is ~2.5 min worst case @8×
const FALLBACK_DEMUX_TIMEOUT = 8000; // ms to wait for metadata/canplay
const FALLBACK_PLAY_GRACE = 8000; // ms past the clip end allowed before giving up
// Target wall-clock budget for capturing one realtime-fallback clip.
const FALLBACK_WALL_BUDGET = 20; // seconds — a clip up to ~160s captures in ≤20s
const FALLBACK_MAX_RATE = 8; // cap the elevate so high rates don't break the element pipeline

interface CapturedAudio {
  data: Float32Array; // mono PCM (already re-time-stretched back to original length)
  sampleRate: number;
}

/**
 * Linearly re-time-stretch `data` (captured while the source was playing at
 * `captureRate`×) back to the original clock. Playing a clip at rate R
 * time-compresses it (wall time = length/R) and pitch-shifts it up (×R); a
 * linear-interpolation resample by factor R stretches it back — original
 * length, original pitch, original timing. Cheap one-pass, no dependency.
 * A mild low-pass from the interpolation is acceptable for a heuristic
 * energy/vocal/groove pipeline (we re-run spectral analysis AFTER the stretch,
 * so the vocal f0 lag search sees the restored frequencies).
 */
export function restretchPCM(data: Float32Array, captureRate: number): Float32Array {
  if (captureRate <= 1 || data.length === 0) return data;
  const outLen = Math.max(1, Math.round(data.length * captureRate));
  const out = new Float32Array(outLen);
  const last = data.length - 1;
  for (let o = 0; o < outLen; o++) {
    const pos = o / captureRate; // position in the captured array
    const i0 = Math.min(last, Math.floor(pos));
    const i1 = Math.min(last, i0 + 1);
    const frac = pos - i0;
    out[o] = i0 === i1 ? data[i0] : data[i0] * (1 - frac) + data[i1] * frac;
  }
  return out;
}

/**
 * Realtime media-element fallback decode (accelerated with playbackRate>1).
 * Creates a hidden <audio> with an object URL of the file, waits until the
 * browser's media engine can demux it (loadedmetadata / canplay), then taps its
 * decoded PCM by routing it through createMediaElementSource -> ScriptProcessor
 * and recording every buffer while the element plays *unmuted* at an elevated
 * playbackRate. The captured PCM is re-time-stretched back to the original
 * length before returning, so downstream analysis sees exactly the clip's
 * sound. Returns null if the element can't demux/decode it, if capture yields
 * no samples, or if the clip is too long even at max capture rate.
 */
async function captureAudioViaMediaElement(
  file: File,
  audioCtx: AudioContext,
  onStage?: (stage: string) => void
): Promise<CapturedAudio | null> {
  if (
    typeof MediaElementAudioSourceNode === "undefined" ||
    typeof ScriptProcessorNode === "undefined"
  ) {
    return null; // browser has no media-element -> audio-graph path
  }
  const url = URL.createObjectURL(file);
  const el = new Audio();
  el.src = url;
  el.muted = false; // muted would silence the pipeline and capture silence
  el.volume = 1;

  try {
    // 1) wait for the browser to prove it can decode the file (metadata)
    const meta = await new Promise<{ duration: number } | null>((resolve) => {
      let done = false;
      const fin = (v: { duration: number } | null) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      el.onloadedmetadata = () => {
        const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        fin({ duration: d });
      };
      el.onerror = () => fin(null);
      el.addEventListener("error", () => fin(null), { once: true });
      setTimeout(() => fin(null), FALLBACK_DEMUX_TIMEOUT);
    });
    if (!meta || meta.duration <= 0) return null; // can't demux/decode this file
    if (meta.duration > FALLBACK_MAX_SECONDS) return null; // too long even at max rate

    // ---- FAST CAPTURE (the speedup): play at an elevated rate so the clip's
    // audio rushes through the graph in `duration/rate` wall-seconds instead of
    // `duration`. Higher rate = faster wall-clock; we then stretch the captured
    // PCM back (restretchPCM) so analysis sees the true length/tempo/pitch.
    const rate = Math.min(
      FALLBACK_MAX_RATE,
      Math.max(1, Math.ceil(meta.duration / FALLBACK_WALL_BUDGET))
    );
    el.playbackRate = rate;

    onStage?.(rate > 1 ? "ready-fast" : "ready");

    // The ScriptProcessor/MediaStream graph only renders while the AudioContext
    // is RUNNING. After a real user gesture it is; in an autoplay-restricted or
    // headless context it may be suspended, in which case we can't capture.
    if (audioCtx.state !== "running") {
      try {
        await Promise.race([
          audioCtx.resume().catch(() => {}),
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      } catch { /* noop */ }
    }
    if (audioCtx.state !== "running") return null; // graph won't render

    // 2) tap the decoded audio: source -> processor -> (silent) media stream
    const source = audioCtx.createMediaElementSource(el);
    const processor = audioCtx.createScriptProcessor(4096, 2, 1);
    // route to a MediaStream destination (not the speakers) so the graph stays
    // rendering without blasting audio at the user.
    const msDest = audioCtx.createMediaStreamDestination();

    // capture in accelerated (playbackRate) wall time: the graph pushes frames
    // at `sampleRate` per wall-second, and the whole clip streams past in
    // `duration/rate` wall-seconds, so we expect `duration/rate * sampleRate`
    // captured frames (then restretch by `rate` recovers the full length).
    let remaining = Math.ceil((meta.duration / rate) * audioCtx.sampleRate);
    let totalFrames = 0;
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer;
      if (input.numberOfChannels < 1 || remaining <= 0) return;
      const ch0 = input.getChannelData(0); // browser downmix; channel 0 == mono mix
      const need = Math.min(ch0.length, remaining);
      if (need > 0) {
        chunks.push(need === ch0.length ? ch0.slice() : ch0.slice(0, need));
        totalFrames += need;
        remaining -= need;
      }
    };
    source.connect(processor);
    processor.connect(msDest);

    onStage?.("playing");
    try {
      await el.play();
    } catch {
      // autoplay/gesture policy may reject play(); we still give the pipeline a
      // moment below in case the browser starts it anyway, else null.
    }

    // 3) capture at accelerated rate until the (rate-scaled) expected frames
    //    arrive or the element ends / the scaled wall-clock budget passes.
    const expected = Math.ceil((meta.duration / rate) * audioCtx.sampleRate);
    const startedAt = performance.now();
    while (totalFrames < expected) {
      if (el.ended) break;
      if (
        performance.now() - startedAt >
        (meta.duration / rate) * 1000 + FALLBACK_PLAY_GRACE
      )
        break;
      await new Promise((r) => setTimeout(r, 200));
    }

    processor.disconnect();
    source.disconnect();
    try { el.pause(); } catch { /* noop */ }

    if (totalFrames <= 0) return null; // nothing flowed (e.g. play() was blocked)

    // 4) concatenate chunks into one mono Float32Array...
    const data = new Float32Array(totalFrames);
    let off = 0;
    for (const c of chunks) {
      data.set(c, off);
      off += c.length;
    }
    // ...then re-time-stretch back to the original duration so downstream
    // analysis sees the clip's true length/tempo/pitch (not the fast capture).
    return { data: restretchPCM(data, rate), sampleRate: audioCtx.sampleRate };
  } catch {
    return null;
  } finally {
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch { /* noop */ }
    URL.revokeObjectURL(url);
  }
}

/**
 * Build the per-clip feature profile + candidate segments from MONO PCM samples.
 * Shared by the fast decodeAudioData path and the realtime media-element
 * fallback so all downstream analysis (RMS, vocal, groove, selection) stays in
 * one place.
 */
export function buildAnalyzedClip(
  data: Float32Array,
  sr: number,
  clipId: number,
  name: string
): AnalyzedClip {
  const hop = Math.max(1, Math.floor(sr * WINDOW_SECONDS));

  // ---- raw loudness (RMS) per window, normalized ----
  const nWindows = Math.ceil(data.length / hop);
  const rawRms: number[] = [];
  for (let i = 0; i < data.length; i += hop) {
    let sum = 0;
    let n = 0;
    const end = Math.min(data.length, i + hop);
    for (let j = i; j < end; j++) {
      sum += data[j] * data[j];
      n++;
    }
    rawRms.push(Math.sqrt(sum / Math.max(1, n)));
  }
  const maxRms = Math.max(...rawRms, 1e-9);

  // ---- onset / beat-ish envelope: how sharply energy ramps up ----
  const onsets: number[] = rawRms.map((_, i) => {
    const prev = i === 0 ? 0 : rawRms[i - 1];
    const next = i === rawRms.length - 1 ? 0 : rawRms[i + 1];
    const rise = Math.max(0, rawRms[i] - prev);
    return rise + Math.max(0, rawRms[i] - next) * 0.5;
  });
  const maxOnset = Math.max(...onsets, 1e-9);

  // ---- spectral features (vocal / fingerprint / centroid) ----
  // Bound how many windows we FFT for long clips; strided, others inherit.
  const featStride = Math.max(1, Math.ceil(nWindows / MAX_FEAT_WINDOWS));
  const featWin = Math.min(sr * WINDOW_SECONDS * 1.0, sr * 0.12);
  const spectral: (SpectralFeatures | null)[] = new Array(nWindows).fill(null);
  for (let w = 0; w < nWindows; w += featStride) {
    const start = w * hop;
    const end = Math.min(data.length, start + featWin);
    const slice = data.subarray(start, end);
    try {
      spectral[w] = spectralFeatures(slice as Float32Array, sr);
    } catch {
      spectral[w] = null;
    }
  }
  // fill gaps
  for (let w = 0; w < nWindows; w++) {
    if (!spectral[w]) {
      const base = Math.max(0, Math.floor(w / featStride) * featStride);
      spectral[w] = spectral[base];
    }
  }

  const windows: Window[] = [];
  for (let w = 0; w < nWindows; w++) {
    const e = rawRms[w] / maxRms; // loudness 0..1
    const o = onsets[w] / maxOnset;
    const energy = Math.min(1, e * 0.7 + o * 0.3);
    windows.push({
      start: w * WINDOW_SECONDS,
      rms: e,
      energy,
      onset: o, // normalized positive energy rise (beat/onset activity)
      peak: false,
      vocal: spectral[w] ? spectral[w]!.vocal : 0,
      beatLock: 0, // filled after tempo detection below
      centroid: spectral[w] ? spectral[w]!.centroid : 0,
    });
  }

  // ---- steady-groove / beat-lock: match energy envelope to a pulse train ----
  const beatLock = grooveLock(windows.map((w) => w.energy));
  for (let i = 0; i < windows.length; i++) windows[i].beatLock = beatLock[i];

  // ---- rolling threshold marks high-energy "peak" windows ----
  // COVERAGE RESET (Build #1): the old gate — max(0.18, mean + 0.55*sd) — was
  // too strict. On real 24-clip uploads it starved the candidate pool down to
  // the single loudest section per show, so the reel had ~2 usable highlights
  // to choose from ("only 2 of 24 clips featured").
  //
  // New gate is deliberately relaxed so the pool holds MANY strong-but-not-
  // maximal moments across every clip, while still rejecting truly dead/blank
  // footage (silence → ~zero variance → no peaks → no segments):
  //   * lower relative bar:   mean + 0.35*sd   (was +0.55*sd)
  //   * lower absolute floor: 0.10             (was 0.18)
  //   * coverage guarantee: if the adaptive threshold still leaves fewer than
  //     ~1/8 of the clip above it (common for loudly-consistent crowd-heavy
  //     clips, where mean is high but sd is tiny, so the old bar floated ABOVE
  //     almost every window and a rich clip contributed nothing), drop it to
  //     the 87.5th percentile so a loud-but-flat clip still yields candidates.
  //     Only applied when there is real variance (sd) and real signal
  //     (top-percentile energy above noise), so silence stays rejected.
  const energies = windows.map((w) => w.energy);
  const mean = avg(energies);
  const sd = stdev(energies);
  let threshold = Math.max(0.1, mean + 0.35 * sd);
  const PEAK_MIN_FRAC = 0.125; // want at least 1/8 of the clip above the bar
  const PEAK_MIN_SD = 0.012; // ignore noise-floor-only variance
  if (sd > PEAK_MIN_SD) {
    const topPct = percentileValue(energies, 1 - PEAK_MIN_FRAC);
    let above = 0;
    for (const e of energies) if (e >= threshold) above++;
    if (above < energies.length * PEAK_MIN_FRAC && topPct > 0.004) {
      threshold = topPct; // guarantee coverage: the top 1/8 count as candidates
    }
  }
  for (const w of windows) w.peak = w.energy >= threshold;

  // ---- group contiguous peak runs into candidate segments ----
  const segments: Segment[] = [];
  let runStart = -1;
  let lastPeakEnd = -1;
  for (let i = 0; i <= windows.length; i++) {
    const peak = i < windows.length ? windows[i].peak : false;
    if (peak) {
      if (runStart < 0) runStart = i;
      lastPeakEnd = i;
    } else if (runStart >= 0) {
      const gapStart = lastPeakEnd * WINDOW_SECONDS + WINDOW_SECONDS;
      const nextStart = i * WINDOW_SECONDS;
      if (nextStart - gapStart > MERGE_GAP) {
        pushSegment(segments, windows, runStart, lastPeakEnd, clipId, name);
        runStart = -1;
      }
    }
    if (i === windows.length && runStart >= 0) {
      pushSegment(segments, windows, runStart, lastPeakEnd, clipId, name);
    }
  }

  return {
    clipId,
    name,
    duration: data.length / sr,
    windows,
    segments,
    segmentAnalysis: analyzeSegments(
      segWindowsFromClip({ clipId, name, duration: data.length / sr, windows, segments } as AnalyzedClip),
      clipId,
      name
    ),
  };
}

/**
 * Decode a video file's audio and build its feature profile + candidate
 * high-energy segments. Pure client-side.
 *
 * Fast path: `decodeAudioData` (most standard MP4/WebM with AAC). If that
 * can't decode the file (some phone-recorded HEVC/MOV, and Safari decoding
 * audio out of a video), it falls back to a realtime media-element capture,
 * which takes ~the clip's length in wall-clock time. Returns null only if
 * neither path can get audio from this file.
 *
 * `onFallback` is called when entering/leaving the slow path so the UI can show
 * per-clip progress ("decoding audio… playing clip to capture"). Stages:
 * "start" | "ready" | "playing" | "done".
 */
export async function analyzeVideoFile(
  file: File,
  clipId: number,
  audioCtx: AudioContext,
  onFallback?: (stage: string, file: File) => void
): Promise<AnalyzedClip | null> {
  // 1) fast path: Web Audio decodeAudioData (off the media element, no capture)
  try {
    const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
    const data = monoData(buffer);
    return buildAnalyzedClip(data, buffer.sampleRate, clipId, file.name);
  } catch {
    // decodeAudioData failed — fall back to native media-engine capture
  }

  onFallback?.("start", file);
  const cap = await captureAudioViaMediaElement(file, audioCtx, (s) =>
    onFallback?.(s, file)
  );
  if (!cap) return null;
  onFallback?.("done", file);
  return buildAnalyzedClip(cap.data, cap.sampleRate, clipId, file.name);
}

function pushSegment(
  out: Segment[],
  windows: Window[],
  startIdx: number,
  endIdx: number,
  clipId: number,
  name: string
) {
  const start = windows[startIdx].start;
  const rawEnd = windows[endIdx].start + WINDOW_SECONDS;
  let end = rawEnd;
  windows.slice(startIdx, endIdx + 1).forEach((w) => (w.peak = true));
  let dur = end - start;
  if (dur < MIN_CUT) return; // too short to be a usable cut
  const cap = Math.min(dur, MAX_CUT);
  if (rawEnd - start > MAX_CUT) {
    end = start + MAX_CUT;
    dur = end - start;
  }
  const slice = windows.slice(startIdx, startIdx + Math.round(cap / WINDOW_SECONDS));
  const avgE = avg(slice.map((w) => w.energy));
  const peakE = Math.max(...slice.map((w) => w.energy));
  const avgVocal = avg(slice.map((w) => w.vocal));
  const beatLock = avg(slice.map((w) => w.beatLock));
  const isDanceBreak = dur >= 4 && (avgE >= 0.55 || beatLock >= 0.6);
  const isVocalHeavy = avgVocal >= 0.45;
  const isGroovy = beatLock >= 0.55;
  const tags: string[] = [];
  if (isVocalHeavy) tags.push("vocals heavy");
  if (isDanceBreak) tags.push("dance break");
  if (isGroovy) tags.push("steady groove");

  // ---- composite score ----
  // OUTPUT-first: energy + duration dominate the pick. Vocal & groove are
  // deliberately de-emphasized as small nudges (heavy audio analysis isn't the
  // product focus) — they no longer drive selection.
  const shortPenalty = Math.min(1, dur / 4.0);
  // "crowd-noise nudge": a small, honest discount for loud broadband crowd or
  // off-key singing nearby. A section that is high-energy but has little
  // sustained tonal lead (low vocal present) reads as crowd/PA noise rather than
  // a singalong highlight, so we steer away from it — modestly.
  const noiseFactor =
    Math.max(0, avgE - 0.5) * Math.min(1, Math.max(0, 0.35 - avgVocal) / 0.35);
  const crowdNudge = 1 - 0.12 * noiseFactor;
  const score =
    shortPenalty *
    dur *
    (0.2 + 0.8 * avgE) *
    (1 + 0.15 * avgVocal) *
    (1 + 0.1 * beatLock) *
    (1 + 0.3 * peakE) *
    (isDanceBreak ? 1.05 : 1) *
    crowdNudge;

  out.push({
    id: `c${clipId}-${Math.round(start * 10)}`,
    clipId,
    name,
    start,
    end,
    duration: dur,
    avgEnergy: avgE,
    peakEnergy: peakE,
    avgVocal,
    beatLock,
    score,
    isDanceBreak,
    tags,
    songIndex: -1,
    songLabel: "",
    fingerprint: computeFingerprint(slice),
  });
}

/** Weighted-average spectral fingerprint of a window slice (recon from windows is not
 * available, so we compute a cheap proxy from vocal + energy trend). */
function computeFingerprint(slice: Window[]): number[] {
  // fingerprint dims: [vocal, energy, beatlock, spread...] — a compact feature
  // vector used only for relative similarity between segments (near-duplicate
  // detection). Reconstructed from per-window signals is sufficient.
  const len = slice.length;
  const f = new Array(8).fill(0);
  for (let i = 0; i < len; i++) {
    const t = i / Math.max(1, len);
    f[0] += slice[i].vocal;
    f[1] += slice[i].energy;
    f[2] += slice[i].beatLock;
    f[3] += slice[i].rms;
    f[4] += Math.sin(t * Math.PI); // envelope shape ~0..1
    f[5] += 1 - slice[i].rms; // quietness
    f[6] += slice[i].vocal * slice[i].energy;
    f[7] += slice[i].beatLock * slice[i].energy;
  }
  const norm = Math.sqrt(f.reduce((s, v) => s + v * v, 0)) || 1;
  return f.map((v) => v / norm / Math.max(1, Math.sqrt(len)));
}

/**
 * Estimate a steady per-window "beat lock": how well each window sits on a
 * regular pulse train at the clip's dominant tempo. Uses the *onset* (energy
 * rise) envelope so flat/steady sections have near-zero onsets and therefore
 * low groove, while periods with a steady rhythmic pulse score high.
 */
function grooveLock(energy: number[]): number[] {
  const n = energy.length;
  const out = new Array(n).fill(0);
  if (n < 40) return out; // < ~4s of data, not enough to find a groove

  // onset envelope: positive energy rise per window, smoothed
  const onsets = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    onsets[i] = Math.max(0, energy[i] - energy[i - 1]);
  }
  // smooth onsets with a 3-tap box
  const so = onsets.slice();
  for (let i = 1; i < n - 1; i++) so[i] = (onsets[i - 1] + onsets[i] + onsets[i + 1]) / 3;
  const maxOns = Math.max(...so, 1e-9);
  const norm = so.map((v) => v / maxOns); // 0..1

  // mean onset as a floor: if there's basically no rhythmic variation, bail
  const meanOns = avg(norm);
  if (meanOns < 0.05) return out; // flat/quiet -> no groove

  // autocorrelation of the zero-mean onset envelope over tempo range 70-180 BPM
  // -> period 0.33-0.857s -> in 0.1s windows: ~3.3-8.6 windows
  const minLag = Math.max(2, Math.round(60 / 180 / WINDOW_SECONDS));
  const maxLag = Math.round(60 / 70 / WINDOW_SECONDS);
  const zm = norm.map((v) => v - meanOns);
  let bestLag = Math.round(minLag + maxLag / 2);
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let acc = 0;
    let e = 0;
    for (let i = 0; i < n - lag; i++) {
      acc += zm[i] * zm[i + lag];
      e += zm[i] * zm[i] + zm[i + lag] * zm[i + lag];
    }
    const score = e > 0 ? acc / e : 0; // normalized autocorrelation (-1..1)
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestScore < 0.15) return out; // no clearly periodic groove

  // build an ideal pulse train at bestLag, phase = strongest on-beat alignment
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let p = 0; p < bestLag; p++) {
    let s = 0;
    for (let i = p; i < n; i += bestLag) s += norm[i];
    if (s > bestPhaseScore) {
      bestPhaseScore = s;
      bestPhase = p;
    }
  }
  const pulse = new Array(n).fill(0);
  for (let i = bestPhase; i < n; i += bestLag) pulse[i] = 1;

  // per-window: normalized cross-correlation of the local onset neighbourhood
  // with the ideal pulse. Flat sections (onsets ~0) get ~0.
  const halfW = Math.max(2, Math.round(bestLag / 2));
  for (let w = 0; w < n; w++) {
    const lo = Math.max(0, w - halfW);
    const hi = Math.min(n, w + halfW + 1);
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = lo; i < hi; i++) {
      num += pulse[i] * norm[i];
      denA += pulse[i] * pulse[i];
      denB += norm[i] * norm[i];
    }
    if (denA > 0 && denB > 0) out[w] = num / Math.sqrt(denA * denB);
    out[w] = clamp01(out[w]);
  }
  return out;
}

export interface SelectOptions {
  targetSeconds: number;
  maxCuts: number;
  seed: number; // reseed to "regenerate" a different-but-similar reel
  // COVERAGE/VARIETY control (major build): 0..1 balance between "tour many
  // distinct clips/songs with shorter per-cut moments" (→1) and "concentrate
  // on fewer, longer standout moments" (→0). 0.5 = the original coverage
  // behavior (fair-share tour). It composes with the pacing pass downstream:
  // selection only decides WHAT and HOW LONG each source's first look is; the
  // pacing classes/arc still run over whatever comes back.
  variety?: number;
}

// similarity between two fingerprints (cosine)
function sim(a: number[], b: number[]) {
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

// ---------------------------------------------------------------------------
// COVERAGE-DRIVEN SELECTION (quality-reset Build #1)
// ---------------------------------------------------------------------------
//
// Why this exists: the previous picker was a greedy "loudest wins" loop. With
// the strict candidate gate the pool was tiny, so the same 1-2 loud segments
// won every budget slot and a 24-clip show featured ~2 of the 24 clips.
//
// New algorithm — a forced varied TOUR of the set, then a fill:
//   PASS A (coverage) — one strong, distinct moment from each detected song IN
//     CHRONOLOGICAL ORDER, before any source repeats. Songs that didn't
//     register (or clips with no detected song) get their first look in a
//     follow-up clip-coverage pass. The remaining budget is split fairly
//     across every not-yet-covered source (fairShare = remaining / pending),
//     so a tour of N sources always fits the duration cap — many clips each
//     get a real moment, and later songs are never starved by an early epic.
//   PASS B (fill) — any budget still open is filled with the strongest leftover
//     segments across the set, with the existing fingerprint anti-repetition
//     penalty PLUS a clip-diversity term (a second cut from an already-featured
//     clip is discounted, a first cut from a not-yet-featured clip is boosted).
//
// Per-cut metadata kept rich (duration, energy, tags, songIndex/songLabel,
// fingerprint) so a follow-up build can layer per-cut pacing/transition
// decisions on top without re-running analysis. Seed jitter makes
// "Regenerate" produce a different-but-similar mix.

const MIN_CUT_FLOOR = 1.5; // no cut shorter than this (QUICK floor; MID/HOLD ≥2.0 enforced by pacing)
const CLIP_REPEAT_PENALTY = 0.18; // discount per extra cut from one clip
const NEW_CLIP_BONUS = 1.12; // fill-pass boost for a first cut from a clip

interface PoolEntry {
  seg: Segment;
  jitter: number;
  base: number;
}

function buildPool(allClips: AnalyzedClip[], seed: number): PoolEntry[] {
  const rand = mulberry32(seed);
  const pool: PoolEntry[] = [];
  for (const clip of allClips) {
    for (const seg of clip.segments) {
      pool.push({ seg, jitter: 0.92 + rand() * 0.16, base: seg.score });
    }
  }
  return pool;
}

/** Effective score of a candidate given the current reel: base score × seed
 * jitter × anti-repetition diversity (near-duplicate fingerprints and similar
 * lengths are penalized so the reel doesn't stack the same-sounding section). */
function effScore(e: PoolEntry, picked: Segment[]): number {
  let diversity = 1;
  for (const p of picked) {
    const s = sim(e.seg.fingerprint, p.fingerprint);
    const lengthSim = 1 - Math.min(1, Math.abs(e.seg.duration - p.duration) / 6);
    if (s > 0.92 && lengthSim > 0.8) diversity *= 0.22;
    else diversity *= 1 - 0.7 * s;
  }
  return e.base * e.jitter * diversity;
}

/**
 * Coverage-driven selection shared by `selectSegments` and
 * `selectSongAwareSegments`. See the block comment above for the algorithm.
 */
export function coverageSelect(
  allClips: AnalyzedClip[],
  songs: DetectedSong[],
  opts: SelectOptions
): Segment[] {
  const pool = buildPool(allClips, opts.seed);
  const picked: Segment[] = [];
  const used = new Set<number>(); // pool indices already consumed
  let total = 0;

  const pickCountForClip = (cid: number) =>
    picked.filter((p) => p.clipId === cid).length;

  // Push a (possibly trimmed) copy of a candidate segment into the reel. Keeps
  // the clip's start, shortens the end when the budget is tight — the segment
  // is always centered on its strong moment so trimming keeps the best part.
  const push = (entry: PoolEntry, len: number, song?: DetectedSong): boolean => {
    const dur = Math.min(len, entry.seg.duration);
    if (dur < MIN_CUT_FLOOR || total + dur > opts.targetSeconds) return false;
    const seg = entry.seg;
    picked.push({
      ...seg,
      duration: dur,
      end: seg.start + dur,
      songIndex: song ? song.index : seg.songIndex,
      songLabel: song ? `Song ${song.index + 1}` : seg.songLabel,
      bpm: song ? song.bpm : seg.bpm ?? 0,
    });
    total += dur;
    return true;
  };

  const songsByClip = new Map<number, DetectedSong[]>();
  for (const s of songs) {
    const arr = songsByClip.get(s.clipId) ?? [];
    arr.push(s);
    songsByClip.set(s.clipId, arr);
  }

  // Candidates in the pool that belong to one source: for a clip unit, all of
  // the clip's segments (preferring ones inside a detected song so the cut can
  // be labelled); for a song unit, only segments centered inside that song.
  const candsForSource = (clipId: number, lo: number, hi: number): number[] => {
    const songUnit = songs.some(
      (s) => s.clipId === clipId && s.start >= lo && s.end <= hi + 1e-6
    );
    const clipSongs = songsByClip.get(clipId) ?? [];
    const out: number[] = [];
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const seg = pool[i].seg;
      if (seg.clipId !== clipId) continue;
      const c = (seg.start + seg.end) / 2;
      if (songUnit) {
        if (c >= lo && c <= hi) out.push(i);
      } else if (clipSongs.length === 0) {
        out.push(i); // no songs detected → the whole clip is one source
      } else if (clipSongs.some((s) => c >= s.start && c <= s.end)) {
        out.push(i);
      }
    }
    return out;
  };

  // Pick the single best (diversity-aware) candidate of a source, trimmed to
  // `len` so the whole tour fits the cap. Tags the cut with whichever detected
  // song it sits inside so the UI can show "Song N". Returns true if added.
  const coverSource = (
    clipId: number,
    lo: number,
    hi: number,
    len: number,
    song?: DetectedSong
  ): boolean => {
    const cands = candsForSource(clipId, lo, hi);
    if (cands.length === 0) return false;
    let bestIdx = -1;
    let best = -Infinity;
    for (const ci of cands) {
      const e = effScore(pool[ci], picked);
      if (e > best) {
        best = e;
        bestIdx = ci;
      }
    }
    const entry = pool[bestIdx];
    const center = (entry.seg.start + entry.seg.end) / 2;
    const tagSong =
      song ??
      songs.find((s) => s.clipId === clipId && center >= s.start && center <= s.end);
    if (!push(entry, len, tagSong)) return false;
    used.add(bestIdx);
    return true;
  };

  // Multiple sources to tour vs. the budget left: when the budget can host ALL
  // of them at a real moment (remaining/pending ≥ MIN_CUT_FLOOR) each gets its
  // fair share; otherwise the EARLY sources keep their floor-length moment and
  // the later sources run out of budget — the tour is chronological, never
  // "finale only".
  const variety = Math.max(0, Math.min(1, opts.variety ?? 0.5));
  // VARIETY leans the per-source moment length: tour-many (variety→1) clamps
  // each first look SHORT (2.0–3.0s) so more sources fit the cap; concentrate
  // (variety→0) allows LONGER moments (3.5–6.0s) so the (maxCuts-scaled) reel
  // dwells on the best few; 0.5 keeps the original fair-share range (2.5–4.0s).
  const sourceLen = (remaining: number, pending: number) => {
    const raw = remaining / Math.max(1, pending);
    // per-source length clamps by variety:
    //  variety 1.0 (tour many):  [2.0, 3.0]
    //  variety 0.5 (balanced):   [2.5, 4.0]   (≈ original fair share)
    //  variety 0.0 (concentrate):[3.5, 6.0]
    const lo = 2.0 + (1 - variety) * 1.5; // 2.0 @1 → 3.5 @0
    const hi = 3.0 + (1 - variety) * 3.0; // 3.0 @1 → 6.0 @0
    const len = Math.max(lo, Math.min(hi, raw));
    return Math.max(MIN_CUT_FLOOR, len);
  };

  // ---- PASS A1: ONE strong moment per DISTINCT CLIP, chronological ----
  // The heart of the coverage reset: an N-clip show tours as many of its clips
  // as the budget can host (≥3s each), in order, before any source repeats — a
  // 24-clip / 60s show features ~20 of the 24 clips, not 2.
  const clipUnits = allClips
    .map((c) => ({ clipId: c.clipId, lo: 0, hi: c.duration }))
    .sort((a, b) => a.clipId - b.clipId);
  let pendingClips = clipUnits.length;
  for (const unit of clipUnits) {
    if (picked.length >= opts.maxCuts || total >= opts.targetSeconds) break;
    pendingClips--;
    coverSource(unit.clipId, unit.lo, unit.hi, sourceLen(opts.targetSeconds - total, pendingClips));
  }

  // ---- PASS A2: one extra moment per ADDITIONAL song in multi-song clips ----
  // Clips with several detected songs get their other songs' best moments too
  // (chronological), as far as the budget allows — never before every clip has
  // already had its first look.
  const seenSongIdx = new Set(picked.map((p) => p.songIndex).filter((i) => i >= 0));
  const extraSongUnits: DetectedSong[] = [];
  for (const c of allClips) {
    const clipSongs = (songsByClip.get(c.clipId) ?? []).sort(
      (a, b) => a.start - b.start
    );
    for (const s of clipSongs) {
      if (!seenSongIdx.has(s.index)) extraSongUnits.push(s);
    }
  }
  extraSongUnits.sort((a, b) => a.clipId - b.clipId || a.start - b.start);
  let pendingSongs = extraSongUnits.length;
  for (const song of extraSongUnits) {
    if (picked.length >= opts.maxCuts || total >= opts.targetSeconds) break;
    pendingSongs--;
    if (song.duration < MIN_CUT_FLOOR) continue;
    coverSource(song.clipId, song.start, song.end, sourceLen(opts.targetSeconds - total, pendingSongs), song);
  }

  // ---- PASS B: fill the open budget with the strongest leftovers ----
  while (picked.length < opts.maxCuts && total < opts.targetSeconds) {
    let bestIdx = -1;
    let best = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const entry = pool[i];
      const remaining = opts.targetSeconds - total;
      if (entry.seg.duration > remaining && remaining < MIN_CUT_FLOOR) continue;
      let e = effScore(entry, picked);
      // clip-diversity: discount extra cuts from an already-featured clip so
      // the fill pass doesn't rebuild a "loudest clip wins" reel.
      const cnt = pickCountForClip(entry.seg.clipId);
      e *= cnt === 0 ? NEW_CLIP_BONUS : Math.max(0.1, 1 - CLIP_REPEAT_PENALTY * cnt);
      // song-variety nudge: piling extra cuts onto an already-featured song is
      // mildly discouraged, a not-yet-featured song gets a small bonus.
      const candSong = songs.find(
        (s) => s.index === entry.seg.songIndex || segCenterInSong(entry.seg, s)
      );
      if (candSong) {
        const sc = picked.filter((p) => p.songIndex === candSong.index).length;
        e *= sc === 0 ? 1.06 : Math.max(0.25, 1 - 0.05 * sc);
      }
      if (e > best) {
        best = e;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const entry = pool[bestIdx];
    const remaining = opts.targetSeconds - total;
    const song = songs.find(
      (s) => s.index === entry.seg.songIndex || segCenterInSong(entry.seg, s)
    );
    if (!push(entry, Math.min(remaining, entry.seg.duration), song)) break;
    used.add(bestIdx);
  }

  // chronological order (by clip, then in-clip time) for a coherent watch
  picked.sort((a, b) => a.clipId - b.clipId || a.start - b.start);
  return picked;
}

/**
 * Rank all candidate segments across every clip and coverage-select a
 * finalized rough-cut: first one strong moment per distinct source in
 * chronological order (budget split fairly across the whole set), then fill
 * the remaining budget with the strongest leftovers under an
 * anti-repetition + clip-diversity penalty. A reseeded seed perturbs scores
 * slightly so "regenerate" feels alive.
 */
export function selectSegments(
  allClips: AnalyzedClip[],
  opts: SelectOptions
): Segment[] {
  return coverageSelect(allClips, [], opts);
}

/**
 * SONG-AWARE coverage selection (the "story reel" smarts).
 *
 * Upgrades the plain picker so the reel is a *varied tour of the set* instead
 * of the loudest overlap:
 *   PASS A1 — one strong highlight per detected song, in chronological order,
 *             each fair-share trimmed into the max-duration cap. This
 *             guarantees the reel features multiple DIFFERENT songs when the
 *             uploads contain them, and tours every clip that has any
 *             audible content (not just the 2 loudest).
 *   PASS A2 — clips with no detected song still get a first look.
 *   PASS B  — if budget remains, fill with the strongest remaining segments
 *             across the set (same energy-dominant score + anti-repetition,
 *             plus a clip-diversity discount so one clip can't dominate).
 *
 * Every returned cut is tagged with its detected song (songLabel / songIndex),
 * so the UI can show "Song 1 · 0:05–0:18 · picked". Cuts are returned unchanged
 * copies (no mutation of the source clips). Honest fallback: if no songs were
 * detected, this degrades to the plain coverage-driven picker.
 */
export function selectSongAwareSegments(
  allClips: AnalyzedClip[],
  songs: DetectedSong[],
  opts: SelectOptions
): Segment[] {
  return coverageSelect(allClips, songs, opts);
}
