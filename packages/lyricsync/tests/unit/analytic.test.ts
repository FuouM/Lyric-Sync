// packages/lyricsync/tests/unit/analytic.test.ts
// The training-free solver over the synthetic two-line song of helpers/song.ts.
import { describe, expect, test } from 'bun:test';
import { solveAnalytic } from '../../src/engine/analytic.ts';
import type { Anchors } from '../../src/types.ts';
import { evidence, full, line, notes, slicedLines0, times } from '../helpers/song.ts';

const none: Anchors = { version: 1, lines: {} };

describe('solveAnalytic', () => {
  test('every line keeps its syllable count, strictly increasing boundaries, and an extent that matches its first and last syllable', () => {
    const out = solveAnalytic({ evidence: evidence(), anchors: none, sliced: {} });
    expect(out.lines.length).toBe(2);
    for (let li = 0; li < 2; li++) {
      const t = times(out.lines, li);
      expect(t.length).toBe(li === 0 ? 5 : 4);
      for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
      expect(out.lines[li]!.start).toBe(t[0]!);
      expect(out.lines[li]!.end).toBe(t[t.length - 1]!);
    }
  });

  test('pinned boundaries come out exactly and carry no expected error', () => {
    const anchors: Anchors = { version: 1, lines: { '0': { start: 1.0, end: 3.0, boundaries: { '2': 2.04 } } } };
    const out = solveAnalytic({ evidence: evidence(), anchors, sliced: slicedLines0() });
    const t = times(out.lines, 0);
    expect(t[0]).toBe(1.0);
    expect(t[2]).toBe(2.04);
    expect(t[4]).toBe(3.0);
    const review = out.review[0]!;
    expect(review.mode).toBe('anchored');
    expect(review.uncertain.every((b) => !b.anchored)).toBe(true);
  });

  test('the same input always gives the same output', () => {
    const a = solveAnalytic({ evidence: evidence(), anchors: none, sliced: {} });
    const b = solveAnalytic({ evidence: evidence(), anchors: none, sliced: {} });
    expect(a.lines).toEqual(b.lines);
  });

  // The annotation tool snaps a boundary dragged to within 25 ms of a beat onto that beat, so a boundary whose evidence sits 20 ms off a beat is a beat.
  describe('beat snapping', () => {
    const lateByTwentyMs = () => {
      const hello = line(0, 'hello world', [{ w: 'hello', syl: [1.0, 1.52, 2.0] }, { w: 'world', syl: [2.0, 2.5, 3.0] }]);
      const onsets = [1.0, 1.52, 2.0, 2.5, 3.0];
      return { ...evidence({ fullBase: [hello, full()[1]!], fullCombined: [hello, full()[1]!], swiftNotes: notes(onsets), rmvpeNotes: [...notes(onsets), ...notes([4.0, 4.5, 5.0, 5.5])] }) };
    };

    test('evidence 20 ms after a beat lands on the beat', () => {
      const out = solveAnalytic({ evidence: lateByTwentyMs(), anchors: none, sliced: {} });
      expect(times(out.lines, 0)[1]).toBe(1.5);
    });

    test('the same evidence 80 ms from the nearest beat stays where the evidence is', () => {
      const away = { ...lateByTwentyMs(), beats: Array.from({ length: 24 }, (_, i) => i * 0.5 + 0.1) };
      const out = solveAnalytic({ evidence: away, anchors: none, sliced: {} });
      expect(times(out.lines, 0)[1]).toBeCloseTo(1.52, 3);
    });
  });
});
