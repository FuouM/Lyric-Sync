// Where a song folder's inputs live (the layout the New Song wizard writes; also the probable-video-editor project layout):
//   <songs>/<id>/project.json                  marks the folder as a song
//   <songs>/<id>/user_input/prompt.yaml        song and stem file names, nearest_bpm, first_downbeat_s
//   <songs>/<id>/user_input/lyrics.sync.json   the lyricsync lyrics contract; optional "unannotatedLines" (see realign.ts)
//   <songs>/<id>/generated/timing.ai.json      the beat grid (beatsync)
//   <songs>/<id>/lyricsync/                    the lyricsync workspace (evidence cache, anchors, results)
// <songs> is the dev server's songs folder (dev.ts --songs).
import * as fs from "node:fs";
import * as path from "node:path";
import { isNumber, isRecord } from "../../src/guards.ts";
import type { Language } from "../../src/index.ts";

export const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface SongInputs {
  id: string;
  dir: string;
  workspaceDir: string;
  lyricsFile: string;
  language: Language;
  /** generated/vocal_fused.wav when the song has one (main + chorus), else the vocal stem named in prompt.yaml. */
  vocalPath: string;
  beatsFile: string;
}

export interface PromptManifest {
  /** The full mix. */
  songPath: string;
  nearestBpm: number | null;
  firstDownbeat: number | null;
}

export type SongsRoots = string | string[];

export function toRoots(roots: SongsRoots): string[] {
  return Array.isArray(roots) ? roots : [roots];
}

/** Locates a song folder: supports absolute path, relative path from cwd, or searching across all roots. */
export function findSongDir(roots: SongsRoots, id: string): string | null {
  const norm = id.replace(/\\/g, "/");
  if (path.isAbsolute(norm) || path.win32.isAbsolute(id)) {
    return fs.existsSync(id) ? path.resolve(id) : null;
  }
  if (fs.existsSync(path.resolve(id)) && (fs.existsSync(path.resolve(id, "lyricsync")) || fs.existsSync(path.resolve(id, "project.json")))) {
    return path.resolve(id);
  }
  for (const root of toRoots(roots)) {
    const candidate = path.join(root, id);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The folder of song `id`: existing location if found, or inside primary root for creation. */
export function songDir(roots: SongsRoots, id: string): string {
  const found = findSongDir(roots, id);
  if (found) return found;
  const norm = id.replace(/\\/g, "/");
  if (path.isAbsolute(norm) || path.win32.isAbsolute(id)) return path.resolve(id);
  const primary = toRoots(roots)[0] ?? "songs";
  return path.join(primary, id);
}

function existingSongDir(roots: SongsRoots, id: string): string {
  const found = findSongDir(roots, id);
  if (!found) {
    throw new Error(`Song "${id}" not found in any known song directories (${toRoots(roots).join(", ")}).`);
  }
  return found;
}

function readPrompt(dir: string): Record<string, unknown> {
  const file = path.join(dir, "user_input", "prompt.yaml");
  if (!fs.existsSync(file)) throw new Error(`Song manifest not found: ${file}`);
  const parsed: unknown = Bun.YAML.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${file} must be a YAML mapping.`);
  return parsed;
}

function promptFile(prompt: Record<string, unknown>, key: string): string {
  const files = prompt.files;
  if (!isRecord(files) || typeof files[key] !== "string") throw new Error(`prompt.yaml needs files.${key}.`);
  return files[key];
}

export function readPromptManifest(roots: SongsRoots, id: string): PromptManifest {
  const dir = existingSongDir(roots, id);
  const prompt = readPrompt(dir);
  const songPath = path.join(dir, "user_input", promptFile(prompt, "song"));
  if (!fs.existsSync(songPath)) throw new Error(`Full mix not found: ${songPath}`);
  return {
    songPath,
    nearestBpm: isNumber(prompt.nearest_bpm) ? prompt.nearest_bpm : null,
    firstDownbeat: isNumber(prompt.first_downbeat_s) ? prompt.first_downbeat_s : null,
  };
}

function promptVocalStem(dir: string, prompt: Record<string, unknown>): string {
  const files = prompt.files;
  const stems = isRecord(files) ? files.stems : undefined;
  if (!isRecord(stems)) throw new Error("prompt.yaml needs files.stems.");
  const folder = typeof stems.folder === "string" ? stems.folder : "stems";
  const vocal = stems.vocal;
  const name = typeof vocal === "string" ? vocal : isRecord(vocal) && typeof vocal.main_vocal === "string" ? vocal.main_vocal : null;
  if (name === null) throw new Error("prompt.yaml needs files.stems.vocal (a file name, or a mapping with main_vocal).");
  return path.join(dir, "user_input", folder, name);
}
export function songInputs(roots: SongsRoots, id: string): SongInputs {
  const dir = existingSongDir(roots, id);
  const prompt = readPrompt(dir);
  const lyricsFile = path.join(dir, "user_input", "lyrics.sync.json");
  if (!fs.existsSync(lyricsFile)) throw new Error(`Lyrics contract not found: ${lyricsFile}`);
  const lyrics: unknown = JSON.parse(fs.readFileSync(lyricsFile, "utf8"));
  if (!isRecord(lyrics) || (lyrics.language !== "en" && lyrics.language !== "ja")) throw new Error(`${lyricsFile} must declare "language": "en" or "ja".`);
  const fused = path.join(dir, "generated", "vocal_fused.wav");
  const vocalPath = fs.existsSync(fused) ? fused : promptVocalStem(dir, prompt);
  if (!fs.existsSync(vocalPath)) throw new Error(`Vocal stem not found: ${vocalPath}`);
  return {
    id,
    dir,
    workspaceDir: path.join(dir, "lyricsync"),
    lyricsFile,
    language: lyrics.language,
    vocalPath,
    beatsFile: path.join(dir, "generated", "timing.ai.json"),
  };
}
