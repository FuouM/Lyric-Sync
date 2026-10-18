// packages/lyricsync/src/workspace/calibration.ts
// Calibrated lyrics document model (lyrics.calibrated.json).
// Human/agent calibration store containing line/word/syllable timings, calibration flags, and sections.
// Generated lyrics (out/lyrics.json) are kept strictly separate and overwritten on solve.
import type { ConsensusLine, ConsensusWord } from '../engine/consensus.ts';
import type { Anchors, LineAnchor, LyricsDefinition, LyricsJson } from '../types.ts';
import { syllableCount } from './anchors.ts';
import { isNumber, isRecord, isStringArray } from '../guards.ts';

export interface CalibratedSection {
  id: string;
  name: string;
  start: number;
  end: number;
}

export interface CalibratedWord {
  w: string;
  start: number;
  end: number;
  conf?: number;
  calibrated?: boolean;
  syl: Array<[number, number]>;
  sylText: string[];
  sylCalibrated: boolean[];
}

export interface CalibratedLine {
  i: number;
  text: string;
  start: number;
  end: number;
  calibrated?: boolean;
  words: CalibratedWord[];
}

export interface CalibratedLyricsDocument {
  version: 1;
  language: string;
  sections: CalibratedSection[];
  lines: CalibratedLine[];
}

function isSyllablePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isNumber(value[0]) && isNumber(value[1]);
}

/** `n` touching syllables that divide [start, end] evenly; the inner edges are rounded to the millisecond. */
export function divideSpan(start: number, end: number, n: number): Array<[number, number]> {
  const edges = Array.from({ length: n + 1 }, (_, k) => (k === 0 ? start : k === n ? end : Number((start + ((end - start) * k) / n).toFixed(3))));
  return edges.slice(1).map((e, k): [number, number] => [edges[k]!, e]);
}

function isCalibratedWord(value: unknown): value is CalibratedWord {
  return (
    isRecord(value) &&
    typeof value.w === 'string' &&
    isNumber(value.start) &&
    isNumber(value.end) &&
    Array.isArray(value.syl) &&
    value.syl.every(isSyllablePair) &&
    isStringArray(value.sylText) &&
    value.sylText.length === value.syl.length &&
    Array.isArray(value.sylCalibrated) &&
    value.sylCalibrated.length === value.syl.length &&
    value.sylCalibrated.every((f: unknown) => typeof f === 'boolean')
  );
}

/** Validates lyrics.calibrated.json content (hand- or tool-edited) and returns it typed. */
export function parseCalibratedDocument(raw: unknown): CalibratedLyricsDocument {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.language !== 'string' || !Array.isArray(raw.sections) || !Array.isArray(raw.lines)) {
    throw new Error('Malformed lyrics.calibrated.json: expected {"version":1,"language":...,"sections":[...],"lines":[...]}.');
  }
  raw.sections.forEach((s: unknown, i: number) => {
    if (!isRecord(s) || typeof s.id !== 'string' || typeof s.name !== 'string' || !isNumber(s.start) || !isNumber(s.end)) {
      throw new Error(`Malformed lyrics.calibrated.json: section ${i} needs id, name, start and end.`);
    }
  });
  raw.lines.forEach((l: unknown, i: number) => {
    if (!isRecord(l) || !isNumber(l.i) || typeof l.text !== 'string' || !isNumber(l.start) || !isNumber(l.end) || !Array.isArray(l.words)) {
      throw new Error(`Malformed lyrics.calibrated.json: line ${i} needs i, text, start, end and words.`);
    }
    l.words.forEach((w: unknown, wi: number) => {
      if (!isCalibratedWord(w)) {
        throw new Error(`Malformed lyrics.calibrated.json: line ${i} word ${wi} needs w, start, end and equally long syl/sylText/sylCalibrated arrays.`);
      }
    });
  });
  return raw as unknown as CalibratedLyricsDocument;
}

/**
 * Creates an initial empty calibrated document derived from definition and initial solved lines.
 */
