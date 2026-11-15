// packages/lyricsync/tests/unit/move-line.test.ts
import { describe, expect, test } from 'bun:test';
import type { CalibrationDoc, CalLine } from '../../src/calibration-doc.ts';
import { moveLine } from '../../web/src/lib/doc-edit.ts';

/** A line of one-syllable words at the given syllable times. */
const line = (i: number, syl: Array<[number, number]>, calibrated = false): CalLine => ({
  i,
  text: syl.map((_, k) => `w${k}`).join(' '),
  start: syl[0]![0],
  end: syl[syl.length - 1]![1],
  ...(calibrated ? { calibrated: true } : {}),
  words: syl.map((s, k) => ({ w: `w${k}`, start: s[0], end: s[1], syl: [s], sylText: [`w${k}`], ...(calibrated ? { calibrated: true, sylCalibrated: [true] } : {}) })),
});

describe('moveLine (drag a whole line)', () => {
  test('shifts every syllable, pins only the first and last, and stays between the neighbouring lines', () => {
    const doc: CalibrationDoc = {
      sections: [],
      lines: [line(0, [[0, 1]]), line(1, [[2, 2.5], [2.5, 3], [3, 4]], true), line(2, [[10, 11]])],
    };
    moveLine(doc, 1, 5);
    const l = doc.lines[1]!;
    expect(l.words.map((w) => w.syl[0])).toEqual([[5, 5.5], [5.5, 6], [6, 7]]);
    expect([l.start, l.end, l.calibrated]).toEqual([5, 7, false]);
    expect(l.words.map((w) => w.sylCalibrated)).toEqual([[true], [false], [true]]);

    moveLine(doc, 1, 9.5); // would end at 11.5, past line 2's start (10)
    expect([doc.lines[1]!.start, doc.lines[1]!.end]).toEqual([8, 10]);
    moveLine(doc, 1, 0); // would start before line 0's end (1)
    expect([doc.lines[1]!.start, doc.lines[1]!.end]).toEqual([1, 3]);
  });
});
