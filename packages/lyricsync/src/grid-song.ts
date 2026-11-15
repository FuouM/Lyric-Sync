// src/grid-song.ts
// `lyricsync grid`: writes generated/timing.ai.json of a song whose prompt.yaml says `grid: fixed` (see fixed-grid.ts).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadAudioFile } from './audio/audio.ts';
import { fixedBeatGrid } from './fixed-grid.ts';
import { readSongPrompt, songFolderPaths, type SongPrompt } from './song-folder.ts';
import type { BeatsDocument } from './workspace/session.ts';

/** The fixed grid of the mix in `prompt`: nearest_bpm, first_downbeat_s (0 when absent) and the duration of the mix. */
export async function fixedGridOfPrompt(prompt: Pick<SongPrompt, 'mixPath' | 'nearestBpm' | 'firstDownbeat'>): Promise<BeatsDocument> {
  if (prompt.nearestBpm === null) throw new Error('grid: fixed needs nearest_bpm in prompt.yaml.');
  const audio = await loadAudioFile(prompt.mixPath, 44100);
  return fixedBeatGrid(prompt.nearestBpm, prompt.firstDownbeat ?? 0, audio.length / 44100);
}

export interface GridResult {
  file: string;
  doc: BeatsDocument;
}

/** Writes generated/timing.ai.json (and the workspace's evidence/beats.json when it exists) of the song folder `dir`. Needs `grid: fixed`. */
export async function writeFixedGrid(dir: string): Promise<GridResult> {
  const prompt = readSongPrompt(dir);
  if (prompt.grid !== 'fixed') throw new Error('grid needs "grid: fixed" in user_input/prompt.yaml (other songs get their beats from the editor or the wizard).');
  const doc = await fixedGridOfPrompt(prompt);
  const paths = songFolderPaths(dir);
  fs.mkdirSync(path.dirname(paths.timingFile), { recursive: true });
  fs.writeFileSync(paths.timingFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const evidenceBeats = path.join(paths.workspaceDir, 'evidence', 'beats.json');
  if (fs.existsSync(evidenceBeats)) fs.writeFileSync(evidenceBeats, `${JSON.stringify(doc)}\n`, 'utf8');
  return { file: paths.timingFile, doc };
}