export function createInitialCalibratedDocument(
  definition: LyricsDefinition,
  initialLines?: ConsensusLine[]
): CalibratedLyricsDocument {
  const lines: CalibratedLine[] = definition.lines.map((defLine, idx) => {
    const solved = initialLines?.[idx];
    let sylIdx = 0;
    const words: CalibratedWord[] = defLine.words.map((w, wIdx) => {
      const solvedWord = solved?.words[wIdx];
      const count = w.syllables.length;
      const syl: Array<[number, number]> = [];
      const sylText = [...w.syllables];
      const sylCalibrated = new Array<boolean>(count).fill(false);

      for (let k = 0; k < count; k++) {
        if (solvedWord?.syl?.[k]) {
          syl.push([solvedWord.syl[k]![0], solvedWord.syl[k]![1]]);
        } else {
          syl.push([0, 0]);
        }
      }

      return {
        w: w.w,
        start: solvedWord?.start ?? 0,
        end: solvedWord?.end ?? 0,
        conf: typeof solvedWord?.conf === 'number' ? solvedWord.conf : 0.5,
        calibrated: false,
        syl,
        sylText,
        sylCalibrated,
      };
    });

    return {
      i: defLine.index,
      text: defLine.text,
      start: solved?.start ?? 0,
      end: solved?.end ?? 0,
      calibrated: false,
      words,
    };
  });

  return {
    version: 1,
    language: definition.language,
    sections: [],
    lines,
  };
}

/**
 * Converts human/agent confirmed flags in CalibratedLyricsDocument into an Anchors structure
 * used by the guided/analytic/trained solver.
 * - If line.calibrated is true, all boundaries in the line are pinned.
 * - Otherwise, if sylCalibrated[k] is true, that syllable's start and end boundaries are pinned.
 */
export function calibratedToAnchors(doc: CalibratedLyricsDocument): Anchors {
  const lines: Record<string, LineAnchor> = {};

  for (const line of doc.lines) {
    const boundaries: Record<string, number> = {};
    let totalSyl = 0;
    for (const w of line.words) totalSyl += w.syl.length;

    let globalSylIdx = 0;
    let anyPinned = false;

    // Line edges
    let startPinned: number | undefined;
    let endPinned: number | undefined;

    if (line.calibrated) {
      startPinned = line.start;
      endPinned = line.end;
      anyPinned = true;
      for (const w of line.words) {
        for (let k = 0; k < w.syl.length; k++) {
          if (globalSylIdx > 0) {
            boundaries[String(globalSylIdx)] = w.syl[k]![0];
          }
          globalSylIdx++;
        }
      }
    } else {
      for (const w of line.words) {
        for (let k = 0; k < w.syl.length; k++) {
          if (w.sylCalibrated[k]) {
            anyPinned = true;
            if (globalSylIdx === 0) startPinned = w.syl[k]![0];
            else boundaries[String(globalSylIdx)] = w.syl[k]![0];

            if (globalSylIdx === totalSyl - 1) endPinned = w.syl[k]![1];
            else boundaries[String(globalSylIdx + 1)] = w.syl[k]![1];
          }
          globalSylIdx++;
        }
      }
    }

    if (anyPinned) {
      lines[String(line.i)] = {
        start: startPinned,
        end: endPinned,
        boundaries: Object.keys(boundaries).length > 0 ? boundaries : undefined,
      };
    }
  }

  return { version: 1, lines };
}

/**
 * Refreshes unconfirmed times in CalibratedLyricsDocument from fresh solver output.
 * Flags and confirmed syllable times are preserved untouched.
 */
export function updateCalibratedFromSolve(
  doc: CalibratedLyricsDocument,
  solvedLines: ConsensusLine[]
): void {
  for (let li = 0; li < doc.lines.length; li++) {
    const line = doc.lines[li]!;
    const solved = solvedLines[li];
    if (!solved) continue;

    if (!line.calibrated) {
      line.start = line.words[0]?.sylCalibrated[0] ? line.start : solved.start;
      line.end = line.words.at(-1)?.sylCalibrated.at(-1) ? line.end : solved.end;

      for (let wi = 0; wi < line.words.length; wi++) {
        const word = line.words[wi]!;
        const solvedWord = solved.words[wi];
        if (!solvedWord) continue;

        if (!word.calibrated) {
          word.start = word.sylCalibrated[0] ? word.start : solvedWord.start;
          word.end = word.sylCalibrated.at(-1) ? word.end : solvedWord.end;

          for (let si = 0; si < word.syl.length; si++) {
            if (!word.sylCalibrated[si] && solvedWord.syl?.[si]) {
              word.syl[si] = [solvedWord.syl[si]![0], solvedWord.syl[si]![1]];
            }
          }
        }
      }
    }
  }
}
