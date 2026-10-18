// packages/beatsync/src/postprocess.ts
// Robust post-processor for Beat This! RoFormer model predictions.
// Implements regularized Dynamic Programming (Viterbi) beat tracking with tempo priors
// to eliminate erratic jumps, skipped beats, and syncopated double-peaks.

import type { BeatResult, PostprocessOptions } from './types.ts';

/**
 * Extracts beat and downbeat timestamps from framewise logits.
 * Uses regularized dynamic programming when targetBpm is specified or useDP=true (default: true).
 */
export function postprocessBeats(
  beatLogits: Float32Array,
  downbeatLogits: Float32Array,
  fpsOrOptions: number | PostprocessOptions = 50
): BeatResult {
  const options: PostprocessOptions =
    typeof fpsOrOptions === 'number'
      ? { fps: fpsOrOptions, targetBpm: 200.0, useDP: true }
      : { fps: 50, targetBpm: 200.0, useDP: true, ...fpsOrOptions };

  const fps = options.fps ?? 50;
  const targetBpm = options.targetBpm ?? 200.0;
  const useDP = options.useDP !== false;

  const len = beatLogits.length;
  if (len === 0) {
    return { beats: [], downbeats: [] };
  }

  // Sigmoid probabilities
  const beatProb = new Float32Array(len);
  const downbeatProb = new Float32Array(len);
  for (let t = 0; t < len; t++) {
    beatProb[t] = 1.0 / (1.0 + Math.exp(-beatLogits[t]!));
    downbeatProb[t] = 1.0 / (1.0 + Math.exp(-downbeatLogits[t]!));
  }

  if (!useDP) {
    return postprocessMinimal(beatLogits, downbeatLogits, fps);
  }

  // Dynamic programming beat tracker with tight tempo prior around targetBpm
  const targetLag = (fps * 60) / targetBpm;
  const minLag = Math.max(1, Math.floor(targetLag * 0.88));
  const maxLag = Math.ceil(targetLag * 1.12);
  const lambda = 25.0;

  const D = new Float32Array(len);
  const P = new Int32Array(len);
  for (let i = 0; i < len; i++) {
    D[i] = beatProb[i]!;
    P[i] = -1;
  }

  for (let i = 1; i < len; i++) {
    const searchStart = Math.max(0, i - maxLag);
    const searchEnd = Math.max(0, i - minLag);
    let bestScore = -Infinity;
    let bestPrev = -1;

    for (let j = searchStart; j <= searchEnd; j++) {
      const lag = i - j;
      const ratio = lag / targetLag;
      const logRatio = Math.log(ratio);
      const score = D[j]! - lambda * (logRatio * logRatio);
      if (score > bestScore) {
        bestScore = score;
        bestPrev = j;
      }
    }

    if (bestPrev !== -1) {
      D[i] = beatProb[i]! + bestScore;
      P[i] = bestPrev;
    }
  }

  // Backtrack from best terminal node within last 0.6 seconds
  let bestTerminal = len - 1;
  let maxTermScore = -Infinity;
  const termSearch = Math.max(0, len - Math.floor(fps * 0.6));
  for (let i = termSearch; i < len; i++) {
    if (D[i]! > maxTermScore) {
      maxTermScore = D[i]!;
      bestTerminal = i;
    }
  }

  const frames: number[] = [];
  let curr = bestTerminal;
  while (curr >= 0) {
    frames.push(curr);
    curr = P[curr]!;
  }
  frames.reverse();

  // Convert to seconds
  const invFps = 1.0 / fps;
  const beats = frames.map((f) => parseFloat((f * invFps).toFixed(3)));

  // Determine downbeat phase: align to firstDownbeatHint if provided, else phase 0
  let bestPhase = 0;
  if (options.firstDownbeatHint !== undefined && !isNaN(options.firstDownbeatHint) && beats.length > 0) {
    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < beats.length; i++) {
      const diff = Math.abs(beats[i]! - options.firstDownbeatHint);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }
    bestPhase = ((closestIdx % 4) + 4) % 4;
  }
  const downbeats: number[] = [];
  for (let i = bestPhase; i < beats.length; i += 4) {
    downbeats.push(beats[i]!);
  }

  return { beats, downbeats };
}

/**
 * Minimal peak-picking matching standard reference implementation.
 */
export function postprocessMinimal(
  beatLogits: Float32Array,
  downbeatLogits: Float32Array,
  fps: number
): BeatResult {
  const len = beatLogits.length;

  const extractPeaks = (logits: Float32Array): number[] => {
    const rawPeaks: number[] = [];
    for (let t = 0; t < len; t++) {
      const val = logits[t]!;
      if (val <= 0) continue;

      let isLocalMax = true;
      for (let dt = -3; dt <= 3; dt++) {
        const neighbor = t + dt;
        if (neighbor >= 0 && neighbor < len && logits[neighbor]! > val) {
          isLocalMax = false;
          break;
        }
      }

      if (isLocalMax) {
        rawPeaks.push(t);
      }
    }

    if (rawPeaks.length === 0) return [];
    const deduped: number[] = [];
    let p = rawPeaks[0]!;
    let count = 1;

    for (let i = 1; i < rawPeaks.length; i++) {
      const p2 = rawPeaks[i]!;
      if (p2 - p <= 1) {
        p += p2;
        count++;
      } else {
        deduped.push(Math.round(p / count));
        p = p2;
        count = 1;
      }
    }
    deduped.push(Math.round(p / count));
    return deduped;
  };

  const beatFrames = extractPeaks(beatLogits);
  const downbeatFrames = extractPeaks(downbeatLogits);

  const invFps = 1.0 / fps;
  const beats = beatFrames.map((f) => parseFloat((f * invFps).toFixed(3)));
  let downbeats = downbeatFrames.map((f) => parseFloat((f * invFps).toFixed(3)));

  if (beats.length > 0 && downbeats.length > 0) {
    downbeats = downbeats.map((dTime) => {
      let bestBeat = beats[0]!;
      let minDiff = Math.abs(dTime - bestBeat);
      for (let b = 1; b < beats.length; b++) {
        const diff = Math.abs(dTime - beats[b]!);
        if (diff < minDiff) {
          minDiff = diff;
          bestBeat = beats[b]!;
        }
      }
      return bestBeat;
    });
    downbeats = Array.from(new Set(downbeats)).sort((a, b) => a - b);
  }

  return { beats, downbeats };
}
