// packages/lyricsync/web/src/lib/song-files.ts
// Reads and writes a song folder through a SongStore: a folder the user picked (File System Access API), or a project the
// dev server serves (a song the wizard just built, opened without the picker).
//
// Song folder layout (one fixed location per file):
//   project.json                        assets.song.src = full mix, relative to the song folder
//   user_input/lyrics.calibrated.json   human calibration (the file this editor saves)
//   user_input/prompt.yaml              first_downbeat_s = bar 1 of the beat grid (lib/beat-grid.ts; the editor rewrites that line)
//   lyricsync/lyricsync.json            lyricsync workspace manifest; "vocal" = vocal stem, relative to lyricsync/
//   lyricsync/evidence/beats.json       beat grid written by "lyricsync prepare"
//   lyricsync/evidence/meta.json        evidence metadata (f0Hz pitch contour)
//   lyricsync/out/review.json           solver review; absent until the first solve
import { isLineReview, isNumber, isRecord } from "../../../src/guards";
import type { LineReview } from "../../../src/types";
import { parseCalibrationDoc, type CalibrationDoc } from "./calibration-doc";
import { gridFromBar1, nearestBeatIndex, PROMPT_PATH, readFirstDownbeat } from "./beat-grid";

export const CALIBRATED_PATH = "user_input/lyrics.calibrated.json";

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
  return {
    name: root.name,
    read: async (path) => (await fileHandle(path))?.getFile() ?? null,
    mtime: async (path) => (await (await fileHandle(path))?.getFile())?.lastModified ?? null,
    async write(path, text) {
      const h = await fileHandle(path, true);
      if (!h) throw new Error(`Cannot write ${path}.`);
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return (await h.getFile()).lastModified;
    },
  };
}

/** A project the dev server serves (GET/HEAD/PUT /api/project/<id>/file/<path>). */
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
  calMtime: number;
  vocal: { blob: Blob; name: string };
  mix: { blob: Blob; name: string };
  beats: number[];
  /** Every 4th beat from bar 1 (pickup bars included). */
  downbeats: number[];
  /** Index in `downbeats` of bar 1. */
  bar1Index: number;
  f0Hz: number[];
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

export async function loadSongFiles(store: SongStore): Promise<SongFiles> {
  const project = await readJson(store, "project.json");
  const mixRel = isRecord(project) && isRecord(project.assets) && isRecord(project.assets.song) ? project.assets.song.src : undefined;
  if (typeof mixRel !== "string") throw new Error("project.json has no assets.song.src (the full mix).");

  const manifest = await readJson(store, "lyricsync/lyricsync.json");
  if (!isRecord(manifest) || typeof manifest.vocal !== "string") throw new Error('lyricsync/lyricsync.json has no "vocal" path.');

  const doc = parseCalibrationDoc(JSON.parse(await (await need(store, CALIBRATED_PATH)).text()));
  const calMtime = await store.mtime(CALIBRATED_PATH);

  const beatsDoc = await readJson(store, "lyricsync/evidence/beats.json");
  if (!isRecord(beatsDoc) || !isNumberArray(beatsDoc.beats) || !isNumberArray(beatsDoc.downbeats)) {
    throw new Error("lyricsync/evidence/beats.json needs numeric beats and downbeats arrays.");
  }
  const meta = await readJson(store, "lyricsync/evidence/meta.json");
  if (!isRecord(meta) || !isNumberArray(meta.f0Hz)) throw new Error("lyricsync/evidence/meta.json has no f0Hz pitch contour.");
  const review = await loadReview(store);
  // Bar 1 from prompt.yaml when set (the beat tracker's downbeats otherwise), as the video editor does on load.
  const firstDownbeat = readFirstDownbeat(await (await need(store, PROMPT_PATH)).text());
  const grid =
    firstDownbeat === null
      ? { downbeats: beatsDoc.downbeats, bar1Index: 0 }
      : gridFromBar1(beatsDoc.beats, nearestBeatIndex(beatsDoc.beats, firstDownbeat));

  const vocalPath = resolvePath(["lyricsync"], manifest.vocal, "Vocal stem");
  const mixPath = resolvePath([], mixRel, "Mix");
  const vocal = await need(store, vocalPath, " (the vocal stem named in lyricsync/lyricsync.json)");
  const mix = await need(store, mixPath, " (the mix named in project.json)");

  return {
    doc,
    calMtime: calMtime ?? 0,
    vocal: { blob: vocal, name: vocalPath },
    mix: { blob: mix, name: mixPath },
    beats: beatsDoc.beats,
    downbeats: grid.downbeats,
    bar1Index: grid.bar1Index,
    f0Hz: meta.f0Hz,
    review,
  };
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
