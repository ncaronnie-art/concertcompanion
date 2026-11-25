import type { AudioSelection, RenderSelection } from "./render-plan.js";
import type { AudioBin } from "./suggestions.js";
import type { VisualEffectCue } from "./visual-effects.js";

/** Measured source beats -> soundtrack time -> picture-source time.
 * Sections keep their approved timing. Low-confidence rhythm is not promoted. */
export function mapVisualMusicCues(pictures: RenderSelection[], sounds: AudioSelection[],
  analyses: ReadonlyMap<string, readonly AudioBin[]>): RenderSelection[] {
  const cues: VisualEffectCue[] = [];
  let offset = 0;
  for (const sound of sounds) {
    for (const bin of analyses.get(sound.asset.path) ?? []) {
      if ((bin.beatConfidence ?? 0) < 0.65) continue;
      for (const beat of bin.beatTimes ?? []) {
        if (!Number.isFinite(beat) || beat < sound.start || beat >= sound.end) continue;
        const seconds = offset + beat - sound.start;
        if (!cues.some(c => Math.abs(c.seconds - seconds) < 0.04)) {
          cues.push({ seconds, confidence: bin.beatConfidence!, strength: Math.min(1, Math.max(0, bin.rms * 3)) });
        }
      }
    }
    offset += sound.end - sound.start;
  }
  offset = 0;
  return pictures.map(picture => {
    const length = picture.end - picture.start;
    const visualCues = cues.filter(c => c.seconds >= offset && c.seconds < offset + length)
      .map(c => ({ ...c, seconds: picture.start + c.seconds - offset }));
    offset += length;
    return { ...picture, visualCues };
  });
}
