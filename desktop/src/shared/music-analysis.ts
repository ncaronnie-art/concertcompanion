// Local signal measurements, not artist, song, lyric, or voice identification.
// Positive spectral change supplies onset candidates; repeating, well-supported
// onset grids supply timing. Uncertain material deliberately has no beat grid.
export type MusicFeatures = {
  tonalProminence?: number;
  crowdNoise?: number;
  beatTimes?: number[];
  tempoBpm?: number;
  beatConfidence?: number;
};

export const MUSIC_SAMPLE_RATE = 8000;
export const MUSIC_BIN_SECONDS = 0.5;
const SIZE = 512, HOP = 128;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(q * ordered.length))];
};

type OnsetFrame = { time: number; flux: number };
type MusicBin = MusicFeatures & { tonalSum: number; noiseSum: number; weight: number };
type Peak = { time: number; strength: number };
type Grid = { period: number; phase: number; confidence: number; beats: number[] };

function timingGrid(frames: OnsetFrame[]): Grid | undefined {
  if (frames.length < 220) return;
  const values = frames.map(f => f.flux), median = quantile(values, 0.5);
  const contrast = clamp((quantile(values, 0.95) / Math.max(median, 1e-7) - 1.35) / 1.8);
  // A steady tone produces tiny periodic FFT leakage. One large recording-start
  // onset must not promote that numerical ripple into a confident music grid.
  if (contrast < 0.25 || quantile(values, 0.98) < 0.02) return;
  const deviation = quantile(values.map(v => Math.abs(v - median)), 0.5);
  const threshold = Math.max(median + deviation * 2.5, quantile(values, 0.95) * 0.25);
  const peaks: Peak[] = [];
  for (let i = 2; i < frames.length - 2; i++) {
    const strength = values[i];
    if (strength < threshold || strength <= values[i - 1] || strength < values[i + 1] ||
      strength < values[i - 2] || strength < values[i + 2]) continue;
    const peak = { time: frames[i].time, strength };
    const last = peaks[peaks.length - 1];
    if (last && peak.time - last.time < 0.18) { if (strength > last.strength) peaks[peaks.length - 1] = peak; }
    else peaks.push(peak);
  }
  if (peaks.length < 6) return;
  // Candidate intervals include missing beats. Quarter-note versus half-note
  // ambiguity is unavoidable without a music model; all emitted times must
  // nevertheless be supported by repeated measured onsets.
  const periods = new Set<number>();
  for (let i = 0; i < peaks.length; i++) for (let j = i + 1; j < Math.min(peaks.length, i + 6); j++) {
    for (let multiples = 1; multiples <= 4; multiples++) {
      const period = (peaks[j].time - peaks[i].time) / multiples;
      if (period >= 0.3 && period <= 1) periods.add(Math.round(period * 200) / 200);
    }
  }
  const anchors = [...peaks].sort((a, b) => b.strength - a.strength).slice(0, 12);
  const strong = Math.max(quantile(peaks.map(p => p.strength), 0.65), 1e-8);
  const start = frames[0].time + 0.08, end = frames[frames.length - 1].time - 0.08;
  // Rhythm confidence needs temporal repetition, not merely high amplitude
  // contrast. Remove a short local baseline before normalized correlation.
  const prefix = [0]; values.forEach(v => prefix.push(prefix[prefix.length - 1] + v));
  const detrended = values.map((v, i) => {
    const a = Math.max(0, i - 8), b = Math.min(values.length, i + 9);
    return v - (prefix[b] - prefix[a]) / (b - a);
  });
  const correlations = new Map<number, number>();
  for (let lag = 17; lag <= 65; lag++) {
    let dot = 0, left = 0, right = 0;
    for (let i = lag + 3; i < detrended.length; i++) {
      const a = detrended[i], b = detrended[i - lag]; dot += a * b; left += a * a; right += b * b;
    }
    correlations.set(lag, dot / Math.max(1e-12, Math.sqrt(left * right)));
  }
  let best: { period: number; phase: number; score: number; confidence: number } | undefined;
  for (const period of periods) for (const anchor of anchors) {
    const tolerance = Math.min(0.065, period * 0.14);
    let count = 0, matched = 0, error = 0, weight = 0, cursor = 0;
    for (let time = anchor.time + Math.ceil((start - anchor.time) / period) * period; time <= end; time += period) {
      while (cursor + 1 < peaks.length && Math.abs(peaks[cursor + 1].time - time) < Math.abs(peaks[cursor].time - time)) cursor++;
      count++;
      const distance = Math.abs(peaks[cursor].time - time);
      if (distance <= tolerance) { matched++; error += distance; weight += Math.min(1, peaks[cursor].strength / strong); }
    }
    if (matched < 6 || count < 6) continue;
    const coverage = matched / count;
    const tightness = clamp(1 - error / matched / tolerance * 0.65);
    const lag = Math.round(period * MUSIC_SAMPLE_RATE / HOP);
    const correlation = Math.max(correlations.get(lag - 1) ?? 0, correlations.get(lag) ?? 0, correlations.get(lag + 1) ?? 0);
    const periodicity = clamp((correlation - 0.06) / 0.3);
    // Extra off-beat musical notes are legitimate; they need not lower tempo
    // confidence when the pulse itself repeats. Noise lacks this correlation.
    const confidence = correlation >= 0.12 && coverage >= 0.6 ? clamp(coverage * 0.45 + tightness * 0.25 + periodicity * 0.3) : 0;
    // Prefer strong actual accents; only a very small tempo prior breaks ties.
    const onsetSupport = Math.min(1, matched / peaks.length);
    const score = confidence * (0.75 + 0.1 * weight / matched + 0.15 * onsetSupport) - Math.abs(Math.log2(period / 0.5)) * 0.008;
    if (!best || score > best.score) best = { period, phase: anchor.time, score, confidence };
  }
  if (!best || best.confidence < 0.65) return;
  // Refine a quantized candidate against its observed beats to avoid cumulative
  // drift over a window. This changes timestamps, never playback speed.
  const assignments = peaks.map(p => ({ beat: Math.round((p.time - best!.phase) / best!.period), time: p.time }))
    .filter(p => Math.abs(p.time - (best!.phase + p.beat * best!.period)) <= Math.min(0.065, best!.period * 0.14));
  const meanX = assignments.reduce((n, p) => n + p.beat, 0) / assignments.length;
  const meanY = assignments.reduce((n, p) => n + p.time, 0) / assignments.length;
  const denominator = assignments.reduce((n, p) => n + (p.beat - meanX) ** 2, 0);
  const period = denominator ? assignments.reduce((n, p) => n + (p.beat - meanX) * (p.time - meanY), 0) / denominator : best.period;
  const phase = meanY - period * meanX;
  if (!Number.isFinite(period) || period < 0.295 || period > 1.005) return;
  const beats: number[] = [];
  const lower = Math.max(0, frames[0].time - SIZE / MUSIC_SAMPLE_RATE / 2);
  const upper = frames[frames.length - 1].time + HOP / MUSIC_SAMPLE_RATE;
  for (let time = phase + Math.ceil((lower - phase) / period) * period; time < upper; time += period) {
    // An inferred grid is only emitted at an actual nearby onset. A rest or
    // a missing beat does not manufacture a new cut point.
    const near = peaks.reduce<Peak | undefined>((a, b) => !a || Math.abs(b.time - time) < Math.abs(a.time - time) ? b : a, undefined);
    if (near && Math.abs(near.time - time) <= Math.min(0.065, period * 0.14)) beats.push(Number(near.time.toFixed(4)));
  }
  return { period, phase, confidence: best.confidence, beats };
}

