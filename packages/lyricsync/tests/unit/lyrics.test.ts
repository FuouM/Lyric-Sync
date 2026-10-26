// packages/lyricsync/tests/unit/lyrics.test.ts
import { describe, expect, test } from 'bun:test';
import { lintLyricsText, lyricsSectionOutline, parseLyricsJson, parseLyricsText } from '../../src/lyrics/parse.ts';
import { syllabifyEnglish, syllabifyJapanese } from '../../src/lyrics/syllabify.ts';
import { dictionaryG2P } from '../../src/lyrics/dictionary.ts';

describe('syllabifyEnglish', () => {
  test('keeps one-vowel words whole', () => {
    expect(syllabifyEnglish('walls', ['ao'])).toEqual(['walls']);
  });

  test('starts the next syllable with a single consonant (maximal onset) and keeps valid onset clusters together', () => {
    expect(syllabifyEnglish('never', ['eh', 'er'])).toEqual(['ne', 'ver']);
    expect(syllabifyEnglish('despair', ['ih', 'eh'])).toEqual(['de', 'spair']);
    expect(syllabifyEnglish('disfigured', ['ih', 'ih', 'er'])).toEqual(['dis', 'fi', 'gured']);
  });

  test('splits doubled consonants between the letters', () => {
    expect(syllabifyEnglish('mirror', ['ih', 'er'])).toEqual(['mir', 'ror']);
  });

  test('splits hiatus vowel pairs only when the pronunciation demands it', () => {
    expect(syllabifyEnglish('reconciliation', ['iy', 'aa', 'ih', 'iy', 'ey', 'ah'])).toEqual(['re', 'con', 'ci', 'li', 'a', 'tion']);
    expect(syllabifyEnglish('nation', ['ey', 'ah'])).toEqual(['na', 'tion']);
  });

  test('drops a silent final e instead of counting it as a syllable', () => {
    expect(syllabifyEnglish('fake', ['ey'])).toEqual(['fake']);
    expect(syllabifyEnglish('remake', ['iy', 'ey'])).toEqual(['re', 'make']);
  });

  test('keeps surrounding punctuation on the first and last syllable', () => {
    expect(syllabifyEnglish('(moment)', ['ow', 'ah'])).toEqual(['(mo', 'ment)']);
  });

  test('refuses an impossible syllable count instead of guessing', () => {
    expect(() => syllabifyEnglish('cat', ['ae', 'ah', 'ih'])).toThrow(/explicit syllables/);
  });
});

describe('syllabifyJapanese', () => {
  test('splits romaji into dictionary morae', () => {
    expect(syllabifyJapanese('koyoi')).toEqual(['ko', 'yo', 'i']);
    expect(syllabifyJapanese('fukinukeru')).toEqual(['fu', 'ki', 'nu', 'ke', 'ru']);
  });

  test('rejects characters that are not morae', () => {
    expect(() => syllabifyJapanese('kxa')).toThrow(/Cannot split/);
  });
});

describe('dictionary G2P (strict)', () => {
  test('throws for a word with no pronunciation instead of dropping it', () => {
    expect(() => dictionaryG2P('en').g2pWords([{ w: 'hello' }, { w: 'zzxqv' }])).toThrow(/zzxqv/);
  });

  test('explicit phones replace the dictionary lookup', () => {
    const r = dictionaryG2P('en').g2pWords([{ w: 'zzxqv', phones: ['z', 'ae', 'k'] }]);
    expect(r.phSeq).toEqual(['SP', 'en/z', 'en/ae', 'en/k', 'SP']);
    expect(r.phIdxToWordIdx).toEqual([-1, 0, 0, 0, -1]);
  });
});

