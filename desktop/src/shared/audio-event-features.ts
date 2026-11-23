// YAMNet (torch_audioset / Qualcomm v0.59.0) preprocessing. This is the model's
// magnitude-log-mel input, not the unrelated signal features used for beat timing.
export const EVENT_SAMPLE_RATE = 16000;
const FFT = 512, HOP = 160, MEL = 64, PATCH = 96, PATCH_HOP = 48;
export type EventPatch = { start: number; end: number; features: Float32Array };
const f32 = Math.fround;

const window = Float32Array.from({ length: FFT }, (_, i) => i < 56 || i >= 456 ? 0 :
  .5 - .5 * Math.cos(2 * Math.PI * (i - 56) / 400));
const weights = (() => {
  const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
  const low = mel(125), high = mel(7500);
  const edges = Float32Array.from({ length: MEL + 2 }, (_, i) => {
    const value = f32(low + (high - low) * i / (MEL + 1));
    return f32(700 * f32(f32(10 ** f32(value / 2595)) - 1));
  });
  const result = new Float32Array((FFT / 2 + 1) * MEL);
  for (let k = 1; k <= FFT / 2; k++) for (let m = 0; m < MEL; m++) {
    const hz = k * EVENT_SAMPLE_RATE / FFT;
    result[k * MEL + m] = Math.max(0, Math.min(
      f32(f32(hz - edges[m]) / f32(edges[m + 1] - edges[m])),
      f32(f32(edges[m + 2] - hz) / f32(edges[m + 2] - edges[m + 1]))));
  }
  return result;
})();

// Reusable radix-2 FFT. The real-time path keeps only a small PCM ring and the
// overlapping 96-frame context; its memory does not grow with recording length.
export class AudioEventFeatures {
  private pcm: number[] = [];
  private offset = 0;
  private total = 0;
  private center = 0;
  private frames: Float32Array[] = [];
  private frameOffset = 0;
  private finished = false;
  private real = new Float64Array(FFT);
  private imaginary = new Float64Array(FFT);
  private spectrum = new Float32Array(FFT / 2 + 1);
  get sampleCount() { return this.total; }
  get bufferedSamples() { return this.pcm.length; }
  get bufferedFrames() { return this.frames.length; }

  push(samples: Float32Array): EventPatch[] {
    if (this.finished) throw new Error("Audio features were already finished.");
    const patches: EventPatch[] = [];
    // Compact frequently even if a caller supplies a very large input chunk.
    for (let begin = 0; begin < samples.length; begin += 4096) {
      const stop = Math.min(samples.length, begin + 4096);
      for (let i = begin; i < stop; i++) this.pcm.push(Number.isFinite(samples[i]) ? samples[i] : 0);
      this.total += stop - begin;
      this.collect(false, patches);
      this.compact();
    }
    return patches;
  }

  finish(): EventPatch[] {
    if (this.finished) return [];
    this.finished = true;
    const result: EventPatch[] = [];
    if (this.total) this.collect(true, result);
    this.pcm = [];
    this.frames = [];
    return result;
  }

  private compact() {
    // Preserve the last FFT window for EOF's reflected padding too.
    const keep = Math.max(0, Math.min(this.center - FFT / 2, this.total - FFT));
    if (keep > this.offset) {
      this.pcm = this.pcm.slice(keep - this.offset);
      this.offset = keep;
    }
  }

  private sample(index: number) {
    if (this.total === 1) return this.pcm[0];
    const period = 2 * (this.total - 1);
    let reflected = ((index % period) + period) % period;
    if (reflected >= this.total) reflected = period - reflected;
    return this.pcm[reflected - this.offset];
  }

