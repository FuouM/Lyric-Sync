// packages/lyricsync/tests/unit/anchors.test.ts
import { describe, expect, test } from 'bun:test';
import {
  clearAnchors,
  emptyAnchors,
  importCalibrated,
  isLineAnchored,
  pinsOf,
  setBoundary,
  setLineBounds,
  summarizeAnchors,
  syllableCount,
  validateAnchors,
} from '../../src/workspace/anchors.ts';
import type { LyricsDefinition } from '../../src/types.ts';

// line 0: "hello(2) world(2)" = 4 syllables; line 1: "good(1) night(1)" = 2 syllables
const def: LyricsDefinition = {
  language: 'en',
  lines: [
    { index: 0, text: 'hello world', words: [{ w: 'hello', syllables: ['hel', 'lo'] }, { w: 'world', syllables: ['wor', 'ld'] }] },
    { index: 1, text: 'good night', words: [{ w: 'good', syllables: ['good'] }, { w: 'night', syllables: ['night'] }] },
  ],
};

const edited = {
  lines: [
    {
      start: 1.0,
      end: 3.0,
      words: [
        { start: 1.0, end: 2.0, syl: [[1.0, 1.4], [1.4, 2.0]], sylCalibrated: [true, false] },
        { start: 2.0, end: 3.0, syl: [[2.0, 2.6], [2.6, 3.0]] },
      ],
    },
    {
      start: 4.0,
      end: 5.0,
      calibrated: true,
      words: [
        { start: 4.0, end: 4.5, syl: [[4.0, 4.5]] },
        { start: 4.5, end: 5.0, syl: [[4.5, 5.0]] },
      ],
    },
  ],
};

describe('setBoundary / setLineBounds', () => {
  test('routes boundary 0 and m to start/end and interior boundaries to the map', () => {
    const a = emptyAnchors();
    setBoundary(a, def, 0, 0, 1.0);
    setBoundary(a, def, 0, 2, 2.0);
    setBoundary(a, def, 0, 4, 3.0);
    expect(a.lines['0']).toEqual({ start: 1.0, end: 3.0, boundaries: { '2': 2.0 } });
    expect(pinsOf(a.lines['0']!, syllableCount(def.lines[0]!))).toEqual([[0, 1.0], [2, 2.0], [4, 3.0]]);
  });

  test('a line is anchored only when both edges are pinned', () => {
    const a = emptyAnchors();
    setBoundary(a, def, 0, 0, 1.0);
    expect(isLineAnchored(a.lines['0'])).toBe(false);
    setBoundary(a, def, 0, 4, 3.0);
    expect(isLineAnchored(a.lines['0'])).toBe(true);
  });

  test('rejects a boundary outside the line and an unknown line', () => {
    const a = emptyAnchors();
    expect(() => setBoundary(a, def, 0, 5, 1.0)).toThrow(/boundary must be 0\.\.4/);
    expect(() => setBoundary(a, def, 7, 0, 1.0)).toThrow(/No line 7/);
  });

  test('clearAnchors removes one line or everything', () => {
    const a = emptyAnchors();
    setLineBounds(a, def, 0, 1, 3);
    setLineBounds(a, def, 1, 4, 5);
    expect(clearAnchors(a, 0)).toBe(1);
    expect(Object.keys(a.lines)).toEqual(['1']);
    expect(clearAnchors(a)).toBe(1);
    expect(a.lines).toEqual({});
  });
});

describe('validateAnchors', () => {
  test('rejects pinned times that are not strictly increasing', () => {
    const a = emptyAnchors();
    a.lines['0'] = { start: 2.0, end: 3.0, boundaries: { '2': 1.5 } };
    expect(() => validateAnchors(a, def)).toThrow(/must be earlier/);
  });

  test('rejects interior boundaries outside 1..m-1 and unknown lines', () => {
    const a = emptyAnchors();
    a.lines['0'] = { boundaries: { '4': 3.0 } };
    expect(() => validateAnchors(a, def)).toThrow(/outside 1\.\.3/);
    const b = emptyAnchors();
    b.lines['9'] = { start: 1 };
    expect(() => validateAnchors(b, def)).toThrow(/line 9/);
  });
});

describe('importCalibrated', () => {
  test('line level pins only start and end', () => {
    const a = emptyAnchors();
    const s = importCalibrated(a, def, edited, { level: 'line' });
    expect(s).toEqual({ linesTouched: 2, boundariesPinned: 4 });
    expect(a.lines['0']).toEqual({ start: 1.0, end: 3.0 });
  });

  test('word level also pins every word start', () => {
    const a = emptyAnchors();
    importCalibrated(a, def, edited, { level: 'word' });
    expect(a.lines['0']).toEqual({ start: 1.0, end: 3.0, boundaries: { '2': 2.0 } });
  });

  test('syllable level pins every syllable boundary', () => {
    const a = emptyAnchors();
    importCalibrated(a, def, edited, { level: 'syllable' });
    expect(pinsOf(a.lines['0']!, 4).map(([j]) => j)).toEqual([0, 1, 2, 3, 4]);
  });

  test('flagged level pins only the edges of syllables the editor marked calibrated, and honours line-level flags', () => {
    const a = emptyAnchors();
    importCalibrated(a, def, edited, { level: 'flagged' });
    // line 0: only syllable 0 is flagged -> boundaries 0 and 1
    expect(pinsOf(a.lines['0']!, 4)).toEqual([[0, 1.0], [1, 1.4]]);
    // line 1: line.calibrated applies to every syllable without its own flags -> all boundaries
    expect(pinsOf(a.lines['1']!, 2)).toEqual([[0, 4.0], [1, 4.5], [2, 5.0]]);
  });

  test('restricts to the requested lines', () => {
    const a = emptyAnchors();
    importCalibrated(a, def, edited, { level: 'line', lines: [1] });
    expect(Object.keys(a.lines)).toEqual(['1']);
  });

  test('skipDefinitionLines maps a shorter file onto the remaining lines', () => {
    const a = emptyAnchors();
    importCalibrated(a, def, { lines: [edited.lines[1]] }, { level: 'line', skipDefinitionLines: [0] });
    expect(Object.keys(a.lines)).toEqual(['1']);
  });

  test('throws when the files do not line up', () => {
    expect(() => importCalibrated(emptyAnchors(), def, { lines: [edited.lines[0]] }, { level: 'line' })).toThrow(/must match line for line/);
    const wrongWords = { lines: [{ ...edited.lines[0], words: [edited.lines[0]!.words[0]] }, edited.lines[1]] };
    expect(() => importCalibrated(emptyAnchors(), def, wrongWords, { level: 'line' })).toThrow(/1 words/);
    const missingSyl = { lines: [{ ...edited.lines[0], words: [{ start: 1, end: 2 }, edited.lines[0]!.words[1]] }, edited.lines[1]] };
    expect(() => importCalibrated(emptyAnchors(), def, missingSyl, { level: 'syllable' })).toThrow(/syllable timings/);
  });

  test('summarizes anchored, partial and free lines', () => {
    const a = emptyAnchors();
    setLineBounds(a, def, 0, 1, 3);
    setBoundary(a, def, 1, 1, 4.5);
    expect(summarizeAnchors(a, def)).toEqual({ anchoredLines: 1, partialLines: 1, freeLines: 0, pinnedBoundaries: 3 });
  });
});
