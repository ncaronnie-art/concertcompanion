import { useEffect, useMemo, useRef, useState } from "react";
import { suggestedRange, type MediaAsset, type RenderSelection } from "../shared/render-plan";

type Chosen = RenderSelection & { included: boolean; previewUrl: string };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function App() {
  const [clips, setClips] = useState<Chosen[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Choose videos from iCloud Drive or anywhere on this PC.");
  const [progress, setProgress] = useState(0);
  const [exporting, setExporting] = useState(false);
  const players = useRef(new Map<string, HTMLVideoElement>());

  useEffect(() => { window.concertCompass.onProgress(setProgress); }, []);
  const selected = useMemo(() => clips.filter((clip) => clip.included), [clips]);
  const totalSeconds = selected.reduce((sum, clip) => sum + (clip.end - clip.start), 0);

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
          const previewUrl = await window.concertCompass.preview(file.id);
          usable.push({ asset, previewUrl });
        } catch { failed++; }
      }
      setClips((previous) => [...previous, ...usable.filter(({ asset }) => !previous.some((clip) => clip.asset.path === asset.path)).map(({ asset, previewUrl }) => ({ asset, previewUrl, ...suggestedRange(asset), included: true }))]);
      setMessage(`${usable.length} video${usable.length === 1 ? "" : "s"} ready.${failed ? ` ${failed} could not be prepared; check that the files are downloaded and playable.` : ""} Review the suggested trims before export.`);
    } catch (error) { setMessage(`Could not read a video: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  function update(index: number, update: Partial<Chosen>) { setClips((old) => old.map((clip, current) => current === index ? { ...clip, ...update } : clip)); }
  function useWholeClip(index: number) { setClips((old) => old.map((clip, current) => current === index ? { ...clip, start: 0, end: clip.asset.duration } : clip)); }
  function move(index: number, offset: number) { setClips((old) => { const next = [...old], target = index + offset; if (target < 0 || target >= next.length) return old; [next[index], next[target]] = [next[target], next[index]]; return next; }); }
  function mark(index: number, side: "start" | "end") {
    const clip = clips[index], current = players.current.get(clip.asset.path)?.currentTime;
    if (current === undefined || !Number.isFinite(current)) return;
    const time = Math.round(current * 100) / 100;
    if ((side === "start" && time >= clip.end - 0.1) || (side === "end" && time <= clip.start + 0.1)) { setMessage("Choose an end point after the start point, leaving at least a tenth of a second."); return; }
    update(index, { [side]: Math.max(0, Math.min(clip.asset.duration, time)) });
  }

  async function exportReel() {
    if (!selected.length) return;
    setBusy(true); setExporting(true); setProgress(0); setMessage("Choose where to save your MP4…");
    try {
      const result = await window.concertCompass.render(selected);
      setMessage(result.cancelled ? "Export cancelled. Your original recordings were not changed." : `Finished MP4: ${result.output}`);
    } catch (error) { setMessage(`Export failed. Your originals are safe. ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); setExporting(false); }
  }

  return <main>
    <header><div><p className="eyebrow">CONCERT COMPASS · WINDOWS PROTOTYPE</p><h1>Keep the night. Skip the timeline.</h1></div><button className="primary" disabled={busy} onClick={importVideos}>Import videos</button></header>
    <section className="intro"><strong>How this works</strong><span>Choose videos from a synced iCloud Drive folder or local storage. This prototype reads them where they are; it never edits or deletes the originals.</span></section>
    <section className="status" aria-live="polite"><span>{message}</span>{busy && (exporting ? <progress max="1" value={progress} /> : <progress aria-label="Preparing videos" />)}</section>
    {!clips.length ? <section className="empty"><h2>Your footage goes here</h2><p>Start with a few short recordings. Longer sources are supported by the project design, but quality and five-minute exports still need real-footage testing.</p><button className="primary" disabled={busy} onClick={importVideos}>Choose videos</button></section> : <>
      <section className="toolbar"><div><b>{selected.length} selected</b><span>{clock(totalSeconds)} planned output · clips play from top to bottom</span></div><button className="primary" disabled={busy || !selected.length} onClick={exportReel}>Export MP4</button></section>
      <section className="clips">{clips.map((clip, index) => <article className={!clip.included ? "off" : ""} key={clip.asset.path}>
        <div className="clip-title"><label><input type="checkbox" disabled={busy} checked={clip.included} onChange={(event) => update(index, { included: event.target.checked })} /> Include</label><h2>{index + 1}. {clip.asset.name}</h2><p>{clock(clip.asset.duration)} · {clip.asset.hasAudio ? "Original audio" : "Silent video"}</p><div className="clip-actions"><button disabled={busy || index === 0} aria-label={`Move ${clip.asset.name} earlier`} onClick={() => move(index, -1)}>↑ Earlier</button><button disabled={busy || index === clips.length - 1} aria-label={`Move ${clip.asset.name} later`} onClick={() => move(index, 1)}>↓ Later</button></div></div>
        <video ref={(element) => { if (element) players.current.set(clip.asset.path, element); else players.current.delete(clip.asset.path); }} controls preload="auto" crossOrigin="anonymous" src={clip.previewUrl} aria-label={`Preview ${clip.asset.name}`} />
        <div className="trim"><p>Pause the video where you want to start or end.</p><div className="clip-actions"><button disabled={busy} onClick={() => mark(index, "start")}>Set start here</button><button disabled={busy} onClick={() => mark(index, "end")}>Set end here</button><button disabled={busy} onClick={() => useWholeClip(index)}>Use whole clip</button></div><label>Start (seconds) <input disabled={busy} aria-label={`${clip.asset.name} start`} type="number" min="0" max={clip.asset.duration} step="0.1" value={Math.round(clip.start * 100) / 100} onChange={(event) => update(index, { start: Math.max(0, Math.min(Number(event.target.value), clip.end - 0.1)) })} /></label><label>End (seconds) <input disabled={busy} aria-label={`${clip.asset.name} end`} type="number" min="0.1" max={clip.asset.duration} step="0.1" value={Math.round(clip.end * 100) / 100} onChange={(event) => update(index, { end: Math.min(clip.asset.duration, Math.max(Number(event.target.value), clip.start + 0.1)) })} /></label></div>
        <p className="note">Selected range: {clock(clip.start)}–{clock(clip.end)} ({(clip.end - clip.start).toFixed(1)} seconds)</p>
      </article>)}</section>
    </>}
    <footer><b>Prototype boundary:</b> automatic suggestions are time-based starting trims, not scene recognition. Export is local H.264/AAC MP4 via FFmpeg. No media is uploaded or posted.</footer>
  </main>;
}
