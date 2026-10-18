// src/workspace/anchors.ts
// Anchors are the timings a human (or an upstream tool) already knows. The solver pins them exactly and decodes everything else around them.
//   boundary j of a line = start of its j-th syllable (flat index over the line's words); boundary m (= syllable count) = line end.
//   `start` is boundary 0, `end` is boundary m, `boundaries` holds the interior ones (1..m-1).
// A line with BOTH start and end anchored is solved in "anchored" mode (higher accuracy); every other line is solved "free" around its pins.

import * as fs from 'node:fs';
import { isNumber, isRecord } from '../guards.ts';
import type { Anchors, LineAnchor, LyricLine, LyricsDefinition } from '../types.ts';

const MIN_GAP_SEC = 0.001;

export function emptyAnchors(): Anchors {
  return { version: 1, lines: {} };
}

export function syllableCount(line: LyricLine): number {
  return line.words.reduce((n, w) => n + w.syllables.length, 0);
}

export function loadAnchors(file: string): Anchors {
  if (!fs.existsSync(file)) throw new Error(`Anchors file not found: ${file} (created by "lyricsync init").`);
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.lines)) throw new Error(`Malformed anchors file (expected {"version":1,"lines":{...}}): ${file}`);
  const lines: Record<string, LineAnchor> = {};
  for (const [key, value] of Object.entries(raw.lines)) {
    if (!isRecord(value)) throw new Error(`Anchors for line ${key} must be an object.`);
    const anchor: LineAnchor = {};
    if (value.start !== undefined) {
      if (!isNumber(value.start)) throw new Error(`Anchors line ${key}: start must be a number.`);
      anchor.start = value.start;
    }
    if (value.end !== undefined) {
      if (!isNumber(value.end)) throw new Error(`Anchors line ${key}: end must be a number.`);
      anchor.end = value.end;
    }
    if (value.boundaries !== undefined) {
      if (!isRecord(value.boundaries)) throw new Error(`Anchors line ${key}: boundaries must be an object.`);
      const boundaries: Record<string, number> = {};
      for (const [j, t] of Object.entries(value.boundaries)) {
        if (!isNumber(t)) throw new Error(`Anchors line ${key}: boundary ${j} must be a number.`);
        boundaries[j] = t;
      }
      anchor.boundaries = boundaries;
    }
    lines[key] = anchor;
  }
  return { version: 1, lines };
}

export function saveAnchors(file: string, anchors: Anchors): void {
  fs.writeFileSync(file, `${JSON.stringify(anchors, null, 2)}\n`, 'utf8');
}

/** Pinned (boundary index -> time) of one line, in boundary order. */
export function pinsOf(anchor: LineAnchor, syllables: number): Array<[number, number]> {
  const pins: Array<[number, number]> = [];
  if (anchor.start !== undefined) pins.push([0, anchor.start]);
  for (const [j, t] of Object.entries(anchor.boundaries ?? {})) pins.push([Number(j), t]);
  if (anchor.end !== undefined) pins.push([syllables, anchor.end]);
  return pins.sort((a, b) => a[0] - b[0]);
}

/**
 * Re-indexes one line's pins after the word whose syllables start at boundary `from` goes from `oldCount` to `newCount` syllables:
 * pins inside the word are dropped, later ones shift. The word's own outer edges keep their pins.
 */
export function resplitLineAnchor(anchor: LineAnchor, from: number, oldCount: number, newCount: number): void {
  if (!anchor.boundaries) return;
  const kept: Record<string, number> = {};
  for (const [key, t] of Object.entries(anchor.boundaries)) {
    const j = Number(key);
    if (j <= from) kept[key] = t;
    else if (j >= from + oldCount) kept[String(j + newCount - oldCount)] = t;
  }
  if (Object.keys(kept).length > 0) anchor.boundaries = kept;
  else delete anchor.boundaries;
}

/** Throws a precise error when the anchors cannot describe the definition. */
export function validateAnchors(anchors: Anchors, def: LyricsDefinition): void {
  for (const [key, anchor] of Object.entries(anchors.lines)) {
    const index = Number(key);
    const line = def.lines[index];
    if (!Number.isInteger(index) || !line) throw new Error(`Anchors reference line ${key}, but the lyrics have ${def.lines.length} lines (0..${def.lines.length - 1}).`);
    const m = syllableCount(line);
    for (const j of Object.keys(anchor.boundaries ?? {})) {
      const n = Number(j);
      if (!Number.isInteger(n) || n < 1 || n > m - 1) {
        throw new Error(`Line ${index} ("${line.text}") has ${m} syllables: interior boundary ${j} is outside 1..${m - 1} (use start/end for boundary 0 and ${m}).`);
      }
    }
    const pins = pinsOf(anchor, m);
    for (let i = 1; i < pins.length; i++) {
      if (pins[i]![1] - pins[i - 1]![1] < MIN_GAP_SEC) {
        throw new Error(`Line ${index}: pinned boundary ${pins[i - 1]![0]} (${pins[i - 1]![1]} s) must be earlier than boundary ${pins[i]![0]} (${pins[i]![1]} s).`);
      }
    }
  }
}

