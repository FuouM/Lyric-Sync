// packages/lyricsync/tests/unit/guided.test.ts
// The guided solver over the synthetic two-line song of helpers/song.ts, with a hand-made boundary model.
import { describe, expect, test } from 'bun:test';
import { boundaryGuide, solveGuided } from '../../src/engine/guided.ts';
import type { Anchors, BoundaryModelEvidence } from '../../src/types.ts';
import { evidence, times } from '../helpers/song.ts';

const none: Anchors = { version: 1, lines: {} };
// The song's boundaries (helpers/song.ts): line 0 at 1.0 1.5 2.0 2.5 3.0, line 1 at 4.0 4.5 5.0 5.5.
const BOUNDARIES: Array<[line: number, j: number, t: number]> = [
  [0, 0, 1.0], [0, 1, 1.5], [0, 2, 2.0], [0, 3, 2.5], [0, 4, 3.0],
  [1, 0, 4.0], [1, 1, 4.5], [1, 2, 5.0], [1, 3, 5.5],
];

/**
 * A model that knows where each boundary is (one embedding channel per boundary, lit only at its frame), except the boundaries in `unsure`,
 * whose queries are zero: every frame scores the same for them.
 */
function model(unsure: Array<[number, number]>, at: (line: number, j: number, t: number) => number = (_l, _j, t) => t): BoundaryModelEvidence {
  const dim = BOUNDARIES.length;
  const frames = new Float32Array(1200 * (dim + 1));
  const queries: Record<number, number[][]> = { 0: [], 1: [] };
  BOUNDARIES.forEach(([line, j, t], k) => {
    frames[Math.round(at(line, j, t) * 100) * (dim + 1) + k] = 40;
    const q = new Array<number>(dim).fill(0);
    if (!unsure.some(([l, jj]) => l === line && jj === j)) q[k] = 1;
    queries[line]![j] = q;
  });
  return { fps: 100, dim, frames, queries };
}

describe('solveGuided', () => {
  test('where the model and the other evidence disagree, the review reports that boundary as more uncertain', () => {
    const review = (m: BoundaryModelEvidence) => solveGuided({ evidence: evidence({ boundary: m }), anchors: none, sliced: {}, guide: boundaryGuide(m) }).review;
    const agree = review(model([]));
    const disagree = review(model([], (line, j, t) => (line === 1 && j === 1 ? 4.62 : t)));
    const at = (r: typeof agree) => r.find((l) => l.line === 1)!.uncertain.find((b) => b.boundary === 1)!.expectedErrorMs;
    expect(at(agree)).toBeLessThan(1);
    expect(at(disagree)).toBeGreaterThan(10);
    expect(disagree.find((l) => l.line === 1)!.uncertain[0]!.boundary).toBe(1);
  });

  test('lines never overlap, even when a pinned line end reaches past where the next line would start', () => {
    const m = model([]);
    const anchors: Anchors = { version: 1, lines: { '0': { end: 4.3 } } };
    const out = solveGuided({ evidence: evidence({ boundary: m }), anchors, sliced: {}, guide: boundaryGuide(m) });
    expect(times(out.lines, 0).at(-1)).toBe(4.3);
    expect(out.lines[1]!.start).toBeGreaterThanOrEqual(4.3);
    const t1 = times(out.lines, 1);
    for (let i = 1; i < t1.length; i++) expect(t1[i]!).toBeGreaterThan(t1[i - 1]!);
  });
});
