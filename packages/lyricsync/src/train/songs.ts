// src/train/songs.ts
// Turns a training manifest (prepared workspaces + hand-calibrated timings) into TrainingSong inputs, and writes trained weights.
//
// Training manifest (JSON; paths are relative to the manifest's directory):
//   { "songs": [ { "id": "songA", "workspace": "ws/songA", "calibrated": "songA.calibrated.json", "skipLines": [37] }, ... ] }
// `id` names the song in reports and held-out weight files (default: the workspace directory name; ids must be unique).
// `calibrated` is a lyrics.json-style file whose line/word/syllable timings are the ground truth; `skipLines` lists lyric lines with no
// counterpart in it (a sung line the annotator left out). Every workspace must have been prepared ("lyricsync prepare").

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isConsensusLine, isNumber, isRecord } from '../guards.ts';
import type { ConsensusLine } from '../types.ts';
import { emptyAnchors, importCalibrated } from '../workspace/anchors.ts';
import { Session } from '../workspace/session.ts';
import type { TrainResult, TrainingSong } from './train.ts';

export interface TrainingManifestSong {
  id: string;
  workspace: string;
  calibrated: string;
  skipLines: number[];
}

export function readTrainingManifest(file: string): TrainingManifestSong[] {
  if (!fs.existsSync(file)) throw new Error(`Training manifest not found: ${file}`);
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(raw) || !Array.isArray(raw.songs) || raw.songs.length === 0) throw new Error(`Training manifest needs a non-empty "songs" array: ${file}`);
  const dir = path.dirname(path.resolve(file));
  const songs = raw.songs.map((s: unknown, i: number): TrainingManifestSong => {
    if (!isRecord(s) || typeof s.workspace !== 'string' || typeof s.calibrated !== 'string') throw new Error(`songs[${i}] needs string "workspace" and "calibrated": ${file}`);
    if (s.id !== undefined && typeof s.id !== 'string') throw new Error(`songs[${i}].id must be a string: ${file}`);
    const skip = s.skipLines === undefined ? [] : Array.isArray(s.skipLines) && s.skipLines.every(isNumber) ? s.skipLines : null;
    if (skip === null) throw new Error(`songs[${i}].skipLines must be an array of line indices: ${file}`);
    const workspace = path.resolve(dir, s.workspace);
    return { id: s.id ?? path.basename(workspace), workspace, calibrated: path.resolve(dir, s.calibrated), skipLines: skip };
  });
  const ids = songs.map((s) => s.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw new Error(`Training manifest has two songs named "${duplicate}"; give each song a unique "id": ${file}`);
  return songs;
}

/** Loads every song of a manifest: evidence, calibrated truth and the sliced alignments of all annotated lines (cached in each workspace). */
export async function loadTrainingSongs(manifestFile: string, onProgress?: (message: string) => void): Promise<TrainingSong[]> {
  const say = onProgress ?? (() => {});
  const songs: TrainingSong[] = [];
  for (const entry of readTrainingManifest(manifestFile)) {
    const id = entry.id;
    say(`${id}: loading`);
    const session = Session.open(entry.workspace);
    const evidence = await session.loadEvidence();
    const calibrated: unknown = JSON.parse(fs.readFileSync(entry.calibrated, 'utf8'));
    if (!isRecord(calibrated) || !Array.isArray(calibrated.lines) || !calibrated.lines.every(isConsensusLine)) throw new Error(`Calibrated file has no usable "lines": ${entry.calibrated}`);
    const anchors = emptyAnchors();
    importCalibrated(anchors, session.definition, calibrated, { level: 'line', skipDefinitionLines: entry.skipLines });
    const truth: Array<ConsensusLine | null> = [];
    let k = 0;
    for (const line of session.definition.lines) truth.push(entry.skipLines.includes(line.index) ? null : calibrated.lines[k++]!);
    const sliced = await session.alignAnchored(anchors, evidence, (m) => say(`${id}: ${m}`));
    songs.push({ id, evidence, anchors, sliced, truth });
  }
  return songs;
}

/**
 * Writes `<mode>.stage1.json` (+ `<mode>.stage2.json` for a mode that ships two stages) and `index.json` to `outDir`, and if given the
 * held-out weights per song to `heldOutDir`. A stage-2 file left over from an earlier run is ignored when index.json says one stage.
 */
export function writeTrainedWeights(results: TrainResult[], outDir: string, heldOutDir?: string): void {
  const anchored = results.find((r) => r.mode === 'anchored');
  const free = results.find((r) => r.mode === 'free');
  if (!anchored || !free) throw new Error('Both the anchored and the free mode must be trained: weights/index.json describes both.');
  const write = (file: string, weights: Record<string, number>): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(weights, null, 1), 'utf8');
  };
  for (const r of results) {
    write(path.join(outDir, `${r.mode}.stage1.json`), r.weights.stage1);
    if (r.weights.stage2) write(path.join(outDir, `${r.mode}.stage2.json`), r.weights.stage2);
    if (!heldOutDir) continue;
    for (const [id, w] of Object.entries(r.heldOut)) {
      write(path.join(heldOutDir, `${r.mode}.${id}.stage1.json`), w.stage1);
      write(path.join(heldOutDir, `${r.mode}.${id}.stage2.json`), w.stage2);
    }
  }
  const index = {
    version: 1,
    trainedOn: anchored.songs.map((s) => s.id),
    anchored: { stages: anchored.stages, heldOutMaeMs: Number(anchored.overall.shipped.toFixed(3)) },
    free: { stages: free.stages, heldOutMaeMs: Number(free.overall.shipped.toFixed(3)) },
  };
  fs.writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}
