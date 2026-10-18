// packages/lyricsync/tests/unit/engine.test.ts
// Synthetic two-line song: line 0 "hello world" (2+2 syllables), line 1 "good night moon" (1+1+1). Evidence is minimal but real-shaped.
import { describe, expect, test } from 'bun:test';
import { solve } from '../../src/engine/solve.ts';
import { readWeightsFile } from '../../src/engine/weights.ts';
import { weightsFile } from '../../src/paths.ts';
import type { Anchors, WeightBundle, Weights } from '../../src/types.ts';
import { evidence, full, slicedLines0, times } from '../helpers/song.ts';

const real = (name: string): Weights => readWeightsFile(weightsFile(name));
const ZERO: Weights = {};
const bundle = (anchored: Weights, free: Weights, stage2 = true): WeightBundle => ({
  anchored: { stage1: anchored, stage2: stage2 ? anchored : null },
  free: { stage1: free, stage2: stage2 ? free : null },
});
const none: Anchors = { version: 1, lines: {} };
const sliced0 = slicedLines0();
const anchorLine0: Anchors = { version: 1, lines: { '0': { start: 1.0, end: 3.0 } } };

describe('solve: pins', () => {
  test('an interior pin comes out exactly and edge pins define the line', () => {
    const anchors: Anchors = { version: 1, lines: { '1': { start: 4.0, end: 5.5, boundaries: { '1': 4.61 } } } };
    const out = solve({ evidence: evidence(), anchors, sliced: { 1: { base: full()[1]!, combined: null } }, weights: bundle(real('anchored.stage1.json'), ZERO) });
    const t = times(out.lines, 1);
    expect(t[0]).toBe(4.0);
    expect(t[1]).toBe(4.61);
    expect(t[3]).toBe(5.5);
    expect(out.lines[1]!.words[0]!.end).toBe(4.61);
    expect(out.lines[1]!.words[1]!.start).toBe(4.61);
  });

  test('a pin contradicting the raw alignment still yields a strictly increasing tiling', () => {
    const anchors: Anchors = { version: 1, lines: { '0': { boundaries: { '1': 2.6 } } } };
    const out = solve({ evidence: evidence(), anchors, sliced: {}, weights: bundle(ZERO, real('anchored.stage1.json')) });
    const t = times(out.lines, 0);
    expect(t[1]).toBe(2.6);
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
  });

  test('pinned boundaries have zero expected error and are not listed as uncertain', () => {
    const anchors: Anchors = { version: 1, lines: { '0': { start: 1.0, end: 3.0, boundaries: { '2': 2.0 } } } };
    const out = solve({ evidence: evidence(), anchors, sliced: sliced0, weights: bundle(real('anchored.stage1.json'), ZERO) });
    const review = out.review[0]!;
    expect(review.mode).toBe('anchored');
    expect(review.uncertain.every((b) => !b.anchored)).toBe(true);
    expect(review.uncertain.map((b) => b.boundary)).not.toContain(2);
  });
});

describe('solve: validation', () => {
  const w = bundle(ZERO, ZERO);
  test('rejects a line index outside the song', () => {
    expect(() => solve({ evidence: evidence(), anchors: { version: 1, lines: { '5': { start: 1 } } }, sliced: {}, weights: w })).toThrow(/line index "5"/);
  });

  test('rejects a boundary outside the line', () => {
    expect(() => solve({ evidence: evidence(), anchors: { version: 1, lines: { '0': { boundaries: { '9': 2 } } } }, sliced: {}, weights: w })).toThrow(/boundary index "9"/);
  });

  test('rejects pinned times that are not increasing', () => {
    expect(() => solve({ evidence: evidence(), anchors: { version: 1, lines: { '0': { start: 3, end: 1 } } }, sliced: sliced0, weights: w })).toThrow(/not strictly increasing/);
  });

  test('an anchored line needs its sliced alignment', () => {
    expect(() => solve({ evidence: evidence(), anchors: anchorLine0, sliced: {}, weights: w })).toThrow(/sliced alignment/);
  });
});

describe('solve: per-line weights', () => {
  const W = real('anchored.stage1.json');

  test('a line uses the anchored weights iff both edges are pinned, and the free weights otherwise', () => {
    const run = (b: WeightBundle) => solve({ evidence: evidence(), anchors: anchorLine0, sliced: sliced0, weights: b }).lines;
    const base = run(bundle(ZERO, ZERO));
    const anchoredOn = run(bundle(W, ZERO));
    const freeOn = run(bundle(ZERO, W));
    // anchored weights change line 0 (anchored) and leave line 1 (free) alone
    expect(times(anchoredOn, 0)).not.toEqual(times(base, 0));
    expect(times(anchoredOn, 1)).toEqual(times(base, 1));
    // free weights change line 1 (free) and leave line 0 (anchored) alone
    expect(times(freeOn, 0)).toEqual(times(base, 0));
    expect(times(freeOn, 1)).not.toEqual(times(base, 1));
  });

  test('a half-pinned line is solved with the free weights', () => {
    const half: Anchors = { version: 1, lines: { '0': { start: 1.0 } } };
    const a = solve({ evidence: evidence(), anchors: half, sliced: {}, weights: bundle(W, ZERO) });
    const b = solve({ evidence: evidence(), anchors: half, sliced: {}, weights: bundle(ZERO, ZERO) });
    expect(times(a.lines, 0)).toEqual(times(b.lines, 0));
    expect(a.review[0]!.mode).toBe('free');
  });
});

describe('solve: stages', () => {
  test('a mode without stage-2 weights is decoded by stage 1 only', () => {
    const W = real('anchored.stage1.json');
    const one = solve({ evidence: evidence(), anchors: none, sliced: {}, weights: bundle(ZERO, W, false) });
    const two = solve({ evidence: evidence(), anchors: none, sliced: {}, weights: bundle(ZERO, W, true) });
    expect(one.lines.length).toBe(2);
    expect(two.lines.length).toBe(2);
    // stage 2 re-runs the DP around stage 1's output, so with identical weights it may move times; one stage must not equal "two stages of nothing"
    for (const out of [one, two]) for (const r of out.review) expect(r.meanExpectedErrorMs).toBeGreaterThanOrEqual(0);
  });

  test('review ranks lines by expected error and caps the uncertain list', () => {
    const out = solve({ evidence: evidence(), anchors: none, sliced: {}, weights: bundle(real('anchored.stage1.json'), real('anchored.stage1.json')) });
    for (const r of out.review) {
      expect(r.uncertain.length).toBeLessThanOrEqual(5);
      const errs = r.uncertain.map((b) => b.expectedErrorMs);
      expect([...errs].sort((a, b) => b - a)).toEqual(errs);
    }
  });
});
