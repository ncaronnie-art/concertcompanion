import { renderVisibleRegion, type ExportOptions, type RenderSelection } from "./render-plan.js";

export type BodyTraceWindow = { start: number; end: number };
/** Electric is a selective editorial accent, not a persistent full-reel halo.
 * Times stay in source coordinates; sound, footage order and speed are untouched.
 * No confident music timing means explicitly editorial timing, never fake beats. */
export function planBodyTraceActivity(selections: RenderSelection[], options: ExportOptions = { aspect: "vertical", reduceRumble: false }) {
  type Candidate = { index: number; sourceTime: number; outputTime: number; score: number; evidence: number; marked?: boolean; timing: "music" | "editorial" };
  const measured: Candidate[] = [], editorial: Candidate[] = [];
  let offset = 0;
  for (let index = 0; index < selections.length; index++) {
    const shot = selections[index], duration = shot.end - shot.start;
    if (duration >= .45 && !shot.bodyOutlineDisabled) {
      const region = renderVisibleRegion(shot, options);
      const context = (time: number) => {
        const tracked = shot.tracking?.keyframes.filter(k => Math.abs(k.time - time) <= .75 && k.status === "tracking" && k.subject) ?? [];
        const frames = shot.visualAnalysis?.frames.filter(f => Math.abs(f.time - time) <= .75) ?? [];
        const bodies = [...tracked.map(k => ({ ...k.subject!, confidence: k.confidence })), ...frames.flatMap(f => f.people)]
          .filter(p => p.confidence >= .28 && p.height >= .12 && p.x + p.width / 2 >= region.x && p.x + p.width / 2 <= region.x + region.width &&
            p.y + p.height / 2 >= region.y && p.y + p.height / 2 <= region.y + region.height && !(p.y + p.height > .97 && (p.y + p.height / 2 > .8 || p.height > .65)))
          .filter(p => !shot.subject || Math.abs(p.x + p.width / 2 - shot.subject.x) <= Math.max(.08, p.width * .8) &&
            Math.abs(p.y + p.height / 2 - shot.subject.y) <= Math.max(.15, p.height * .8));
        const detail = Math.max(0, ...bodies.map(p => p.confidence * (p.height + Math.sqrt(p.width * p.height))).filter(Number.isFinite));
        // Actual visible-body evidence leads effect placement. Audio timing
        // cannot rescue an off-screen musician or a known unusable pose.
        return { score: detail + (shot.subject ? .08 : 0) + (shot.focus !== undefined ? .04 : 0),
          evidence: bodies.length ? 2 : shot.subject || !frames.length ? 1 : 0 };
      };
      for (const cue of shot.visualCues ?? []) if (cue.confidence >= .65 && cue.seconds >= shot.start + .12 && cue.seconds <= shot.end - .35) {
        const body = context(cue.seconds);
        measured.push({ index, sourceTime: cue.seconds, outputTime: offset + cue.seconds - shot.start,
          score: cue.confidence * (.5 + (cue.strength ?? .5) * .5) + body.score, evidence: body.evidence, timing: "music" });
      }
      const middle = shot.start + duration / 2, body = context(middle);
      editorial.push({ index, sourceTime: middle, outputTime: offset + duration / 2, score: body.score, evidence: body.evidence, timing: "editorial" });
      if(shot.subject?.time!==undefined&&Number.isFinite(shot.subject.time)&&shot.subject.time>=shot.start&&shot.subject.time<=shot.end){
        const selectedTime=shot.subject.time,marked=context(selectedTime);
        editorial.push({index,sourceTime:selectedTime,outputTime:offset+selectedTime-shot.start,score:marked.score,evidence:marked.evidence,marked:true,timing:"editorial"});
      }
    }
    offset += duration;
  }
  const budget = Math.min(8, Math.max(1, Math.ceil(offset / 15))), spacing = Math.max(5, offset / budget * .35);
  const order = (a: Candidate, b: Candidate) => Number(!!b.marked)-Number(!!a.marked) || b.evidence - a.evidence || Number(b.timing === "music") - Number(a.timing === "music") || b.score - a.score || a.outputTime - b.outputTime;
  // Confirmed visible bodies lead; clear beats guide viable moments. A sparse
  // beat estimate still permits well-separated editorial performance accents.
  const all = [...measured, ...editorial];
  const hasConfirmedBody = all.some(candidate => candidate.evidence === 2);
  const source = all.filter(c => c.marked || !hasConfirmedBody || c.evidence > 0).sort(order);
  const chosen: Candidate[] = [];
  for (const cue of source) {
    if (chosen.length >= budget) break;
    if (chosen.every(existing => Math.abs(existing.outputTime - cue.outputTime) >= spacing)) chosen.push(cue);
  }
  const ranges = new Map<number, BodyTraceWindow[]>();
  for (const cue of chosen.sort((a, b) => a.outputTime - b.outputTime)) {
    const shot = selections[cue.index], length=Math.min(.8,shot.end-shot.start);
    const start=cue.marked?Math.max(shot.start,Math.min(shot.end-length,cue.sourceTime-length/2)):Math.max(shot.start,cue.sourceTime-.16);
    const range = { start, end: cue.marked?start+length:Math.min(shot.end, cue.sourceTime + .64) };
    const existing = ranges.get(cue.index) ?? []; existing.push(range); ranges.set(cue.index, existing);
  }
  const musical = chosen.filter(c => c.timing === "music").length;
  return { ranges, timing: musical === chosen.length && musical ? "music" as const : musical ? "mixed" as const : "editorial" as const, accents: chosen.length };
}
