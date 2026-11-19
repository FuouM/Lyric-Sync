// packages/lyricsync/tests/unit/match-in-order.test.ts
import { describe, expect, test } from 'bun:test';
import { carriedWords, carrySections, matchInOrder, pairEditedLines, type CalSection } from '../../web/server/syllables.ts';

describe('matchInOrder (lyrics edit keeps each line its own pins)', () => {
  test('a repeated chorus line pairs with its own copy, also after a line is split in two before it', () => {
    const oldLines = ['feel a thing', 'I am falling, I am fading', 'lost it all', 'feel a thing', 'I am falling,', 'lost it all', 'I am falling,'];
    const newLines = ['feel a thing', 'I am falling,', 'I am fading', 'lost it all', 'feel a thing', 'I am falling,', 'lost it all', 'I am falling,'];
    expect(matchInOrder(newLines, oldLines, (a, b) => a === b)).toEqual([0, null, null, 2, 3, 4, 5, 6]);
  });

  test('a line edited in place pairs with its old line; a split line does not', () => {
    // old: A B C D, new: A B' C D (B edited) -> B' pairs with B
    expect(pairEditedLines([0, null, 2, 3], 4)).toEqual([null, 1, null, null]);
    // old: A BC D, new: A B C D (BC split in two) -> nothing to pair
    expect(pairEditedLines([0, null, null, 2], 3)).toEqual([null, null, null, null]);
  });
});

describe('carriedWords (an edited line keeps the pins of its unchanged words)', () => {
  test('a word added in the middle of repeated words keeps both line edges', () => {
    expect(carriedWords(['ah', 'ah', 'ah'], ['ah', 'ah'])).toEqual({ words: [0, null, 1], prefix: 1, suffix: 1 });
  });

  test('a changed word keeps the words around it; a removed word leaves its neighbours paired', () => {
    expect(carriedWords(['I', 'am', 'fading,'], ['I', 'am', 'falling,'])).toEqual({ words: [0, 1, null], prefix: 2, suffix: 0 });
    expect(carriedWords(['help', 'breathe'], ['help', 'me', 'breathe'])).toEqual({ words: [0, 2], prefix: 1, suffix: 1 });
  });
});

describe('carrySections (Edit Lyrics keeps the sections set in the editor)', () => {
  // igaku: Intro and Interlude were added in the editor (no header), Verse 1 moved to 12.9 s.
  const old: CalSection[] = [
    { id: 'intro', name: 'Intro', start: 0, end: 12.9 },
    { id: 'v1', name: 'Verse 1', start: 12.9, end: 35.64 },
    { id: 'c1', name: 'Chorus 1', start: 35.64, end: 69.5 },
    { id: 'inter', name: 'Interlude', start: 69.5, end: 80.8 },
    { id: 'v2', name: 'Verse 2', start: 80.8, end: 120 },
  ];
  const headers = ['Verse 1', 'Chorus 1', 'Verse 2'];
  const fresh = (names: string[], starts: number[]): CalSection[] => names.map((name, k) => ({ id: `f${k}`, name, start: starts[k]!, end: starts[k + 1] ?? 120 }));

  test('unchanged headers keep every section and its times, also the ones without a header', () => {
    expect(carrySections(old, headers, headers, fresh(headers, [0, 35.6, 80.8]), 120)).toEqual(old);
  });

  test('a renamed header renames its section in place; a removed one gives its time to the section before', () => {
    const renamed = carrySections(old, headers, ['Verse 1', 'Chorus', 'Verse 2'], fresh(['Verse 1', 'Chorus', 'Verse 2'], [0, 35.6, 80.8]), 120);
    expect(renamed.map((s) => [s.name, s.start, s.end])).toEqual([
      ['Intro', 0, 12.9],
      ['Verse 1', 12.9, 35.64],
      ['Chorus', 35.64, 69.5],
      ['Interlude', 69.5, 80.8],
      ['Verse 2', 80.8, 120],
    ]);
    const removed = carrySections(old, headers, ['Verse 1', 'Verse 2'], fresh(['Verse 1', 'Verse 2'], [0, 80.8]), 120);
    expect(removed.map((s) => [s.name, s.start, s.end])).toEqual([
      ['Intro', 0, 12.9],
      ['Verse 1', 12.9, 69.5],
      ['Interlude', 69.5, 80.8],
      ['Verse 2', 80.8, 120],
    ]);
  });

  test('an added header splits the section its first line falls in', () => {
    const next = ['Verse 1', 'Pre-Chorus', 'Chorus 1', 'Verse 2'];
    const out = carrySections(old, headers, next, fresh(next, [0, 30, 35.6, 80.8]), 120);
    expect(out.map((s) => [s.name, s.start, s.end])).toEqual([
      ['Intro', 0, 12.9],
      ['Verse 1', 12.9, 30],
      ['Pre-Chorus', 30, 35.64],
      ['Chorus 1', 35.64, 69.5],
      ['Interlude', 69.5, 80.8],
      ['Verse 2', 80.8, 120],
    ]);
  });

  test('a timing without sections takes the ones from the headers', () => {
    const f = fresh(headers, [0, 35.6, 80.8]);
    expect(carrySections([], [], headers, f, 120)).toEqual(f);
  });
});
