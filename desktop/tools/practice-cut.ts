// Local, read-only source review tool. Media and project evidence stay in the
// caller's output folder; this does not launch Electron or upload recordings.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { measureAudio } from "../electron/audio-analysis.js";
import { displayDimensions } from "../electron/media-orientation.js";
import { interpretCreativeBrief, type CreativeClip } from "../src/shared/creative-brief.js";
import { planAudioStory } from "../src/shared/audio-story.js";
import { chooseAudioHighlight, type AudioBin } from "../src/shared/suggestions.js";
import { buildAudioLedRenderCommand, renderDimensions } from "../src/shared/render-plan.js";
import { buildOverlayAss } from "../src/shared/visual-design.js";
import { parseProjectSnapshot } from "../src/shared/project-file.js";

const [mode, input, folder, profile = "draft"] = process.argv.slice(2);
if (!input || !folder || !["plan", "render"].includes(mode) || !["draft", "export"].includes(profile)) {
  throw new Error("Use: practice-cut.ts plan sources.json output-folder OR render project.json output-folder [draft|export]");
}
const out = path.resolve(folder);
await mkdir(out, { recursive: true });
const ffmpeg = ffmpegPath as string;
if (mode === "plan") {
  const sources = JSON.parse(await readFile(input, "utf8"));
  const bins: Record<string, AudioBin[]> = {};
  const clips: CreativeClip[] = [];
  for (const source of sources) {
    const asset = { path: source.path, name: source.name, duration: source.duration,
      ...displayDimensions({ ...source, side_data_list: source.rotation }), hasAudio: source.hasAudio };
    const cache = path.join(out, `${source.name}.audio.json`);
    let audio: AudioBin[];
    try { audio = JSON.parse(await readFile(cache, "utf8")); }
    catch { audio = await measureAudio(ffmpeg, source.path, true); await writeFile(cache, JSON.stringify(audio)); }
    bins[asset.path] = audio;
    const suggestion = chooseAudioHighlight(asset, audio);
    clips.push({ asset, start: suggestion.start, end: suggestion.end, included: true,
      selectionSource: "suggested", locked: false, excludedByUser: false });
    console.log(`Measured ${asset.name}: ${audio.length} windows`);
  }
  const briefInput = { description: "An energetic one-minute recap. Three sound moments with low rumble reduced, ending with a crescendo, and independent pictures from twelve recordings.",
    targetSeconds: 60, vibe: "energetic" as const, videoType: "recap" as const,
    separatePicture: true, soundMomentCount: 3, pictureSourceCount: 12,
    reduceRumble: true, aspect: "portrait913" as const, eventTitle: "Take me back." };
  const brief = interpretCreativeBrief(briefInput, clips, { aspect: "portrait913", reduceRumble: true });
  if (brief.conflict) throw new Error(brief.conflict.message);
  const cut = planAudioStory(clips, brief, bins);
  const snapshot = parseProjectSnapshot({ version: 2, clips: cut.clips, options: cut.options,
    briefInput, audioSelections: cut.audioSelections, briefDirty: false });
  await writeFile(path.join(out, "automatic-project.json"), JSON.stringify(snapshot, null, 2));
  await writeFile(path.join(out, "automatic-review.json"), JSON.stringify({ summary: brief.summary,
    notes: cut.notes, limitations: brief.limitations, picture: cut.clips.filter(c => c.included).map(c => ({ name: c.asset.name, start: c.start, end: c.end })),
    sound: cut.audioSelections.map(c => ({ name: c.asset.name, start: c.start, end: c.end })) }, null, 2));
  console.log(JSON.stringify({ summary: brief.summary, notes: cut.notes, sound: cut.audioSelections.map(c => ({ name: c.asset.name, start: c.start, end: c.end })) }));
} else {
  const snapshot = parseProjectSnapshot(JSON.parse(await readFile(input, "utf8")));
  if (!snapshot.audioSelections) throw new Error("This review tool expects a separate soundtrack.");
  const stem = path.basename(input, ".json");
  const file = path.join(out, `${stem}-${profile}.mp4`);
  const script = buildOverlayAss({ eventTitle: snapshot.options.eventTitle,
    ...renderDimensions(snapshot.options, profile as "draft" | "export", snapshot.clips.filter(c => c.included).map(c => c.asset)), style: snapshot.options.finish ?? "natural" });
  const ass = script ? path.join(out, `${stem}-${profile}.ass`) : undefined;
  if (script && ass) await writeFile(ass, script);
  const command = buildAudioLedRenderCommand(snapshot.clips.filter(c => c.included && !c.excludedByUser),
    snapshot.audioSelections, file, snapshot.options, profile as "draft" | "export", ass);
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, command.args, { windowsHide: true });
    let stderr = "", last = 0;
    child.stderr.on("data", d => { stderr = (stderr + d).slice(-6000); });
    child.stdout.on("data", d => { if (Date.now() - last > 15000) { last = Date.now(); console.log(d.toString().trim()); } });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  console.log(JSON.stringify({ file, elapsedSeconds: (Date.now() - started) / 1000 }));
}
