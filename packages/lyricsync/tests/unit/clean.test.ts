// packages/lyricsync/tests/unit/clean.test.ts
import { describe, expect, test } from 'bun:test';
import { normalizeBracedPhones, stripPunctuation } from '../../src/lyrics/clean.ts';

describe('stripPunctuation', () => {
  test('trims surrounding punctuation from both ends', () => {
    expect(stripPunctuation('...hello...')).toBe('hello');
    expect(stripPunctuation('"!hello?!"')).toBe('hello');
    expect(stripPunctuation('([hello])')).toBe('hello');
    expect(stripPunctuation('{hello}')).toBe('hello');
    expect(stripPunctuation(':;hello:;')).toBe('hello');
  });

  test('keeps internal punctuation and hyphens untouched', () => {
    expect(stripPunctuation('don\'t')).toBe('don\'t');
    expect(stripPunctuation('rock-and-roll')).toBe('rock-and-roll');
    expect(stripPunctuation('a.b.c')).toBe('a.b.c');
  });

  test('handles strings with only punctuation or empty strings', () => {
    expect(stripPunctuation('.,?!:;"\'()[]{}')).toBe('');
    expect(stripPunctuation('!!!!!!')).toBe('');
    expect(stripPunctuation('')).toBe('');
    expect(stripPunctuation('word')).toBe('word');
  });

  test('executes in linear time without ReDoS on long repeated punctuation', () => {
    const longPunct = '!'.repeat(100_000) + 'test' + '?'.repeat(100_000);
    const t0 = performance.now();
    const result = stripPunctuation(longPunct);
    const elapsedMs = performance.now() - t0;
    expect(result).toBe('test');
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe('normalizeBracedPhones', () => {
  test('removes space between words and inline braced phones', () => {
    expect(normalizeBracedPhones('foom {f uw m}')).toBe('foom{f uw m}');
    expect(normalizeBracedPhones('foom {f uw m} bar {b aa r}')).toBe('foom{f uw m} bar{b aa r}');
    expect(normalizeBracedPhones('word{a} {b}')).toBe('word{a}{b}');
    expect(normalizeBracedPhones('foom{f uw m}')).toBe('foom{f uw m}');
  });

  test('preserves spacing between words and ignores unclosed braces', () => {
    expect(normalizeBracedPhones('la la la la')).toBe('la la la la');
    expect(normalizeBracedPhones('word {unclosed')).toBe('word {unclosed');
    expect(normalizeBracedPhones('{phones}')).toBe('{phones}');
  });

  test('executes in linear time without ReDoS on pathological inputs', () => {
    const pathological = '! {{|'.repeat(20_000);
    const t0 = performance.now();
    const result = normalizeBracedPhones(pathological);
    const elapsedMs = performance.now() - t0;
    expect(result).toBe(pathological);
    expect(elapsedMs).toBeLessThan(100);
  });
});
