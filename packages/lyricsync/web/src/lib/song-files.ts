// packages/lyricsync/web/src/lib/song-files.ts
// Reads and writes a song folder through a SongStore: a folder the user picked (File System Access API), or a project the
// dev server serves (a song the wizard just built, opened without the picker).
//
// Song folder layout (one fixed location per file):
//   project.json                        assets.song.src = full mix, relative to the song folder
//   user_input/lyrics.calibrated.json   human calibration of the lead singer (the file this editor saves); absent = an empty document, written by the first save after an edit
//   user_input/singers.json             the singers (src/singers.ts); absent = one singer, the file above. Another singer's calibration:
//                                       user_input/lyrics.calibrated.<id>.json (calibratedFileFor), same rules as above
//   user_input/prompt.yaml              first_downbeat_s = bar 1 of the beat grid (lib/beat-grid.ts; the editor rewrites that line)
//   user_input/placements.json          the vocal lanes and their clips (lib/lanes.ts); absent = one lane per render with one parked clip
//   generated/timing.ai.json            the song beat grid (beats, downbeats)
//   generated/renders/index.json        rendered vocal tracks (wavs in generated/renders/); absent = no vocal lanes
//   lyricsync/lyricsync.json            lyricsync workspace manifest; "vocal" = vocal stem, relative to lyricsync/; absent = no workspace
//   lyricsync/evidence/meta.json        evidence metadata (f0Hz pitch contour); part of the workspace
//   lyricsync/out/review.json           solver review; absent until the first solve
//   backups/<time>_<reason>/...         copies of hand-made files taken before an overwrite (src/backup-policy.ts); a save here takes one
import { BACKUP_DIR, BACKUP_WITH, backupSnapshotName, parseSnapshotName, snapshotsToPrune } from "../../../src/backup-policy";
import { isLineReview, isNumber, isRecord } from "../../../src/guards";
import type { LineReview } from "../../../src/types";
import { scanLyricLines } from "../../../src/lyrics/scan";
import { parseCalibrationDoc, type CalibrationDoc, type CalLine } from "../../../src/calibration-doc";
import { parseSingers, type Singers } from "../../../src/singers";
import { defaultPlacements, parsePlacements, parseRenderIndex, type Placements, type RenderEntry, type RenderIndex } from "../../../src/placements";
import { gridFromBar1, nearestBeatIndex, PROMPT_PATH, readFirstDownbeat } from "./beat-grid";

export const CALIBRATED_PATH = "user_input/lyrics.calibrated.json";
export const PLACEMENTS_PATH = "user_input/placements.json";
const TIMING_PATH = "generated/timing.ai.json";
const SINGERS_PATH = "user_input/singers.json";
const RENDER_INDEX_PATH = "generated/renders/index.json";

/** A song folder. Paths are relative to it, with forward slashes. */
export interface SongStore {
  /** The folder name; the dev server's solve finds the song as <songs folder>/<name>. */
  readonly name: string;
  /** The file, or null when it does not exist. */
  read(path: string): Promise<Blob | null>;
  /** Modification time in ms, or null when the file does not exist. */
  mtime(path: string): Promise<number | null>;
  /** Writes text and returns the new modification time. */
  write(path: string, text: string): Promise<number>;
  /** Names in the folder at `path` ("" = the song folder), or [] when it does not exist. */
  list(path: string): Promise<string[]>;
}

const isMissing = (e: unknown) => e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError");

