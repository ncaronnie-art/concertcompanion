// Session-progress persistence for the Reel Studio.
//
// Everything stays on-device — no server, no account. The goal: when a user
// leaves or refreshes mid-session, they pick up exactly where they left off
// (uploaded videos + analyzed clips + settings) without re-uploading and
// without re-waiting through the slow audio decode/analysis.
//
// STORAGE LAYOUT (why two layers):
//  * IndexedDB  -> the BIG, binary, or array-heavy data: the raw uploaded
//    video File/Blob objects and the serialized AnalyzedClip[] (which holds up
//    to ~2200 spectral windows per clip — too big to risk in localStorage's
//    ~5MB quota with several clips). IndexedDB can store large blobs and has
//    no tight practical quota, and it keeps the bytes out of main memory — we
//    only touch them (via blob URLs) when a clip actually needs to play/export.
//  * localStorage -> a tiny synchronous JSON "meta" record: settings
//    (aspectRatio, maxDuration, seed), a savedAt timestamp, and metadata about
//    what got stored (file names/sizes, whether files & clips are present).
//    Reading it is synchronous, so on /create load we instantly know a session
//    exists and can restore the cheap settings before IndexedDB resolves.
//
// Auto-save writes are small enough (the settings record) to happen inline;
// the big IndexedDB writes (files/clips) are the bottleneck, so those at least
// are deferred to the browser's idle callback so we never block the main
// thread during upload/analysis/selection.

import type { AnalyzedClip } from "./reel";
import type { DetectedSong } from "./songs";
import type { EdlState } from "./edl";

const DB_NAME = "concert-compass-session";
const DB_VERSION = 1;
const KV_STORE = "kv";

// localStorage key for the small settings/meta record
const META_KEY = "cc.session.meta.v1";

export interface SessionMeta {
  version: 1;
  savedAt: number;
  aspectRatio: string;
  maxDuration: number;
  seed: number;
  theme?: string; // visual theme id (optional for backward compat with older sessions)
  // major build: new controls, all optional for backward compat
  vibe?: string; // legacy (pre-STEP C) — Auto | dance | ballad | bigshow (migrated to `mode`)
  mode?: string; // STEP C edit mode: cinematic | hype | memory | music-video | surprise-me
  variety?: number; // 0..1 coverage/variety balance
  singleAudio?: SingleAudioSetting; // the one-track audio bed choice
  // STEP D (2.0, segment path): the user's editable Edit Decision List state
  // (rows + locks + mode + energy). Small JSON, persisted here so a user who
  // edited their reel doesn't lose those edits on reload. Optional for compat.
  edl?: EdlState;
  energy?: number; // STEP D energy dial (0 calm … 1 hype)
  segSelect?: boolean; // STEP B/D segment-level picks toggle
  filesStored: boolean; // did we manage to persist the raw video blobs?
  clipsStored: boolean; // did analysis results get persisted?
  filesMeta: { name: string; size: number; type: string; lastModified: number }[];
}

/** The "1 AUDIO" single-track bed setting. Persisted in meta (light) so the
 * mode/choice come back instantly; the uploaded audio-only FILE itself lives in
 * IndexedDB (bedFile) alongside the video files. */
export interface SingleAudioSetting {
  on: boolean;
  sourceType: "clip" | "file";
  clipId?: number; // source = one of the uploaded video clips' audio
  fileName?: string; // display name (clip file or audio file)
  duration?: number; // the track's length in seconds (for trim/fit decisions)
}

// Synchronous check + cheap settings restore. Returns null when there's no
// usable saved session. Read this on page load before touching IndexedDB.
export function getSavedSessionMeta(): SessionMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as SessionMeta;
    if (!m || m.version !== 1) return null;
    return m;
  } catch {
    return null;
  }
}

export interface RestoredSession {
  files: File[] | null; // null if files weren't stored (quota/private mode)
  clips: AnalyzedClip[] | null; // null if analysis wasn't completed/persisted
  songs: DetectedSong[] | null; // null if no song-detection was persisted
  bedFile: File | null; // the single-audio mode's uploaded audio-only file (if any)
}

