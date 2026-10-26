// src/song-folder.ts
// The song folder: the layout the New Song wizard writes, also the input of the pve video editor.
//   <dir>/project.json                       marks the folder as a song
//   <dir>/user_input/prompt.yaml             mix and stem file names, nearest_bpm, tempo_changes, first_downbeat_s
//   <dir>/user_input/lyrics.sync.json        the lyricsync lyrics contract; optional "unannotatedLines"
//   <dir>/user_input/lyrics.calibrated.json  the human calibration and the sections (lyrics editor)
//   <dir>/generated/timing.ai.json           the beat grid (beatsync)
//   <dir>/generated/features.json            audio feature envelopes (beatsync features)
//   <dir>/generated/lyrics.json              the last free solve
//   <dir>/lyricsync/                         the lyricsync workspace (evidence cache, anchors, results)
// This module imports only node:fs, node:path and the guards, so other tools can import it without the models
// (subpath export "lyricsync/song-folder"). prompt.yaml is parsed with Bun.YAML, so the prompt readers need Bun.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FeaturesDocument, TempoChange } from 'beatsync';
import { parseCalibrationDoc, type CalibrationDoc } from './calibration-doc.ts';
import { isNumber, isRecord } from './guards.ts';
import type { Language } from './types.ts';

export type { CalibrationDoc, CalLine, CalSection, CalWord } from './calibration-doc.ts';
export type { FeaturesDocument } from 'beatsync';

/** A valid song id (also the folder name). */
export const SONG_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** One songs folder or several, searched in order. The first one is where new songs go. */
export type SongsRoots = string | string[];

export interface SongFolderPaths {
  dir: string;
  projectFile: string;
  userInputDir: string;
  generatedDir: string;
  workspaceDir: string;
  promptFile: string;
  lyricsSyncFile: string;
  calibratedFile: string;
  timingFile: string;
  featuresFile: string;
  generatedLyricsFile: string;
  vocalFusedFile: string;
}

/** Stem files from prompt.yaml, as absolute paths. A key without stems is an empty array. */
export interface SongStems {
  /** Every vocal file: the one file, or every value of the vocal mapping (main_vocal first). */
  vocal: string[];
  /** The lead vocal: the one file, or main_vocal of the mapping. Null when the mapping has no main_vocal. */
  mainVocal: string | null;
  drums: string[];
  bass: string[];
  other: string[];
}

/** user_input/prompt.yaml, with file names resolved to absolute paths. Files are not checked for existence. */
export interface SongPrompt {
  projectCode: string | null;
  songName: string | null;
  /** The full mix (files.song). */
  mixPath: string;
  /** files.lyrics, when present. */
  lyricsTextPath: string | null;
  stemsDir: string;
  stems: SongStems;
  nearestBpm: number | null;
  /** tempo_changes: from each `at` seconds the tempo is `bpm`. Empty when the song has one tempo. */
  tempoChanges: TempoChange[];
  firstDownbeat: number | null;
}

/** generated/timing.ai.json (beatsync output). */
export interface TimingAi {
  v?: number;
  model?: string;
  duration: number;
  bpm: number;
  beat_period: number;
  beats: number[];
  downbeats: number[];
}

export interface PromptManifest {
  /** The full mix. */
  songPath: string;
  nearestBpm: number | null;
  /** Tempo changes after the start of the song (see SongPrompt.tempoChanges). */
  tempoChanges: TempoChange[];
  firstDownbeat: number | null;
}

export interface SongInputs {
  id: string;
  dir: string;
  workspaceDir: string;
  lyricsFile: string;
  language: Language;
  /** generated/vocal_fused.wav when the song has one (main + chorus), else the main vocal stem named in prompt.yaml. */
  vocalPath: string;
  beatsFile: string;
}

export function toRoots(roots: SongsRoots): string[] {
  return Array.isArray(roots) ? roots : [roots];
}

const isAbsoluteAnywhere = (p: string) => path.isAbsolute(p.replace(/\\/g, '/')) || path.win32.isAbsolute(p);