/** A folder picked with the File System Access API. */
export function handleStore(root: FileSystemDirectoryHandle): SongStore {
  const fileHandle = async (path: string, create = false): Promise<FileSystemFileHandle | null> => {
    const segs = path.split("/");
    try {
      let d = root;
      for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s);
      return await d.getFileHandle(segs[segs.length - 1]!, { create });
    } catch (e: unknown) {
      if (isMissing(e)) return null;
      throw e;
    }
  };
  /**
   * Copies `blob` (the file at `rel` before a save) into the save snapshot of the backups folder, with the lyrics files
   * (BACKUP_WITH), then prunes old snapshots. A file already in the snapshot is kept: it is the older state.
   */
  const backup = async (rel: string, blob: Blob) => {
    const backups = await root.getDirectoryHandle(BACKUP_DIR, { create: true });
    const snapshot = await backups.getDirectoryHandle(backupSnapshotName("save"), { create: true });
    const copy = async (path: string, data: Blob) => {
      const segs = path.split("/");
      let d = snapshot;
      for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
      const name = segs[segs.length - 1]!;
      const exists = await d.getFileHandle(name).then(
        () => true,
        (e: unknown) => {
          if (isMissing(e)) return false;
          throw e;
        }
      );
      if (exists) return;
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(data);
      await w.close();
    };
    await copy(rel, blob);
    for (const path of BACKUP_WITH) {
      const f = await (await fileHandle(path))?.getFile();
      if (f) await copy(path, f);
    }
    const names: string[] = [];
    for await (const n of backups.keys()) names.push(n);
    for (const old of snapshotsToPrune(names)) await backups.removeEntry(old, { recursive: true });
  };
  return {
    name: root.name,
    read: async (path) => (await fileHandle(path))?.getFile() ?? null,
    mtime: async (path) => (await (await fileHandle(path))?.getFile())?.lastModified ?? null,
    async list(path) {
      try {
        let d = root;
        for (const s of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(s);
        const names: string[] = [];
        for await (const n of d.keys()) names.push(n);
        return names;
      } catch (e: unknown) {
        if (isMissing(e)) return [];
        throw e;
      }
    },
    async write(path, text) {
      const h = await fileHandle(path, true);
      if (!h) throw new Error(`Cannot write ${path}.`);
      const before = await h.getFile();
      if (before.size > 0 && (await before.text()) !== text) await backup(path, before);
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return (await h.getFile()).lastModified;
    },
  };
}

/** A project the dev server serves (GET/HEAD/PUT /api/project/<id>/file/<path>, GET /api/project/<id>/list/<path>). */
export function serverStore(id: string): SongStore {
  const url = (path: string) => `/api/project/${encodeURIComponent(id)}/file/${path.split("/").map(encodeURIComponent).join("/")}`;
  const failed = async (res: Response) => {
    const body: unknown = await res.json().catch(() => null);
    return new Error(isRecord(body) && typeof body.message === "string" ? body.message : `HTTP ${res.status}`);
  };
  return {
    name: id,
    async read(path) {
      const res = await fetch(url(path));
      if (res.status === 404) return null;
      if (!res.ok) throw await failed(res);
      return res.blob();
    },
    async mtime(path) {
      const res = await fetch(url(path), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      return Number(res.headers.get("X-Mtime-Ms"));
    },
    async list(path) {
      const res = await fetch(`/api/project/${encodeURIComponent(id)}/list/${path.split("/").map(encodeURIComponent).join("/")}`);
      if (!res.ok) throw await failed(res);
      const body: unknown = await res.json();
      if (!isRecord(body) || !Array.isArray(body.names) || !body.names.every((n) => typeof n === "string")) throw new Error("Unexpected answer to a folder listing.");
      return body.names;
    },
    async write(path, text) {
      const res = await fetch(url(path), { method: "PUT", body: text });
      if (!res.ok) throw await failed(res);
      const body: unknown = await res.json();
      if (!isRecord(body) || typeof body.mtimeMs !== "number") throw new Error("Unexpected answer to a file write.");
      return body.mtimeMs;
    },
  };
}

export interface SongFiles {
  doc: CalibrationDoc;
  /** False when the song folder has no calibration yet (`doc` is empty then). */
  calExists: boolean;
  calMtime: number;
  /** The vocal stem of the lyricsync workspace; null when the song has no workspace. */
  vocal: { blob: Blob; name: string } | null;
  mix: { blob: Blob; name: string };
  beats: number[];
  /** Every 4th beat from bar 1 (pickup bars included). */
  downbeats: number[];
  /** Index in `downbeats` of bar 1. */
  bar1Index: number;
  /** Pitch contour of the vocal stem; null when the song has no workspace. */
  f0Hz: number[] | null;
  review: LineReview[];
}

/** Resolves a relative path (either slash style, may contain "..") against a folder path inside the song folder. */
function resolvePath(base: string[], rel: string, what: string): string {
  const out = [...base];
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) throw new Error(`${what} "${rel}" points outside the song folder.`);
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

async function need(store: SongStore, path: string, hint = ""): Promise<Blob> {
  const blob = await store.read(path);
  if (!blob) throw new Error(`Missing ${path} in the song folder.${hint}`);
  return blob;
}

const readJson = async (store: SongStore, path: string): Promise<unknown> => JSON.parse(await (await need(store, path)).text());

const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNumber);

