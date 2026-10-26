// src/calibration-doc.ts
// user_input/lyrics.calibrated.json: the project "words" lyrics format plus the human pin flags.
// A line flagged `calibrated` is frozen (every syllable pinned); otherwise a syllable is pinned when its word is flagged
// `calibrated` or its `sylCalibrated` entry is true. Missing flags mean "not pinned": the solver may move those syllables.
// Unknown fields (format, fps, method, conf, sourceFile, ...) are kept as read and written back unchanged.
// No Node or Bun imports: the editor's browser code uses this module too.
import { isNumber, isRecord, isStringArray } from "./guards.ts";

export interface CalSection {
  id: string;
  name: string;
  start: number;
  end: number;
}

export interface CalWord {
  w: string;
  start: number;
  end: number;
  syl: Array<[number, number]>;
  sylText: string[];
  sylCalibrated?: boolean[];
  /** Japanese: gap i is true when syllables i and i+1 are shown as one unit ("ko+n"). Display only; the timing stays per syllable. */
  sylJoin?: boolean[];
  calibrated?: boolean;
  [key: string]: unknown;
}

export interface CalLine {
  i: number;
  text: string;
  start: number;
  end: number;
  calibrated?: boolean;
  words: CalWord[];
  [key: string]: unknown;
}

export interface CalibrationDoc {
  sections: CalSection[];
  lines: CalLine[];
  [key: string]: unknown;
}

/** True when syllable `si` of `word` in `line` is pinned. */
export function isSylPinned(line: CalLine, word: CalWord, si: number): boolean {
  return line.calibrated === true || word.calibrated === true || word.sylCalibrated?.[si] === true;
}

const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isNumber(v[0]) && isNumber(v[1]);
const isOptionalFlag = (v: unknown) => v === undefined || typeof v === "boolean";

/** Validates user_input/lyrics.calibrated.json content and returns it typed. */
export function parseCalibrationDoc(raw: unknown): CalibrationDoc {
  const where = "user_input/lyrics.calibrated.json";
  if (!isRecord(raw) || !Array.isArray(raw.sections) || !Array.isArray(raw.lines)) {
    throw new Error(`${where}: expected an object with "sections" and "lines" arrays.`);
  }
  raw.sections.forEach((s: unknown, k: number) => {
    if (!isRecord(s) || typeof s.id !== "string" || typeof s.name !== "string" || !isNumber(s.start) || !isNumber(s.end)) {
      throw new Error(`${where}: section ${k} needs id, name, start and end.`);
    }
  });
  raw.lines.forEach((l: unknown, k: number) => {
    if (!isRecord(l) || !isNumber(l.i) || typeof l.text !== "string" || !isNumber(l.start) || !isNumber(l.end) || !Array.isArray(l.words) || !isOptionalFlag(l.calibrated)) {
      throw new Error(`${where}: line ${k} needs i, text, start, end and words.`);
    }
    l.words.forEach((w: unknown, wi: number) => {
      const ok =
        isRecord(w) &&
        typeof w.w === "string" &&
        isNumber(w.start) &&
        isNumber(w.end) &&
        Array.isArray(w.syl) &&
        w.syl.length > 0 &&
        w.syl.every(isPair) &&
        isStringArray(w.sylText) &&
        w.sylText.length === w.syl.length &&
        isOptionalFlag(w.calibrated) &&
        (w.sylCalibrated === undefined ||
          (Array.isArray(w.sylCalibrated) && w.sylCalibrated.length === w.syl.length && w.sylCalibrated.every((f: unknown) => typeof f === "boolean"))) &&
        (w.sylJoin === undefined || (Array.isArray(w.sylJoin) && w.sylJoin.length === w.syl.length - 1 && w.sylJoin.every((f: unknown) => typeof f === "boolean")));
      if (!ok) throw new Error(`${where}: line ${k} word ${wi} needs w, start, end and equally long syl / sylText (/ sylCalibrated) arrays (sylJoin: one flag per gap).`);
    });
  });
  // Every field the editor reads was checked above.
  const doc: CalibrationDoc = raw as CalibrationDoc;
  return doc;
}
