// packages/lyricsync/tests/unit/match-in-order.test.ts
import { describe, expect, test } from 'bun:test';
import { matchInOrder } from '../../web/server/syllables.ts';

describe('matchInOrder (lyrics edit keeps each line its own pins)', () => {
  test('a repeated chorus line pairs with its own copy, also after a line is split in two before it', () => {
    const oldLines = ['feel a thing', 'I am falling, I am fading', 'lost it all', 'feel a thing', 'I am falling,', 'lost it all', 'I am falling,'];
    const newLines = ['feel a thing', 'I am falling,', 'I am fading', 'lost it all', 'feel a thing', 'I am falling,', 'lost it all', 'I am falling,'];
    expect(matchInOrder(newLines, oldLines, (a, b) => a === b)).toEqual([0, null, null, 2, 3, 4, 5, 6]);
  });
});