/** A calibration file: its document (empty when the file does not exist), whether it exists and its modification time (0 when not). */
export interface CalibrationFile {
  doc: CalibrationDoc;
  exists: boolean;
  mtime: number;
}

export async function loadCalibration(store: SongStore, path: string): Promise<CalibrationFile> {
  const blob = await store.read(path);
  if (!blob) return { doc: { sections: [], lines: [] }, exists: false, mtime: 0 };
  const doc = parseCalibrationDoc(JSON.parse(await blob.text()));
  return { doc, exists: true, mtime: (await store.mtime(path)) ?? 0 };
}

/** A backup snapshot (src/backup-policy.ts) that holds a copy of one song file. */
export interface FileBackup {
  /** The snapshot folder (in backups/). */
  snapshot: string;
  /** The copy's path in the song folder. */
  path: string;
  time: Date;
  /** What overwrote the file after the copy was taken: save, edit-lyrics, retime... */
  reason: string;
}

/** The backups of the song file at `path`, newest first. */
export async function listBackups(store: SongStore, path: string): Promise<FileBackup[]> {
  const out: FileBackup[] = [];
  for (const name of await store.list(BACKUP_DIR)) {
    const snap = parseSnapshotName(name);
    const copy = `${BACKUP_DIR}/${name}/${path}`;
    if (snap && (await store.mtime(copy)) !== null) out.push({ snapshot: name, path: copy, ...snap });
  }
  return out.sort((a, b) => b.time.getTime() - a.time.getTime());
}

const LYRICS_PATH = "user_input/lyrics.txt";

/**
 * The lyrics text a backup's timing `doc` belongs to: the lyrics.txt of the backup's own snapshot, else of a later snapshot (backups
 * taken before snapshots held the lyrics), else the song's current one; the first whose lines are the timing's lines. When none
 * is, the nearest of them with as many lines, its differing lines rebuilt from the timing (`rebuild`; sections, comments and the
 * other lines' {phones} stay): `rebuilt` lists those lines (1-based). Null when there is neither.
 */
export async function backupLyricsText(
  store: SongStore,
  backup: FileBackup,
  doc: CalibrationDoc,
  rebuild: (line: CalLine) => string
): Promise<{ text: string; rebuilt: number[] } | null> {
  // A timing line's text is its words without the syllable marks ("|"; "+" too in Japanese).
  const textOf = (tokens: Array<{ word: string }>, marks: RegExp) => tokens.map((t) => t.word.replace(marks, "")).join(" ");
  const same = (tokens: Array<{ word: string }>, line: CalLine | undefined) =>
    line !== undefined && (textOf(tokens, /\|/g) === line.text || textOf(tokens, /[|+]/g) === line.text);
  const later = (await store.list(BACKUP_DIR)).filter((n) => parseSnapshotName(n) !== null && n >= backup.snapshot).sort();
  let nearest: string | null = null;
  for (const p of [...later.map((n) => `${BACKUP_DIR}/${n}/${LYRICS_PATH}`), LYRICS_PATH]) {
    const text = await (await store.read(p))?.text();
    if (text === undefined) continue;
    const lines = scanLyricLines(text);
    if (lines.length === doc.lines.length && lines.every((l, i) => same(l.tokens, doc.lines[i]))) return { text, rebuilt: [] };
    nearest ??= text;
  }
  if (nearest === null) return null;
  const lines = scanLyricLines(nearest);
  if (lines.length !== doc.lines.length) return null;
  let text = nearest;
  const rebuilt: number[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (same(l.tokens, doc.lines[i])) continue;
    text = text.slice(0, l.from) + rebuild(doc.lines[i]!) + text.slice(l.to);
    rebuilt.unshift(i + 1);
  }
  return { text, rebuilt };
}

/** The singers of the song (user_input/singers.json), or null when the song has no singers file. */
export async function loadSingers(store: SongStore): Promise<Singers | null> {
  const blob = await store.read(SINGERS_PATH);
  if (!blob) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await blob.text());
  } catch (e: unknown) {
    throw new Error(`${SINGERS_PATH}: ${errorMessage(e)}`);
  }
  return parseSingers(raw);
}

