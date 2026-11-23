import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMusic, MusicAnalyzer, type MusicFeatures } from "../src/shared/music-analysis.js";

const SR = 8000;
function random(seed = 37) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; }; }
function percussion(seconds: number, times: number[]): Float32Array {
  const pcm = new Float32Array(Math.floor(seconds * SR)), noise = random();
  for (const onset of times) for (let n = 0; n < SR * 0.09; n++) {
    const i = Math.round(onset * SR) + n; if (i >= pcm.length) break;
    pcm[i] += Math.exp(-n / SR * 65) * (Math.sin(2 * Math.PI * 95 * n / SR) * 0.5 + noise() * 0.3);
  }
  return pcm;
}
function grid(seconds: number, bpm: number, phase: number): number[] {
  const times: number[] = []; for (let t = phase; t < seconds - 0.2; t += 60 / bpm) times.push(t); return times;
}
function beats(bins: MusicFeatures[]) { return bins.flatMap(b => b.beatTimes ?? []); }
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

test("repeated measured onsets produce a confident tempo and source-time beat grid", () => {
  const expected = grid(16, 120, 0.23), bins = analyzeMusic(percussion(16, expected)), actual = beats(bins);
  assert.ok(actual.length >= 24, `Only ${actual.length} beats detected`);
  assert.ok(bins.filter(b => (b.beatConfidence ?? 0) >= 0.65).length >= 24);
  assert.ok(bins.filter(b => b.tempoBpm).every(b => Math.abs(b.tempoBpm! - 120) < 1));
  for (const time of actual) assert.ok(Math.min(...expected.map(t => Math.abs(t - time))) < 0.05, `Off-beat timestamp ${time}`);
  bins.forEach((bin, i) => assert.ok((bin.beatTimes ?? []).every(t => t >= i * 0.5 && t < (i + 1) * 0.5)));
});

test("silence, steady tones, noise, and irregular hits do not manufacture a reliable beat", () => {
  const noise = random(81);
  const irregular: number[] = [];
  for (let t = 0.2; t < 16; t += 0.19 + (noise() + 1) * 0.37) irregular.push(t);
  const fixtures = [new Float32Array(16 * SR), Float32Array.from({ length: 16 * SR }, (_, i) => Math.sin(2 * Math.PI * 330 * i / SR) * 0.2),
    Float32Array.from({ length: 16 * SR }, () => noise() * 0.3), percussion(16, irregular)];
  fixtures.forEach((pcm, index) => assert.equal(beats(analyzeMusic(pcm)).length, 0, `False reliable beat in fixture ${index}`));
});

test("local timing windows follow a source tempo change instead of imposing one tempo", () => {
  const expected = [...grid(20, 120, 0.25), ...grid(20, 90, 0.25).map(t => t + 20)];
  const bins = analyzeMusic(percussion(40, expected));
  const early = bins.slice(4, 28).filter(b => b.tempoBpm), late = bins.slice(56, 76).filter(b => b.tempoBpm);
  assert.ok(early.length > 15 && late.length > 12);
  assert.ok(early.every(b => Math.abs(b.tempoBpm! - 120) < 1));
  assert.ok(late.every(b => Math.abs(b.tempoBpm! - 90) < 1));
});

test("supported tempos keep their measured pulse instead of a half-tempo alias", () => {
  for (const bpm of [60, 90, 128, 180]) {
    const expected = grid(16, bpm, 0.37), bins = analyzeMusic(percussion(16, expected));
    const measured = bins.filter(b => b.tempoBpm);
    assert.ok(measured.length >= 24, `Missing tempo ${bpm}`);
    assert.ok(measured.every(b => Math.abs(b.tempoBpm! - bpm) < 1), `Wrong tempo for ${bpm}: ${measured.map(b => b.tempoBpm).join(",")}`);
  }
});

test("multiple independent noise and irregular-crowd fixtures remain conservative", () => {
  for (let seed = 1; seed <= 8; seed++) {
    const noise = random(seed * 827), times: number[] = [];
    for (let t = 0.17; t < 16; t += 0.2 + (noise() + 1) * 0.41) times.push(t);
    const irregular = percussion(16, times), background = Float32Array.from({ length: 16 * SR }, () => noise() * 0.2);
    assert.equal(beats(analyzeMusic(background)).length, 0, `Noise seed ${seed}`);
    assert.equal(beats(analyzeMusic(irregular)).length, 0, `Irregular seed ${seed}`);
  }
});

test("sustained pitched midrange is distinct from louder broadband noise without calling either a singer", () => {
  const noise = random(3), voiceLike = Float32Array.from({ length: 8 * SR }, (_, i) => {
    const t = i / SR, vibrato = 0.007 * Math.sin(2 * Math.PI * 5 * t);
    return 0.08 * (Math.sin(2 * Math.PI * 260 * t + vibrato) + 0.5 * Math.sin(2 * Math.PI * 520 * t) + 0.25 * Math.sin(2 * Math.PI * 780 * t));
  });
  const noisy = Float32Array.from({ length: 8 * SR }, () => noise() * 0.5);
  const toneFeatures = analyzeMusic(voiceLike), noiseFeatures = analyzeMusic(noisy);
  assert.ok(mean(toneFeatures.map(b => b.tonalProminence!)) > mean(noiseFeatures.map(b => b.tonalProminence!)) + 0.5);
  assert.ok(mean(noiseFeatures.map(b => b.crowdNoise!)) > mean(toneFeatures.map(b => b.crowdNoise!)) + 0.5);
});

test("streaming measurements retain a final partial bin and sanitize nonfinite samples", () => {
  const music = new MusicAnalyzer();
  for (let i = 0; i < SR * 1.13; i++) music.addSample(i % 100 === 0 ? NaN : 0.1 * Math.sin(i * 0.3));
  const result = music.finish();
  assert.equal(result.length, 3);
  assert.ok(result.every(b => Number.isFinite(b.tonalProminence) && Number.isFinite(b.crowdNoise)));
  assert.deepEqual(music.finish(), result);
  assert.throws(() => music.addSample(0), /already complete/);
});