/** Streaming: retains one FFT frame and at most twelve seconds of onset data. */
export class MusicAnalyzer {
  private ring = new Float64Array(SIZE);
  private real = new Float64Array(SIZE);
  private imaginary = new Float64Array(SIZE);
  private previous = new Float64Array(SIZE / 2);
  private current = new Float64Array(SIZE / 2);
  private window = Float64Array.from({ length: SIZE }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (SIZE - 1)));
  private samples = 0;
  private bins: MusicBin[] = [];
  private onsetFrames: OnsetFrame[] = [];
  private finished = false;

  addSample(value: number): void {
    if (this.finished) throw new Error("Music analysis is already complete.");
    this.ring[this.samples % SIZE] = Number.isFinite(value) ? value : 0;
    this.samples++;
    if (this.samples >= SIZE && (this.samples - SIZE) % HOP === 0) this.frame();
  }

  private frame(): void {
    let power = 0;
    for (let i = 0; i < SIZE; i++) {
      const sample = this.ring[(this.samples + i) % SIZE];
      power += sample * sample;
      this.real[i] = sample * this.window[i]; this.imaginary[i] = 0;
    }
    for (let i = 1, j = 0; i < SIZE; i++) {
      let bit = SIZE >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; } j ^= bit;
      if (i < j) { const v = this.real[i]; this.real[i] = this.real[j]; this.real[j] = v; }
    }
    for (let length = 2; length <= SIZE; length <<= 1) {
      const angle = -2 * Math.PI / length, wr = Math.cos(angle), wi = Math.sin(angle);
      for (let start = 0; start < SIZE; start += length) {
        let tr = 1, ti = 0;
        for (let offset = 0; offset < length / 2; offset++) {
          const a = start + offset, b = a + length / 2;
          const br = this.real[b] * tr - this.imaginary[b] * ti, bi = this.real[b] * ti + this.imaginary[b] * tr;
          this.real[b] = this.real[a] - br; this.imaginary[b] = this.imaginary[a] - bi;
          this.real[a] += br; this.imaginary[a] += bi;
          const next = tr * wr - ti * wi; ti = tr * wi + ti * wr; tr = next;
        }
      }
    }
    let total = 0, mid = 0, upper = 0, logSum = 0, midCount = 0, flux = 0;
    const highest = [0, 0, 0, 0, 0];
    for (let k = 1; k < SIZE / 2; k++) {
      const p = (this.real[k] ** 2 + this.imaginary[k] ** 2) / SIZE ** 2;
      const magnitude = Math.log1p(Math.sqrt(p) * 50);
      const hz = k * MUSIC_SAMPLE_RATE / SIZE;
      // A phone recording contains many more noisy upper-frequency bins than
      // bass bins. Equal-bin summation lets crowd hiss mask musical percussion.
      // Favor low musical attacks while retaining quieter mid/high accents.
      this.current[k] = magnitude; total += p;
      if (hz >= 150 && hz <= 3000) {
        mid += p; logSum += Math.log(Math.max(p, 1e-14)); midCount++;
        if (p > highest[0]) { highest[0] = p; highest.sort((a, b) => a - b); }
      }
      if (hz >= 1600) upper += p;
    }
    for (let k = 1; k < SIZE / 2; k++) {
      const hz = k * MUSIC_SAMPLE_RATE / SIZE;
      // A frequency-local maximum suppresses vibrato/moving partials, which
      // would otherwise look like fresh attacks (SuperFlux onset principle).
      const reference = Math.max(this.previous[k - 1], this.previous[k], this.previous[Math.min(SIZE / 2 - 1, k + 1)]);
      flux += Math.max(0, this.current[k] - reference) * (hz < 40 ? 0 : hz <= 350 ? 1 : hz <= 2000 ? 0.12 : 0.02);
    }
    this.previous.set(this.current);
    const flatness = mid > 1e-12 ? Math.exp(logSum / midCount) / (mid / midCount) : 1;
    const concentration = highest.reduce((a, b) => a + b, 0) / Math.max(mid, 1e-12);
    const rms = Math.sqrt(power / SIZE), weight = clamp(rms / 0.02);
    const tonal = rms >= 0.002 ? clamp((concentration - 0.08) / 0.4) * clamp(1 - flatness * 1.5) * Math.sqrt(mid / Math.max(total, 1e-12)) : 0;
    const noisy = rms >= 0.002 ? clamp(flatness / 0.5) * clamp(0.5 + upper / Math.max(total, 1e-12)) : 0;
    const time = (this.samples - SIZE / 2) / MUSIC_SAMPLE_RATE, index = Math.floor(time / MUSIC_BIN_SECONDS);
    const bin = this.bin(index); bin.tonalSum += tonal * weight; bin.noiseSum += noisy * weight; bin.weight += weight;
    this.onsetFrames.push({ time, flux: rms >= 0.002 ? flux : 0 });
    if (this.onsetFrames.length >= 750) { this.applyTiming(); this.onsetFrames.splice(0, 375); }
  }

  private bin(index: number): MusicBin {
    return this.bins[index] ??= { tonalSum: 0, noiseSum: 0, weight: 0 };
  }

  private applyTiming(): void {
    const grid = timingGrid(this.onsetFrames); if (!grid) return;
    const from = Math.floor(this.onsetFrames[0].time / MUSIC_BIN_SECONDS);
    const until = Math.floor(this.onsetFrames[this.onsetFrames.length - 1].time / MUSIC_BIN_SECONDS);
    for (let i = from; i <= until; i++) {
      const bin = this.bin(i);
      if ((bin.beatConfidence ?? 0) > grid.confidence) continue;
      bin.beatTimes = grid.beats.filter(t => t >= i * MUSIC_BIN_SECONDS && t < (i + 1) * MUSIC_BIN_SECONDS);
      bin.tempoBpm = Number((60 / grid.period).toFixed(2)); bin.beatConfidence = Number(grid.confidence.toFixed(4));
    }
  }

  finish(): MusicFeatures[] {
    if (!this.finished) { this.applyTiming(); this.finished = true; }
    const length = Math.ceil(this.samples / MUSIC_SAMPLE_RATE / MUSIC_BIN_SECONDS);
    return Array.from({ length }, (_, i) => {
      const b = this.bins[i];
      if (!b) return { tonalProminence: 0, crowdNoise: 0 };
      return { tonalProminence: Number((b.weight ? b.tonalSum / b.weight : 0).toFixed(4)),
        crowdNoise: Number((b.weight ? b.noiseSum / b.weight : 0).toFixed(4)),
        ...(b.beatConfidence !== undefined ? { beatTimes: b.beatTimes, tempoBpm: b.tempoBpm, beatConfidence: b.beatConfidence } : {}) };
    });
  }
}

export function analyzeMusic(samples: ArrayLike<number>): MusicFeatures[] {
  const analyzer = new MusicAnalyzer();
  for (let i = 0; i < samples.length; i++) analyzer.addSample(samples[i]);
  return analyzer.finish();
}
