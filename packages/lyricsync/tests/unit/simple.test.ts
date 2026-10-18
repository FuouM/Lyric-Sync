// packages/lyricsync/tests/unit/simple.test.ts
// The simplest training-free solver over the synthetic two-line song of helpers/song.ts.
import { describe, expect, test } from 'bun:test';
import { solveSimple } from '../../src/engine/simple.ts';
import type { Anchors } from '../../src/types.ts';
import { evidence, full, line, notes, slicedLines0, times } from '../helpers/song.ts';

const none: Anchors = { version: 1, lines: {} };

describe('solveSimple', () => {
  test('every line keeps its syllable count, strictly increasing boundaries, and an extent that matches its first and last syllable', () => {
    const out = solveSimple({ evidence: evidence(), anchors: none, sliced: {} });
    expect(out.lines.length).toBe(2);
    for (let li = 0; li < 2; li++) {
      const t = times(out.lines, li);
      expect(t.length).toBe(li === 0 ? 5 : 4);
      for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
      expect(out.lines[li]!.start).toBe(t[0]!);
      expect(out.lines[li]!.end).toBe(t[t.length - 1]!);
    }
  });

  test('pinned boundaries come out exactly', () => {
    const anchors: Anchors = { version: 1, lines: { '0': { start: 1.0, end: 3.0, boundaries: { '2': 2.04 } } } };
    const t = times(solveSimple({ evidence: evidence(), anchors, sliced: slicedLines0() }).lines, 0);
    expect(t[0]).toBe(1.0);
    expect(t[2]).toBe(2.04);
    expect(t[4]).toBe(3.0);
  });

  // The annotation tool snaps a boundary to a beat it was dragged close to; the solver does the same after decoding.
  describe('beat snapping', () => {
    const lateByTwentyMs = () => {
      const hello = line(0, 'hello world', [{ w: 'hello', syl: [1.0, 1.52, 2.0] }, { w: 'world', syl: [2.0, 2.5, 3.0] }]);
      const onsets = [1.0, 1.52, 2.0, 2.5, 3.0];
      return { ...evidence({ fullBase: [hello, full()[1]!], fullCombined: [hello, full()[1]!], swiftNotes: notes(onsets), rmvpeNotes: [...notes(onsets), ...notes([4.0, 4.5, 5.0, 5.5])] }) };
    };

    test('evidence 20 ms after a beat lands on the beat', () => {
      expect(times(solveSimple({ evidence: lateByTwentyMs(), anchors: none, sliced: {} }).lines, 0)[1]).toBe(1.5);
    });

    test('the same evidence 80 ms from the nearest beat stays where the evidence is', () => {
      const away = { ...lateByTwentyMs(), beats: Array.from({ length: 24 }, (_, i) => i * 0.5 + 0.1) };
      expect(times(solveSimple({ evidence: away, anchors: none, sliced: {} }).lines, 0)[1]).toBeCloseTo(1.52, 3);
    });
  });

  // Labelled lines tile: a line ends where the next one starts unless there is a real pause.
  describe('line ends', () => {
    const withSecondLineAt = (start: number) => {
      const second = line(1, 'good night moon', [{ w: 'good', syl: [start, start + 0.5] }, { w: 'night', syl: [start + 0.5, start + 1.0] }, { w: 'moon', syl: [start + 1.0, start + 1.5] }]);
      return evidence({ fullBase: [full()[0]!, second], fullCombined: [full()[0]!, second] });
    };

    test('a line end 0.2 s before the next line starts is moved onto that start', () => {
      const out = solveSimple({ evidence: withSecondLineAt(3.2), anchors: none, sliced: {} });
      expect(times(out.lines, 0).at(-1)).toBe(times(out.lines, 1)[0]!);
    });

    test('a pause of one second between the lines is kept', () => {
      const out = solveSimple({ evidence: withSecondLineAt(4.0), anchors: none, sliced: {} });
      expect(times(out.lines, 1)[0]! - times(out.lines, 0).at(-1)!).toBeGreaterThan(0.9);
    });

    test('a pinned line end is never moved', () => {
      const anchors: Anchors = { version: 1, lines: { '0': { start: 1.0, end: 3.0, boundaries: {} } } };
      const out = solveSimple({ evidence: withSecondLineAt(3.2), anchors, sliced: slicedLines0() });
      expect(times(out.lines, 0).at(-1)).toBe(3.0);
    });
  });

  // A forced aligner can collapse on a held melisma: the line's first syllable swallows the whole line and the rest pile up at the end.
  describe('collapsed alignment', () => {
    // Sung: hel 1.0, lo 1.5, wor 2.0, ld 2.5 held to 5.0 as a melisma (a note every 0.1 s).
    const melisma = Array.from({ length: 26 }, (_, i) => 2.5 + i * 0.1);
    const sung = line(0, 'hello world', [{ w: 'hello', syl: [1.0, 1.5, 2.0] }, { w: 'world', syl: [2.0, 2.5, 5.0] }]);
    const collapsed = line(0, 'hello world', [{ w: 'hello', syl: [1.0, 4.7, 4.8] }, { w: 'world', syl: [4.8, 4.9, 5.0] }]);
    const later = line(1, 'good night moon', [{ w: 'good', syl: [6.0, 6.5] }, { w: 'night', syl: [6.5, 7.0] }, { w: 'moon', syl: [7.0, 7.5] }]);
    const song = (base: typeof sung, combined: typeof sung) =>
      evidence({ fullBase: [base, later], fullCombined: [combined, later], rmvpeNotes: notes([1.0, 1.5, 2.0, ...melisma, 6.0, 6.5, 7.0, 7.5]) });

    test('a base alignment that swallows the line gives way to the combined one', () => {
      const t = times(solveSimple({ evidence: song(collapsed, sung), anchors: none, sliced: {} }).lines, 0);
      expect(t[1]!).toBeCloseTo(1.5, 1);
      expect(t[3]!).toBeCloseTo(2.5, 1);
    });

    test('the base alignment stays when the combined one collapsed instead', () => {
      const t = times(solveSimple({ evidence: song(sung, collapsed), anchors: none, sliced: {} }).lines, 0);
      expect(t[1]!).toBeCloseTo(1.5, 1);
    });
  });
});
