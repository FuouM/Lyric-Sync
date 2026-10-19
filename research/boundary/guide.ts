// Boundary-model output for research runs. The shipped model's output is part of the prepared evidence (evidence.boundary); a checkpoint
// exported with export_guide.py (<workspace>/<dir>/frames.f32 + queries.json) is read here into the same shape, so both go through the
// package's boundaryGuide (packages/lyricsync/src/engine/guided.ts).
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BoundaryModelEvidence } from '../../packages/lyricsync/src/types.ts';

/** A research export: <workspace>/<dir>/frames.f32 ((T, dim + 1) float32) and queries.json ({fps, dim, frames, lines: [{index, q}]}). */
export function loadGuideExport(workspace: string, dir: string): BoundaryModelEvidence {
  const meta = JSON.parse(fs.readFileSync(path.join(workspace, dir, 'queries.json'), 'utf8')) as {
    fps: number;
    dim: number;
    frames: number;
    lines: Array<{ index: number; q: number[][] }>;
  };
  const buf = fs.readFileSync(path.join(workspace, dir, 'frames.f32'));
  const frames = new Float32Array(buf.byteLength / 4);
  new Uint8Array(frames.buffer).set(buf);
  if (frames.length !== meta.frames * (meta.dim + 1)) throw new Error(`frames.f32 has ${frames.length} floats, expected ${meta.frames * (meta.dim + 1)}`);
  const queries: Record<number, number[][]> = {};
  for (const l of meta.lines) queries[l.index] = l.q;
  return { fps: meta.fps, dim: meta.dim, frames, queries };
}

/** `--guide-dir <dir>` on the command line: that research export; otherwise the shipped model's output from the evidence. */
export function guideModel(workspace: string, evidence: { boundary: BoundaryModelEvidence }, argv: string[] = process.argv): BoundaryModelEvidence {
  const i = argv.indexOf('--guide-dir');
  return i < 0 ? evidence.boundary : loadGuideExport(workspace, argv[i + 1]!);
}
