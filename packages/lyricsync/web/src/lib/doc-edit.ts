// packages/lyricsync/web/src/lib/doc-edit.ts
// Pure edit operations and musical-time helpers for the lyrics timing editor.
import { isSylPinned, type CalibrationDoc, type CalLine } from "./calibration-doc";

export interface SylRef {
  lineIdx: number;
  wordIdx: number;
  sylIdx: number;
}

/** Minimum syllable duration kept by boundary edits (seconds). */
export const MIN_SYL_SEC = 0.02;
/** Two edges closer than this are one shared edit point (rolled together). */
const SHARED_EDGE_SEC = 0.0015;

export const sameSyl = (a: SylRef | null | undefined, b: SylRef | null | undefined): boolean =>
  !!a && !!b && a.lineIdx === b.lineIdx && a.wordIdx === b.wordIdx && a.sylIdx === b.sylIdx;

/** All syllables in document order. */
export function flattenSyllables(doc: CalibrationDoc): SylRef[] {
  const out: SylRef[] = [];
  doc.lines.forEach((line, lineIdx) => {
    line.words.forEach((word, wordIdx) => {
      word.syl.forEach((_, sylIdx) => out.push({ lineIdx, wordIdx, sylIdx }));
    });
  });
  return out;
}

export function sylPair(doc: CalibrationDoc, ref: SylRef): [number, number] | undefined {
  return doc.lines[ref.lineIdx]?.words[ref.wordIdx]?.syl[ref.sylIdx];
}

/**
 * Apply `change` to the per-syllable pin state of one line, then write the flags back in the file's terms:
 * word `calibrated` when all its syllables are pinned, line `calibrated` (frozen) when all words are. Spans follow the syllables.
 */
function updateLine(line: CalLine, change: (pins: boolean[][]) => void): void {
  const pins = line.words.map((w) => w.syl.map((_, si) => isSylPinned(line, w, si)));
  change(pins);
  line.words.forEach((w, wi) => {
    w.sylCalibrated = pins[wi]!;
    w.calibrated = pins[wi]!.every(Boolean);
    w.start = w.syl[0]![0];
    w.end = w.syl[w.syl.length - 1]![1];
  });
  line.calibrated = line.words.every((w) => w.calibrated);
  line.start = line.words[0]!.start;
  line.end = line.words[line.words.length - 1]!.end;
}

/**
 * The syllable whose edge touches `ref`'s `edge` inside the same line: a roll edit moves both. Syllables of different lines
 * never roll together, so a gap can open between lines.
 */
export function rollPartner(doc: CalibrationDoc, ref: SylRef, edge: "start" | "end"): SylRef | null {
  const flat = flattenSyllables(doc);
  const idx = flat.findIndex((r) => sameSyl(r, ref));
  const pair = sylPair(doc, ref);
  const nRef = edge === "start" ? flat[idx - 1] : flat[idx + 1];
  const n = nRef ? sylPair(doc, nRef) : undefined;
  if (!pair || !nRef || !n || nRef.lineIdx !== ref.lineIdx) return null;
  const touching = Math.abs((edge === "start" ? n[1] : n[0]) - (edge === "start" ? pair[0] : pair[1])) < SHARED_EDGE_SEC;
  return touching ? nRef : null;
}

/**
 * Move one syllable edge to `time`; the edge never crosses the neighbouring syllable. With a roll `partner` (see rollPartner,
 * decided when the drag starts) the partner's touching edge moves along. The moved syllables become pinned.
 */
export function moveEdge(doc: CalibrationDoc, ref: SylRef, edge: "start" | "end", time: number, partner: SylRef | null): void {
  const flat = flattenSyllables(doc);
  const idx = flat.findIndex((r) => sameSyl(r, ref));
  const pair = sylPair(doc, ref);
  if (idx < 0 || !pair) return;

  const neighbourRef = edge === "start" ? flat[idx - 1] : flat[idx + 1];
  const neighbour = neighbourRef ? sylPair(doc, neighbourRef) : undefined;
  const rolls = partner !== null && neighbourRef !== undefined && sameSyl(partner, neighbourRef);

  let lo: number;
  let hi: number;
  if (edge === "start") {
    hi = pair[1] - MIN_SYL_SEC;
    lo = neighbour ? (rolls ? neighbour[0] + MIN_SYL_SEC : neighbour[1]) : 0;
  } else {
    lo = pair[0] + MIN_SYL_SEC;
    hi = neighbour ? (rolls ? neighbour[1] - MIN_SYL_SEC : neighbour[0]) : Number.POSITIVE_INFINITY;
  }
  const t = Number(Math.min(hi, Math.max(lo, time)).toFixed(3));

  if (edge === "start") pair[0] = t;
  else pair[1] = t;
  setPinned(doc, ref, true);

  if (rolls && neighbour && neighbourRef) {
    if (edge === "start") neighbour[1] = t;
    else neighbour[0] = t;
    setPinned(doc, neighbourRef, true);
  }
}

