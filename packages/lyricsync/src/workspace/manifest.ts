// src/workspace/manifest.ts
// A workspace is a directory holding everything needed to (re)solve one song, so a session can be resumed by a person or an agent:
//   lyricsync.json     manifest (language, vocal stem, beat source, evidence key)
//   lyrics.def.json    resolved LyricsDefinition (words, syllables, optional phones)
//   anchors.json       user-known timings (see anchors.ts)
//   evidence/          audio-derived evidence written by `prepare` (+ beats.json)
//   sliced/<line>.json cached per-line forced alignments for anchored lines
//   out/lyrics.json    solve result;  out/review.json  per-line uncertainty ranking

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isNumber, isRecord } from '../guards.ts';
import { modelFile } from '../paths.ts';
import type { Language, LyricsDefinition } from '../types.ts';

/** Bump when the evidence layout or extraction semantics change; invalidates prepared workspaces. */
export const EVIDENCE_FORMAT = 1;

export type BeatSource =
  | { kind: 'mix'; path: string; targetBpm: number; firstDownbeat?: number }
  | { kind: 'file'; path: string };

export interface WorkspaceManifest {
  version: 1;
  language: Language;
  /** Vocal stem path, relative to the workspace directory when possible. */
  vocal: string;
  beats: BeatSource;
  /** Hash of everything the evidence depends on, set by `prepare`; null until prepared. */
  evidenceKey: string | null;
}

export interface WorkspacePaths {
  dir: string;
  manifest: string;
  definition: string;
  anchors: string;
  evidence: string;
  beats: string;
  sliced: string;
  out: string;
  lyricsOut: string;
  reviewOut: string;
}

export function workspacePaths(dir: string): WorkspacePaths {
  const root = path.resolve(dir);
  const evidence = path.join(root, 'evidence');
  const out = path.join(root, 'out');
  return {
    dir: root,
    manifest: path.join(root, 'lyricsync.json'),
    definition: path.join(root, 'lyrics.def.json'),
    anchors: path.join(root, 'anchors.json'),
    evidence,
    beats: path.join(evidence, 'beats.json'),
    sliced: path.join(root, 'sliced'),
    out,
    lyricsOut: path.join(out, 'lyrics.json'),
    reviewOut: path.join(out, 'review.json'),
  };
}

/** Resolves a manifest path (relative ones are relative to the workspace directory). */
export function resolveInWorkspace(dir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(dir, p);
}

/** Stores `p` relative to the workspace directory (with "/" separators, so a copied song folder works on any platform) when that stays on
 *  the same drive; otherwise absolute. */
export function storePath(dir: string, p: string): string {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return path.isAbsolute(rel) ? path.resolve(p) : rel.split(path.sep).join('/');
}

/** A stored path with "/" separators when it is relative (older workspaces stored Windows separators). */
function portablePath(p: string): string {
  return path.win32.isAbsolute(p) || path.posix.isAbsolute(p) ? p : p.replace(/\\/g, '/');
}

export function readManifest(file: string): WorkspaceManifest {
  if (!fs.existsSync(file)) throw new Error(`Not a lyricsync workspace (missing ${file}). Create one with "lyricsync init".`);
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(raw) || raw.version !== 1) throw new Error(`Unsupported workspace manifest: ${file}`);
  if (raw.language !== 'en' && raw.language !== 'ja') throw new Error(`Manifest language must be "en" or "ja": ${file}`);
  if (typeof raw.vocal !== 'string') throw new Error(`Manifest has no vocal path: ${file}`);
  const b = raw.beats;
  if (!isRecord(b) || typeof b.path !== 'string') throw new Error(`Manifest has no beat source: ${file}`);
  let beats: BeatSource;
  if (b.kind === 'mix') {
    if (!isNumber(b.targetBpm)) throw new Error(`Manifest beats.targetBpm (the song's approximate tempo) is required for a mix beat source: ${file}`);
    beats = { kind: 'mix', path: portablePath(b.path), targetBpm: b.targetBpm };
    if (b.firstDownbeat !== undefined) {
      if (!isNumber(b.firstDownbeat)) throw new Error(`Manifest beats.firstDownbeat must be a number: ${file}`);
      beats.firstDownbeat = b.firstDownbeat;
    }
  } else if (b.kind === 'file') {
    beats = { kind: 'file', path: portablePath(b.path) };
  } else {
    throw new Error(`Manifest beats.kind must be "mix" or "file": ${file}`);
  }
  return { version: 1, language: raw.language, vocal: portablePath(raw.vocal), beats, evidenceKey: typeof raw.evidenceKey === 'string' ? raw.evidenceKey : null };
}

export function writeManifest(file: string, manifest: WorkspaceManifest): void {
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

const contentStamps = new Map<string, string>();
/** SHA-256 of a file's content: the same after a copy, a zip round trip or a checkout, unlike its mtime. Memoised per path, size and mtime. */
function contentStamp(file: string): string {
  const st = fs.statSync(file);
  const memo = `${path.resolve(file)}|${st.size}|${st.mtimeMs}`;
  let stamp = contentStamps.get(memo);
  if (stamp === undefined) {
    stamp = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    contentStamps.set(memo, stamp);
  }
  return stamp;
}

let boundaryStamp: string | undefined;
/**
 * Fingerprint of the bundled boundary model, whose output is part of the evidence: the content of queries.onnx and config.json (exported
 * together with frames.onnx from one checkpoint) and the size of frames.onnx. A new model makes prepared evidence stale.
 */
function boundaryModelStamp(): string {
  boundaryStamp ??= crypto
    .createHash('sha256')
    .update(fs.readFileSync(modelFile('boundary', 'queries.onnx')))
    .update(fs.readFileSync(modelFile('boundary', 'config.json')))
    .update(String(fs.statSync(modelFile('boundary', 'frames.onnx')).size))
    .digest('hex');
  return boundaryStamp;
}

function audioInputs(dir: string, manifest: WorkspaceManifest): object {
  const vocal = resolveInWorkspace(dir, manifest.vocal);
  const beatPath = resolveInWorkspace(dir, manifest.beats.path);
  for (const f of [vocal, beatPath]) if (!fs.existsSync(f)) throw new Error(`Workspace input file not found: ${f}`);
  return { format: EVIDENCE_FORMAT, boundaryModel: boundaryModelStamp(), vocal: contentStamp(vocal), beats: { ...manifest.beats, path: undefined, stamp: contentStamp(beatPath) } };
}

/**
 * Hash of everything the evidence depends on: lyrics, vocal stem, beat source, the evidence format and the bundled boundary model.
 * Input files are fingerprinted by content, so a song folder that is copied, zipped or checked out elsewhere stays prepared.
 */
export function computeEvidenceKey(dir: string, manifest: WorkspaceManifest, definition: LyricsDefinition): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ...audioInputs(dir, manifest), definition })).digest('hex');
}

/**
 * Hash of the inputs of the audio-derived evidence alone: vocal stem, beat source, evidence format and boundary model.
 * Independent of lyrics text or syllable definitions.
 */
export function computeAudioKey(dir: string, manifest: WorkspaceManifest): string {
  return crypto.createHash('sha256').update(JSON.stringify(audioInputs(dir, manifest))).digest('hex');
}
