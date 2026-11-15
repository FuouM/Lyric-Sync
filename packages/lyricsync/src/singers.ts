// src/singers.ts
// user_input/singers.json: the singers of a song. A UST belongs to the singer whose voiceDir equals its VoiceDir.
// Each singer has one lyrics file and one calibration file; the lead singer uses the default file names.
// No Node or Bun imports: the editor's browser code uses this module too.
import { isRecord } from "./guards.ts";

export interface Singer {
  /** `[a-z0-9_]+`, unique. Part of the singer's file names. */
  id: string;
  /** The UST VoiceDir (without `%VOICE%`), unique. */
  voiceDir: string;
  /** Exactly one singer is the lead. */
  lead?: boolean;
}

export interface Singers {
  v: 1;
  singers: Singer[];
}

const SINGERS = "user_input/singers.json";
export const SINGER_ID_RE = /^[a-z0-9_]+$/;

/** Validates user_input/singers.json content and returns it typed. */
export function parseSingers(raw: unknown): Singers {
  if (!isRecord(raw)) throw new Error(`${SINGERS}: expected an object.`);
  if (raw.v !== 1) throw new Error(`${SINGERS}: "v" must be 1.`);
  if (!Array.isArray(raw.singers)) throw new Error(`${SINGERS}: "singers" must be an array.`);
  const ids = new Set<string>();
  const dirs = new Set<string>();
  let leads = 0;
  raw.singers.forEach((s: unknown, k: number) => {
    const at = `${SINGERS}: singers[${k}]`;
    if (!isRecord(s)) throw new Error(`${at} must be an object.`);
    if (typeof s.id !== "string" || !SINGER_ID_RE.test(s.id)) throw new Error(`${at}.id must match [a-z0-9_]+.`);
    if (ids.has(s.id)) throw new Error(`${at}.id "${s.id}" is used twice.`);
    ids.add(s.id);
    if (typeof s.voiceDir !== "string" || s.voiceDir === "") throw new Error(`${at}.voiceDir must be a non-empty string.`);
    if (dirs.has(s.voiceDir)) throw new Error(`${at}.voiceDir "${s.voiceDir}" is used twice.`);
    dirs.add(s.voiceDir);
    if (s.lead !== undefined && typeof s.lead !== "boolean") throw new Error(`${at}.lead must be a boolean.`);
    if (s.lead === true) leads++;
  });
  if (leads !== 1) throw new Error(`${SINGERS}: exactly one singer must have "lead": true (found ${leads}).`);
  // Every field was checked above.
  return raw as unknown as Singers;
}

/** The lead singer of `s`. */
export function leadSinger(s: Singers): Singer {
  return s.singers.find((x) => x.lead === true)!;
}

/** The singer whose voiceDir is `voiceDir`, or null when no singer has it. */
export function singerOfVoiceDir(s: Singers, voiceDir: string): Singer | null {
  return s.singers.find((x) => x.voiceDir === voiceDir) ?? null;
}

/** The calibration file of singer `s`, relative to the song folder. */
export function calibratedFileFor(s: Singer): string {
  return s.lead === true ? "user_input/lyrics.calibrated.json" : `user_input/lyrics.calibrated.${s.id}.json`;
}

/** The lyrics file of singer `s`, relative to the song folder. */
export function lyricsFileFor(s: Singer): string {
  return s.lead === true ? "user_input/lyrics.txt" : `user_input/lyrics.${s.id}.txt`;
}
