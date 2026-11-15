// packages/lyricsync/tests/unit/match-in-order.test.ts
import { describe, expect, test } from 'bun:test';
import { carriedWords, matchInOrder, pairEditedLines } from '../../web/server/syllables.ts';

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
