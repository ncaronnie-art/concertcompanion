import { useEffect, useMemo, useRef, useState } from "react";
import {
  interpretCreativeBrief, makeFirstCut, refineCut,
  type CreativeBrief, type CreativeBriefInput, type CreativeClip,
  type Refinement, type SelectionMode, type Vibe, type VideoType,
} from "../shared/creative-brief";
import { suggestedRange, type ExportOptions, type MediaAsset } from "../shared/render-plan";

type Chosen = CreativeClip & { previewUrl: string };
type UndoState = { clips: Chosen[]; options: ExportOptions };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const videoTypes: { value: VideoType; label: string }[] = [
  { value: "highlight", label: "Highlights" }, { value: "one-song", label: "One song" },
  { value: "recap", label: "Whole-night recap" }, { value: "compilation", label: "Compilation" },
];
const vibes: { value: Vibe; label: string }[] = [
  { value: "energetic", label: "Energetic" }, { value: "cinematic", label: "Cinematic" },
  { value: "nostalgic", label: "Nostalgic" }, { value: "intimate", label: "Intimate" },
  { value: "clean-live", label: "Clean / live" }, { value: "custom", label: "Custom" },
];
const modes: { value: SelectionMode; label: string }[] = [
  { value: "use-my-sections", label: "Use my sections" },
  { value: "choose-for-me", label: "Choose for me" },
  { value: "keep-and-choose", label: "Keep mine, choose the rest" },
];

function parseLength(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const mmss = /^(\d{1,3}):([0-5]\d)$/.exec(text);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 60;
  return Number.NaN;
}

