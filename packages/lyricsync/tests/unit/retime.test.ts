// packages/lyricsync/tests/unit/retime.test.ts
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { retimeDoc, retimeSong } from '../../src/retime.ts';
import { exportSubs } from '../../src/subs-song.ts';
import type { CalibrationDoc } from '../../src/calibration-doc.ts';

const doc = (): CalibrationDoc => ({
  format: 'words',
  fps: 60,
  sections: [{ id: 's', name: 'Intro', start: 0, end: 1.1 }],
  lines: [
    {
      i: 0,
      text: 'ko n',
      start: 1.1,
      end: 2.2,
      calibrated: true,
      words: [{ w: 'kon', start: 1.1, end: 2.2, syl: [[1.1, 1.5], [1.5, 2.2]], sylText: ['ko', 'n'], sylCalibrated: [true, false], conf: 0.5 }],
    },
  ],
});

/** A temp song folder with a lead file and a singer "ca". */
function makeSong(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retime-')), 'demo');
  const input = path.join(dir, 'user_input');
  fs.mkdirSync(input, { recursive: true });
  fs.writeFileSync(path.join(input, 'singers.json'), JSON.stringify({ v: 1, singers: [{ id: 'te', voiceDir: 'a', lead: true }, { id: 'ca', voiceDir: 'b' }] }));
  fs.writeFileSync(path.join(input, 'lyrics.calibrated.json'), `${JSON.stringify(doc(), null, 2)}\n`);
  fs.writeFileSync(path.join(input, 'lyrics.calibrated.ca.json'), `${JSON.stringify(doc(), null, 2)}\n`);
  return dir;
}

const read = (dir: string, f: string): CalibrationDoc => JSON.parse(fs.readFileSync(path.join(dir, 'user_input', f), 'utf8')) as CalibrationDoc;

describe('retimeDoc', () => {
  test('shifts every time and keeps pins, text, flags and unknown fields', () => {
    const out = retimeDoc(doc(), 0.1);
    expect(out.sections[0]).toEqual({ id: 's', name: 'Intro', start: 0.1, end: 1.2 });
    const l = out.lines[0]!;
    expect([l.start, l.end]).toEqual([1.2, 2.3]);
    expect(l.words[0]!.syl).toEqual([[1.2, 1.6], [1.6, 2.3]]);
    expect(l.words[0]!.sylCalibrated).toEqual([true, false]);
    expect(l.words[0]!.conf).toBe(0.5);
    expect(l.calibrated).toBe(true);
    expect(l.text).toBe('ko n');
  });
  test('does not change its input and round trips without float noise', () => {
    const d = doc();
    expect(retimeDoc(retimeDoc(d, 0.7), -0.7)).toEqual(doc());
    expect(d).toEqual(doc());
  });
  test('refuses a shift below 0', () => {
    expect(() => retimeDoc(doc(), -0.1)).toThrow('below 0');
  });
});

describe('retimeSong', () => {
  test('shifts the lead by default, one singer with singer, all with all; leaves generated/ alone', () => {
    const dir = makeSong();
    fs.mkdirSync(path.join(dir, 'generated'));
    fs.writeFileSync(path.join(dir, 'generated', 'timing.ai.json'), '{"keep":1}');
    retimeSong(dir, 1);
    expect(read(dir, 'lyrics.calibrated.json').lines[0]!.start).toBe(2.1);
    expect(read(dir, 'lyrics.calibrated.ca.json').lines[0]!.start).toBe(1.1);
    retimeSong(dir, 1, { singer: 'ca' });
    expect(read(dir, 'lyrics.calibrated.ca.json').lines[0]!.start).toBe(2.1);
    retimeSong(dir, 1, { all: true });
    expect(read(dir, 'lyrics.calibrated.json').lines[0]!.start).toBe(3.1);
    expect(read(dir, 'lyrics.calibrated.ca.json').lines[0]!.start).toBe(3.1);
    expect(fs.readFileSync(path.join(dir, 'generated', 'timing.ai.json'), 'utf8')).toBe('{"keep":1}');
  });
  test('an error writes nothing', () => {
    const dir = makeSong();
    const before = fs.readFileSync(path.join(dir, 'user_input', 'lyrics.calibrated.json'), 'utf8');
    expect(() => retimeSong(dir, -1.1, { all: true })).toThrow('below 0');
    expect(fs.readFileSync(path.join(dir, 'user_input', 'lyrics.calibrated.json'), 'utf8')).toBe(before);
  });
  test('an unknown singer is an error', () => {
    expect(() => retimeSong(makeSong(), 1, { singer: 'zz' })).toThrow('not in');
  });
});

describe('exportSubs', () => {
  test('writes one file per singer and a combined ASS and YTT with both singers, outside the song folder', () => {
    const dir = makeSong();
    const out = path.join(path.dirname(dir), 'out');
    const files = exportSubs(dir, { formats: ['ass', 'ytt', 'srt'], out, all: true });
    expect(files.map((f) => path.basename(f.file)).sort()).toEqual(['demo.all.ass', 'demo.all.ytt', 'demo.ca.ass', 'demo.ca.srt', 'demo.ca.ytt', 'demo.te.ass', 'demo.te.srt', 'demo.te.ytt']);
    const all = fs.readFileSync(path.join(out, 'demo.all.ass'), 'utf8');
    expect(all).toContain('Style: te,');
    expect(all).toContain('Style: ca,');
    expect(fs.readdirSync(path.join(dir, 'user_input')).length).toBe(3);
  });
});
