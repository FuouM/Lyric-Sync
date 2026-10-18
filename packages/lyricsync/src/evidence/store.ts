// packages/lyricsync/src/evidence/store.ts
/**
 * On-disk Evidence Storage Layout (version 2):
 *
 * directory/
 * ├── meta.json         General metadata (version, language, durationSec, sampleRate, beats, f0Hz, edgeSets, breaths, posteriors and boundary meta)
 * ├── notes.json        Extracted pitch note sequences (swiftNotes, harmoNotes, rmvpeNotes)
 * ├── alignments.json   Full-song phonetic alignments (fullBase, fullCombined)
 * ├── posteriors.bin    Raw binary Uint8Array frame-major phoneme posteriors (frames * vocabSize bytes)
 * ├── boundary.bin      Boundary-model frames: float32 (platform order, little-endian in practice), frame-major (frames * (dim + 1))
 * └── boundary.json     Boundary-model queries per line ({ "<line index>": [[dim floats] per boundary] })
 *
 * Audio is NOT persisted on disk; loadEvidence re-decodes the vocal audio file and rebuilds nucleusFor
 * using the bundled vocabulary and dictionaries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AcousticBreath,
  AcousticEdge,
  ConsensusLine,
  ConsensusNote,
  Language,
  SongEvidence,
} from '../types.ts';
import { loadAudioFile } from '../audio/audio.ts';
import { createNucleusResolver } from './nucleus.ts';

interface MetaJson {
  version: 2;
  audioKey?: string;
  language: Language;
  durationSec: number;
  sampleRate: 44100;
  beats: number[];
  f0Hz: number[];
  edgeSets: [AcousticEdge[], AcousticEdge[]];
  breaths: AcousticBreath[];
  posteriors: {
    frames: number;
    vocabSize: number;
    silenceId: number;
  };
  boundary: {
    fps: number;
    dim: number;
    frames: number;
  };
}

interface NotesJson {
  swiftNotes: ConsensusNote[];
  harmoNotes: ConsensusNote[];
  rmvpeNotes: ConsensusNote[];
}

interface AlignmentsJson {
  fullBase: ConsensusLine[];
  fullCombined: ConsensusLine[] | null;
}

export function saveEvidence(dir: string, evidence: SongEvidence, options: { audioKey?: string } = {}): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const meta: MetaJson = {
    version: 2,
    ...(options.audioKey ? { audioKey: options.audioKey } : {}),
    language: evidence.language,
    durationSec: evidence.durationSec,
    sampleRate: 44100,
    beats: evidence.beats,
    f0Hz: evidence.f0Hz,
    edgeSets: evidence.edgeSets,
    breaths: evidence.breaths,
    posteriors: {
      frames: evidence.posteriors.frames,
      vocabSize: evidence.posteriors.vocabSize,
      silenceId: evidence.posteriors.silenceId,
    },
    boundary: {
      fps: evidence.boundary.fps,
      dim: evidence.boundary.dim,
      frames: evidence.boundary.frames.length / (evidence.boundary.dim + 1),
    },
  };

  const notes: NotesJson = {
    swiftNotes: evidence.swiftNotes,
    harmoNotes: evidence.harmoNotes,
    rmvpeNotes: evidence.rmvpeNotes,
  };

  const alignments: AlignmentsJson = {
    fullBase: evidence.fullBase,
    fullCombined: evidence.fullCombined,
  };

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(notes, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'alignments.json'), JSON.stringify(alignments, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'posteriors.bin'), evidence.posteriors.data);
  const b = evidence.boundary.frames;
  fs.writeFileSync(path.join(dir, 'boundary.bin'), new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  fs.writeFileSync(path.join(dir, 'boundary.json'), JSON.stringify(evidence.boundary.queries), 'utf8');
}

export async function loadEvidence(dir: string, vocalPath: string): Promise<SongEvidence> {
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error(`Evidence meta.json not found in: ${dir}`);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MetaJson;
  if (meta.version !== 2) {
    throw new Error(`Evidence in ${dir} was written by an older lyricsync (version ${meta.version}, needs 2). Run "lyricsync prepare <workspace> --force".`);
  }

  const notesPath = path.join(dir, 'notes.json');
  if (!fs.existsSync(notesPath)) {
    throw new Error(`Evidence notes.json not found in: ${dir}`);
  }
  const notes = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as NotesJson;

  const alignmentsPath = path.join(dir, 'alignments.json');
  if (!fs.existsSync(alignmentsPath)) {
    throw new Error(`Evidence alignments.json not found in: ${dir}`);
  }
  const alignments = JSON.parse(fs.readFileSync(alignmentsPath, 'utf8')) as AlignmentsJson;

  const postBinPath = path.join(dir, 'posteriors.bin');
  if (!fs.existsSync(postBinPath)) {
    throw new Error(`Evidence posteriors.bin not found in: ${dir}`);
  }
  const postBytes = fs.readFileSync(postBinPath);
  const postData = new Uint8Array(postBytes.buffer, postBytes.byteOffset, postBytes.byteLength);

  const boundaryBin = path.join(dir, 'boundary.bin');
  const boundaryJson = path.join(dir, 'boundary.json');
  if (!fs.existsSync(boundaryBin) || !fs.existsSync(boundaryJson)) {
    throw new Error(`Evidence boundary.bin / boundary.json not found in: ${dir}`);
  }
  const bBytes = fs.readFileSync(boundaryBin);
  // Copied into a fresh buffer: a file Buffer may sit at an offset that is not a multiple of 4.
  const frames = new Float32Array(bBytes.byteLength / 4);
  new Uint8Array(frames.buffer).set(bBytes);
  if (frames.length !== meta.boundary.frames * (meta.boundary.dim + 1)) {
    throw new Error(`Evidence boundary.bin has ${frames.length} floats, expected ${meta.boundary.frames * (meta.boundary.dim + 1)}: ${dir}`);
  }
  const queries = JSON.parse(fs.readFileSync(boundaryJson, 'utf8')) as Record<number, number[][]>;

  const audio = await loadAudioFile(vocalPath, 44100);
  const { resolver: nucleusFor } = createNucleusResolver(meta.language);

  return {
    language: meta.language,
    durationSec: meta.durationSec,
    audio,
    sampleRate: 44100,
    swiftNotes: notes.swiftNotes,
    harmoNotes: notes.harmoNotes,
    rmvpeNotes: notes.rmvpeNotes,
    f0Hz: meta.f0Hz,
    edgeSets: meta.edgeSets,
    breaths: meta.breaths,
    beats: meta.beats,
    posteriors: {
      frames: meta.posteriors.frames,
      vocabSize: meta.posteriors.vocabSize,
      data: postData,
      silenceId: meta.posteriors.silenceId,
    },
    nucleusFor,
    fullBase: alignments.fullBase,
    fullCombined: alignments.fullCombined,
    boundary: { fps: meta.boundary.fps, dim: meta.boundary.dim, frames, queries },
  };
}
