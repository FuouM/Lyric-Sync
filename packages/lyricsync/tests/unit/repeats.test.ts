// packages/lyricsync/tests/unit/repeats.test.ts
import { describe, expect, test } from 'bun:test';
import { parseLyricsText } from '../../src/lyrics/parse.ts';
import { applyPattern, findRepeatSuggestions } from '../../src/lyrics/repeats.ts';

const slice = (text: string, t: { from: number; to: number }) => text.slice(t.from, t.to);

describe('findRepeatSuggestions', () => {
  test('a marked word offers its markup to every unmarked copy, across lines, sections and comments', () => {
    const text = ['[Verse]', '# a comment', 'ko+n|ni|chi|wa sekai', '', 'Konnichiwa, konnichiwa na'].join('\n');
    const [s, ...rest] = findRepeatSuggestions(text, 'ja');
    expect(rest).toEqual([]);
    expect(s!.word).toBe('konnichiwa');
    expect(s!.pattern).toBe('ko+n|ni|chi|wa');
    expect(s!.targets.map((t) => [t.line, slice(text, t)])).toEqual([[1, 'Konnichiwa'], [1, 'konnichiwa']]);
    expect(s!.targets.map((t) => text.slice(t.tokenFrom, t.tokenFrom + 3))).toEqual(['Kon', 'kon']);
  });

  test('applyPattern keeps the letters of the copy and takes the separators of the pattern', () => {
    expect(applyPattern('ko+n|ni|chi|wa', 'KonNichiwa')).toBe('Ko+n|Ni|chi|wa');
  });

  test('a word marked two different ways has no suggestion', () => {
    expect(findRepeatSuggestions('ko+n|ni|chi|wa\nko|n|ni|chi|wa\nkonnichiwa', 'ja')).toEqual([]);
  });

  test('a copy the automatic split already gives the same syllables is left out; a join is never a no-op', () => {
    const piped = 'ko|n|ni|chi|wa konnichiwa';
    expect(findRepeatSuggestions(piped, 'ja')).toHaveLength(1);
    expect(findRepeatSuggestions(piped, 'ja', parseLyricsText(piped, 'ja').autoSplit)).toEqual([]);
    const joined = 'ko+n|ni|chi|wa konnichiwa';
    expect(findRepeatSuggestions(joined, 'ja', parseLyricsText(joined, 'ja').autoSplit)).toHaveLength(1);
  });

  test('"+" is no separator in English; "|" markup is offered', () => {
    expect(findRepeatSuggestions('re+con re+con', 'en')).toEqual([]);
    const [s] = findRepeatSuggestions('re|con|cile line\nreconcile', 'en');
    expect(s!.pattern).toBe('re|con|cile');
    expect(s!.targets).toHaveLength(1);
  });

  test('copies with phone braces or inner punctuation are not touched', () => {
    expect(findRepeatSuggestions('re|con|cile reconcile{r iy k ax n s ay l}\nre|con|cile re"con"cile', 'en')).toEqual([]);
  });
});
