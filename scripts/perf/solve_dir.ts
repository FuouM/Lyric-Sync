// Solves a workspace's lyrics from two evidence folders (guided method, snapped, with the workspace's anchors and with none) and
// reports how far the solved syllable boundaries move between them.
// usage: bun scripts/perf/solve_dir.ts <workspace dir> <evidence dir A> <evidence dir B> [--device gpu|cpu]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Session } from '../../packages/lyricsync/src/workspace/session.ts';
import { alignAnchoredLines, loadEvidence } from '../../packages/lyricsync/src/evidence/index.ts';
import { boundaryGuide, solveGuided } from '../../packages/lyricsync/src/engine/guided.ts';
import { emptyAnchors, isLineAnchored } from '../../packages/lyricsync/src/workspace/anchors.ts';
import type { Anchors } from '../../packages/lyricsync/src/types.ts';

const [ws, a, b] = process.argv.slice(2);
if (!ws || !a || !b) throw new Error('usage: solve_dir.ts <workspace> <evidence A> <evidence B> [--device gpu|cpu]');
const device = process.argv.includes('cpu') ? 'cpu' : 'gpu';
const session = Session.open(ws);
const manifest = JSON.parse(fs.readFileSync(path.join(ws, 'lyricsync.json'), 'utf8'));
const vocal = path.resolve(ws, manifest.vocal);

async function solveWith(dir: string, anchors: Anchors): Promise<number[]> {
  const evidence = await loadEvidence(dir, vocal);
  const bounds: Record<number, { start: number; end: number }> = {};
  for (const line of session.definition.lines) {
    const anchor = anchors.lines[String(line.index)];
    if (isLineAnchored(anchor)) bounds[line.index] = { start: anchor!.start!, end: anchor!.end! };
  }
  const sliced = await alignAnchoredLines(evidence, session.definition, bounds, undefined, device);
  const out = solveGuided({ evidence, anchors, sliced, guide: boundaryGuide(evidence.boundary), design: {} });
  return out.lines.flatMap((l) => l.words.flatMap((w) => w.syl.flat()));
}

for (const [name, anchors] of [['free', emptyAnchors()], ['anchors.json', session.loadAnchors()]] as const) {
  const x = await solveWith(a, anchors);
  const y = await solveWith(b, anchors);
  let moved = 0;
  let max = 0;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(x[i]! - y[i]!);
    if (d > 0) moved++;
    max = Math.max(max, d);
  }
  console.log(JSON.stringify({ anchors: name, times: x.length, moved, maxMs: Math.round(max * 1000) }));
}