// Hand-rolled promisified IndexedDB (tiny, no dependency).
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE); // keyPath-less key-value store
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, "readonly");
    const req = tx.objectStore(KV_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, "readwrite");
    const req = tx.objectStore(KV_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, "readwrite");
    const req = tx.objectStore(KV_STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function closeDB(db: IDBDatabase) {
  try {
    db.close();
  } catch {
    /* noop */
  }
}

export interface SaveResult {
  filesStored: boolean;
  clipsStored: boolean;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
let savedFilesSize = 0;
let savedClipsSize = 0;

/**
 * Persist the current session. Never throws and never blocks the caller: any
 * storage failure (private mode, quota, indexedDB unavailable) is caught and
 * reported back so the app can keep working in-memory. Settings go to
 * localStorage; files + clips go to IndexedDB. Files are written second and
 * independently — if a big upload blows the quota, we still keep the (much more
 * valuable) analysis results.
 */
export async function saveSession(args: {
  files: File[];
  clips: AnalyzedClip[];
  songs: DetectedSong[];
  aspectRatio: string;
  maxDuration: number;
  seed: number;
  theme?: string;
  mode?: string; // STEP C edit mode
  vibe?: string; // legacy (pre-STEP C) - kept so old sessions migrate
  variety?: number;
  singleAudio?: SingleAudioSetting;
  bedFile?: File | null;
  edl?: EdlState | null; // STEP D — the user's editable Edit Decision List state
  energy?: number; // STEP D energy dial
  segSelect?: boolean; // STEP B/D segment-level picks toggle
}): Promise<SaveResult> {
  const filesMeta = args.files.map((f) => ({
    name: f.name,
    size: f.size,
    type: f.type,
    lastModified: f.lastModified,
  }));

  const writeMeta = (filesStored: boolean, clipsStored: boolean) => {
    try {
      const meta: SessionMeta = {
        version: 1,
        savedAt: Date.now(),
        aspectRatio: args.aspectRatio,
        maxDuration: args.maxDuration,
        seed: args.seed,
        ...(args.theme ? { theme: args.theme } : {}),
        ...(args.mode ? { mode: args.mode } : {}),
        ...(typeof args.variety === "number" ? { variety: args.variety } : {}),
        ...(args.singleAudio ? { singleAudio: args.singleAudio } : {}),
        ...(args.edl ? { edl: args.edl } : {}),
        ...(typeof args.energy === "number" ? { energy: args.energy } : {}),
        ...(typeof args.segSelect === "boolean" ? { segSelect: args.segSelect } : {}),
        filesStored,
        clipsStored,
        filesMeta,
      };
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch {
      /* storage full / disabled => nothing to do, stay in-memory */
    }
  };

  let filesStored = false;
  let clipsStored = false;

  try {
    const db = await openDB();
    try {
      // Analysis results are the expensive-to-recompute part and are small.
      // Persist them first so they survive even if file storage overflows.
      try {
        await idbPut(db, "clips", args.clips);
        savedClipsSize = JSON.stringify(args.clips).length;
        clipsStored = true;
      } catch {
        clipsStored = false;
      }
      // Detected songs are small and cheap to store — keep them so a restored
      // session can tag cuts with their song labels without re-detecting.
      try {
        await idbPut(db, "songs", args.songs);
      } catch {
        /* songs are non-critical; we re-derive them from restored clips */
      }
      // Raw video blobs — the large payload. Isolated so a quota failure here
      // degrades to "re-upload, but skip re-analysis" rather than losing all.
      try {
        await idbPut(db, "files", args.files);
        savedFilesSize = args.files.reduce((s, f) => s + f.size, 0);
        filesStored = true;
      } catch {
        filesStored = false;
      }
      // The single-audio bed file (an audio-only upload, usually small); cleared
      // when null.
      try {
        if (args.bedFile) await idbPut(db, "bedFile", args.bedFile);
        else await idbDelete(db, "bedFile").catch(() => {});
      } catch {
        /* non-critical */
      }
    } finally {
      await closeDB(db);
    }
  } catch {
    // indexedDB unavailable / private mode / blocked
    filesStored = false;
    clipsStored = false;
  }

  writeMeta(filesStored, clipsStored);
  return { filesStored, clipsStored };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
/**
 * Fetch the full persisted session from IndexedDB. Returns null if there is
 * nothing stored. Files come back as real File objects (structured-clone
 * preserves them); if a browser demoted them to bare Blobs we re-wrap with the
 * metadata from localStorage so names/types survive.
 */
export async function loadSession(): Promise<RestoredSession | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDB();
    const [files, clips, songs, bedFile] = await Promise.all([
      idbGet<File[] | null>(db, "files"),
      idbGet<AnalyzedClip[] | null>(db, "clips"),
      idbGet<DetectedSong[] | null>(db, "songs"),
      idbGet<File | null>(db, "bedFile"),
    ]);
    if (!files && !clips && !songs && !bedFile) return null;

    const meta = getSavedSessionMeta();
    const metaByName = new Map((meta?.filesMeta ?? []).map((m) => [m.name, m]));

    const restoredFiles = Array.isArray(files)
      ? files.map((f) => {
          // Normalize whatever came back (Blob or File) into a real File.
          const info = metaByName.get(f.name);
          if (f instanceof File) return f;
          return new File([f], info?.name ?? f.name ?? "clip", {
            type: f.type || info?.type || "video/mp4",
            lastModified: info?.lastModified ?? Date.now(),
          });
        })
      : null;

    return {
      files: restoredFiles,
      clips: Array.isArray(clips) ? clips : null,
      songs: Array.isArray(songs) ? songs : null,
      bedFile: bedFile && typeof bedFile !== "string" ? (bedFile as File) : null,
    };
  } catch {
    return null;
  } finally {
    if (db) await closeDB(db);
  }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------
/** Wipe the whole saved session (IndexedDB blobs + localStorage meta). */
export async function clearSession(): Promise<void> {
  try {
    localStorage.removeItem(META_KEY);
  } catch {
    /* noop */
  }
  let db: IDBDatabase | null = null;
  try {
    db = await openDB();
    await Promise.all([
      idbDelete(db, "files").catch(() => {}),
      idbDelete(db, "clips").catch(() => {}),
      idbDelete(db, "songs").catch(() => {}),
      idbDelete(db, "bedFile").catch(() => {}),
    ]);
  } catch {
    /* noop */
  } finally {
    if (db) await closeDB(db);
  }
  savedFilesSize = 0;
  savedClipsSize = 0;
}

/** Rough estimate of currently persisted bytes (0 when clear/never saved). */
export function persistedSize(): { files: number; clips: number } {
  return { files: savedFilesSize, clips: savedClipsSize };
}

/** Defer a task to the browser's idle time without blocking the main thread. */
export function whenIdle(fn: () => void, timeout = 1200): void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(
      () => {
        try {
          fn();
        } catch {
          /* never throw from idle */
        }
      },
      { timeout }
    );
    if (typeof id === "number") return;
  }
  // Fallback: a short timeout keeps this off the hot path.
  setTimeout(fn, 50);
}
