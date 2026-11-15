// packages/lyricsync/tests/unit/scan.test.ts
import { describe, expect, test } from 'bun:test';
import { lintLyricsText, parseLyricsText } from '../../src/lyrics/parse.ts';
import { scanLyricLines } from '../../src/lyrics/scan.ts';

describe('scanLyricLines', () => {
  test('its lines and word offsets are the words the parser reads, punctuation, spaced phones and CRLF included', () => {
    const text = [
      '[Chorus 1]',
      'I am falling, I am fa|ding',
      '@pron foom = f uw m',
      '# comment',
      "don't foom {f uw m} now",
    ].join('\r\n');
    const parsed = parseLyricsText(text, 'en');
    const lines = scanLyricLines(text);

    expect(lines.map((l) => l.index)).toEqual(parsed.definition.lines.map((l) => l.index));
    lines.forEach((l, i) => {
      expect(l.tokens.map((t) => text.slice(t.from, t.from + t.word.length).replace(/\|/g, ''))).toEqual(parsed.definition.lines[i]!.words.map((w) => w.w));
    });

    const falling = parsed.autoSplit.find((a) => a.word === 'falling,')!;
    const tok = lines[falling.line]!.tokens.find((t) => t.word === falling.word)!;
    expect(text.slice(tok.from, tok.to)).toBe('falling,');

    const foom = lines[1]!.tokens[1]!;
    expect(text.slice(foom.from, foom.to)).toBe('foom {f uw m}');
    expect(foom.phones).toBe('f uw m');
    expect(text.slice(foom.phonesFrom, foom.to)).toBe('{f uw m}');
  });

  test('an `@pron` line without `=` is a sung line for the parser, so it counts in the line numbers of the words after it', () => {
    const text = '@pron no equals sign\nzzqx';
    const issue = lintLyricsText(text, 'en').find((i) => i.word === 'zzqx')!;
    expect(scanLyricLines(text)[issue.line]!.tokens.map((t) => t.word)).toEqual(['zzqx']);
  });
});
