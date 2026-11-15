// src/ust-song.ts
// The UST commands on a song folder: `lyricsync notes` (generated/notes.json) and `lyricsync import ust` (the singers' calibration
// files). Reads the placements, the USTs of the placed lanes, the beat grid, the singers, the map and the singers' lyrics files.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ust } from './formats/ust.ts';
import { parseLyricsText, type ParsedLyrics } from './lyrics/parse.ts';
import { placedNotes, type NotesFile } from './placed-notes.ts';
import { lyricsFileFor, singerOfVoiceDir } from './singers.ts';
import { readPlacements, readSingers, readTimingAi, readUst, readUstMap, songFolderPaths } from './song-folder.ts';
import { importUst, type UstImportFile } from './ust-import.ts';

function placedInputs(dir: string) {
  const placements = readPlacements(dir);
  if (!placements) throw new Error(`Placements not found: ${songFolderPaths(dir).placementsFile}`);
  const usts = new Map<string, Ust>();
  for (const lane of placements.lanes) if (!usts.has(lane.ust)) usts.set(lane.ust, readUst(dir, lane.ust));
  const grid = readTimingAi(dir);
  const singers = readSingers(dir);
  return { placements, usts, grid, singers, notes: placedNotes(placements, usts, singers, grid.beats) };
}

/** Every placed note of the song folder `dir` (PLAN 9.3). */
export function songNotes(dir: string): NotesFile {
  return { v: 1, notes: placedInputs(dir).notes };
}

/** The calibration files the UST import of the song folder `dir` writes (PLAN 9.4). Nothing is written. Throws on any failure. */
export function songUstImport(dir: string): UstImportFile[] {
  const paths = songFolderPaths(dir);
  const map = readUstMap(dir);
  if (!map) throw new Error(`UST map not found: ${paths.ustMapFile}`);
  const { placements, usts, grid, singers, notes } = placedInputs(dir);
  if (!singers) throw new Error(`Singers not found: ${paths.singersFile}`);
  const lyrics = new Map<string, ParsedLyrics>();
  for (const laneId of Object.keys(map.lanes)) {
    const lane = placements.lanes.find((l) => l.id === laneId);
    const ust = lane ? usts.get(lane.ust) : undefined;
    const singer = ust ? singerOfVoiceDir(singers, ust.voiceDir) : null;
    if (!singer || lyrics.has(singer.id)) continue;
    const file = path.join(dir, lyricsFileFor(singer));
    if (!fs.existsSync(file)) throw new Error(`Lyrics of singer "${singer.id}" not found: ${file}`);
    try {
      // The lyrics of a UST song are Japanese romaji (the god_ish lyrics.txt syntax).
      lyrics.set(singer.id, parseLyricsText(fs.readFileSync(file, 'utf8'), 'ja'));
    } catch (e) {
      throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return importUst({ map, placements, usts, singers, lyrics }, notes, { downbeats: grid.downbeats, duration: grid.duration });
}
