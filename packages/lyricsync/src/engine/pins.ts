// src/engine/pins.ts
// Per-line boundary pinning and validation.
// Maps boundary indices [0..m] to syllable starts/ends and validates anchor constraints.

import type { ConsensusLine } from './consensus.ts';
import type { LineAnchor, Anchors, SlicedAlignment } from '../types.ts';

export interface LinePins {
  lineIndex: number;
  syllableCount: number;
  pins: Array<number | undefined>;
  isAnchored: boolean;
}

export function countLineSyllables(line: ConsensusLine): number {
  let count = 0;
  for (const w of line.words) {
    count += w.syl && w.syl.length > 0 ? w.syl.length : 1;
  }
  return count;
}

interface SyllableLocation {
  wordIdx: number;
  sylIdx: number;
}

function getSyllableMap(line: ConsensusLine): SyllableLocation[] {
  const map: SyllableLocation[] = [];
  for (let wi = 0; wi < line.words.length; wi++) {
    const w = line.words[wi]!;
    if (!w.syl || w.syl.length === 0) {
      w.syl = [[w.start, w.end]];
    }
    for (let si = 0; si < w.syl.length; si++) {
      map.push({ wordIdx: wi, sylIdx: si });
    }
  }
  return map;
}

/**
 * Validates anchors against the song definition and extracts per-line pins.
 * Throws precise errors for:
 *   - Anchors referencing a line index >= number of lines
 *   - Boundary index outside 0..m
 *   - Pinned times not strictly increasing within a line
 *   - Anchored line lacking sliced[i]
 */
export function extractAndValidatePins(
  lines: ConsensusLine[],
  anchors: Anchors,
  sliced?: Record<number, SlicedAlignment>
): LinePins[] {
  const numLines = lines.length;

  for (const key of Object.keys(anchors.lines)) {
    const li = Number(key);
    if (!Number.isInteger(li) || li < 0 || li >= numLines) {
      throw new Error(`Anchor references invalid line index "${key}"; song has ${numLines} lines (valid line indices: 0..${numLines - 1})`);
    }
  }

  const result: LinePins[] = [];

  for (let li = 0; li < numLines; li++) {
    const line = lines[li]!;
    const m = countLineSyllables(line);
    const pins: Array<number | undefined> = new Array(m + 1).fill(undefined);
    const anchor: LineAnchor | undefined = anchors.lines[String(li)];

    if (anchor) {
      if (anchor.start !== undefined) {
        pins[0] = anchor.start;
      }
      if (anchor.end !== undefined) {
        pins[m] = anchor.end;
      }

      if (anchor.boundaries) {
        for (const [bKey, time] of Object.entries(anchor.boundaries)) {
          const bj = Number(bKey);
          if (!Number.isInteger(bj) || bj < 0 || bj > m) {
            throw new Error(`Anchor for line ${li} references boundary index "${bKey}"; line has ${m} syllables (valid boundary indices: 0..${m})`);
          }
          if (pins[bj] !== undefined && Math.abs(pins[bj]! - time) > 1e-9) {
            throw new Error(`Conflicting pin times for line ${li}, boundary ${bj}: ${pins[bj]} vs ${time}`);
          }
          pins[bj] = time;
        }
      }

      const defined: Array<{ bIdx: number; t: number }> = [];
      for (let j = 0; j <= m; j++) {
        if (pins[j] !== undefined) {
          defined.push({ bIdx: j, t: pins[j]! });
        }
      }

      for (let k = 1; k < defined.length; k++) {
        const prev = defined[k - 1]!;
        const curr = defined[k]!;
        if (curr.t <= prev.t) {
          throw new Error(`Pinned times for line ${li} not strictly increasing: boundary ${prev.bIdx} at ${prev.t}s >= boundary ${curr.bIdx} at ${curr.t}s`);
        }
      }
    }

    const isAnchored = pins[0] !== undefined && pins[m] !== undefined;

    if (isAnchored) {
      const sliceEntry = sliced?.[li];
      if (!sliceEntry || !sliceEntry.base) {
        throw new Error(`Line ${li} is anchored (both start and end are pinned) but sliced alignment input.sliced[${li}] is missing`);
      }
    }

    result.push({
      lineIndex: li,
      syllableCount: m,
      pins,
      isAnchored,
    });
  }

  return result;
}

/**
 * Mutates `line` so all pinned boundaries are written into word and syllable timings.
 * Boundary 0 pins line start, word[0] start, syl[0][0].
 * Boundary m pins line end, word[last] end, syl[last][1].
 * Boundary j (0 < j < m) pins syl[j-1][1] and syl[j][0].
 */
export function pinLineBoundaries(line: ConsensusLine, pins: Array<number | undefined>): void {
  const sylMap = getSyllableMap(line);
  const m = sylMap.length;

  if (pins.length !== m + 1) {
    throw new Error(`Pins length mismatch: line has ${m} syllables (${m + 1} boundaries) but pins array has ${pins.length}`);
  }

  const touched: Record<number, true> = {};
  for (let j = 0; j <= m; j++) {
    const t = pins[j];
    if (t === undefined) continue;

    if (j === 0) {
      line.start = t;
      const firstSyl = sylMap[0];
      if (firstSyl) {
        line.words[firstSyl.wordIdx]!.syl![firstSyl.sylIdx]![0] = t;
        touched[firstSyl.wordIdx] = true;
      }
    } else if (j === m) {
      line.end = t;
      const lastSyl = sylMap[m - 1];
      if (lastSyl) {
        line.words[lastSyl.wordIdx]!.syl![lastSyl.sylIdx]![1] = t;
        touched[lastSyl.wordIdx] = true;
      }
    } else {
      const prevSyl = sylMap[j - 1]!;
      const nextSyl = sylMap[j]!;
      line.words[prevSyl.wordIdx]!.syl![prevSyl.sylIdx]![1] = t;
      line.words[nextSyl.wordIdx]!.syl![nextSyl.sylIdx]![0] = t;
      touched[prevSyl.wordIdx] = true;
      touched[nextSyl.wordIdx] = true;
    }
  }

  // Word extents follow their syllables, but only for words a pin touched (other words keep the alignment's own values).
  for (const key of Object.keys(touched)) {
    const w = line.words[Number(key)]!;
    w.start = w.syl![0]![0];
    w.end = w.syl![w.syl!.length - 1]![1];
  }
}
