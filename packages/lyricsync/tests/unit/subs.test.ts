// packages/lyricsync/tests/unit/subs.test.ts
import { describe, expect, test } from 'bun:test';
import { buildCues, toAss, toSrt, toTtml, toYtt, type Cue, type CueLine } from '../../src/formats/subs.ts';

const cue = (start: number, end: number, text: string, role?: string): Cue => ({ start, end, rows: [[{ text, state: 'sung' }]], role });

describe('time formatting', () => {
  test('a time that rounds up to the next minute carries over', () => {
    const cs = [cue(59.9995, 61.0004, 'a')];
    expect(toSrt(cs)).toContain('00:01:00,000 --> 00:01:01,000');
    expect(toTtml(cs, 'en')).toContain('begin="00:01:00.000" end="00:01:01.000"');
    expect(toAss(cs)).toContain('Dialogue: 0,0:01:00.00,0:01:01.00,');
    expect(toYtt(cs)).toContain('t="60000" d="1000"');
  });
});

describe('escaping', () => {
  const text = 'a{b}\\N<&>"';
  const cs = [cue(0, 1, text)];
  test('ASS: braces and backslashes cannot start a tag or a line break', () => {
    const line = toAss(cs).split('\n').find((l) => l.startsWith('Dialogue'))!;
    const body = line.split(',,').at(-1)!.replace('{\\c&H4AD8FF&}', '');
    expect(body).toBe('a\\{b\\}\\\u200BN<&>"');
    expect(body).not.toContain('\\N');
  });
  test('TTML and YTT: XML special characters are escaped', () => {
    expect(toTtml(cs, 'en')).toContain('a{b}\\N&lt;&amp;&gt;&quot;');
    expect(toYtt(cs)).toContain('a{b}\\N&lt;&amp;&gt;&quot;');
  });
  test('SRT: markup characters are escaped', () => {
    expect(toSrt(cs)).toContain('a{b}\\N&lt;&amp;&gt;"');
  });
});

describe('roles', () => {
  const lead = cue(0, 4, 'lead', 'te');
  const counter = cue(2, 3, 'counter', 'ca');
  test('ASS: one style per role, overlapping cues allowed, the second role sits higher', () => {
    const ass = toAss([lead, counter]);
    const margin = (name: string): number => Number(ass.split('\n').find((l) => l.startsWith(`Style: ${name},`))!.split(',').at(-2));
    expect(margin('ca')).toBeGreaterThan(margin('te'));
    expect(ass).toMatch(/Dialogue: 0,0:00:00.00,0:00:04.00,te,/);
    expect(ass).toMatch(/Dialogue: 0,0:00:02.00,0:00:03.00,ca,/);
  });
  test('ASS: style names that only differ after cleaning are an error', () => {
    expect(() => toAss([cue(0, 1, 'a', 'x,y'), cue(0, 1, 'b', 'x_y')])).toThrow('not unique');
  });
  test('YTT: one window position per role, higher for the second role', () => {
    const ytt = toYtt([lead, counter]);
    const av = (id: number): number => Number(new RegExp(`<wp id="${id}"[^>]* av="(\\d+)"`).exec(ytt)![1]);
    expect(av(2)).toBeLessThan(av(1));
    expect(ytt).toContain('wp="2"');
  });
});

describe('buildCues', () => {
  const line: CueLine = { start: 10, end: 12, joiner: ' ', tokens: [['re', 10, 10.5], ['con', 10.5, 11, true], ['cil', 11, 12, true], ['now', 12, 12.01]] };
  test('syllables of a word are glued and lit one at a time; a space stays outside a colour', () => {
    const cs = buildCues([[line]], { lead: 0.25, tail: 0.7 });
    const texts = cs.map((c) => c.rows[0]!.map((r) => `${r.state[0]}:${r.text}`).join('|'));
    expect(texts[0]).toBe('p:reconcil now');
    expect(cs.every((c, i) => i === 0 || c.start === cs[i - 1]!.end)).toBe(true);
    expect(cs.some((c) => c.rows[0]!.some((r) => r.text === 'con' && r.state === 'sung'))).toBe(true);
  });
  test('the role goes on every cue', () => {
    expect(buildCues([[line]], { lead: 0.25, tail: 0.7, role: 'ca' }).every((c) => c.role === 'ca')).toBe(true);
  });
});