  private collect(eof: boolean, patches: EventPatch[]) {
    while (eof ? this.center <= this.total : this.center + FFT / 2 < this.total) {
      for (let i = 0; i < FFT; i++) {
        this.real[i] = f32(this.sample(this.center + i - FFT / 2) * window[i]);
        this.imaginary[i] = 0;
      }
      this.fft();
      for (let k = 0; k <= FFT / 2; k++) this.spectrum[k] = Math.hypot(this.real[k], this.imaginary[k]);
      const frame = new Float32Array(MEL);
      for (let m = 0; m < MEL; m++) {
        let sum = 0;
        for (let k = 0; k <= FFT / 2; k++) sum += this.spectrum[k] * weights[k * MEL + m];
        frame[m] = Math.log(f32(f32(sum) + f32(.001)));
      }
      this.frames.push(frame);
      this.center += HOP;
      if (this.frames.length === PATCH) {
        const features = new Float32Array(PATCH * MEL);
        this.frames.forEach((row, i) => features.set(row, i * MEL));
        const start = this.frameOffset * HOP / EVENT_SAMPLE_RATE;
        patches.push({ start, end: Math.min(start + .96, this.total / EVENT_SAMPLE_RATE), features });
        this.frames.splice(0, PATCH_HOP);
        this.frameOffset += PATCH_HOP;
      }
    }
  }

  private fft() {
    for (let i = 1, j = 0; i < FFT; i++) {
      let bit = FFT >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) [this.real[i], this.real[j]] = [this.real[j], this.real[i]];
    }
    for (let length = 2; length <= FFT; length *= 2) {
      const angle = -2 * Math.PI / length, wr = Math.cos(angle), wi = Math.sin(angle);
      for (let i = 0; i < FFT; i += length) {
        let ur = 1, ui = 0;
        for (let j = 0; j < length / 2; j++) {
          const a = i + j, b = a + length / 2;
          const vr = this.real[b] * ur - this.imaginary[b] * ui;
          const vi = this.real[b] * ui + this.imaginary[b] * ur;
          this.real[b] = this.real[a] - vr;
          this.imaginary[b] = this.imaginary[a] - vi;
          this.real[a] += vr;
          this.imaginary[a] += vi;
          const next = ur * wr - ui * wi;
          ui = ur * wi + ui * wr; ur = next;
        }
      }
    }
  }
}

export type EventScores = { singingScore: number; musicScore: number; crowdScore: number; speechScore: number };
export function eventScores(logits: ArrayLike<number>): EventScores {
  if (logits.length !== 521 || Array.from(logits).some(value => !Number.isFinite(value)))
    throw new Error("The local sound model returned invalid scores.");
  const family = (indices: number[]) => Math.max(...indices.map(index => 1 / (1 + Math.exp(-logits[index]))));
  return { singingScore: family([24, 29, 25, 31, 32]), musicScore: family([132]),
    crowdScore: family([64, 61, 62, 11, 6, 9, 8, 63]), speechScore: family([0]) };
}

type WeightedEvent = { sums: EventScores; weight: number; covered: number; coveredUntil: number };
export type EventBin = Partial<EventScores> & { eventStatus: "classified" | "unmeasured"; eventCoverage: number };
export class AudioEventBins {
  private bins: WeightedEvent[] = [];
  add(start: number, end: number, scores: EventScores) {
    for (let index = Math.floor(start / .5); index * .5 < end; index++) {
      const left = Math.max(start, index * .5), right = Math.min(end, (index + 1) * .5);
      const overlap = Math.max(0, right - left);
      if (!overlap) continue;
      const bin = this.bins[index] ??= { sums: { singingScore: 0, musicScore: 0, crowdScore: 0, speechScore: 0 },
        weight: 0, covered: 0, coveredUntil: index * .5 };
      for (const key of Object.keys(scores) as (keyof EventScores)[]) bin.sums[key] += scores[key] * overlap;
      bin.weight += overlap;
      bin.covered += Math.max(0, right - Math.max(left, bin.coveredUntil));
      bin.coveredUntil = Math.max(bin.coveredUntil, right);
    }
  }
  finish(duration: number): EventBin[] {
    return Array.from({ length: Math.ceil(duration / .5) }, (_, i) => {
      const bin = this.bins[i], width = Math.min(.5, duration - i * .5);
      const coverage = bin ? Math.min(1, bin.covered / width) : 0;
      // A tiny overlap does not classify a whole half-second. Partial tails stay
      // explicitly unmeasured; no zero-valued fake singer/crowd predictions.
      if (!bin || coverage < .75) return { eventStatus: "unmeasured", eventCoverage: coverage };
      return { eventStatus: "classified", eventCoverage: coverage,
        ...Object.fromEntries(Object.entries(bin.sums).map(([key, value]) => [key, Math.max(0, Math.min(1, value / bin.weight))])) };
    });
  }
}
