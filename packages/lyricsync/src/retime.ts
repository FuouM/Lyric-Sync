// src/retime.ts
// `lyricsync retime`: add one constant to every time of the calibration files (sections, lines, words, syllables).
// Pins, text and flags stay as they are. generated/ and the cache are not touched.
import * as fs from 'node:fs';
import { parseCalibrationDoc, type CalibrationDoc } from './calibration-doc.ts';
import { calibrationTargets, type TargetSelector } from './calibration-files.ts';

/** Times in the files have at most six decimals. */
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** A copy of `doc` with `by` seconds added to every time. Throws when a time would be below 0. Other fields stay as they are. */
export function retimeDoc(doc: CalibrationDoc, by: number): CalibrationDoc {
  if (!Number.isFinite(by)) throw new Error(`retime: --by must be a finite number of seconds, got ${by}.`);
  const out = structuredClone(doc);
  const shift = (x: number, what: string): number => {
    const y = round6(x + by);
    if (y < 0) throw new Error(`retime: ${what} (${x} s) would move to ${y} s, below 0. Use a larger --by.`);
    return y;
  };
  for (const s of out.sections) {
    s.start = shift(s.start, `section "${s.name}" start`);
    s.end = shift(s.end, `section "${s.name}" end`);
  }
  for (const l of out.lines) {
    const at = `line ${l.i}`;
    l.start = shift(l.start, `${at} start`);
    l.end = shift(l.end, `${at} end`);
    for (const w of l.words) {
      w.start = shift(w.start, `${at} word "${w.w}" start`);
      w.end = shift(w.end, `${at} word "${w.w}" end`);
      w.syl = w.syl.map(([a, b]): [number, number] => [shift(a, `${at} word "${w.w}" syllable start`), shift(b, `${at} word "${w.w}" syllable end`)]);
    }
  }
  return out;
}

export interface RetimeResult {
  singer: string;
  file: string;
  lines: number;
}

/**
 * Shifts the calibration files `sel` names by `by` seconds and writes them back (2-space JSON, as the editor writes them).
 * Every file is read and shifted before the first one is written, so an error leaves all files as they were.
 */
export function retimeSong(dir: string, by: number, sel: TargetSelector = {}): RetimeResult[] {
  const planned = calibrationTargets(dir, sel).map((t) => {
    const doc = parseCalibrationDoc(JSON.parse(fs.readFileSync(t.file, 'utf8')) as unknown);
    return { ...t, doc: retimeDoc(doc, by) };
  });
  for (const p of planned) fs.writeFileSync(p.file, `${JSON.stringify(p.doc, null, 2)}\n`, 'utf8');
  return planned.map((p) => ({ singer: p.singer, file: p.file, lines: p.doc.lines.length }));
}