export function setPinned(doc: CalibrationDoc, ref: SylRef, pinned: boolean): void {
  const line = doc.lines[ref.lineIdx];
  if (!line?.words[ref.wordIdx]) return;
  updateLine(line, (pins) => {
    pins[ref.wordIdx]![ref.sylIdx] = pinned;
  });
}

export function setLinePinned(doc: CalibrationDoc, lineIdx: number, pinned: boolean): void {
  const line = doc.lines[lineIdx];
  if (!line) return;
  updateLine(line, (pins) => pins.forEach((p) => p.fill(pinned)));
}

/** Pin the first syllable and the last syllable of a line, so the solver treats both line edges as known. */
export function pinLineEdges(doc: CalibrationDoc, lineIdx: number): void {
  const line = doc.lines[lineIdx];
  if (!line || line.words.length === 0) return;
  updateLine(line, (pins) => {
    pins[0]![0] = true;
    const last = pins[pins.length - 1]!;
    last[last.length - 1] = true;
  });
}

/**
 * Moves the auto-timed parts of `doc` from one solve result (`from`) to another (`to`): the same Auto-time with the other "snap to
 * beats" setting. Pinned syllables never move. An unpinned syllable moves only while it still has `from`'s time, so one moved by hand
 * since the solve stays; word and line spans follow the same rule. Returns the number of syllables whose time changed.
 */
export function switchSolvedTimes(doc: CalibrationDoc, from: readonly CalLine[], to: readonly CalLine[]): number {
  const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];
  let moved = 0;
  doc.lines.forEach((line, li) => {
    const f = from[li];
    const t = to[li];
    if (!f || !t || line.calibrated === true || f.words.length !== line.words.length || t.words.length !== line.words.length) return;
    line.words.forEach((word, wi) => {
      const fw = f.words[wi]!;
      const tw = t.words[wi]!;
      if (word.calibrated === true || fw.syl.length !== word.syl.length || tw.syl.length !== word.syl.length) return;
      word.syl.forEach((pair, si) => {
        if (isSylPinned(line, word, si) || !same(pair, fw.syl[si]!)) return;
        if (!same(pair, tw.syl[si]!)) moved++;
        word.syl[si] = [tw.syl[si]![0], tw.syl[si]![1]];
      });
      if (same([word.start, word.end], [fw.start, fw.end])) {
        word.start = tw.start;
        word.end = tw.end;
      }
    });
    if (same([line.start, line.end], [f.start, f.end])) {
      line.start = t.start;
      line.end = t.end;
    }
  });
  return moved;
}

/** "re|con|cile" -> its syllables; throws a message for the user when a syllable is empty or has spaces. */
export function parseSplit(text: string): string[] {
  const parts = text.trim().split("|").map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) throw new Error("Every syllable needs at least one letter (no empty parts between |).");
  if (parts.some((p) => /\s/.test(p))) throw new Error("Syllables cannot contain spaces; separate them with |.");
  return parts;
}

/**
 * Gives a word new syllables. With the same count only the texts change. Otherwise the word's span is divided evenly over
 * the new syllables and the word is unpinned (its old pins belong to the old split); the rest of the line keeps its pins.
 */
export function resplitWord(doc: CalibrationDoc, lineIdx: number, wordIdx: number, parts: string[]): void {
  const line = doc.lines[lineIdx];
  const word = line?.words[wordIdx];
  if (!line || !word) return;
  if (parts.length === word.syl.length) {
    word.sylText = [...parts];
    return;
  }
  updateLine(line, (pins) => {
    const n = parts.length;
    const edges = parts.map((_, k) => (k === 0 ? word.start : Number((word.start + ((word.end - word.start) * k) / n).toFixed(3))));
    word.syl = edges.map((e, k): [number, number] => [e, edges[k + 1] ?? word.end]);
    word.sylText = [...parts];
    pins[wordIdx] = parts.map(() => false);
  });
}