/** True when both line edges are pinned (the line is solved in anchored mode). */
export function isLineAnchored(anchor: LineAnchor | undefined): boolean {
  return anchor !== undefined && anchor.start !== undefined && anchor.end !== undefined;
}

export function setBoundary(anchors: Anchors, def: LyricsDefinition, line: number, boundary: number, time: number): void {
  const lyric = def.lines[line];
  if (!lyric) throw new Error(`No line ${line} (the lyrics have ${def.lines.length} lines).`);
  const m = syllableCount(lyric);
  if (!Number.isInteger(boundary) || boundary < 0 || boundary > m) throw new Error(`Line ${line} has ${m} syllables: boundary must be 0..${m}.`);
  if (!Number.isFinite(time) || time < 0) throw new Error(`Invalid time ${time}.`);
  const key = String(line);
  const anchor = (anchors.lines[key] ??= {});
  if (boundary === 0) anchor.start = time;
  else if (boundary === m) anchor.end = time;
  else (anchor.boundaries ??= {})[String(boundary)] = time;
}

export function setLineBounds(anchors: Anchors, def: LyricsDefinition, line: number, start: number, end: number): void {
  const lyric = def.lines[line];
  if (!lyric) throw new Error(`No line ${line} (the lyrics have ${def.lines.length} lines).`);
  setBoundary(anchors, def, line, 0, start);
  setBoundary(anchors, def, line, syllableCount(lyric), end);
}

/** Removes the anchors of one line, or of every line when `line` is undefined. Returns the number of lines cleared. */
export function clearAnchors(anchors: Anchors, line?: number): number {
  if (line === undefined) {
    const n = Object.keys(anchors.lines).length;
    anchors.lines = {};
    return n;
  }
  const had = anchors.lines[String(line)] !== undefined;
  delete anchors.lines[String(line)];
  return had ? 1 : 0;
}

export type ImportLevel = 'line' | 'word' | 'syllable' | 'flagged';

export interface ImportOptions {
  level: ImportLevel;
  /** Only import these definition line indices (default: all mapped lines). */
  lines?: number[];
  /** Definition lines that have no counterpart in the imported file (e.g. a sung line the annotator left out). */
  skipDefinitionLines?: number[];
}

export interface ImportSummary {
  linesTouched: number;
  boundariesPinned: number;
}

interface ImportedWord {
  start?: number;
  end?: number;
  syl?: Array<[number, number]>;
  sylCalibrated?: boolean[];
  calibrated?: boolean;
}

interface ImportedLine {
  start?: number;
  end?: number;
  calibrated?: boolean;
  words: ImportedWord[];
}

function readImportedLines(raw: unknown): ImportedLine[] {
  if (!isRecord(raw) || !Array.isArray(raw.lines)) throw new Error('The imported file must be a lyrics.json-style object with a "lines" array.');
  return raw.lines.map((l: unknown, i: number): ImportedLine => {
    if (!isRecord(l) || !Array.isArray(l.words)) throw new Error(`Imported line ${i} has no "words" array.`);
    const words = l.words.map((w: unknown, wi: number): ImportedWord => {
      if (!isRecord(w)) throw new Error(`Imported line ${i} word ${wi} is not an object.`);
      const word: ImportedWord = {};
      if (isNumber(w.start)) word.start = w.start;
      if (isNumber(w.end)) word.end = w.end;
      if (Array.isArray(w.syl)) {
        word.syl = w.syl.map((p: unknown): [number, number] => {
          if (!Array.isArray(p) || !isNumber(p[0]) || !isNumber(p[1])) throw new Error(`Imported line ${i} word ${wi} has a malformed syl pair.`);
          return [p[0], p[1]];
        });
      }
      if (Array.isArray(w.sylCalibrated)) word.sylCalibrated = w.sylCalibrated.map((c: unknown) => c === true);
      if (w.calibrated === true) word.calibrated = true;
      return word;
    });
    const line: ImportedLine = { words };
    if (isNumber(l.start)) line.start = l.start;
    if (isNumber(l.end)) line.end = l.end;
    if (l.calibrated === true) line.calibrated = true;
    return line;
  });
}

