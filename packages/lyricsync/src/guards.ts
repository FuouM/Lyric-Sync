// src/guards.ts
// The package's single set of runtime type guards, used where untrusted JSON (lyrics, anchors, workspace files) enters.

import type { ConsensusLine, LineReview, SlicedAlignment } from './types.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string');
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isConsensusLine(value: unknown): value is ConsensusLine {
  return isRecord(value) && isNumber(value.start) && isNumber(value.end) && Array.isArray(value.words);
}

/** Guards a cached per-line alignment read back from the workspace. */
export function isSlicedAlignment(value: unknown): value is SlicedAlignment {
  return isRecord(value) && isConsensusLine(value.base) && (value.combined === null || isConsensusLine(value.combined));
}

export function isLineReview(value: unknown): value is LineReview {
  if (!isRecord(value) || !isNumber(value.line) || !isNumber(value.meanExpectedErrorMs) || !Array.isArray(value.uncertain)) return false;
  if (value.mode !== 'anchored' && value.mode !== 'free') return false;
  return value.uncertain.every(
    (b: unknown) => isRecord(b) && isNumber(b.boundary) && isNumber(b.time) && isNumber(b.expectedErrorMs) && typeof b.anchored === 'boolean' && typeof b.syllable === 'string',
  );
}