/** Split the section under `time` (or append one) so a new section starts at `time`. */
export function addSectionAt(doc: CalibrationDoc, time: number, songEnd: number): number {
  const t = Number(time.toFixed(3));
  const sections = doc.sections;
  const containing = sections.findIndex((s) => t > s.start && t < s.end);
  const id = `sec_${Date.now().toString(36)}`;
  if (containing >= 0) {
    const sec = sections[containing]!;
    sections.splice(containing + 1, 0, { id, name: `Section ${sections.length + 1}`, start: t, end: sec.end });
    sec.end = t;
    return containing + 1;
  }
  const next = sections.findIndex((s) => s.start >= t);
  const end = next >= 0 ? sections[next]!.start : Math.max(t + 1, songEnd);
  const insertAt = next >= 0 ? next : sections.length;
  sections.splice(insertAt, 0, { id, name: `Section ${sections.length + 1}`, start: t, end });
  return insertAt;
}

/** Move the start of section `si`; the previous section's end follows (sections tile the song). */
export function moveSectionStart(doc: CalibrationDoc, si: number, time: number): void {
  const sec = doc.sections[si];
  if (!sec) return;
  const prev = doc.sections[si - 1];
  const lo = prev ? prev.start + 0.1 : 0;
  const hi = sec.end - 0.1;
  const t = Number(Math.min(hi, Math.max(lo, time)).toFixed(3));
  sec.start = t;
  if (prev) prev.end = t;
}

export function removeSection(doc: CalibrationDoc, si: number): void {
  const sec = doc.sections[si];
  if (!sec) return;
  const prev = doc.sections[si - 1];
  if (prev) prev.end = sec.end;
  else if (doc.sections[si + 1]) doc.sections[si + 1]!.start = sec.start;
  doc.sections.splice(si, 1);
}

export function calibrationStats(doc: CalibrationDoc): { pinned: number; total: number; linesDone: number } {
  let pinned = 0;
  let total = 0;
  let linesDone = 0;
  for (const l of doc.lines) {
    if (l.calibrated) linesDone++;
    for (const w of l.words) {
      total += w.syl.length;
      for (let i = 0; i < w.syl.length; i++) if (isSylPinned(l, w, i)) pinned++;
    }
  }
  return { pinned, total, linesDone };
}

/** Index of the line under `t`, or the last line that started before `t`. */
export function lineAt(doc: CalibrationDoc, t: number): number {
  let found = -1;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.lines[i]!.start <= t) found = i;
    else break;
  }
  return found;
}

// ── Musical time ────────────────────────────────────────────────────────────

/** Last index i with sorted[i] <= t, or -1. */
export function floorIndex(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Bar and beat (1-based) at time t, from beat and downbeat grids. Bar 1 is downbeats[bar1Index]; pickup bars count 0, -1, … */
export function barBeatAt(
  t: number,
  beats: readonly number[] | undefined,
  downbeats: readonly number[] | undefined,
  bar1Index: number
): { bar: number; beat: number } | null {
  if (!beats || beats.length === 0 || !downbeats || downbeats.length === 0) return null;
  const di = floorIndex(downbeats, t);
  if (di < 0) return { bar: -bar1Index, beat: 0 };
  const bi = floorIndex(beats, t);
  const barBeat = floorIndex(beats, downbeats[di]! + 1e-4);
  return { bar: di + 1 - bar1Index, beat: Math.max(0, bi - barBeat) + 1 };
}

export function tempoBpm(beats?: readonly number[]): number | null {
  if (!beats || beats.length < 2) return null;
  const d: number[] = [];
  for (let i = 1; i < beats.length; i++) d.push(beats[i]! - beats[i - 1]!);
  d.sort((a, b) => a - b);
  const med = d[d.length >> 1]!;
  return med > 0 ? 60 / med : null;
}

/** Average tempo of the bar that contains t (its downbeat to the next one), or null outside a complete bar. */
export function barTempoBpm(t: number, beats?: readonly number[], downbeats?: readonly number[]): number | null {
  if (!beats || !downbeats) return null;
  const di = floorIndex(downbeats, t);
  if (di < 0 || di + 1 >= downbeats.length) return null;
  const b0 = floorIndex(beats, downbeats[di]! + 1e-4);
  const b1 = floorIndex(beats, downbeats[di + 1]! + 1e-4);
  if (b0 < 0 || b1 <= b0) return null;
  return (60 * (b1 - b0)) / (beats[b1]! - beats[b0]!);
}

/** mm:ss.mmm */
export function formatTimecode(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
}