export function App() {
  const [clips, setClips] = useState<Chosen[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Choose videos from iCloud Drive or anywhere on this PC.");
  const [progress, setProgress] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [aspect, setAspect] = useState<ExportOptions["aspect"]>("vertical");
  const [reduceRumble, setReduceRumble] = useState(false);
  const [finish, setFinish] = useState<NonNullable<ExportOptions["finish"]>>("natural");
  const [transition, setTransition] = useState<NonNullable<ExportOptions["transition"]>>("cut");
  const [briefInput, setBriefInput] = useState<CreativeBriefInput>({ description: "" });
  const [lengthText, setLengthText] = useState("");
  const [reviewBrief, setReviewBrief] = useState<CreativeBrief | null>(null);
  const [stage, setStage] = useState<"describe" | "review" | "cut">("describe");
  const [undoStack, setUndoStack] = useState<UndoState[]>([]);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const players = useRef(new Map<string, HTMLVideoElement>());
  const audioSuggestions = useRef(new Map<string, { start: number; end: number }>());

  useEffect(() => { window.concertCompass.onProgress(setProgress); }, []);
  const selected = useMemo(() => clips.filter((clip) => clip.included && !clip.excludedByUser), [clips]);
  const totalSeconds = selected.reduce((sum, clip) => sum + (clip.end - clip.start), 0);
  const options: ExportOptions = { aspect, reduceRumble, finish, transition };

  function remember() {
    setUndoStack((old) => [...old.slice(-24), { clips, options }]);
  }
  function changeClips(next: Chosen[]) {
    remember(); setClips(next);
    if (stage === "review") { setReviewBrief(null); setStage("describe"); }
  }
  function changeBrief(patch: Partial<CreativeBriefInput>) {
    setBriefInput((old) => ({ ...old, ...patch }));
    setReviewBrief(null); setStage("describe");
  }
  function invalidateReview() {
    if (stage === "review") { setReviewBrief(null); setStage("describe"); }
  }
  function changeClip(index: number, patch: Partial<Chosen>, markManual = false) {
    changeClips(clips.map((clip, current) => current === index ? {
      ...clip, ...patch,
      ...(markManual ? { selectionSource: "manual" as const, locked: true } : {}),
    } : clip));
  }
  function setShape(value: ExportOptions["aspect"]) {
    remember(); setAspect(value); setBriefInput((old) => ({ ...old, aspect: value }));
    invalidateReview();
  }
  function undo() {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setUndoStack((old) => old.slice(0, -1));
    setClips(previous.clips);
    setAspect(previous.options.aspect); setReduceRumble(previous.options.reduceRumble);
    setFinish(previous.options.finish ?? "natural"); setTransition(previous.options.transition ?? "cut");
    setMessage("Undid the last edit. Your earlier choices are back.");
  }

  async function importVideos() {
    const paths = await window.concertCompass.pickVideos();
    if (!paths.length) return;
    setBusy(true); setMessage(`Preparing previews for ${paths.length} video${paths.length === 1 ? "" : "s"}…`);
    try {
      const usable: { asset: MediaAsset; previewUrl: string }[] = [];
      let failed = 0;
      for (const [index, file] of paths.entries()) {
        setMessage(`Preparing video ${index + 1} of ${paths.length}…`);
        try {
          const asset = await window.concertCompass.probe(file.path);
          if (asset.duration < 0.1 || !asset.width) throw new Error("Not a usable video");
          usable.push({ asset, previewUrl: await window.concertCompass.preview(file.id) });
        } catch { failed++; }
      }
      const newClips = usable.filter(({ asset }) => !clips.some((clip) => clip.asset.path === asset.path))
        .map(({ asset, previewUrl }) => ({ asset, previewUrl, ...suggestedRange(asset), included: true,
          selectionSource: "suggested" as const, locked: false, excludedByUser: false }));
      if (newClips.length) changeClips([...clips, ...newClips]);
      setMessage(`${newClips.length} new video${newClips.length === 1 ? "" : "s"} ready.${failed ? ` ${failed} could not be prepared; check that the files are downloaded and playable.` : ""} Describe what you want, or edit sections below.`);
    } catch (error) { setMessage(`Could not read a video: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  async function saveProject() {
    try {
      const targetSeconds = parseLength(lengthText);
      if (targetSeconds !== undefined && (!Number.isFinite(targetSeconds) || targetSeconds < 0.1)) {
        throw new Error("Enter a length like 2:00 for two minutes, or leave it blank.");
      }
      const snapshot = { version: 1 as const, clips: clips.map(({ previewUrl: _previewUrl, ...clip }) => clip),
        options, briefInput: { ...briefInput, targetSeconds } };
      const result = await window.concertCompass.saveProject(snapshot);
      setMessage(result.cancelled ? "Save cancelled. Your edit is still here." : `Project saved: ${result.path}`);
    } catch (error) { setMessage(`Could not save project: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async function openProject() {
    setBusy(true);
    try {
      const result = await window.concertCompass.openProject();
      if (!result) return;
      const byPath = new Map(result.files.map((file) => [file.path, file.id]));
      const restored: Chosen[] = [];
      for (const saved of result.snapshot.clips) {
        const id = byPath.get(saved.asset.path);
        if (!id) throw new Error(`Could not locate ${saved.asset.name}.`);
        const asset = await window.concertCompass.probe(saved.asset.path);
        if (saved.end > asset.duration + 0.05) throw new Error(`${asset.name} changed since this project was saved.`);
        restored.push({ ...saved, asset, previewUrl: await window.concertCompass.preview(id) });
      }
      setClips(restored); setUndoStack([]);
      setAspect(result.snapshot.options.aspect); setReduceRumble(result.snapshot.options.reduceRumble);
      setFinish(result.snapshot.options.finish ?? "natural"); setTransition(result.snapshot.options.transition ?? "cut");
      setBriefInput(result.snapshot.briefInput);
      setLengthText(result.snapshot.briefInput.targetSeconds ? clock(result.snapshot.briefInput.targetSeconds) : "");
      setReviewBrief(null); setStage("describe"); audioSuggestions.current.clear();
      setMessage("Project opened. Your sections and protected moments are ready.");
    } catch (error) { setMessage(`Could not open project: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  function reviewPlan() {
    const targetSeconds = parseLength(lengthText);
    if (targetSeconds !== undefined && (!Number.isFinite(targetSeconds) || targetSeconds < 0.1)) {
      setMessage("Enter a length like 2:00 for two minutes, or leave it blank."); return;
    }
    try {
      const input = { ...briefInput, targetSeconds };
      const interpreted = interpretCreativeBrief(input, clips, options);
      setBriefInput(input); setReviewBrief(interpreted); setStage("review");
      setMessage("Review the plan before Concert Compass changes your edit.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  async function firstCut(extend = false) {
    if (!reviewBrief) return;
    setBusy(true);
    try {
      let candidates = clips.map((clip) => ({ ...clip }));
      if (reviewBrief.selectionMode !== "use-my-sections") {
        for (let index = 0; index < candidates.length; index++) {
          const clip = candidates[index];
          if (clip.excludedByUser || clip.locked || clip.selectionSource === "manual") continue;
          try {
            setMessage(`Finding a starting moment in ${clip.asset.name}…`);
            let suggestion = audioSuggestions.current.get(clip.asset.path);
            if (!suggestion) {
              suggestion = await window.concertCompass.suggest(clip.asset);
              audioSuggestions.current.set(clip.asset.path, suggestion);
            }
            candidates[index] = { ...clip, start: suggestion.start, end: suggestion.end };
          } catch { /* The current section remains a valid fallback. */ }
        }
      }
      const result = makeFirstCut(candidates, reviewBrief, extend ? "extend" : undefined);
      remember(); setClips(result.clips);
      setAspect(result.options.aspect); setReduceRumble(result.options.reduceRumble);
      setFinish(result.options.finish ?? "natural"); setTransition(result.options.transition ?? "cut");
      setStage("cut"); setMessage(`First cut ready: ${clock(result.plannedSeconds)}. ${result.notes.join(" ")} Preview the sections, adjust anything, then export.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function refine(request: Refinement) {
    try {
      const result = refineCut(clips, request, reviewBrief ?? interpretCreativeBrief(briefInput, clips, options));
      changeClips(result.clips); setMessage(result.notes.join(" "));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  function move(index: number, offset: number) {
    const next = [...clips], target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; changeClips(next);
  }
  function seek(clip: Chosen, seconds: number) {
    const player = players.current.get(clip.asset.path);
    if (!player || !Number.isFinite(player.duration)) return;
    player.currentTime = Math.max(0, Math.min(player.duration, seconds));
    setPositions((old) => ({ ...old, [clip.asset.path]: player.currentTime }));
  }
  function mark(index: number, side: "start" | "end") {
    const clip = clips[index], current = players.current.get(clip.asset.path)?.currentTime;
    if (current === undefined || !Number.isFinite(current)) return;
    const time = Math.round(current * 100) / 100;
    if ((side === "start" && time >= clip.end - 0.1) || (side === "end" && time <= clip.start + 0.1)) {
      setMessage("Choose an end point after the start point, leaving at least a tenth of a second."); return;
    }
    changeClip(index, { [side]: Math.max(0, Math.min(clip.asset.duration, time)) }, true);
  }
  async function suggest(index: number) {
    const clip = clips[index];
    if (clip.locked) { setMessage("This section is protected. Unlock it before asking for another suggestion."); return; }
    setBusy(true); setMessage(`Listening for stronger sound in ${clip.asset.name}…`);
    try {
      const suggestion = await window.concertCompass.suggest(clip.asset);
      audioSuggestions.current.set(clip.asset.path, suggestion);
      changeClip(index, { start: suggestion.start, end: suggestion.end, selectionSource: "suggested" });
      seek(clip, suggestion.start); setMessage(suggestion.reason);
    } catch { setMessage("Couldn't analyze this recording's sound. Your selection is unchanged; you can still choose the moment yourself."); }
    finally { setBusy(false); }
  }
  async function exportReel() {
    if (!selected.length) return;
    setBusy(true); setExporting(true); setProgress(0); setMessage("Choose where to save your MP4…");
    try {
      const result = await window.concertCompass.render(selected, options);
      setMessage(result.cancelled ? "Export cancelled. Your original recordings were not changed." : `Finished MP4: ${result.output}${result.cleanupWarning ? " The video is saved, but a temporary folder could not be removed." : ""}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail.includes("Export stopped.") ? "Export stopped. Your selections are still here." : `Export failed. Your originals are safe. ${detail}`);
    } finally { setBusy(false); setExporting(false); }
  }

  return <main>
    <header><div><p className="eyebrow">CONCERT COMPASS · WINDOWS PROTOTYPE</p><h1>Make a vibe capsule.</h1><p className="subhead">Tell us the feeling. Keep the moments you love. We’ll build a first cut you can change.</p></div><div className="header-actions"><button disabled={busy} onClick={openProject}>Open project</button><button className="primary" disabled={busy} onClick={importVideos}>Import videos</button></div></header>
    <section className="status" aria-live="polite"><span>{message}</span>{busy && (exporting ? <><progress max="1" value={progress} /><button className="stop" onClick={async () => { if (await window.concertCompass.cancelRender()) setMessage("Stopping export…"); }}>Stop export</button></> : <progress aria-label="Preparing videos" />)}</section>
    {!clips.length ? <section className="empty"><h2>Start with your recordings</h2><p>Choose videos from a synced iCloud Drive folder or this PC. Originals stay untouched.</p><button className="primary" disabled={busy} onClick={importVideos}>Choose videos</button></section> : <>
      <section className="brief" aria-label="What are we making?">
        <div className="section-heading"><div><p className="eyebrow">YOUR CREATIVE BRIEF</p><h2>What are we making?</h2><p>Describe it in your own words, or tap a few choices. Everything below uses the same clip selections and export settings.</p></div><button disabled={busy || !undoStack.length} onClick={undo}>Undo</button></div>
        {stage !== "review" ? <>
          <label className="brief-description">Describe your video<textarea disabled={busy} value={briefInput.description} onChange={(event) => changeBrief({ description: event.target.value })} placeholder="A two-minute recap of the whole night. Energetic, several recordings, and keep the section I marked." rows={3} /></label>
          <div className="choice-grid">
            <fieldset><legend>Video type</legend><div className="choices">{videoTypes.map(({ value, label }) => <button type="button" key={value} aria-pressed={briefInput.videoType === value} disabled={busy} onClick={() => changeBrief({ videoType: briefInput.videoType === value ? undefined : value })}>{label}</button>)}</div></fieldset>
            <fieldset><legend>Vibe</legend><div className="choices">{vibes.map(({ value, label }) => <button type="button" key={value} aria-pressed={briefInput.vibe === value} disabled={busy} onClick={() => changeBrief({ vibe: briefInput.vibe === value ? undefined : value })}>{label}</button>)}</div>{briefInput.vibe === "custom" && <input aria-label="Custom vibe" disabled={busy} placeholder="Describe your custom vibe" value={briefInput.customVibe ?? ""} onChange={(event) => changeBrief({ customVibe: event.target.value })} />}</fieldset>
          </div>
          <fieldset><legend>Which moments?</legend><div className="choices">{modes.map(({ value, label }) => <button type="button" key={value} aria-pressed={briefInput.selectionMode === value} disabled={busy} onClick={() => changeBrief({ selectionMode: briefInput.selectionMode === value ? undefined : value })}>{label}</button>)}</div></fieldset>
          <div className="brief-bottom"><label>Target length <span>(optional; minutes or m:ss)</span><input disabled={busy} aria-label="Target length" value={lengthText} onChange={(event) => { setLengthText(event.target.value); setReviewBrief(null); }} placeholder={`Current edit ${clock(totalSeconds)}`} /></label><div className="brief-buttons"><button disabled={busy} onClick={() => document.getElementById("clip-editor")?.scrollIntoView({ behavior: "smooth" })}>Skip to editor</button><button className="primary" disabled={busy} onClick={reviewPlan}>Review my plan</button></div></div>
        </> : reviewBrief && <div className="brief-review"><p className="eyebrow">HERE’S THE PLAN</p><h3>{reviewBrief.summary}</h3><p>{reviewBrief.selectionMode === "use-my-sections" ? "Only your marked sections will be used." : "We’ll use sound strength to suggest unprotected moments, then fit them to your length. You can change every suggestion."}</p><p>Visual look: {reviewBrief.options.finish ?? "natural"} · joins: {reviewBrief.options.transition === "fade" ? "short fades" : "straight cuts"}. Your original sound stays unless you turn on low-rumble reduction.</p>{reviewBrief.limitations.map((item) => <p className="limit" key={item}>{item}</p>)}
          {reviewBrief.conflict && <div className="conflict" role="alert"><strong>{reviewBrief.conflict.message}</strong>{reviewBrief.conflict.kind === "one-song-multiple-sections" && <div className="choices">{clips.filter((clip) => clip.included && (clip.locked || clip.selectionSource === "manual")).map((clip) => <button disabled={busy} key={clip.asset.path} onClick={() => {
            changeClips(clips.map((item) => item.asset.path === clip.asset.path ? item : item.included && (item.locked || item.selectionSource === "manual") ? { ...item, included: false, excludedByUser: true } : item));
            setReviewBrief(null); setStage("describe"); setMessage(`Keeping ${clip.asset.name}. Review the plan again.`);
          }}>Use {clip.asset.name}</button>)}</div>}{reviewBrief.conflict.kind === "insufficient-footage" && <button disabled={busy} onClick={() => { const seconds = reviewBrief.conflict?.availableSeconds; if (seconds) { setLengthText(clock(seconds)); changeBrief({ targetSeconds: seconds }); } }}>Use available length</button>}</div>}
          <div className="brief-buttons"><button disabled={busy} onClick={() => setStage("describe")}>Adjust</button>{reviewBrief.conflict?.kind === "protected-over-target" ? <button className="primary" disabled={busy} onClick={() => firstCut(true)}>Keep all and extend</button> : <button className="primary" disabled={busy || !!reviewBrief.conflict} onClick={() => firstCut()}>Make my first cut</button>}</div>
        </div>}
      </section>
      <section className="toolbar"><div><b>{selected.length} selected</b><span>{clock(totalSeconds)} planned output · clips play from top to bottom</span></div><div className="toolbar-actions"><button disabled={busy} onClick={saveProject}>Save project</button><button className="primary" disabled={busy || !selected.length} onClick={exportReel}>Export MP4</button></div></section>
      {stage === "cut" && <section className="refine"><div><p className="eyebrow">FIRST CUT READY</p><h2>Make it yours</h2><p>Try one change. Everything else stays where it is.</p></div><button disabled={busy} onClick={() => refine({ kind: "fewer-cuts" })}>Fewer cuts</button></section>}
      <section className="options" aria-label="Export options"><div><b>Video shape</b><div className="clip-actions"><button disabled={busy} aria-pressed={aspect === "vertical"} onClick={() => setShape("vertical")}>Vertical 9:16</button><button disabled={busy} aria-pressed={aspect === "landscape"} onClick={() => setShape("landscape")}>Widescreen 16:9</button></div><p>The center of each recording fills the frame; edges may be cropped. The preview shows the original frame.</p></div><label><input disabled={busy} type="checkbox" checked={reduceRumble} onChange={(event) => { remember(); setReduceRumble(event.target.checked); invalidateReview(); }} /> Reduce low rumble <small>Gently lowers very low bass. It does not remove crowd voices.</small></label><div><b>Finishing look</b><div className="clip-actions">{(["natural", "vivid", "cinematic", "warm"] as const).map((look) => <button key={look} disabled={busy} aria-pressed={finish === look} onClick={() => { remember(); setFinish(look); invalidateReview(); }}>{look}</button>)}</div><p>Subtle color treatment; it does not detect scenes or moods.</p></div><div><b>Between recordings</b><div className="clip-actions"><button disabled={busy} aria-pressed={transition === "cut"} onClick={() => { remember(); setTransition("cut"); invalidateReview(); }}>Straight cut</button><button disabled={busy} aria-pressed={transition === "fade"} onClick={() => { remember(); setTransition("fade"); invalidateReview(); }}>Short fade</button></div><p>Protected sections keep their full length.</p></div></section>
      <section className="clips" id="clip-editor" aria-label="Clip editor">{clips.map((clip, index) => <article className={!clip.included || clip.excludedByUser ? "off" : ""} key={clip.asset.path}>
        <div className="clip-title"><label><input type="checkbox" disabled={busy} checked={clip.included && !clip.excludedByUser} onChange={(event) => changeClip(index, { included: event.target.checked, excludedByUser: !event.target.checked }, event.target.checked)} /> Include</label><h2>{index + 1}. {clip.asset.name}</h2><p>{clock(clip.asset.duration)} · {clip.asset.hasAudio ? "Original audio" : "Silent video"}</p><label className="moment-label">Song or moment name <input disabled={busy} value={clip.label ?? ""} maxLength={100} placeholder="Optional, supplied by you" onChange={(event) => changeClip(index, { label: event.target.value })} /></label><div className="clip-actions"><button disabled={busy || index === 0} aria-label={`Move ${clip.asset.name} earlier`} onClick={() => move(index, -1)}>↑ Earlier</button><button disabled={busy || index === clips.length - 1} aria-label={`Move ${clip.asset.name} later`} onClick={() => move(index, 1)}>↓ Later</button></div></div>
        <div className="preview"><video ref={(element) => { if (element) players.current.set(clip.asset.path, element); else players.current.delete(clip.asset.path); }} onTimeUpdate={(event) => { const time = event.currentTarget.currentTime; setPositions((old) => ({ ...old, [clip.asset.path]: time })); }} controls preload="auto" crossOrigin="anonymous" src={clip.previewUrl} aria-label={`Preview ${clip.asset.name}`} /><div className="seek"><button disabled={busy} aria-label={`Back five seconds in ${clip.asset.name}`} onClick={() => seek(clip, (positions[clip.asset.path] ?? 0) - 5)}>−5s</button><input disabled={busy} aria-label={`Move through ${clip.asset.name}`} type="range" min="0" max={clip.asset.duration} step="0.1" value={Math.min(clip.asset.duration, positions[clip.asset.path] ?? 0)} onChange={(event) => seek(clip, Number(event.target.value))} /><button disabled={busy} aria-label={`Forward five seconds in ${clip.asset.name}`} onClick={() => seek(clip, (positions[clip.asset.path] ?? 0) + 5)}>+5s</button></div><small>{clock(positions[clip.asset.path] ?? 0)} / {clock(clip.asset.duration)}</small></div>
        <div className="trim"><div className="trim-heading"><div><b>{clip.locked ? "Kept by you" : clip.selectionSource === "manual" ? "Selected by you" : "Suggested section"}</b><p>Pause the preview where you want to start or end.</p></div><label><input type="checkbox" disabled={busy} checked={clip.locked} onChange={(event) => changeClip(index, { locked: event.target.checked, selectionSource: event.target.checked ? "manual" : "suggested" })} /> Keep this section</label></div><div className="clip-actions"><button disabled={busy} onClick={() => mark(index, "start")}>Set start here</button><button disabled={busy} onClick={() => mark(index, "end")}>Set end here</button><button disabled={busy} onClick={() => changeClip(index, { start: 0, end: clip.asset.duration }, true)}>Use whole clip</button><button disabled={busy || clip.locked} onClick={() => suggest(index)}>Suggest a moment</button></div><p>Suggestions use sound energy, not song or performer recognition.</p><label>Start (seconds) <input disabled={busy} aria-label={`${clip.asset.name} start`} type="number" min="0" max={clip.asset.duration} step="0.1" value={Math.round(clip.start * 100) / 100} onChange={(event) => changeClip(index, { start: Math.max(0, Math.min(Number(event.target.value), clip.end - 0.1)) }, true)} /></label><label>End (seconds) <input disabled={busy} aria-label={`${clip.asset.name} end`} type="number" min="0.1" max={clip.asset.duration} step="0.1" value={Math.round(clip.end * 100) / 100} onChange={(event) => changeClip(index, { end: Math.min(clip.asset.duration, Math.max(Number(event.target.value), clip.start + 0.1)) }, true)} /></label></div>
        {stage === "cut" && <div className="clip-actions refine-actions"><button disabled={busy || clip.excludedByUser || clip.locked} onClick={() => refine({ kind: "more-from-clip", path: clip.asset.path })}>More from this clip</button><button disabled={busy} onClick={() => refine({ kind: "keep-section", path: clip.asset.path })}>Keep that section</button><button disabled={busy || clip.excludedByUser || clip.locked} onClick={() => refine({ kind: "choose-another", path: clip.asset.path })}>Choose something else</button></div>}
        <p className="note">Selected range: {clock(clip.start)}–{clock(clip.end)} ({(clip.end - clip.start).toFixed(1)} seconds){clip.label ? ` · ${clip.label} (named by you)` : ""}</p>
      </article>)}</section>
    </>}
    <footer><b>What this build can do:</b> local sound-based suggestions, your protected sections, pacing across recordings, subtle color looks, cuts or short fades, and MP4 export. It does not recognize songs, lyrics, scenes, or emotions; create captions or title overlays; or publish to social media.</footer>
  </main>;
}
