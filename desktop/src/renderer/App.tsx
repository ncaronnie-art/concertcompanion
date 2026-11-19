import { useEffect, useMemo, useState } from "react";
import { suggestedRange, type MediaAsset, type RenderSelection } from "../shared/render-plan";

type Chosen = RenderSelection & { included: boolean; previewUrl: string };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function App() {
  const [clips, setClips] = useState<Chosen[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Choose videos from iCloud Drive or anywhere on this PC.");
  const [progress, setProgress] = useState(0);

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

  async function exportReel() {
    if (!selected.length) return;
    setBusy(true); setProgress(0); setMessage("Choose where to save your MP4…");
    try {
      const result = await window.concertCompass.render(selected);
      setMessage(result.cancelled ? "Export cancelled. Your original recordings were not changed." : `Finished MP4: ${result.output}`);
    } catch (error) { setMessage(`Export failed. Your originals are safe. ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  return <main>
    <header><div><p className="eyebrow">CONCERT COMPASS · WINDOWS PROTOTYPE</p><h1>Keep the night. Skip the timeline.</h1></div><button className="primary" disabled={busy} onClick={importVideos}>Import videos</button></header>
    <section className="intro"><strong>How this works</strong><span>Choose videos from a synced iCloud Drive folder or local storage. This prototype reads them where they are; it never edits or deletes the originals.</span></section>
    <section className="status" aria-live="polite"><span>{message}</span>{busy && <progress max="1" value={progress} />}</section>
    {!clips.length ? <section className="empty"><h2>Your footage goes here</h2><p>Start with a few short recordings. Longer sources are supported by the project design, but quality and five-minute exports still need real-footage testing.</p><button className="primary" disabled={busy} onClick={importVideos}>Choose videos</button></section> : <>
      <section className="toolbar"><div><b>{selected.length} selected</b><span>{clock(totalSeconds)} planned output</span></div><button className="primary" disabled={busy || !selected.length} onClick={exportReel}>Export MP4</button></section>
      <section className="clips">{clips.map((clip, index) => <article className={!clip.included ? "off" : ""} key={clip.asset.path}>
        <div className="clip-title"><label><input type="checkbox" checked={clip.included} onChange={(event) => update(index, { included: event.target.checked })} /> Include</label><h2>{clip.asset.name}</h2><p>{clock(clip.asset.duration)} · {clip.asset.width}×{clip.asset.height} · {clip.asset.hasAudio ? "Original audio" : "Silent video"}</p></div>
        <video controls preload="auto" crossOrigin="anonymous" src={clip.previewUrl} aria-label={`Preview ${clip.asset.name}`} />
        <div className="trim"><label>Start (seconds) <input aria-label={`${clip.asset.name} start`} type="number" min="0" max={clip.asset.duration} step="0.1" value={clip.start} onChange={(event) => update(index, { start: Math.max(0, Math.min(Number(event.target.value), clip.end - 0.1)) })} /></label><label>End (seconds) <input aria-label={`${clip.asset.name} end`} type="number" min="0.1" max={clip.asset.duration} step="0.1" value={clip.end} onChange={(event) => update(index, { end: Math.min(clip.asset.duration, Math.max(Number(event.target.value), clip.start + 0.1)) })} /></label><button disabled={busy} onClick={() => useWholeClip(index)}>Use whole clip</button></div>
        <p className="note">Selected range: {clock(clip.start)}–{clock(clip.end)} ({(clip.end - clip.start).toFixed(1)} seconds)</p>
      </article>)}</section>
    </>}
    <footer><b>Prototype boundary:</b> automatic suggestions are time-based starting trims, not scene recognition. Export is local H.264/AAC MP4 via FFmpeg. No media is uploaded or posted.</footer>
  </main>;
}
