// packages/lyricsync/src/evidence/events.ts
// Pure TypeScript port of acoustic event detection and segment morphological operations.

import type { AcousticBreath, AcousticEdge } from '../types.ts';

export interface AcousticEvent {
  index: number;
  prob: number;
}

/**
 * Fill short gaps in a sequence of labelled binary samples.
 */
export function fillGaps(labels: Uint8Array, gapDur = 5): Uint8Array {
  const onsets: number[] = [];
  const offsets: number[] = [];

  for (let i = 0; i < labels.length - 1; i++) {
    const diff = (labels[i + 1] ?? 0) - (labels[i] ?? 0);
    if (diff === 1) onsets.push(i);
    else if (diff === -1) offsets.push(i);
  }

  let validOnsets = onsets;
  let validOffsets = offsets;
  if (validOnsets.length > 0 && validOffsets.length > 0) {
    const lastOffset = validOffsets[validOffsets.length - 1]!;
    const firstOnset = validOnsets[0]!;
    validOnsets = validOnsets.filter((on) => on < lastOffset);
    validOffsets = validOffsets.filter((off) => off > firstOnset);
  }

  if (validOnsets.length > 0 && validOffsets.length > 0 && validOnsets.length === validOffsets.length) {
    for (let idx = 1; idx < validOnsets.length; idx++) {
      const prevOff = validOffsets[idx - 1]!;
      const currOn = validOnsets[idx]!;
      if (prevOff > currOn - gapDur) {
        for (let j = prevOff; j <= currOn; j++) {
          labels[j] = 1;
        }
      }
    }
  }

  return labels;
}

/**
 * Remove short segments from a sequence of labelled binary samples.
 */
export function removeShort(labels: Uint8Array, minLen = 7): Uint8Array {
  const onsets: number[] = [];
  const offsets: number[] = [];

  for (let i = 0; i < labels.length - 1; i++) {
    const diff = (labels[i + 1] ?? 0) - (labels[i] ?? 0);
    if (diff === 1) onsets.push(i);
    else if (diff === -1) offsets.push(i);
  }

  let validOnsets = onsets;
  let validOffsets = offsets;
  if (validOnsets.length > 0 && validOffsets.length > 0) {
    const lastOffset = validOffsets[validOffsets.length - 1]!;
    const firstOnset = validOnsets[0]!;
    validOnsets = validOnsets.filter((on) => on < lastOffset);
    validOffsets = validOffsets.filter((off) => off > firstOnset);
  }

  if (validOnsets.length > 0 && validOffsets.length > 0 && validOnsets.length === validOffsets.length) {
    for (let idx = 0; idx < validOnsets.length; idx++) {
      const on = validOnsets[idx]!;
      const off = validOffsets[idx]!;
      const dur = off - on;
      if (dur < minLen) {
        for (let j = on; j <= off; j++) {
          labels[j] = 0;
        }
      }
    }
  }

  return labels;
}

/**
 * Detect event peak indices from a 1D probability curve.
 */
export function detectEventPeaks(prob: Float32Array, thres = 0.35, minDist = 4): AcousticEvent[] {
  const peaks: AcousticEvent[] = [];

  for (let i = 1; i < prob.length - 1; i++) {
    const cur = prob[i] ?? 0;
    const prev = prob[i - 1] ?? 0;
    const next = prob[i + 1] ?? 0;

    if (cur >= thres && cur >= prev && cur > next) {
      if (peaks.length === 0 || i - peaks[peaks.length - 1]!.index >= minDist) {
        peaks.push({ index: i, prob: cur });
      } else if (cur > peaks[peaks.length - 1]!.prob) {
        peaks[peaks.length - 1] = { index: i, prob: cur };
      }
    }
  }

  return peaks;
}

/**
 * Fast logistic sigmoid: 1 / (1 + exp(-x))
 */
export function sigmoid(x: number): number {
  if (x >= 40) return 1.0;
  if (x <= -40) return 0.0;
  return 1.0 / (1.0 + Math.exp(-x));
}

/**
 * In-place softmax along 3 channels for cvnt_logits of shape [3, numFrames].
 * Returns channel 1 (AP breath probability) as Float32Array of length numFrames.
 */
export function extractApProbabilities(cvntLogits: Float32Array, numFrames: number): Float32Array {
  const apProb = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const l0 = cvntLogits[0 * numFrames + f] ?? 0;
    const l1 = cvntLogits[1 * numFrames + f] ?? 0;
    const l2 = cvntLogits[2 * numFrames + f] ?? 0;

    const maxL = Math.max(l0, l1, l2);
    const e0 = Math.exp(l0 - maxL);
    const e1 = Math.exp(l1 - maxL);
    const e2 = Math.exp(l2 - maxL);
    const sum = e0 + e1 + e2;

    apProb[f] = sum > 0 ? e1 / sum : 0;
  }

  return apProb;
}

export type { AcousticBreath, AcousticEdge };