/** Locates a song folder: an absolute path, a relative path from the working directory, or an id in one of the roots. */
export function findSongDir(roots: SongsRoots, id: string): string | null {
  if (isAbsoluteAnywhere(id)) {
    return fs.existsSync(id) ? path.resolve(id) : null;
  }
  if (fs.existsSync(path.resolve(id)) && (fs.existsSync(path.resolve(id, 'lyricsync')) || fs.existsSync(path.resolve(id, 'project.json')))) {
    return path.resolve(id);
  }
  for (const root of toRoots(roots)) {
    const candidate = path.join(root, id);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The folder of song `id`: the existing location if found, else a new folder inside the first root. */
export function songDir(roots: SongsRoots, id: string): string {
  const found = findSongDir(roots, id);
  if (found) return found;
  if (isAbsoluteAnywhere(id)) return path.resolve(id);
  const primary = toRoots(roots)[0] ?? 'songs';
  return path.join(primary, id);
}

function existingSongDir(roots: SongsRoots, id: string): string {
  const found = findSongDir(roots, id);
  if (!found) {
    throw new Error(`Song "${id}" not found in any known song directories (${toRoots(roots).join(', ')}).`);
  }
  return found;
}

/** Every file path of the song folder `dir`. Nothing is read. */
export function songFolderPaths(dir: string): SongFolderPaths {
  const userInputDir = path.join(dir, 'user_input');
  const generatedDir = path.join(dir, 'generated');
  return {
    dir,
    projectFile: path.join(dir, 'project.json'),
    userInputDir,
    generatedDir,
    workspaceDir: path.join(dir, 'lyricsync'),
    promptFile: path.join(userInputDir, 'prompt.yaml'),
    lyricsSyncFile: path.join(userInputDir, 'lyrics.sync.json'),
    calibratedFile: path.join(userInputDir, 'lyrics.calibrated.json'),
    timingFile: path.join(generatedDir, 'timing.ai.json'),
    featuresFile: path.join(generatedDir, 'features.json'),
    generatedLyricsFile: path.join(generatedDir, 'lyrics.json'),
    vocalFusedFile: path.join(generatedDir, 'vocal_fused.wav'),
  };
}

function readJsonFile(file: string, what: string): unknown {
  if (!fs.existsSync(file)) throw new Error(`${what} not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function readPromptRecord(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) throw new Error(`Song manifest not found: ${file}`);
  if (typeof Bun === 'undefined') throw new Error(`Reading ${file} needs the Bun runtime (Bun.YAML).`);
  const parsed: unknown = Bun.YAML.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${file} must be a YAML mapping.`);
  return parsed;
}

function stemList(value: unknown, key: string, file: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value;
  throw new Error(`${file}: files.stems.${key} must be a file name or a list of file names.`);
}

/** `tempo_changes` of prompt.yaml: a list of `{ at: seconds, bpm }`; absent means the song keeps nearest_bpm throughout. Order is checked by the beat tracker. */
function tempoChanges(value: unknown, file: string): TempoChange[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((c) => isRecord(c) && isNumber(c.at) && isNumber(c.bpm))) {
    throw new Error(`${file}: tempo_changes must be a list of { at: seconds, bpm: number }.`);
  }
  return value.map((c: { at: number; bpm: number }) => ({ at: c.at, bpm: c.bpm }));
}

/** Reads and checks user_input/prompt.yaml of the song folder `dir`. Needs files.song. */
export function readSongPrompt(dir: string): SongPrompt {
  const { promptFile, userInputDir } = songFolderPaths(dir);
  const prompt = readPromptRecord(promptFile);
  const files = prompt.files;
  if (!isRecord(files) || typeof files.song !== 'string') throw new Error(`${promptFile} needs files.song.`);
  const stems = files.stems === undefined ? {} : files.stems;
  if (!isRecord(stems)) throw new Error(`${promptFile}: files.stems must be a mapping.`);
  const stemsDir = path.join(userInputDir, typeof stems.folder === 'string' ? stems.folder : 'stems');
  const inStems = (name: string) => path.join(stemsDir, name);

  let vocal: string[];
  let mainVocal: string | null;
  if (isRecord(stems.vocal)) {
    const entries = Object.entries(stems.vocal);
    if (!entries.every(([, v]) => typeof v === 'string')) throw new Error(`${promptFile}: every value of files.stems.vocal must be a file name.`);
    const main = stems.vocal.main_vocal;
    mainVocal = typeof main === 'string' ? inStems(main) : null;
    const names = entries.map(([, v]) => v as string);
    vocal = (typeof main === 'string' ? [main, ...names.filter((n) => n !== main)] : names).map(inStems);
  } else {
    vocal = stemList(stems.vocal, 'vocal', promptFile).map(inStems);
    mainVocal = vocal[0] ?? null;
  }

  return {
    projectCode: typeof prompt.project_code === 'string' ? prompt.project_code : null,
    songName: typeof prompt.song_name === 'string' ? prompt.song_name : null,
    mixPath: path.join(userInputDir, files.song),
    lyricsTextPath: typeof files.lyrics === 'string' ? path.join(userInputDir, files.lyrics) : null,
    stemsDir,
    stems: {
      vocal,
      mainVocal,
      drums: stemList(stems.drums, 'drums', promptFile).map(inStems),
      bass: stemList(stems.bass, 'bass', promptFile).map(inStems),
      other: stemList(stems.other, 'other', promptFile).map(inStems),
    },
    nearestBpm: isNumber(prompt.nearest_bpm) ? prompt.nearest_bpm : null,
    tempoChanges: tempoChanges(prompt.tempo_changes, promptFile),
    firstDownbeat: isNumber(prompt.first_downbeat_s) ? prompt.first_downbeat_s : null,
  };
}

/** Reads and checks generated/timing.ai.json of the song folder `dir`. */
export function readTimingAi(dir: string): TimingAi {
  const file = songFolderPaths(dir).timingFile;
  const raw = readJsonFile(file, 'Beat grid');
  const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNumber);
  if (!isRecord(raw) || !isNumber(raw.duration) || !isNumber(raw.bpm) || !isNumber(raw.beat_period) || !isNumberArray(raw.beats) || !isNumberArray(raw.downbeats)) {
    throw new Error(`${file} needs duration, bpm, beat_period, beats[] and downbeats[].`);
  }
  return {
    ...(isNumber(raw.v) ? { v: raw.v } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    duration: raw.duration,
    bpm: raw.bpm,
    beat_period: raw.beat_period,
    beats: raw.beats,
    downbeats: raw.downbeats,
  };
}

/** Reads and checks user_input/lyrics.calibrated.json of the song folder `dir`. */
export function readCalibratedLyrics(dir: string): CalibrationDoc {
  const file = songFolderPaths(dir).calibratedFile;
  return parseCalibrationDoc(readJsonFile(file, 'Calibrated lyrics'));
}

const MIX_ENVELOPES = ['rms', 'low', 'mid', 'high'] as const;
const STEM_ENVELOPES = ['vocal', 'drums', 'bass', 'other'] as const;
const ONSET_KEYS = ['kick', 'snare', 'hat', 'vocal'] as const;

/**
 * Reads and checks generated/features.json of the song folder `dir` (v1). The mix envelopes must be present.
 * Stem envelopes and onset keys are present only when the song had that stem or detector. All envelopes have the same length.
 */
export function readFeatures(dir: string): FeaturesDocument {
  const file = songFolderPaths(dir).featuresFile;
  const raw = readJsonFile(file, 'Audio features');
  if (!isRecord(raw) || raw.v !== 1 || !isNumber(raw.fps) || !isRecord(raw.envelopes) || !isRecord(raw.onsets)) {
    throw new Error(`${file} must be features v1: { v: 1, fps, envelopes, onsets }.`);
  }
  const { envelopes, onsets } = raw;
  let length = -1;
  for (const [key, env] of Object.entries(envelopes)) {
    if (!(MIX_ENVELOPES as readonly string[]).includes(key) && !(STEM_ENVELOPES as readonly string[]).includes(key)) throw new Error(`${file}: unknown envelope "${key}".`);
    if (!Array.isArray(env) || !env.every((v) => isNumber(v) && v >= 0 && v <= 1)) throw new Error(`${file}: envelopes.${key} must be numbers in 0..1.`);
    if (length !== -1 && env.length !== length) throw new Error(`${file}: envelopes.${key} has ${env.length} frames, the others ${length}.`);
    length = env.length;
  }
  for (const key of MIX_ENVELOPES) if (!(key in envelopes)) throw new Error(`${file}: envelopes.${key} is missing.`);
  for (const [key, list] of Object.entries(onsets)) {
    if (!(ONSET_KEYS as readonly string[]).includes(key)) throw new Error(`${file}: unknown onset key "${key}".`);
    if (!Array.isArray(list) || !list.every((o) => Array.isArray(o) && o.length === 2 && isNumber(o[0]) && isNumber(o[1]) && o[1] >= 0 && o[1] <= 1)) {
      throw new Error(`${file}: onsets.${key} must be [time s, strength 0..1] pairs.`);
    }
  }
  // Every field was checked above.
  return raw as unknown as FeaturesDocument;
}

/** The mix and tempo hints of song `id`. The mix must exist. */
export function readPromptManifest(roots: SongsRoots, id: string): PromptManifest {
  const prompt = readSongPrompt(existingSongDir(roots, id));
  if (!fs.existsSync(prompt.mixPath)) throw new Error(`Full mix not found: ${prompt.mixPath}`);
  return { songPath: prompt.mixPath, nearestBpm: prompt.nearestBpm, tempoChanges: prompt.tempoChanges, firstDownbeat: prompt.firstDownbeat };
}

/** The lyricsync inputs of song `id`: lyrics contract, language, vocal and beat grid. */
export function songInputs(roots: SongsRoots, id: string): SongInputs {
  const dir = existingSongDir(roots, id);
  const paths = songFolderPaths(dir);
  const prompt = readSongPrompt(dir);
  const lyrics = readJsonFile(paths.lyricsSyncFile, 'Lyrics contract');
  if (!isRecord(lyrics) || (lyrics.language !== 'en' && lyrics.language !== 'ja')) throw new Error(`${paths.lyricsSyncFile} must declare "language": "en" or "ja".`);
  let vocalPath = paths.vocalFusedFile;
  if (!fs.existsSync(vocalPath)) {
    if (prompt.stems.mainVocal === null) throw new Error(`${paths.promptFile} needs files.stems.vocal (a file name, or a mapping with main_vocal).`);
    vocalPath = prompt.stems.mainVocal;
  }
  if (!fs.existsSync(vocalPath)) throw new Error(`Vocal stem not found: ${vocalPath}`);
  return {
    id,
    dir,
    workspaceDir: paths.workspaceDir,
    lyricsFile: paths.lyricsSyncFile,
    language: lyrics.language,
    vocalPath,
    beatsFile: paths.timingFile,
  };
}