/**
 * Pins boundaries from an existing timing document (a hand-corrected lyrics.json, or one saved by the lyrics editor with its
 * calibration flags). Levels: `line` pins start/end; `word` also pins every word start; `syllable` every syllable boundary;
 * `flagged` only the edges of syllables the editor marked calibrated (sylCalibrated / calibrated flags).
 * The imported document must have the same lines/words/syllables as the lyrics (apart from `skipDefinitionLines`); anything else throws.
 */
export function importCalibrated(anchors: Anchors, def: LyricsDefinition, raw: unknown, options: ImportOptions): ImportSummary {
  const imported = readImportedLines(raw);
  const skip = options.skipDefinitionLines ?? [];
  const mapped = def.lines.map((l) => l.index).filter((i) => !skip.includes(i));
  if (mapped.length !== imported.length) {
    throw new Error(`The imported file has ${imported.length} lines but the lyrics have ${def.lines.length} (${skip.length} skipped): they must match line for line.`);
  }
  const only = options.lines;
  let linesTouched = 0;
  let boundariesPinned = 0;
  imported.forEach((src, k) => {
    const index = mapped[k]!;
    if (only && !only.includes(index)) return;
    const lyric = def.lines[index]!;
    if (src.words.length !== lyric.words.length) {
      throw new Error(`Imported line ${k} has ${src.words.length} words but lyric line ${index} ("${lyric.text}") has ${lyric.words.length}.`);
    }
    const before = boundariesPinned;
    const pin = (boundary: number, time: number | undefined): void => {
      if (time === undefined) return;
      setBoundary(anchors, def, index, boundary, time);
      boundariesPinned++;
    };
    const m = syllableCount(lyric);
    const lineStart = src.start ?? src.words[0]?.start;
    const lineEnd = src.end ?? src.words[src.words.length - 1]?.end;
    if (options.level === 'line') {
      if (lineStart === undefined || lineEnd === undefined) throw new Error(`Imported line ${k} has no start/end.`);
      pin(0, lineStart);
      pin(m, lineEnd);
    } else if (options.level === 'word') {
      let flat = 0;
      lyric.words.forEach((w, wi) => {
        pin(flat, src.words[wi]!.start ?? src.words[wi]!.syl?.[0]?.[0]);
        flat += w.syllables.length;
      });
      pin(m, lineEnd);
    } else {
      let flat = 0;
      lyric.words.forEach((w, wi) => {
        const iw = src.words[wi]!;
        const n = w.syllables.length;
        const syl = iw.syl ?? (n === 1 && iw.start !== undefined && iw.end !== undefined ? [[iw.start, iw.end] as [number, number]] : undefined);
        if (!syl || syl.length !== n) {
          throw new Error(`Imported line ${k} word ${wi} ("${w.w}") has ${iw.syl?.length ?? 0} syllable timings but the lyrics have ${n}.`);
        }
        for (let s = 0; s < n; s++) {
          const calibrated = options.level === 'syllable' || (iw.sylCalibrated && iw.sylCalibrated.length === n ? iw.sylCalibrated[s] === true : iw.calibrated === true || src.calibrated === true);
          if (!calibrated) continue;
          pin(flat + s, syl[s]![0]);
          pin(flat + s + 1, syl[s]![1]);
        }
        flat += n;
      });
    }
    if (boundariesPinned > before) linesTouched++;
  });
  validateAnchors(anchors, def);
  return { linesTouched, boundariesPinned };
}

export interface AnchorSummary {
  anchoredLines: number;
  partialLines: number;
  freeLines: number;
  pinnedBoundaries: number;
}

export function summarizeAnchors(anchors: Anchors, def: LyricsDefinition): AnchorSummary {
  let anchoredLines = 0;
  let partialLines = 0;
  let pinnedBoundaries = 0;
  for (const line of def.lines) {
    const anchor = anchors.lines[String(line.index)];
    if (!anchor) continue;
    const pins = pinsOf(anchor, syllableCount(line)).length;
    if (pins === 0) continue;
    pinnedBoundaries += pins;
    if (isLineAnchored(anchor)) anchoredLines++;
    else partialLines++;
  }
  return { anchoredLines, partialLines, freeLines: def.lines.length - anchoredLines - partialLines, pinnedBoundaries };
}
