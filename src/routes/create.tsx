import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeVideoFile,
  selectSongAwareSegments,
  type AnalyzedClip,
  type Segment,
} from "~/lib/reel";
import { detectSongs, type DetectedSong } from "~/lib/songs";
import { computeGlobalUniqueness } from "~/lib/segments";
import { type EditModeId } from "~/lib/selection";
import {
  clipKeyOf,
  edlToSegments,
  keepSourceAll,
  muteAll,
  reSelectPreserving,
  replaceSlot,
  reorderRows,
  setEnding,
  setHook,
  shortenLengthen,
  unlockRow,
  lockRow,
  type EdlState,
} from "~/lib/edl";
import { ReframeController, type MotionStyle } from "~/lib/reframe";
import {
  applyTheme,
  DEFAULT_THEME,
  isThemeId,
  THEMES,
  themeIds,
  type ThemeId,
} from "~/lib/theme";
import {
  composeTransition,
  clamp01,
  equalPower,
} from "~/lib/transitions";
import {
  computeBoundaries,
  motionStyleFor,
  planPacing,
  type Boundary,
  type CutStyle,
  type PacedCut,
} from "~/lib/editorial";
import {
  biasFor,
  DEFAULT_MODE,
  EDIT_MODES,
  editModeIds,
  isEditModeId,
  modeFromLegacyVibe,
  resolvedMode,
  transitionsFor,
  type EditMode,
} from "~/lib/editmodes";
import {
  clearSession,
  getSavedSessionMeta,
  loadSession,
  saveSession,
  whenIdle,
  type SingleAudioSetting,
} from "~/lib/sessiondb";

export const Route = createFileRoute("/create")({
  component: Create,
});

type Phase = "idle" | "analyzing" | "done";

const DISPLAY_BARS = 260; // cap timeline resolution for perf

// ---- OUTPUT-first shape controls ----
type AspectRatio = "9:16" | "16:9" | "1:1" | "4:5";
const RATIOS: Record<
  AspectRatio,
  { w: number; h: number; label: string; hint: string; icon: string }
> = {
  "9:16": { w: 1080, h: 1920, label: "Vertical", hint: "Reels · TikTok · Shorts", icon: "▯" },
  "16:9": { w: 1920, h: 1080, label: "Widescreen", hint: "YouTube · TV", icon: "▬" },
  "1:1": { w: 1080, h: 1080, label: "Square", hint: "Feed posts", icon: "▢" },
  "4:5": { w: 1080, h: 1350, label: "Portrait 4:5", hint: "Feed · ads", icon: "▯" },
};
const DURATIONS = [15, 30, 45, 60];

interface VideoHandle {
  clipId: number;
  url: string;
  el: HTMLVideoElement;
}

interface ExportInfo {
  url: string;
  ext: string;
  isMp4: boolean;
  sizeMB: number;
  dims: string;
  codecs: string;
}

// pick the best real-world recording container/codec the browser supports.
function getExportMime(): {
  mime: string;
  baseType: string;
  ext: string;
  isMp4: boolean;
  codecs: string;
} {
  const candidates = [
    { mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', baseType: "video/mp4", ext: "mp4", isMp4: true, codecs: "H.264 + AAC" },
    { mime: "video/mp4", baseType: "video/mp4", ext: "mp4", isMp4: true, codecs: "MP4" },
    { mime: 'video/webm;codecs="vp9,opus"', baseType: "video/webm", ext: "webm", isMp4: false, codecs: "VP9 + Opus" },
    { mime: 'video/webm;codecs="vp8,opus"', baseType: "video/webm", ext: "webm", isMp4: false, codecs: "VP8 + Opus" },
    { mime: "video/webm", baseType: "video/webm", ext: "webm", isMp4: false, codecs: "WebM" },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mime)) {
      return c;
    }
  }
  return { mime: "", baseType: "video/webm", ext: "webm", isMp4: false, codecs: "WebM" };
}