export async function loadSongFiles(store: SongStore): Promise<SongFiles> {
  const project = await readJson(store, "project.json");
  const mixRel = isRecord(project) && isRecord(project.assets) && isRecord(project.assets.song) ? project.assets.song.src : undefined;
  if (typeof mixRel !== "string") throw new Error("project.json has no assets.song.src (the full mix).");

  const cal = await loadCalibration(store, CALIBRATED_PATH);

  const beatsDoc = await readJson(store, TIMING_PATH);
  if (!isRecord(beatsDoc) || !isNumberArray(beatsDoc.beats) || !isNumberArray(beatsDoc.downbeats)) {
    throw new Error(`${TIMING_PATH} needs numeric beats and downbeats arrays.`);
  }
  const review = await loadReview(store);
  // Bar 1 from prompt.yaml when set (the beat tracker's downbeats otherwise), as the video editor does on load.
  const firstDownbeat = readFirstDownbeat(await (await need(store, PROMPT_PATH)).text());
  const grid =
    firstDownbeat === null
      ? { downbeats: beatsDoc.downbeats, bar1Index: 0 }
      : gridFromBar1(beatsDoc.beats, nearestBeatIndex(beatsDoc.beats, firstDownbeat));

  const mixPath = resolvePath([], mixRel, "Mix");
  const mix = await need(store, mixPath, " (the mix named in project.json)");

  // The lyricsync workspace (vocal stem and its pitch contour) is there once the song was prepared for lyric timing.
  const manifestBlob = await store.read("lyricsync/lyricsync.json");
  let vocal: SongFiles["vocal"] = null;
  let f0Hz: number[] | null = null;
  if (manifestBlob) {
    const manifest: unknown = JSON.parse(await manifestBlob.text());
    if (!isRecord(manifest) || typeof manifest.vocal !== "string") throw new Error('lyricsync/lyricsync.json has no "vocal" path.');
    const meta = await readJson(store, "lyricsync/evidence/meta.json");
    if (!isRecord(meta) || !isNumberArray(meta.f0Hz)) throw new Error("lyricsync/evidence/meta.json has no f0Hz pitch contour.");
    const vocalPath = resolvePath(["lyricsync"], manifest.vocal, "Vocal stem");
    vocal = { blob: await need(store, vocalPath, " (the vocal stem named in lyricsync/lyricsync.json)"), name: vocalPath };
    f0Hz = meta.f0Hz;
  }

  return {
    doc: cal.doc,
    calExists: cal.exists,
    calMtime: cal.mtime,
    vocal,
    mix: { blob: mix, name: mixPath },
    beats: beatsDoc.beats,
    downbeats: grid.downbeats,
    bar1Index: grid.bar1Index,
    f0Hz,
    review,
  };
}

export interface SongRenders {
  index: RenderIndex;
  placements: Placements;
  /** False when user_input/placements.json does not exist yet (`placements` is the default then). */
  placementsExist: boolean;
}

/** The rendered vocal tracks and their placements, or null when the song has no generated/renders/index.json. */
export async function loadRenders(store: SongStore): Promise<SongRenders | null> {
  const indexBlob = await store.read(RENDER_INDEX_PATH);
  if (!indexBlob) return null;
  const index = parseRenderIndex(JSON.parse(await indexBlob.text()));
  const placementsBlob = await store.read(PLACEMENTS_PATH);
  const placements = placementsBlob ? parsePlacements(JSON.parse(await placementsBlob.text()), index) : defaultPlacements(index);
  return { index, placements, placementsExist: placementsBlob !== null };
}

/** The wav of a render (`wav` is relative to generated/renders/). */
export async function readRenderWav(store: SongStore, render: RenderEntry): Promise<{ blob: Blob; name: string }> {
  const name = resolvePath(["generated", "renders"], render.wav, "Render wav");
  return { blob: await need(store, name, ` (the wav of ${render.ust} in ${RENDER_INDEX_PATH})`), name };
}

/** The last solve's review (lyricsync/out/review.json), or none before the first solve. */
export async function loadReview(store: SongStore): Promise<LineReview[]> {
  const blob = await store.read("lyricsync/out/review.json");
  if (!blob) return [];
  const raw: unknown = JSON.parse(await blob.text());
  if (!isRecord(raw) || !Array.isArray(raw.lines) || !raw.lines.every(isLineReview)) throw new Error("lyricsync/out/review.json is malformed.");
  return raw.lines;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}