describe('parseLyricsText', () => {
  const text = [
    '# demo',
    '[verse 1]',
    'i looking at the walls',
    '',
    're|con|cil|i|a|tion (i) mirror',
  ].join('\n');

  test('parses sections, explicit syllables and auto-split words', () => {
    const { definition, autoSplit } = parseLyricsText(text, 'en');
    expect(definition.lines.length).toBe(2);
    expect(definition.lines[0]!.section).toBe('verse 1');
    expect(definition.lines[0]!.words.map((w) => w.w)).toEqual(['i', 'looking', 'at', 'the', 'walls']);
    expect(definition.lines[1]!.words[0]!.syllables).toEqual(['re', 'con', 'cil', 'i', 'a', 'tion']);
    expect(definition.lines[1]!.words[1]!.syllables).toEqual(['(i)']);
    expect(autoSplit.map((a) => a.word)).toEqual(['looking', 'mirror']);
  });

  test('explicit English syllables may be respelled and are kept verbatim', () => {
    const { definition, autoSplit } = parseLyricsJson({ lines: [{ words: [{ w: 'fading', syllables: ['fay', 'ding'] }] }] }, 'en');
    expect(definition.lines[0]!.words[0]!.syllables).toEqual(['fay', 'ding']);
    expect(autoSplit).toEqual([]);
  });

  test('unknown words are an error that names the word', () => {
    expect(() => parseLyricsText('hello zzxqv', 'en')).toThrow(/zzxqv/);
  });

  test('japanese explicit syllables must be single morae matching the pronunciation', () => {
    const { definition } = parseLyricsText('koyoi kaze', 'ja');
    expect(definition.lines[0]!.words.map((w) => w.syllables)).toEqual([['ko', 'yo', 'i'], ['ka', 'ze']]);
    expect(() => parseLyricsText('ko|yoi', 'ja')).toThrow(/not a single mora/);
  });

  test('the auto split written out with pipes is valid, also where a doubled consonant is a closure mora', () => {
    const piped = parseLyricsText('ko|n|ni|chi|wa wa|ka|re|p|po|i', 'ja').definition;
    expect(piped.lines[0]!.words.map((w) => w.syllables)).toEqual([['ko', 'n', 'ni', 'chi', 'wa'], ['wa', 'ka', 're', 'p', 'po', 'i']]);
    expect(() => parseLyricsText('kon|ni|chi|wa', 'ja')).toThrow(/not a single mora/);
  });

  test('japanese "+" gives the same syllables as "|" and only records the join', () => {
    const joined = parseLyricsText('ko+n|ni|chi|wa nii ni+i', 'ja');
    const piped = parseLyricsText('ko|n|ni|chi|wa nii ni|i', 'ja');
    expect(joined.definition).toEqual(piped.definition);
    expect(joined.sylJoin).toEqual([[[true, false, false, false], null, [true]]]);
    expect(piped.sylJoin).toEqual([[null, null, null]]);
  });

  test('"+" is not a syllable separator in English', () => {
    expect(() => parseLyricsText('re+con+cile', 'en')).toThrow(/re\+con\+cile/);
  });

  test('sylJoin in lyrics JSON needs explicit syllables and one flag per gap', () => {
    const lyric = (word: object) => ({ language: 'ja', lines: [{ text: 'kon', words: [word] }] });
    expect(parseLyricsJson(lyric({ w: 'kon', syllables: ['ko', 'n'], sylJoin: [true] }), 'ja').sylJoin).toEqual([[[true]]]);
    expect(() => parseLyricsJson(lyric({ w: 'kon', syllables: ['ko', 'n'], sylJoin: [true, false] }), 'ja')).toThrow(/sylJoin/);
    expect(() => parseLyricsJson(lyric({ w: 'kon', sylJoin: [true] }), 'ja')).toThrow(/sylJoin/);
  });
});

describe('lyrics text extras', () => {
  test('the section outline keeps headers without lines (instrumental sections)', () => {
    const text = '[intro]\n[verse]\nhello world\nhello again\n[interlude]\n[chorus]\nsing\n[outro]\n';
    expect(lyricsSectionOutline(text)).toEqual([
      { name: 'intro', lines: 0 },
      { name: 'verse', lines: 2 },
      { name: 'interlude', lines: 0 },
      { name: 'chorus', lines: 1 },
      { name: 'outro', lines: 0 },
    ]);
  });

  test('lint reports every unknown word, and a pronunciation resolves it', () => {
    const text = 'hello zzxqv\nqqvvz world zzxqv';
    const issues = lintLyricsText(text, 'en');
    expect(issues.map((i) => [i.line, i.word, i.unknown])).toEqual([
      [0, 'zzxqv', true],
      [1, 'qqvvz', true],
      [1, 'zzxqv', true],
    ]);
    const pron = { zzxqv: ['z', 'ae', 'k'], qqvvz: ['k', 'uw'] };
    expect(lintLyricsText(text, 'en', pron)).toEqual([]);
    expect(parseLyricsText(text, 'en', pron).definition.lines[1]!.words[0]!.phones).toEqual(['k', 'uw']);
  });
});

describe('parseLyricsJson', () => {
  test('accepts strings, objects and explicit phones', () => {
    const { definition } = parseLyricsJson(
      { language: 'en', lines: ['hello world', { section: 'x', words: ['hello', { w: 'zzxqv', phones: ['z', 'ae', 'k'] }] }] },
      'en',
    );
    expect(definition.lines[1]!.section).toBe('x');
    expect(definition.lines[1]!.words[1]!.phones).toEqual(['z', 'ae', 'k']);
  });

  test('rejects a language mismatch', () => {
    expect(() => parseLyricsJson({ language: 'ja', lines: ['x'] }, 'en')).toThrow(/language/);
  });

  test('rejects a malformed document', () => {
    expect(() => parseLyricsJson({ lines: [{ text: 'no words' }] }, 'en')).toThrow(/words/);
  });
});