export default function Create() {
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [analyzingStatus, setAnalyzingStatus] = useState("");
  const [clips, setClips] = useState<AnalyzedClip[]>([]);
  const [songs, setSongs] = useState<DetectedSong[]>([]);
  const [selected, setSelected] = useState<Segment[]>([]);
  const [seed, setSeed] = useState(1);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [studioRef, setStudioRef] = useState<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playInfo, setPlayInfo] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [exportInfo, setExportInfoState] = useState<ExportInfo | null>(null);

  // ---- OUTPUT controls ----
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [maxDuration, setMaxDuration] = useState(30);
  const [showCamRoll, setShowCamRoll] = useState(false);
  // EDITORIAL (Build #2): DEFAULT = Warm (least polarizing, flatters crowds).
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);

  // ---- EDIT MODES (STEP C, 2.0; replaces "vibes") ----
  // A mode is the full editing directive (pacing + transition policy + theme
  // suggestion). Surprise Me auto-resolves to a concrete mode from the footage.
  const [mode, setMode] = useState<EditModeId>(DEFAULT_MODE);
  // STEP B (2.0 pivot): OFF by default so the shipped coverage-driven selection
  // is preserved. When ON and clips carry per-segment analysis, selection
  // dispatches to the segment-level diversity-aware picker (src/lib/selection.ts)
  // instead of the whole-clip-slice coverage picker.
  // NOTE: must be declared before the `resolved` useMemo below (referenced in
  // its factory body + deps) to avoid a TDZ ReferenceError at mount.
  const [segSelect, setSegSelect] = useState(false);
  // Surprise Me resolves to an actual mode once we have analysed footage stats.
  const resolved = useMemo(
    () =>
      resolvedMode(
        mode,
        segSelect && clips.every((c) => c.segmentAnalysis)
          ? clips.map((c) => c.segmentAnalysis!)
          : undefined
      ),
    [mode, clips, segSelect]
  );
  const modeBias = useMemo(() => biasFor(resolved), [resolved]);
  const modeBiasRef = useRef(modeBias);
  modeBiasRef.current = modeBias;
  const modePolicy = useMemo(() => transitionsFor(resolved), [resolved]);
  // theme stays a nudge: when the user picks a mode and hasn't diverged from
  // the previous default/suggestion, we move the theme to the mode's accent.
  const applyMode = useCallback(
    (m: EditModeId) => {
      setMode((prev) => {
        const prevSug = EDIT_MODES[resolved]?.themeSuggestion ?? DEFAULT_THEME;
        const untouched =
          theme === DEFAULT_THEME || theme === prevSug; // user hasn't diverged
        if (untouched && EDIT_MODES[m].themeSuggestion) setTheme(EDIT_MODES[m].themeSuggestion);
        return m;
      });
      setExportInfoState(null);
    },
    [theme, resolved]
  );
  // COVERAGE/VARIETY (Part B1): 0..1 — tour many short moments vs fewer longer
  // ones. 0.5 = the original coverage behavior. Default stays 0.5 (no change
  // for anyone who doesn't touch it).
  const [variety, setVariety] = useState(0.5);
  // STEP D (2.0): user energy dial + the editable Edit Decision List for the
  // segment path. The EDL is the source of truth for the segment picks; the
  // create.tsx render/export pipeline consumes it via edlToSegments.
  const [energy, setEnergy] = useState(0.5); // 0 calm … 1 hype (0.5 neutral)
  const [segEdl, setSegEdl] = useState<EdlState | null>(null); // segment-path EDL
  const segEdlRef = useRef<EdlState | null>(null);
  segEdlRef.current = segEdl;
  // a persisted EDL waiting to be handed to the segment path once clips restore
  const restoredEdlRef = useRef<EdlState | null>(null);
  // the analyzed segment pool + whether the segment path is active
  const segResults = useMemo(
    () => (clips.every((c) => c.segmentAnalysis) ? clips.map((c) => c.segmentAnalysis!) : null),
    [clips]
  );
  const segOn = segSelect && !!segResults;
  // SINGLE-AUDIO "1 AUDIO" (Part B2): one handpicked audio bed (a clip's audio
  // or an uploaded audio-only file) with the visuals trimmed/paced to fit it.
  const [singleAudio, setSingleAudio] = useState<SingleAudioSetting>({
    on: false,
    sourceType: "clip",
  });
  const [bedFile, setBedFile] = useState<File | null>(null);
  // the single-audio bed element (dedicated <audio>, independent of the visual
  // elements so it can play the whole reel while clips seek freely)
  const bedElRef = useRef<HTMLAudioElement | null>(null);
  const bedUrlRef = useRef<string | null>(null);
  const bedGainRef = useRef<GainNode | null>(null);
  const bedStartedRef = useRef(false);
  // mirrors the source file for the bed so export can rebuild it
  const bedFileRef = useRef<File | null>(null);
  bedFileRef.current = bedFile;

  // ---- session persistence ----
  const [sessionStatus, setSessionStatus] = useState<"idle" | "restoring" | "restored">("idle");
  const [storageNote, setStorageNote] = useState("");
  const sessionReadyRef = useRef(false); // true once initial restore has resolved
  const debounceRef = useRef<number | undefined>(undefined);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoHandles = useRef<Map<number, VideoHandle>>(new Map());
  const playingRef = useRef(false);
  const cancelPlayRef = useRef(false);
  // persistent audio graph for audible export (createMediaElementSource claims an
  // element to a context permanently, so we keep one context + one source per clip)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<Map<number, MediaElementAudioSourceNode>>(new Map());
  const exportUrlRef = useRef<string | null>(null);
  // per-export audio-bed gain nodes (one per clip) for smooth song crossfades
  const exportGainRef = useRef<Map<number, GainNode>>(new Map());
  // mirrors the chosen theme so the shared renderer always reads the current one
  const themeRef = useRef<ThemeId>(DEFAULT_THEME);
  themeRef.current = theme;
  // per-run smart-reframing controller (shared by preview and export)
  const reframeRef = useRef<ReframeController | null>(null);

  const setExportInfo = useCallback((info: ExportInfo | null) => {
    setExportInfoState((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return info;
    });
    if (info?.url) exportUrlRef.current = info.url;
    else exportUrlRef.current = null;
  }, []);

  // object URLs are created against their own clipId index; re-analyze keeps same files
  const ensureVideo = useCallback((clipId: number, file: File): HTMLVideoElement => {
    let handle = videoHandles.current.get(clipId);
    if (!handle) {
      const el = document.createElement("video");
      el.muted = false;
      el.playsInline = true;
      const url = URL.createObjectURL(file);
      handle = { clipId, url, el };
      videoHandles.current.set(clipId, handle);
      document.body.appendChild(el);
    }
    return handle.el;
  }, []);

  // The SINGLE-AUDIO bed element: a dedicated hidden <audio> (independent of the
  // visual elements, so it can play the whole reel while the clips seek). Built
  // fresh each use since createMediaElementSource claims an element permanently.
  const ensureBedElement = useCallback((file: File | null): HTMLAudioElement | null => {
    try {
      bedElRef.current?.pause();
      bedElRef.current?.removeAttribute("src");
      bedElRef.current?.load();
      bedElRef.current?.remove();
    } catch {
      /* noop */
    }
    if (bedUrlRef.current) {
      try {
        URL.revokeObjectURL(bedUrlRef.current);
      } catch {
        /* noop */
      }
      bedUrlRef.current = null;
    }
    bedElRef.current = null;
    if (!file) return null;
    const el = new Audio();
    el.muted = false;
    el.playsInline = true;
    el.preload = "auto";
    const url = URL.createObjectURL(file);
    el.src = url;
    document.body.appendChild(el);
    bedElRef.current = el;
    bedUrlRef.current = url;
    return el;
  }, []);

  // clean up object URLs / hidden videos on unmount
  useEffect(() => {
    return () => {
      videoHandles.current.forEach((h) => {
        try {
          h.el.pause();
          h.el.removeAttribute("src");
          h.el.load();
          h.el.remove();
        } catch {
          /* noop */
        }
        URL.revokeObjectURL(h.url);
      });
      try {
        audioCtxRef.current?.close().catch(() => {});
      } catch {
        /* noop */
      }
      try {
        bedElRef.current?.pause();
        bedElRef.current?.removeAttribute("src");
        bedElRef.current?.load();
        bedElRef.current?.remove();
      } catch {
        /* noop */
      }
      if (bedUrlRef.current) {
        try {
          URL.revokeObjectURL(bedUrlRef.current);
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  // ---- restore a previously saved session on load ----
  // Cheap settings (aspectRatio/maxDuration/seed) come back synchronously from
  // localStorage for a snappy first paint; the uploaded files + analyzed clips
  // are fetched from IndexedDB asynchronously. Nothing is re-uploaded and the
  // expensive audio decode/analysis is NOT re-run — it comes back from storage.
  useEffect(() => {
    let cancelled = false;
    const meta = getSavedSessionMeta();
    if (!meta) {
      sessionReadyRef.current = true; // nothing to restore; autosave is armed
      return;
    }
    // restore the light settings immediately
    if ((Object.keys(RATIOS) as AspectRatio[]).includes(meta.aspectRatio as AspectRatio)) {
      setAspectRatio(meta.aspectRatio as AspectRatio);
    }
    if (isThemeId(meta.theme)) setTheme(meta.theme);
    // STEP C: restore the edit mode; migrate a legacy (pre-2.0) `vibe` if present.
    if (isEditModeId(meta.mode)) setMode(meta.mode);
    else if (isEditModeId(modeFromLegacyVibe(meta.vibe ?? ""))) setMode(modeFromLegacyVibe(meta.vibe ?? ""));
    if (typeof meta.variety === "number") setVariety(meta.variety);
    if (meta.singleAudio) setSingleAudio(meta.singleAudio);
    if (DURATIONS.includes(meta.maxDuration)) setMaxDuration(meta.maxDuration);
    setSeed(typeof meta.seed === "number" ? meta.seed : 1);
    // STEP D: restore the segment-path preferences + the user's editable EDL
    // (rows + locks + mode + energy) so a user who edited their reel keeps it.
    if (typeof meta.energy === "number") setEnergy(meta.energy);
    if (typeof meta.segSelect === "boolean") setSegSelect(meta.segSelect);
    if (meta.edl && Array.isArray(meta.edl.rows) && meta.edl.rows.length > 0) {
      restoredEdlRef.current = meta.edl;
    }
    setSessionStatus("restoring");
    loadSession().then((loaded) => {
      if (cancelled) return;
      if (loaded && (loaded.files || loaded.clips || loaded.bedFile)) {
        if (loaded.bedFile) setBedFile(loaded.bedFile);
        if (loaded.files && loaded.files.length) setFiles(loaded.files);
        if (loaded.clips && loaded.clips.length) {
          setClips(loaded.clips);
          setPhase("done");
          // STEP D: hand the user's persisted editable EDL to the segment path
          // (the build effect below will keep it when its inputs match; the
          // restored energy/mode/maxDuration were set above so they do).
          if (restoredEdlRef.current) {
            setSegEdl(restoredEdlRef.current);
            restoredEdlRef.current = null;
          }
        }
        if (loaded.clips && !loaded.files) {
          // Analysis came back but the raw video blobs couldn't be stored
          // (quota/private mode) — re-upload the clips, skip re-analysis.
          setStorageNote(
            "Your session analysis was restored, but the video files were too " +
              "large to store on this device. Re-upload them and we'll skip re-analysis."
          );
        }
        setSessionStatus("restored");
      } else {
        // Stale meta without real IndexedDB data — ignore it.
        setSessionStatus("idle");
      }
      sessionReadyRef.current = true;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- auto-save ----
  // Transparent: no Save button. Debounced so rapid state churn (seed bump,
  // ratio/length toggles, file drops) collapses into one write, and the heavy
  // IndexedDB blob write is pushed to the browser's idle time so the main
  // thread never stalls. Files + analyzed clips + settings all round-trip.
  useEffect(() => {
    if (!sessionReadyRef.current) return; // wait until restore settles
    if (files.length === 0 && clips.length === 0 && !bedFile) return; // nothing to persist yet
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      whenIdle(() => {
        saveSession({
          files,
          clips,
          songs,
          aspectRatio,
          maxDuration,
          seed,
          theme,
          mode,
          variety,
          singleAudio,
          bedFile,
          edl: segEdl,
          energy,
          segSelect,
        }).then((r) => {
          if (r.filesStored && r.clipsStored) {
            setStorageNote(""); // all good — clear any earlier quota warning
          } else if (files.length > 0 && clips.length > 0) {
            setStorageNote(
              "We saved your progress, but this browser couldn't store your full " +
                "video files (storage may be full or private mode is on). If you " +
                "reload now, you may need to re-upload the clips."
            );
          }
          setSessionStatus((s) => (s === "restoring" ? s : "restored"));
        });
      });
    }, 500);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [files, clips, songs, seed, aspectRatio, maxDuration, theme, mode, variety, singleAudio, bedFile, segEdl, energy, segSelect]);

  const onFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const videoFiles = Array.from(list).filter((f) => f.type.startsWith("video/"));
      if (videoFiles.length === 0) return;
      setFiles((prev) => {
        const merged = [...prev];
        for (const f of videoFiles) {
          if (!merged.some((m) => m.name === f.name && m.size === f.size)) merged.push(f);
        }
        return merged;
      });
      setError("");
    },
    []
  );

  // Detect distinct song sections from the analyzed clips. This is heuristic
  // boundary detection (NOT song-recognition ML) — pure client-side, derived from
  // the audio's own energy/applause gaps + groove/tempo + timbre shape. Labels
  // are deterministic from the clips, so a restored session keeps the same song
  // labels without re-decoding audio.
  useEffect(() => {
    if (clips.length === 0) {
      setSongs([]);
      return;
    }
    setSongs(detectSongs(clips));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  // ---- SINGLE-AUDIO target (Part B2): the "1 AUDIO" bed decides the reel cap
  // when its track is shorter than the user's max-duration cap (honest: visuals
  // fit the track; a longer track is simply trimmed to the cap). Declared here
  // (before the (re)select effect below) because that effect reads `effTarget`.
  const singleTrackSeconds = useMemo(() => {
    if (!singleAudio.on) return null;
    if (singleAudio.sourceType === "clip") {
      const c = clips[singleAudio.clipId ?? -1];
      if (c && c.duration > 0) return c.duration;
    } else if (singleAudio.sourceType === "file") {
      const d = singleAudio.duration || 0;
      if (d > 0) return d;
    }
    return null;
  }, [singleAudio, clips]);
  const effTarget = useMemo(() => {
    if (singleAudio.on && singleTrackSeconds) return Math.max(4, Math.min(maxDuration, singleTrackSeconds));
    return maxDuration;
  }, [singleAudio.on, singleTrackSeconds, maxDuration]);

  // (Re)select the reel whenever clips / detected songs / duration / reseed /
  // variety / single-audio target change. targetSeconds is the user's
  // max-duration CAP (or the single-audio track length when that's shorter).
  // Selection is COVERAGE-DRIVEN: it tours one strong moment per distinct
  // clip/song in chronological order (budget split fairly so many clips each
  // get a moment, not just the 2 loudest), then fills the remaining budget
  // with variety. `variety` leans "tour many short moments" vs "fewer longer
  // ones"; maxCuts scales with it and the duration target so a 60s reel can
  // genuinely tour ~20 distinct sources (or dwell on a few at variety=0).
  useEffect(() => {
    if (clips.length === 0) return;
    // STEP B/D dispatch: when segment-level picks (2.0) are enabled, selection
    // is driven entirely by the editable EDL (built below; the user edits it via
    // the "Edit your reel" panel). The legacy coverage path is unchanged.
    if (segOn) return;
    const vf = 0.45 + (variety - 0.5) * 0.5; // 0.2 @variety0 (concentrate) → 0.7 @variety1 (tour many)
    const maxCuts = Math.max(4, Math.min(30, Math.floor(effTarget * vf)));
    setSelected(
      selectSongAwareSegments(clips, songs, {
        targetSeconds: effTarget,
        maxCuts,
        seed,
        variety,
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, songs, seed, effTarget, variety, segOn, resolved]);

  // ---- STEP D: build/refresh the editable Edit Decision List (segment path) ---
  // Rebuilt only when the generation inputs actually change (new clips, target,
  // mode, energy, or a reseed/regenerate). Locked rows survive every rebuild
  // (reSelectPreserving re-inserts pins). On reload the restored EDL matches the
  // restored inputs, so it isn't clobbered and the user's edits persist.
  useEffect(() => {
    if (!segOn || !segResults) {
      setSegEdl(null);
      return;
    }
    computeGlobalUniqueness(segResults);
    const cur = segEdlRef.current;
    const clipKey = clipKeyOf(segResults);
    const needs =
      !cur ||
      cur.clipKey !== clipKey ||
      cur.targetSeconds !== effTarget ||
      cur.mode !== resolved ||
      cur.energy !== energy ||
      cur.seed !== seed;
    if (!needs) return;
    const built = reSelectPreserving(cur, segResults, {
      targetSeconds: effTarget,
      seed,
      mode: resolved,
      energy,
    });
    segEdlRef.current = built;
    setSegEdl(built);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segOn, segResults, effTarget, resolved, energy, seed]);

  // ---- STEP D: keep `selected` in sync with the user's EDL (segment path) ----
  // The existing pacing/render/export pipeline consumes `selected`, so feeding
  // it the EDL's segments means every edit recomputes a valid reel preview.
  useEffect(() => {
    if (segOn && segEdl && segResults) {
      setSelected(edlToSegments(segEdl.rows, segResults));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segOn, segEdl, segResults]);

  // ---- EDITORIAL (Build #2): pacing + transition plan for the selected set ----
  // `paced` assigns each cut a beat class (§1.3) + a concrete slot duration and
  // builds the 60s arc; `boundaries[i]` is the transition INTO cut i (index 0:
  // none). Both are computed once for the set and consumed by the SINGLE shared
  // render pipeline (preview == export). A chosen mode leans both.
  const paced: PacedCut[] = useMemo(
    () => planPacing(selected, effTarget, modeBias),
    [selected, effTarget, modeBias]
  );
  const boundaries: (Boundary | null)[] = useMemo(
    () => computeBoundaries(paced, modePolicy),
    [paced, modePolicy]
  );

  const runAnalysis = useCallback(async () => {
    if (files.length === 0) return;
    setPhase("analyzing");
    setPlaying(false);
    cancelPlayRef.current = true;
    setExportInfo(null);
    if (typeof AudioContext === "undefined") {
      setError("Your browser doesn't support the Web Audio API, so we can't analyze audio. Try a recent Chrome/Firefox/Safari.");
      setPhase("idle");
      return;
    }
    const ctx = new AudioContext();
    // Never hard-block on resume: some browsers/headless contexts keep the
    // AudioContext "suspended" until a user gesture (or forever), but
    // decodeAudioData works fine on a suspended context. Time it out.
    if (ctx.state === "suspended") {
      await Promise.race([
        ctx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }

    const done: AnalyzedClip[] = [];
    const failed: string[] = [];
    const total = files.length;
    for (let i = 0; i < files.length; i++) {
      setAnalyzingStatus(`Decoding audio… clip ${i + 1}/${total} — ${files[i].name}`);
      const t0 = performance.now();
      const clip = await analyzeVideoFile(files[i], i, ctx, (stage, file) => {
        if (stage === "start") {
          setAnalyzingStatus(
            `Decoding audio… clip ${i + 1}/${total} (needs the native capture path) — ${file.name}`
          );
        } else if (stage === "ready-fast") {
          setAnalyzingStatus(
            `Reading audio fast (accelerated capture)… clip ${i + 1}/${total} — ${file.name}`
          );
        } else if (stage === "ready") {
          setAnalyzingStatus(
            `Reading audio… clip ${i + 1}/${total} (realtime capture) — ${file.name}`
          );
        } else if (stage === "playing") {
          setAnalyzingStatus(
            `Capturing audio… clip ${i + 1}/${total} — ${file.name}`
          );
        }
      });
      if (clip) {
        const v = ensureVideo(i, files[i]);
        if (v.src !== videoHandles.current.get(i)?.url)
          v.src = videoHandles.current.get(i)!.url;
        v.preload = "auto";
        v.load();
        done.push(clip);
      } else {
        failed.push(files[i].name);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await ctx.close().catch(() => {});
    setClips(done);
    setAnalyzingStatus("");
    if (done.length === 0) {
      setError(
        "We couldn't get audio from any of those clips" +
          (failed.length ? ` — ${failed.join(", ")}` : "") +
          ". Try phone videos (MP4/MOV/WebM) with audio that play in your browser."
      );
      setPhase("idle");
      return;
    }
    if (failed.length) {
      setError(
        `One or more clips couldn't be decoded and were skipped: ${failed.join(
          ", "
        )}. The rest were analyzed.`
      );
    }
    setAnalyzingStatus("");
    setPhase("done");
    setTimeout(() => studioRef?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    // selection is recomputed by the clips/maxDuration effect above
  }, [files, ensureVideo, studioRef, setExportInfo]);

  const regenerate = useCallback(() => {
    if (clips.length === 0) return;
    setSeed((s) => s + 1);
    setExportInfo(null);
  }, [clips, setExportInfo]);

  const stopPlayback = useCallback(() => {
    cancelPlayRef.current = true;
    playingRef.current = false;
    videoHandles.current.forEach((h) => h.el.pause());
    setPlaying(false);
    setPlayInfo("");
  }, []);

  // Wipe the whole session — state AND persisted storage — for a clean slate.
  const startOver = useCallback(() => {
    stopPlayback();
    setExportInfo(null);
    setFiles([]);
    setClips([]);
    setSelected([]);
    setPhase("idle");
    setAspectRatio("9:16");
    setMaxDuration(30);
    setTheme(DEFAULT_THEME);
    setSeed(1);
    setMode(DEFAULT_MODE);
    setVariety(0.5);
    setSingleAudio({ on: false, sourceType: "clip" });
    setBedFile(null);
    ensureBedElement(null);
    setStorageNote("");
    setSessionStatus("idle");
    clearSession().catch(() => {});
    window.setTimeout(() => studioRef?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }, [stopPlayback, setExportInfo, studioRef, ensureBedElement]);

  // clear the canvas now (e.g. when aspect ratio changes)
  const clearCanvas = useCallback(() => {
    const canvas = studioRef?.querySelector("#reel-canvas") as HTMLCanvasElement | null;
    const c2d = canvas?.getContext("2d");
    if (canvas && c2d) {
      c2d.fillStyle = "#0b0b12";
      c2d.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, [studioRef]);

  useEffect(() => {
    clearCanvas();
  }, [aspectRatio, clearCanvas]);

  // draw a source frame onto a LAYER canvas, reframing into the action with a
  // subtle pan/zoom when the clip's orientation calls for it. Matching-orientation
  // sources get a simple full-frame cover. Each layer has its own ReframeController
  // so the outgoing and incoming clips each keep a smooth, independent motion.
  const blitLayer = useCallback(
    (
      lctx: CanvasRenderingContext2D,
      el: HTMLVideoElement | null,
      cw: number,
      ch: number,
      ref: ReframeController
    ) => {
      lctx.fillStyle = "#0b0b12";
      lctx.fillRect(0, 0, cw, ch);
      if (!el) return;
      try {
        const rect = ref.update(el, cw, ch);
        if (rect.sw > 0 && rect.sh > 0) {
          lctx.drawImage(el, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, cw, ch);
          return;
        }
      } catch {
        /* frame not ready */
      }
      // fallback: plain cover center-crop
      try {
        const vw = el.videoWidth || cw;
        const vh = el.videoHeight || ch;
        const scale = Math.max(cw / vw, ch / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        lctx.drawImage(el, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      } catch {
        /* not ready */
      }
    },
    []
  );

  // composite the (up to two) layers onto the output canvas with a dissolve.
  const composeFrame = useCallback(
    (
      c2d: CanvasRenderingContext2D,
      ca: HTMLCanvasElement,
      cb: HTMLCanvasElement | null,
      alphaA: number,
      alphaB: number,
      cw: number,
      ch: number
    ) => {
      c2d.clearRect(0, 0, cw, ch);
      c2d.globalAlpha = alphaA;
      c2d.drawImage(ca, 0, 0);
      if (cb) {
        c2d.globalAlpha = alphaB;
        c2d.drawImage(cb, 0, 0);
      }
      c2d.globalAlpha = 1;
    },
    []
  );

  interface Paint {
    seg: Segment;
    dur: number; // EDITORIAL: the cut's paced slot duration
    style: CutStyle; // EDITORIAL: beat class (drives motion + boundary logic)
    el: HTMLVideoElement;
  }

  interface ReelAudioAdapter {
    start(seg: Segment, el: HTMLVideoElement): void;
    transition(t: number, from: Segment, to: Segment): void;
    stopAll(): void;
  }

  interface RenderReelOpts {
    canvas: HTMLCanvasElement;
    c2d: CanvasRenderingContext2D;
    layers: [HTMLCanvasElement, HTMLCanvasElement];
    paints: Paint[];
    boundaries: (Boundary | null)[]; // per-boundary transition plan (index i = into cut i)
    audio?: ReelAudioAdapter;
    onFrame?: (reelT: number, pct: number) => void;
  }

  // THE shared reel engine. Drives the realtime timeline for BOTH preview and
  // export so what you preview is byte-for-byte what you export:
  //   * each cut plays its full selected slice (nothing lost),
  //   * where two DIFFERENT clips meet, the outgoing clip's tail and the
  //     incoming clip's head overlap for TRANSITION_S and dissolve (visual) while
  //     the audio bed equal-power crossfades old → new,
  //   * the chosen visual theme (grade + vignette + opening title) is applied to
  //     every frame, and smart-reframing (Ken Burns) keeps each clip in motion.
  // Reel length == sum of cut durations → always within the caller's max-duration cap.
  const renderReel = useCallback(async (opts: RenderReelOpts) => {
    const { canvas, c2d, layers, paints, boundaries, audio } = opts;
    const cw = canvas.width;
    const ch = canvas.height;
    const [la, lb] = layers;
    const lca = la.getContext("2d", { alpha: false })!;
    const lcb = lb.getContext("2d", { alpha: false })!;

    const slotStart: number[] = [];
    let acc = 0;
    for (const p of paints) {
      slotStart.push(acc);
      acc += p.dur;
    }
    const total = acc;
    if (total <= 0) return;

    const startWall = performance.now();
    const endWall = startWall + total * 1000;

    const started: boolean[] = paints.map(() => false);
    const refs: Record<number, ReframeController> = {};

    const seekTo = (el: HTMLVideoElement, t: number) =>
      new Promise<void>((res) => {
        // resolve fast; a slightly-off seek is fine for a realtime edit preview
        let done = false;
        const fin = () => {
          if (!done) {
            done = true;
            res();
          }
        };
        el.onloadedmetadata = () => {
          try {
            el.currentTime = t;
          } catch {
            /* noop */
          }
          fin();
        };
        el.onerror = fin;
        try {
          el.load();
          el.currentTime = t;
        } catch {
          fin();
        }
        setTimeout(fin, 700);
      });

    const ensurePlaying = async (idx: number) => {
      if (started[idx]) return;
      const p = paints[idx];
      try {
        await seekTo(p.el, p.seg.start);
      } catch {
        /* noop */
      }
      try {
        await p.el.play().catch(() => {});
      } catch {
        /* noop */
      }
      started[idx] = true;
      refs[idx] = new ReframeController();
      // EDITORIAL (§5): each cut gets a motion style from its class, refined
      // by the source/orientation (wide-guard for 16:9→9:16, match for ✓ ratio),
      // and leaned by the chosen edit mode.
      const want = motionStyleFor(p.style, modeBiasRef.current);
      const eff = ReframeController.styleForSource(
        want,
        p.el.videoWidth || cw,
        p.el.videoHeight || ch,
        cw,
        ch
      );
      refs[idx].startCut(eff as MotionStyle);
      audio?.start(p.seg, p.el);
    };

    try {
      while (true) {
        if (cancelPlayRef.current) break;
        const now = performance.now();
        if (now >= endWall) break;
        const reelT = (now - startWall) / 1000;

        // which cut's slot are we in (the "current"/incoming cut)
        let cur = -1;
        for (let i = 0; i < slotStart.length; i++) if (reelT >= slotStart[i]) cur = i;
        if (cur < 0) cur = 0;

        // EDITORIAL (§2/§3): per-boundary transition window (not a uniform dissolve)
        const bnd = cur > 0 ? boundaries[cur] : null;
        const isTrans = !!bnd && bnd.dur > 0 && reelT - slotStart[cur] < bnd.dur;

        if (isTrans) {
          const prev = cur - 1;
          await ensurePlaying(prev);
          await ensurePlaying(cur);
          const t = clamp01((reelT - slotStart[cur]) / bnd!.dur);
          blitLayer(lca, paints[prev].el, cw, ch, refs[prev]);
          blitLayer(lcb, paints[cur].el, cw, ch, refs[cur]);
          composeTransition(
            c2d,
            cw,
            ch,
            la,
            lb,
            bnd!.type,
            t
          );
          audio?.transition(t, paints[prev].seg, paints[cur].seg);
        } else {
          await ensurePlaying(cur);
          blitLayer(lca, paints[cur].el, cw, ch, refs[cur]);
          composeFrame(c2d, la, null, 1, 0, cw, ch);
        }

        applyTheme(c2d, cw, ch, themeRef.current, reelT, total);
        opts.onFrame?.(reelT, Math.min(1, reelT / total));

        await new Promise((r) => requestAnimationFrame(r));
      }
    } finally {
      paints.forEach((p) => {
        try {
          p.el.pause();
        } catch {
          /* noop */
        }
      });
      audio?.stopAll();
    }
  }, [blitLayer, composeFrame]);

  const playRoughCut = useCallback(async () => {
    if (paced.length === 0 || !clips.length) return;
    stopPlayback();
    cancelPlayRef.current = false;
    playingRef.current = true;
    setPlaying(true);

    const paints: Paint[] = paced.map((pc) => {
      const s = pc.seg;
      const el = ensureVideo(s.clipId, files[s.clipId]);
      if (el.src !== videoHandles.current.get(s.clipId)!.url)
        el.src = videoHandles.current.get(s.clipId)!.url;
      // STEP D: a cut with audioBehavior "mute" keeps its source silent in the
      // review preview too (the exported bed honors it the same way).
      try {
        el.muted = s.audioBehavior === "mute";
      } catch {
        /* noop */
      }
      return { seg: s, dur: pc.dur, style: pc.style, el };
    });

    const canvas = studioRef?.querySelector("#reel-canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    const cw = canvas.width;
    const ch = canvas.height;
    const layers: [HTMLCanvasElement, HTMLCanvasElement] = [
      document.createElement("canvas"),
      document.createElement("canvas"),
    ];
    layers[0].width = layers[1].width = cw;
    layers[0].height = layers[1].height = ch;

    reframeRef.current = new ReframeController();

    // ---- SINGLE-AUDIO preview (Part B2): mute the visual clips and play the
    // chosen one-track bed through a dedicated element so ONLY the handpicked
    // audio is heard (preview == export bed). Normal mode stays "each clip
    // audible as it plays" (no adapter, unchanged). ----
    const singleBed = singleAudio.on
      ? singleAudio.sourceType === "clip"
        ? files[singleAudio.clipId ?? -1] ?? null
        : bedFile
      : null;
    const previewAdapter: ReelAudioAdapter | undefined = singleAudio.on
      ? (() => {
          const bedEl = singleBed ? ensureBedElement(singleBed) : null;
          if (!bedEl) return undefined;
          paints.forEach((p) => {
            p.el.muted = true;
          });
          bedStartedRef.current = false;
          return {
            start() {
              if (bedStartedRef.current) return;
              bedStartedRef.current = true;
              try {
                bedEl.play().catch(() => {});
              } catch {
                /* noop */
              }
            },
            transition() {
              /* one continuous bed — no per-cut crossfade */
            },
            stopAll() {
              bedStartedRef.current = false;
              try {
                bedEl.pause();
              } catch {
                /* noop */
              }
              paints.forEach((p) => {
                try {
                  p.el.muted = false;
                } catch {
                  /* noop */
                }
              });
            },
          };
        })()
      : undefined;

    await renderReel({
      canvas,
      c2d,
      layers,
      paints,
      boundaries,
      audio: previewAdapter,
      onFrame: (_, pct) => {
        // live-status overlay so the preview clearly reads as a rough cut
        c2d.fillStyle = "rgba(0,0,0,0.55)";
        c2d.fillRect(0, ch - 34, cw, 34);
        c2d.fillStyle = "#fff";
        c2d.font = "600 14px system-ui, sans-serif";
        c2d.fillText(`STORY REEL · ${pct === 0 ? "starts on the hook" : `${Math.round(pct * 100)}%`}`, 12, ch - 12);
        c2d.fillStyle = "#a78bfa";
        c2d.fillRect(0, ch - 2, cw * pct, 2);
      },
    });

    // tidy up (adapter.stopAll ran in renderReel's finally; make sure clipped)
    paints.forEach((p) => {
      try {
        p.el.muted = false;
      } catch {
        /* noop */
      }
    });
    playingRef.current = false;
    setPlaying(false);
    setPlayInfo("");
    cancelPlayRef.current = false;
  }, [paced, boundaries, clips, files, ensureVideo, studioRef, stopPlayback, renderReel, singleAudio, bedFile, ensureBedElement]);

  //---- audible export: canvas video + source clips' audio composited ----
  const ensureAudioGraph = useCallback(async (): Promise<AudioContext | null> => {
    if (typeof AudioContext === "undefined") return null;
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") {
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 900))]);
    }
    return ctx.state === "running" ? ctx : null;
  }, []);

  const ensureAudioSource = useCallback((ctx: AudioContext, clipId: number, el: HTMLVideoElement) => {
    let src = audioSourceRef.current.get(clipId);
    if (!src) {
      src = ctx.createMediaElementSource(el);
      // keep the element audible to speakers even after it's claimed by the graph
      src.connect(ctx.destination);
      audioSourceRef.current.set(clipId, src);
    }
    return src;
  }, []);

  const exportRoughCut = useCallback(async () => {
    if (selected.length === 0 || !clips.length) return;
    if (typeof MediaRecorder === "undefined") {
      setError("Your browser doesn't support MediaRecorder — use Play rough cut instead.");
      return;
    }
    const canvas = studioRef?.querySelector("#reel-canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    const cw = canvas.width;
    const ch = canvas.height;

    setExporting(true);
    setExportMsg("");
    setExportInfo(null);
    setShowCamRoll(false);
    cancelPlayRef.current = false;
    reframeRef.current = new ReframeController();

    const ctx = await ensureAudioGraph();
    if (!ctx) {
      setExporting(false);
      setError(
        "The browser won't let us record audio right now — tap Export again (a click grants audio access), or use Play rough cut to preview."
      );
      return;
    }
    const recDest = ctx.createMediaStreamDestination();

    // Fresh audio-bed gains for this export (each clip → its own gain → the
    // recording destination, so we can crossfade from song to song).
    exportGainRef.current.forEach((g) => {
      try {
        g.disconnect();
      } catch {
        /* noop */
      }
    });
    exportGainRef.current.clear();

    const gainFor = (clipId: number, el: HTMLVideoElement): GainNode => {
      let g = exportGainRef.current.get(clipId);
      if (!g) {
        const src = ensureAudioSource(ctx, clipId, el);
        g = ctx.createGain();
        g.gain.value = 0;
        src.connect(g);
        g.connect(recDest); // this export's audio destination (recorded)
        exportGainRef.current.set(clipId, g);
      }
      return g;
    };

    // ---- AUDIO BED, two modes ----
    // (A) SINGLE-AUDIO "1 AUDIO" (Part B2): the ONE handpicked track (a clip's
    //     audio or an uploaded audio-only file) is the ONLY recorded bed. It
    //     plays through a dedicated element (independent of the visuals) for the
    //     whole reel, fades in at the start and out before the end. The visual
    //     clips contribute NO audio — so the user's chosen song drives the whole
    //     piece, trimmed/paced to fit it (see effTarget).
    // (B) default multi-bed: per-clip gains + equal-power song crossfades.
    let audio: ReelAudioAdapter;
    if (singleAudio.on) {
      const bedSrcFile =
        singleAudio.sourceType === "clip"
          ? files[singleAudio.clipId ?? -1] ?? null
          : bedFile;
      if (!bedSrcFile) {
        setExporting(false);
        setError("Pick an audio source for 1 AUDIO mode (or turn it off).");
        return;
      }
      const bedEl = ensureBedElement(bedSrcFile);
      if (!bedEl) {
        setExporting(false);
        setError("We couldn't load that audio source — try again or use a different one.");
        return;
      }
      const bedGain = ctx.createGain();
      bedGain.gain.value = 0;
      try {
        const bedSrc = ctx.createMediaElementSource(bedEl);
        bedSrc.connect(bedGain);
        bedGain.connect(recDest);
      } catch {
        setExporting(false);
        setError("We couldn't route that audio source to the recording — try again.");
        return;
      }
      bedGainRef.current = bedGain;
      bedStartedRef.current = false;
      audio = {
        start() {
          if (bedStartedRef.current) return;
          bedStartedRef.current = true;
          try {
            bedEl.play().catch(() => {});
          } catch {
            /* noop */
          }
          try {
            bedGain.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
          } catch {
            /* noop */
          }
        },
        transition() {
          /* one continuous chosen bed — no per-cut crossfade */
        },
        stopAll() {
          bedStartedRef.current = false;
          try {
            bedGain.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
          } catch {
            /* noop */
          }
          try {
            bedEl.pause();
          } catch {
            /* noop */
          }
        },
      };
    } else {
      // (B) ---- flexible audio bed: per-clip gains + equal-power song
      // crossfades. STEP D: a cut whose EDL audioBehavior is "mute" contributes
      // silence (its source audio is muted) while its neighbours still crossfade.
      audio = {
        start(seg, el) {
          try {
            const target = seg.audioBehavior === "mute" ? 0 : 1;
            gainFor(seg.clipId, el).gain.setTargetAtTime(target, ctx.currentTime, 0.04);
          } catch {
            /* noop */
          }
        },
        transition(t, from, to) {
          const [gFrom, gTo] = equalPower(t);
          try {
            const fromEl = videoHandles.current.get(from.clipId)?.el;
            const toEl = videoHandles.current.get(to.clipId)?.el;
            if (fromEl) {
              const v = from.audioBehavior === "mute" ? 0 : gFrom;
              gainFor(from.clipId, fromEl).gain.setTargetAtTime(v, ctx.currentTime, 0.015);
            }
            if (toEl) {
              const v = to.audioBehavior === "mute" ? 0 : gTo;
              gainFor(to.clipId, toEl).gain.setTargetAtTime(v, ctx.currentTime, 0.015);
            }
          } catch {
            /* noop */
          }
        },
        stopAll() {
          exportGainRef.current.forEach((g) => {
            try {
              g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
            } catch {
              /* noop */
            }
          });
        },
      };
    }

    const paints: Paint[] = paced.map((pc) => {
      const s = pc.seg;
      const el = ensureVideo(s.clipId, files[s.clipId]);
      if (el.src !== videoHandles.current.get(s.clipId)!.url)
        el.src = videoHandles.current.get(s.clipId)!.url;
      return { seg: s, dur: pc.dur, style: pc.style, el };
    });
    // Single-audio: keep the visual clips silent so only the chosen bed is
    // heard (restored after this export).
    if (singleAudio.on) paints.forEach((p) => { try { p.el.muted = true; } catch { /* noop */ } });

    const mime = getExportMime();
    let stream: MediaStream;
    try {
      const canvasStream = canvas.captureStream(30);
      const vTracks = canvasStream.getVideoTracks();
      const aTracks = recDest.stream.getAudioTracks();
      if (aTracks.length === 0) throw new Error("no audio track");
      stream = new MediaStream([...vTracks, ...aTracks]);
    } catch {
      setExporting(false);
      setError("Couldn't get an audio track to record. Try again or use Play rough cut to preview.");
      return;
    }

    const rec = new MediaRecorder(stream, {
      mimeType: mime.mime,
      videoBitsPerSecond: 10_000_000, // ~10 Mbps high-quality
      audioBitsPerSecond: 192_000,
    });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((res) => {
      rec.onstop = () => res();
    });
    rec.start(250);

    try {
      await renderReel({
        canvas,
        c2d,
        layers: [
          (() => {
            const c = document.createElement("canvas");
            c.width = cw;
            c.height = ch;
            return c;
          })(),
          (() => {
            const c = document.createElement("canvas");
            c.width = cw;
            c.height = ch;
            return c;
          })(),
        ],
        paints,
        boundaries,
        audio,
        onFrame: (reelT, pct) => {
          setExportMsg(
            `Composing reel… ${Math.ceil(reelT)}/${maxDuration}s — ${Math.round(pct * 100)}%`
          );
        },
      });
    } finally {
      videoHandles.current.forEach((h) => h.el.pause());
      if (singleAudio.on) paints.forEach((p) => { try { p.el.muted = false; } catch { /* noop */ } });
      try {
        audio.stopAll();
      } catch {
        /* noop */
      }
    }
    cancelPlayRef.current = false;
    setExportMsg("");
    await new Promise((r) => setTimeout(r, 60));
    rec.stop();
    await stopped;

    if (chunks.length === 0) {
      setExporting(false);
      setError("Recording produced no data. Try again or use Play rough cut to preview.");
      return;
    }
    const blob = new Blob(chunks, { type: mime.baseType || (mime.isMp4 ? "video/mp4" : "video/webm") });
    const url = URL.createObjectURL(blob);
    setExporting(false);
    setExportInfo({
      url,
      ext: mime.ext,
      isMp4: mime.isMp4,
      sizeMB: blob.size / 1e6,
      dims: `${cw}×${ch}`,
      codecs: mime.codecs,
    });
  }, [
    paced,
    boundaries,
    clips,
    files,
    maxDuration,
    ensureVideo,
    ensureAudioGraph,
    ensureAudioSource,
    renderReel,
    studioRef,
    setExportInfo,
    singleAudio,
    bedFile,
    ensureBedElement,
  ]);

  const saveDownload = useCallback(() => {
    if (!exportInfo) return;
    const a = document.createElement("a");
    a.href = exportInfo.url;
    a.download = `concert-compass-reel.${exportInfo.ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [exportInfo]);

  // EDITORIAL: the real on-screen reel length (sum of the paced slot durations)
  const pacedTotal = useMemo(() => paced.reduce((s, x) => s + x.dur, 0), [paced]);
  // how many DISTINCT source clips get at least one moment in the reel (the
  // coverage story: a 24-clip show should feature many of them, not 2)
  const featuredClipCount = useMemo(() => new Set(selected.map((s) => s.clipId)).size, [selected]);
  // which detected songs currently have at least one cut in the reel
  const pickedSongIds = useMemo(
    () => new Set(selected.filter((s) => s.songIndex >= 0).map((s) => s.songIndex)),
    [selected]
  );

  // ---- STEP D: editing handlers over the segment-path EDL ----
  // All operations are pure + recompute within the duration budget, then feed
  // `selected` (and thus the preview/export) through the sync effect above. Locked
  // rows are preserved by the ops themselves and by reSelectPreserving on rebuilds.
  const edlPatch = (fn: (s: EdlState) => EdlState) => {
    setSegEdl((s) => (s && segResults ? { ...fn(s) } : s));
  };
  const edlTotal = segEdl ? segEdl.rows.reduce((a, r) => a + r.duration, 0) : 0;
  const segMutedAny = segEdl ? segEdl.rows.some((r) => (r.audioBehavior ?? "keep_source") === "mute") : false;
  const roleOf = (reason: string) => (reason ? reason.split("|")[0] : "—");
  const catOf = (reason: string) => (reason ? reason.split("|")[1] ?? "" : "");

  return (
    <div className="min-h-dvh bg-[#0b0b12] text-white">
      {/* header */}
      <header className="sticky top-0 z-20 border-b border-white/10 bg-[#0b0b12]/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-fuchsia-500 to-violet-600 text-base">
              ♪
            </span>
            <span>Concert Compass</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm text-white/60">
            <Link to="/" className="hover:text-white">Home</Link>
            <span className="rounded-full bg-fuchsia-500/15 px-3 py-1 font-medium text-fuchsia-300">
              Reel Studio
            </span>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 pb-24">
        {/* session persistence banner */}
        {sessionStatus === "restoring" && (
          <div className="mx-auto mt-6 max-w-3xl rounded-2xl border border-violet-400/30 bg-violet-500/10 px-5 py-4 text-center text-sm text-violet-100">
            Restoring your saved session… <span className="text-violet-300/70">(clips, analysis &amp; settings are stored on this device — no re-upload)</span>
          </div>
        )}
        {sessionStatus === "restored" && (
          <div className="mx-auto mt-6 flex max-w-3xl flex-col items-center gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-5 py-4 text-center text-sm text-emerald-100 sm:flex-row sm:justify-between sm:text-left">
            <p>
              <span className="font-semibold">✓ Session saved on this device</span>
              <span className="text-emerald-200/70"> — your clips, analysis &amp; settings are stored locally. If you leave or close this tab, everything picks back up here — no re-upload, no re-analysis.</span>
            </p>
            <button
              onClick={startOver}
              className="shrink-0 rounded-xl border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-400/10"
            >
              Start over · clear saved session
            </button>
          </div>
        )}
        {storageNote && (
          <div className="mx-auto mt-3 max-w-3xl rounded-2xl border border-amber-400/30 bg-amber-400/10 px-5 py-3 text-center text-xs text-amber-200">
            {storageNote}
          </div>
        )}

        {/* upload zone — output-first framing */}
        <section className="pt-12 pb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Turn your clips into a shareable reel
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-white/60">
            Drop in your concert clips. We pick the best moments, trim the dead
            air, and stitch them into one polished video — you choose the format,
            set the length, and export a high-quality MP4 for your camera roll.
            Everything stays on this device. Phone videos (MP4/MOV/WebM) work;
            most clips decode in a second or two — even rare phone files that
            need the native capture path now read in seconds, not clip-length.
          </p>
        </section>

        {/* -------- EDIT MODES (STEP C, 2.0): pick the edit's character up-front -------- */}
        <section className="mx-auto mt-4 max-w-3xl rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-white/80">🎬 Edit mode</p>
            <span className="text-[10px] text-white/40">
              {mode === "surprise-me"
                ? "We pick the best fit for your footage — you can change it."
                : `${EDIT_MODES[mode].emoji} ${EDIT_MODES[mode].label} — hard-cut edits, no opening title.`}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {editModeIds().map((m) => {
              const p: EditMode = EDIT_MODES[m];
              return (
                <button
                  key={m}
                  onClick={() => applyMode(m)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${
                    m === mode
                      ? "border-fuchsia-400 bg-fuchsia-500/15 text-white"
                      : "border-white/10 bg-white/5 text-white/60 hover:border-fuchsia-400/50"
                  }`}
                  title={p.tagline}
                >
                  <span className="block text-lg leading-none">{p.emoji}</span>
                  <span className="mt-1 block text-xs font-bold">{p.label}</span>
                  <span className="mt-0.5 block text-[9px] leading-tight text-white/45">
                    {m === "surprise-me"
                      ? resolved === "surprise-me"
                        ? "Auto — resolves to a mode"
                        : `→ ${EDIT_MODES[resolved].label}`
                      : p.desc.split(";")[0]}
                  </span>
                </button>
              );
            })}
          </div>
          {mode === "surprise-me" && (
            <p className="mt-2 text-[10px] text-white/45">
              {resolved === "surprise-me"
                ? "Analyse your clips first — Surprise Me will pick the best mode for this show."
                : `We picked ${EDIT_MODES[resolved].emoji} ${EDIT_MODES[resolved].label} for this show's energy/beat/crowd — you can change it.`}
            </p>
          )}
        </section>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          className={`mx-auto max-w-3xl cursor-pointer rounded-3xl border-2 border-dashed p-10 text-center transition-colors ${
            dragOver ? "border-fuchsia-400 bg-fuchsia-500/10" : "border-white/15 bg-white/5 hover:border-fuchsia-400/60"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            multiple
            className="hidden"
            onChange={(e) => { onFiles(e.target.files); e.currentTarget.value = ""; }}
          />
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500 to-violet-600 text-2xl">▲</div>
          <p className="text-lg font-semibold">Drag your concert videos here</p>
          <p className="mt-1 text-sm text-white/50">or click to browse · multiple files · stays on-device</p>
        </div>

        {files.length > 0 && (
          <div className="mx-auto mt-6 max-w-3xl space-y-2">
            {files.map((f, i) => (
              <div key={`${f.name}-${f.size}`} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-500/20 text-violet-200">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{f.name}</p>
                  <p className="text-xs text-white/40">{(f.size / 1e6).toFixed(1)} MB</p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setFiles(files.filter((_, j) => j !== i));
                    setClips(clips.filter((c) => c.clipId !== i).map((c) => ({ ...c, clipId: c.clipId > i ? c.clipId - 1 : c.clipId })));
                  }}
                  className="rounded-lg px-2 py-1 text-white/40 hover:bg-white/10 hover:text-white"
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {files.length > 0 && (
          <div className="mx-auto mt-6 flex max-w-3xl flex-wrap items-center justify-center gap-3">
            <button
              onClick={runAnalysis}
              disabled={phase === "analyzing"}
              className="rounded-2xl bg-gradient-to-r from-fuchsia-500 to-violet-600 px-6 py-3 font-semibold shadow-lg shadow-fuchsia-500/20 transition hover:brightness-110 disabled:opacity-50"
            >
              {phase === "analyzing" ? "Analyzing…" : "Build my reel"}
            </button>
            {files.length > 0 && (
              <button
                onClick={startOver}
                className="rounded-2xl border border-white/15 px-5 py-3 font-medium text-white/70 hover:bg-white/5"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {phase === "analyzing" && (
          <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-white/60">{analyzingStatus}</p>
        )}
        {error && (
          <p className="mx-auto mt-4 max-w-2xl rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-center text-sm text-amber-200">
            {error}
          </p>
        )}
        {exporting && (
          <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-fuchsia-300">
            ⏺ Recording your reel with sound… {exportMsg}
          </p>
        )}

        <div ref={setStudioRef} className="mt-12 grid scroll-mt-24 gap-8 md:grid-cols-[1.5fr_1fr]">
          {/* left: OUTPUT controls + canvas + timeline */}
          <div className="space-y-6">
            {/* -------- output controls (the priority) -------- */}
            <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-bold text-white/80">Your reel output</p>
              <p className="text-xs text-white/40">Pick the format and length — the preview and the exported file both match.</p>
              <div className="mt-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/50">Aspect ratio</p>
                <div className="grid grid-cols-4 gap-2">
                  {(Object.keys(RATIOS) as AspectRatio[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => { setAspectRatio(r); setExportInfo(null); }}
                      className={`rounded-xl border px-2 py-2 text-center transition ${
                        r === aspectRatio
                          ? "border-fuchsia-400 bg-fuchsia-500/15 text-white"
                          : "border-white/10 bg-white/5 text-white/60 hover:border-fuchsia-400/50"
                      }`}
                    >
                      <span className="block text-base leading-none">{RATIOS[r].icon}</span>
                      <span className="mt-1 block text-[11px] font-semibold">{r}</span>
                      <span className="hidden text-[9px] text-white/40 sm:block">{RATIOS[r].label}</span>
                    </button>
                  ))}
                </div>
                {/* visual ratio glyphs for quick reference */}
                <div className="mt-2 flex items-center gap-2 text-[10px] text-white/40">
                  <span className="rounded bg-white/5 px-1.5 py-0.5">{RATIOS[aspectRatio].hint}</span>
                  <span className="hidden sm:inline">— smart reframe pans &amp; zooms into the action</span>
                </div>
              </div>
              <div className="mt-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/50">
                  Max reel length
                </p>
                <div className="grid grid-cols-4 gap-2 sm:max-w-sm">
                  {DURATIONS.map((d) => (
                    <button
                      key={d}
                      onClick={() => { setMaxDuration(d); setExportInfo(null); }}
                      className={`rounded-xl border px-2 py-2 text-sm font-semibold transition ${
                        d === maxDuration
                          ? "border-fuchsia-400 bg-fuchsia-500/15 text-white"
                          : "border-white/10 bg-white/5 text-white/60 hover:border-fuchsia-400/50"
                      }`}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-white/40">
                  {singleAudio.on && singleTrackSeconds
                    ? `Fit to your 1 AUDIO track (${singleTrackSeconds.toFixed(0)}s).`
                    : `Cuts are chosen to fit your ${maxDuration}s cap.`}
                </p>
              </div>
              {/* -------- COVERAGE / VARIETY control (Part B1) -------- */}
              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
                    Coverage mix
                  </p>
                  <span className="text-[10px] text-fuchsia-300">
                    {variety >= 0.75 ? "Tour many videos/songs" : variety <= 0.25 ? "Fewer, longer moments" : "Balanced"}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(variety * 100)}
                  onChange={(e) => { setVariety(Number(e.target.value) / 100); setExportInfo(null); }}
                  className="w-full accent-fuchsia-500"
                />
                <div className="mt-0.5 flex justify-between text-[10px] text-white/40">
                  <span>Fewer, longer moments</span>
                  <span>Tour many · shorter each</span>
                </div>
                <p className="mt-1.5 text-[11px] text-white/40">
                  Lean the edit: tour a lot of distinct clips/songs at shorter
                  moments, or concentrate the time on a few standout ones — always
                  within your length cap.
                </p>
              </div>
              {/* -------- STEP B: segment-level selection dispatch (2.0 pivot) -------- */}
              <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div className="min-w-0">
                    <p className="text-[12px] font-bold text-white/80">
                      ⚙ Segment-level picks (2.0)
                    </p>
                    <p className="text-[10px] text-white/45">
                      Edit at the MOMENT level — rank diverse bursts, hard-cut
                      hero moments, respect the story arc. Off for now keeps the
                      classic coverage mix.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={segSelect}
                    onChange={(e) => { setSegSelect(e.target.checked); setExportInfo(null); }}
                    className="shrink-0 h-5 w-5 accent-fuchsia-500"
                  />
                </label>
              </div>
              {/* -------- SINGLE-AUDIO "1 AUDIO" (Part B2) -------- */}
              <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[12px] font-bold text-white/80">
                      1 AUDIO · one-track sound bed
                    </p>
                    <p className="text-[10px] text-white/45">
                      Play the visuals over ONE handpicked track — a clip's audio
                      or an audio file you upload.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setSingleAudio((s) => ({ ...s, on: !s.on }));
                      setExportInfo(null);
                    }}
                    className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-bold transition ${
                      singleAudio.on
                        ? "border-fuchsia-400 bg-fuchsia-500/20 text-fuchsia-100"
                        : "border-white/15 bg-white/5 text-white/60 hover:bg-white/10"
                    }`}
                  >
                    {singleAudio.on ? "ON" : "OFF"}
                  </button>
                </div>
                {singleAudio.on && (
                  <div className="mt-3 space-y-2.5">
                    <div>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/50">Audio source</p>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setSingleAudio((s) => ({ ...s, sourceType: "clip" }))}
                          className={`rounded-lg border px-2 py-1.5 text-left text-[11px] font-medium transition ${
                            singleAudio.sourceType === "clip"
                              ? "border-fuchsia-400 bg-fuchsia-500/15 text-white"
                              : "border-white/10 bg-white/5 text-white/60 hover:border-fuchsia-400/50"
                          }`}
                          disabled={clips.length === 0}
                        >
                          From a clip
                          <span className="block text-[9px] font-normal text-white/40">pick one of your videos</span>
                        </button>
                        <button
                          onClick={() => setSingleAudio((s) => ({ ...s, sourceType: "file" }))}
                          className={`rounded-lg border px-2 py-1.5 text-left text-[11px] font-medium transition ${
                            singleAudio.sourceType === "file"
                              ? "border-fuchsia-400 bg-fuchsia-500/15 text-white"
                              : "border-white/10 bg-white/5 text-white/60 hover:border-fuchsia-400/50"
                          }`}
                        >
                          Audio file
                          <span className="block text-[9px] font-normal text-white/40">upload a song / track</span>
                        </button>
                      </div>
                    </div>
                    {singleAudio.sourceType === "clip" && (
                      <select
                        value={singleAudio.clipId ?? ""}
                        onChange={(e) => {
                          const id = Number(e.target.value);
                          setSingleAudio((s) => ({ ...s, clipId: id, fileName: files[id]?.name }));
                          setExportInfo(null);
                        }}
                        className="w-full rounded-lg border border-white/10 bg-[#12121c] px-2 py-1.5 text-xs"
                      >
                        <option value="" disabled>
                          {clips.length ? "Choose a clip's audio…" : "Analyze clips first…"}
                        </option>
                        {files.map((f, i) => (
                          <option key={i} value={i}>
                            {f.name} {clips[i] ? `(${clips[i].duration?.toFixed(0)}s)` : ""}
                          </option>
                        ))}
                      </select>
                    )}
                    {singleAudio.sourceType === "file" && (
                      <label className="block cursor-pointer rounded-lg border border-dashed border-white/20 bg-white/5 px-3 py-2 text-center text-[11px] text-white/60 hover:border-fuchsia-400/50">
                        {bedFile ? (
                          <>
                            <span className="font-semibold text-fuchsia-200">✓ {bedFile.name}</span>
                            <span className="block text-[10px] text-white/40">
                              {singleAudio.duration ? `~${singleAudio.duration.toFixed(0)}s track` : "track length read on play"}
                            </span>
                          </>
                        ) : (
                          "Tap to upload an audio-only file (MP3 / M4A / WAV / AAC)"
                        )}
                        <input
                          type="file"
                          accept="audio/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0] ?? null;
                            if (!f) return;
                            setBedFile(f);
                            // read the track's duration for honest length fitting
                            const probe = new Audio();
                            probe.src = URL.createObjectURL(f);
                            probe.onloadedmetadata = () => {
                              const d = Number.isFinite(probe.duration) ? probe.duration : 0;
                              setSingleAudio((s) => ({ ...s, on: true, fileName: f.name, duration: d }));
                              URL.revokeObjectURL(probe.src);
                            };
                            probe.onerror = () => {
                              setSingleAudio((s) => ({ ...s, on: true, fileName: f.name, duration: 0 }));
                              URL.revokeObjectURL(probe.src);
                            };
                            setExportInfo(null);
                          }}
                        />
                      </label>
                    )}
                    <p className="text-[10px] leading-relaxed text-white/40">
                      {singleTrackSeconds && singleTrackSeconds < maxDuration
                        ? `Your track is ${singleTrackSeconds.toFixed(0)}s — the reel trims to fit it (shorter than your ${maxDuration}s cap).`
                        : "The reel plays up to your length cap (a longer track is trimmed to it)."}
                      {" "}Preview and the exported file both use the chosen track as the bed.
                    </p>
                  </div>
                )}
              </div>
              <div className="mt-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/50">
                  Visual theme
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {themeIds().map((t) => (
                    <button
                      key={t}
                      onClick={() => { setTheme(t); setExportInfo(null); }}
                      className={`rounded-xl border px-2 py-2 text-center transition ${
                        t === theme
                          ? "border-fuchsia-400 bg-fuchsia-500/15 text-white"
                          : "border-white/10 bg-white/5 text-white/60 hover:border-fuchsia-400/50"
                      }`}
                      title={THEMES[t].hint}
                    >
                      <span
                        className="mx-auto mb-1 block h-2.5 w-full rounded-full"
                        style={{ background: `linear-gradient(90deg, ${THEMES[t].gradeTop}, ${THEMES[t].gradeBottom})` }}
                      />
                      <span className="block text-[11px] font-semibold">{THEMES[t].label}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-white/40">
                  Color grade + vignette, applied to the whole reel (plus a subtle
                  "Concert Compass" credit over the final second). No opening title. A stylistic choice — no mood-detection ML.
                </p>
              </div>
            </section>

            <div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
              <canvas
                id="reel-canvas"
                width={RATIOS[aspectRatio].w}
                height={RATIOS[aspectRatio].h}
                className="h-auto w-full"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-white/80">Rough-cut preview</p>
                <p className="text-xs text-white/40">
                  Plays each paced slice in {RATIOS[aspectRatio].label.toLowerCase()} ·{" "}
                  {effTarget}s target
                  · hard-cut edits, no opening title ·{" "}
                  {THEMES[theme].label} theme
                  {mode === "surprise-me"
                    ? ` · ${EDIT_MODES[resolved].emoji} ${EDIT_MODES[resolved].label} mode`
                    : ` · ${EDIT_MODES[mode].emoji} ${EDIT_MODES[mode].label} mode`}
                  {singleAudio.on ? ` · 1 AUDIO bed (${singleAudio.fileName || "—"})` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={playRoughCut}
                  disabled={selected.length === 0 || playing || exporting}
                  className="rounded-xl bg-gradient-to-r from-fuchsia-500 to-violet-600 px-4 py-2 text-sm font-semibold disabled:opacity-40"
                >
                  {playing ? "Playing…" : "▶ Play"}
                </button>
                <button
                  onClick={exportRoughCut}
                  disabled={selected.length === 0 || playing || exporting}
                  className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 px-4 py-2 text-sm font-semibold shadow-lg shadow-emerald-500/20 disabled:opacity-40"
                  title="Export a high-quality video with sound, in the selected format"
                >
                  {exporting ? "⏺ Exporting…" : "⬇ Export with sound"}
                </button>
                <button
                  onClick={stopPlayback}
                  disabled={!playing && !exporting}
                  className="rounded-xl border border-white/15 px-4 py-2 text-sm font-medium text-white/70 hover:bg-white/5 disabled:opacity-40"
                >
                  ■ Stop
                </button>
              </div>
            </div>
            {playInfo && <p className="text-center text-sm text-fuchsia-300">▶ {playInfo}</p>}

            {/* timelines per clip */}
            {clips.length > 0 && (
              <div className="space-y-5">
                <div>
                  <p className="text-sm font-semibold text-white/80">Feature profiles &amp; selected slices</p>
                  <p className="text-xs text-white/40">
                    Taller = louder. Violet = picked for your reel.
                  </p>
                </div>
                {clips.map((clip) => (
                  <ClipTimeline key={clip.clipId} clip={clip} selected={selected} />
                ))}
              </div>
            )}
          </div>

          {/* right: detected songs + selected cuts + export / camera-roll helper */}
          <aside className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white/80">Set list · detected songs</h2>
                {phase === "done" && songs.length > 0 && (
                  <span className="text-[10px] text-white/40">
                    {songs.filter((sg) => pickedSongIds.has(sg.index)).length}/{songs.length} featured
                  </span>
                )}
              </div>
              {phase === "done" && songs.length === 0 && (
                <p className="mt-2 text-xs text-white/40">
                  No clear song boundary detected in these clips, so we treated
                  them as one continuous set and picked the strongest moments.
                </p>
              )}
              {songs.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {songs.map((sg) => {
                    const picked = pickedSongIds.has(sg.index);
                    return (
                      <li
                        key={`${sg.clipId}-${sg.start}-${sg.index}`}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                          picked
                            ? "border-fuchsia-400/40 bg-fuchsia-500/10"
                            : "border-white/10 bg-white/5"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-white/80">
                            ♪ Song {sg.index + 1}
                          </p>
                          <p className="truncate text-[10px] text-white/40">
                            {sg.clipName} · {sg.start.toFixed(0)}–{sg.end.toFixed(0)}s
                            {sg.bpm > 0 ? ` · ~${sg.bpm} BPM` : ""}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-bold ${
                            picked
                              ? "bg-fuchsia-500 text-white"
                              : "bg-white/10 text-white/40"
                          }`}
                        >
                          {picked ? "PICKED" : "—"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-2.5 text-[10px] leading-relaxed text-white/40">
                Heuristic song-boundary detection — not song-recognition ML.
                We spot the gaps/applause breaks, groove/tempo shifts and timbre
                changes in your audio to guess where one song ends and the next
                begins. It can't name a song; two similar back-to-back songs may
                merge, and a long pause mid-song may over-split.
              </p>
            </div>

            {/* STEP-D EDL editing panel */}
            {segOn && segEdl && segEdl.rows.length > 0 && segResults && (
              <div className="rounded-2xl border border-fuchsia-400/30 bg-fuchsia-500/5 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-bold text-fuchsia-100">🎛 Edit your reel</h2>
                  <span className="text-[10px] text-fuchsia-200/60">
                    {segEdl.rows.length} cuts · ~{edlTotal.toFixed(0)}s (≤ {effTarget}s)
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-white/45">
                  Reorder, lock, replace or mute any moment — saved on this device
                  and kept across a reload. Length buttons re-select to fit; ↻
                  Regenerate makes a fresh, different edit (locks stay).
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => edlPatch((s) => setHook(segResults, s))}
                    disabled={segEdl.rows[0]?.locked}
                    className="rounded-lg border border-white/15 px-2.5 py-1.5 text-[11px] font-medium text-white/75 hover:bg-white/5 disabled:opacity-40"
                    title="Choose a different opening moment"
                  >▶ Change hook</button>
                  <button
                    onClick={() => edlPatch((s) => setEnding(segResults, s))}
                    disabled={segEdl.rows[segEdl.rows.length - 1]?.locked}
                    className="rounded-lg border border-white/15 px-2.5 py-1.5 text-[11px] font-medium text-white/75 hover:bg-white/5 disabled:opacity-40"
                    title="Choose a different closing moment"
                  >⏹ Change ending</button>
                  <button
                    onClick={() => segEdl && segResults && edlPatch((s) => (segMutedAny ? keepSourceAll(s) : muteAll(s)))}
                    className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium ${
                      segMutedAny
                        ? "border-fuchsia-400 bg-fuchsia-500/20 text-fuchsia-100"
                        : "border-white/15 text-white/75 hover:bg-white/5"
                    }`}
                    title="Mute / unmute all source audio"
                  >{segMutedAny ? "🔇 Muted" : "🔊 Mute source audio"}</button>
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-white/50">Energy</p>
                    <span className="text-[10px] text-fuchsia-300">
                      {energy <= 0.33 ? "Calm / cinematic" : energy >= 0.66 ? "Hype / on-beat" : "Balanced"}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(energy * 100)}
                    onChange={(e) => { setEnergy(Number(e.target.value) / 100); setExportInfo(null); }}
                    className="w-full accent-fuchsia-500"
                  />
                  <p className="mt-0.5 flex justify-between text-[10px] text-white/40">
                    <span>Quiet, moody</span>
                    <span>Loud, crowd energy</span>
                  </p>
                </div>

                <ul className="mt-3 space-y-2">
                  {segEdl.rows.map((r, i) => {
                    const role = roleOf(r.reasonSelected);
                    const cat = catOf(r.reasonSelected);
                    const muted = (r.audioBehavior ?? "keep_source") === "mute";
                    return (
                      <li
                        key={`${r.segmentId}-${i}`}
                        className={`rounded-xl border p-2.5 ${
                          r.locked
                            ? "border-amber-400/50 bg-amber-500/10"
                            : "border-white/10 bg-black/20"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold text-fuchsia-300">
                            {i + 1}. <span className="text-white/80">{role}</span>
                            {r.locked && <span className="ml-1 text-amber-300">🔒</span>}
                            {muted && <span className="ml-1 text-white/50">🔇</span>}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => edlPatch((s) => reorderRows(s, i, i - 1))}
                              disabled={i === 0}
                              className="rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] text-white/60 hover:bg-white/5 disabled:opacity-30"
                            >↑</button>
                            <button
                              onClick={() => edlPatch((s) => reorderRows(s, i, i + 1))}
                              disabled={i === segEdl.rows.length - 1}
                              className="rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] text-white/60 hover:bg-white/5 disabled:opacity-30"
                            >↓</button>
                            <button
                              onClick={() => edlPatch((s) => (r.locked ? unlockRow(s, i) : lockRow(s, i)))}
                              title={r.locked ? "Unlock this segment" : "Lock this segment (survives regenerate/replace)"}
                              className={`rounded-md border px-1.5 py-0.5 text-[11px] ${
                                r.locked ? "border-amber-400/60 text-amber-200" : "border-white/10 text-white/60 hover:bg-white/5"
                              }`}
                            >{r.locked ? "🔓" : "🔒"}</button>
                            <button
                              onClick={() => edlPatch((s) => replaceSlot(segResults, s, i))}
                              disabled={r.locked}
                              title="Swap in the next-best different moment for this slot"
                              className="rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] text-white/60 hover:bg-white/5 disabled:opacity-30"
                            >↻</button>
                            <button
                              onClick={() => edlPatch((s) => (muted ? keepSourceAll(s, i) : muteAll(s, i)))}
                              title={muted ? "Un-mute this segment's audio" : "Mute this segment's audio"}
                              className={`rounded-md border px-1.5 py-0.5 text-[11px] ${
                                muted ? "border-fuchsia-400/60 text-fuchsia-200" : "border-white/10 text-white/60 hover:bg-white/5"
                              }`}
                            >{muted ? "🔊" : "🔇"}</button>
                          </div>
                        </div>
                        <p className="mt-1 truncate text-xs font-medium text-white/85">{r.sourceFile}</p>
                        <div className="mt-0.5 flex items-center justify-between text-[10px] text-white/40">
                          <span>
                            {r.startTime.toFixed(1)}–{r.endTime.toFixed(1)}s · {r.duration.toFixed(1)}s{cat ? ` · ${cat}` : ""}
                          </span>
                          <span>score {r.score.toFixed(2)}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>

              </div>
            )}

            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Selected cuts</h2>
              <button
                onClick={regenerate}
                disabled={phase !== "done" || exporting}
                className="rounded-xl border border-white/15 px-3 py-1.5 text-sm font-medium text-white/70 hover:bg-white/5 disabled:opacity-40"
                title="Reseed the picker for a slightly different mix"
              >
                ↻ Regenerate
              </button>
            </div>

            {phase === "done" && selected.length === 0 && (
              <p className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/60">
                No strong moments found. Try different/more energetic clips, or hit Regenerate.
              </p>
            )}

            <ul className="space-y-2">
              {paced.map((pc, i) => {
                const s = pc.seg;
                const bnd = i > 0 ? boundaries[i] : null;
                const classColor =
                  pc.style === "RAPID"
                    ? "bg-fuchsia-500/25 text-fuchsia-200"
                    : pc.style === "HERO"
                      ? "bg-emerald-500/20 text-emerald-200"
                      : pc.style === "OPENING_HIT"
                        ? "bg-amber-500/25 text-amber-200"
                        : "bg-sky-500/20 text-sky-200";
                return (
                <li key={s.id} className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-fuchsia-300">CUT {i + 1}</span>
                    <div className="flex items-center gap-1.5">
                      <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-bold ${classColor}`}>
                        {pc.style}
                      </span>
                      <span className="text-xs text-white/40">{pc.dur.toFixed(1)}s</span>
                    </div>
                  </div>
                  {bnd && i > 0 && (
                    <div className="mt-0.5 text-[10px] text-white/50">
                      ⌁ {bnd.type.replace(/_/g, " ").toLowerCase()} · {bnd.dur.toFixed(1)}s in
                    </div>
                  )}
                  <p className="mt-1 truncate text-sm font-medium">{s.name}</p>
                  {s.songLabel && (
                    <span className="mt-1 inline-block rounded-md bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">
                      ♪ {s.songLabel}
                    </span>
                  )}
                  <p className="mt-1 text-xs text-white/40">{s.start.toFixed(1)}s – {s.end.toFixed(1)}s</p>
                  <div className="mt-1.5">
                    <Meter label="energy" pct={s.avgEnergy} color="from-violet-400 to-fuchsia-400" />
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-white/40">
                    <span>score {s.score.toFixed(1)}</span>
                    <span>{pc.style} pacing</span>
                  </div>
                </li>
                );
              })}
            </ul>

            {phase === "done" && (
              <p className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/50">
                {paced.length} cuts · ~{pacedTotal.toFixed(0)}s reel (≤ {effTarget}s) ·{" "}
                {featuredClipCount} of {clips.length} clips featured ·{" "}
                {featuredClipCount > 0 && clips.length > 0
                  ? `${Math.round((featuredClipCount / clips.length) * 100)}% distinct sources`
                  : ""}
              </p>
            )}

            {/* -------- export result + camera-roll helper -------- */}
            {exportInfo && (
              <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-4">
                <p className="text-sm font-bold text-emerald-200">✓ Your reel is ready</p>
                <p className="mt-1 text-xs text-emerald-100/70">
                  {exportInfo.ext.toUpperCase()} · {exportInfo.codecs} · {exportInfo.dims} ·{" "}
                  {exportInfo.sizeMB < 1 ? `${(exportInfo.sizeMB * 1000).toFixed(0)} KB` : `${exportInfo.sizeMB.toFixed(1)} MB`} ·
                  has sound
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={saveDownload}
                    className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
                  >
                    ⬇ Download .{exportInfo.ext}
                  </button>
                  <button
                    onClick={() => setShowCamRoll((v) => !v)}
                    className="rounded-xl border border-emerald-300/40 px-4 py-2 text-sm font-medium text-emerald-100 hover:bg-emerald-400/10"
                  >
                    {showCamRoll ? "Hide" : "📱 Save to camera roll"}
                  </button>
                </div>

                {showCamRoll && (
                  <div className="mt-3 space-y-3 text-xs text-emerald-50/80">
                    <p className="rounded-lg bg-black/30 p-2.5 leading-relaxed">
                      A website can't silently write to your phone's camera roll —
                      but the file above is a normal, high-quality{" "}
                      <span className="font-semibold text-emerald-100">{exportInfo.ext.toUpperCase()}</span>{" "}
                      you save in two taps:
                    </p>
                    <div>
                      <p className="font-bold text-emerald-100">iPhone (iOS)</p>
                      <ol className="mt-1 list-decimal space-y-1 pl-4">
                        <li>Tap <span className="font-semibold">Download</span> and choose <span className="font-semibold">Save to Files</span>.</li>
                        <li>Open the <span className="font-semibold">Files</span> app, find the video, tap the <span className="font-semibold">Share</span> sheet (⤴), then tap <span className="font-semibold">Save Video</span>.</li>
                      </ol>
                      <p className="mt-1 text-emerald-100/60">It lands straight in your Photos camera roll.</p>
                    </div>
                    <div>
                      <p className="font-bold text-emerald-100">Android</p>
                      <ol className="mt-1 list-decimal space-y-1 pl-4">
                        <li>Tap <span className="font-semibold">Download</span>.</li>
                        <li>Open it from your <span className="font-semibold">Downloads</span> or <span className="font-semibold">Files</span> app and tap <span className="font-semibold">Save to Gallery</span>.</li>
                      </ol>
                      <p className="mt-1 text-emerald-100/60">Now it's in your phone's gallery, ready to post.</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            <details className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/50">
              <summary className="cursor-pointer font-medium text-white/70">Audio &amp; editing detail</summary>
              <p className="mt-2 leading-relaxed">
                Each cut is paced to its moment — a pacing class (RAPID 0.5–1.5s /
                NORMAL 1.5–3s / HERO 3–5s / opening hit) sets its length and motion
                across the HOOK→ESTABLISH→BUILD→PEAK→PAYOFF→END story arc. Cuts are
                mostly a <span className="font-semibold text-white/70">clean hard cut</span>; a
                transition only appears when the footage earns one (a whip on strong
                directional motion, a flash on a stage-light pop, a beat-cut on a
                strong onset, a dissolve between two calm quiet shots) and only up to
                a strict per-mode cap — never a "Song N" chip or fade-to-black. A new
                song is just a hard cut; the audio bed carries the continuity. The
                visual theme (grade / vignette, plus a subtle "Concert Compass"
                credit over the final beat — no opening title) is a stylistic
                choice, applied to the whole reel (warm by default).
              </p>
              <p className="mt-2 leading-relaxed">
                Selection is coverage-driven: we tour the whole set — one strong
                moment from each detected song and each of your clips, in
                chronological order — then fill any remaining time with the
                strongest varied extras up to your length cap. A 24-clip show
                features many of your clips, not just the 2 loudest. Song
                boundaries are a heuristic (energy/applause gaps, groove and
                timbre shifts) — <span className="font-semibold text-white/70">not song-recognition
                ML</span>: we can't name a song, two similar back-to-back songs may
                merge, and a long pause mid-song may over-split. A light spectral
                nudge (harmonic/periodicity analysis, not ML) gently steers away
                from loud crowd/off-key sections. Real vocal separation is on the
                roadmap, not a feature today.
              </p>
            </details>
          </aside>
        </div>
      </main>
    </div>
  );
}

function Meter({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-white/40">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full bg-gradient-to-r ${color}`} style={{ width: `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-white/40">{Math.round(pct * 100)}%</span>
    </div>
  );
}

function ClipTimeline({ clip, selected }: { clip: AnalyzedClip; selected: Segment[] }) {
  const bars = useMemo(() => {
    const n = clip.windows.length;
    if (n === 0) return [];
    const step = Math.max(1, Math.ceil(n / DISPLAY_BARS));
    const out: { start: number; energy: number; peak: boolean; selected: boolean }[] = [];
    for (let i = 0; i < n; i += step) {
      const chunk = clip.windows.slice(i, i + step);
      const energy = chunk.reduce((s, w) => s + w.energy, 0) / chunk.length;
      const peak = chunk.some((w) => w.peak);
      const t0 = clip.windows[i].start;
      const t1 = clip.windows[Math.min(i + step - 1, n - 1)].start;
      const isSel = selected.some((s) => s.clipId === clip.clipId && s.start <= t1 + 0.2 && s.end >= t0 - 0.2);
      out.push({ start: t0, energy, peak, selected: isSel });
    }
    return out;
  }, [clip, selected]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="truncate text-sm font-medium text-white/80">{clip.name}</p>
        <p className="shrink-0 text-xs text-white/40">{clip.duration.toFixed(0)}s · {clip.segments.length} peaks</p>
      </div>
      <div className="flex h-16 items-end gap-px overflow-hidden">
        {bars.map((b, i) => (
          <div
            key={i}
            title={`${b.start.toFixed(1)}s · ${Math.round(b.energy * 100)}%`}
            className={`h-full flex-1 rounded-t transition-colors ${
              b.selected ? "bg-fuchsia-400" : b.peak ? "bg-violet-500" : "bg-white/20"
            }`}
            style={{ height: `${Math.max(6, b.energy * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
