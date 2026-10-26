// packages/beatsync/src/postprocess.ts
// Robust post-processor for Beat This! RoFormer model predictions.
// Implements regularized Dynamic Programming (Viterbi) beat tracking with tempo priors
// to eliminate erratic jumps, skipped beats, and syncopated double-peaks.

import type { BeatResult, PostprocessOptions, TempoChange } from './types.ts';

/** Throws unless `bpm` and every change are usable: positive tempos, `at` > 0 and strictly increasing. */
export function checkTempoChanges(bpm: number, changes: readonly TempoChange[] = []): void {
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error(`targetBpm must be a positive number (the song's approximate tempo in BPM), got ${String(bpm)}.`);
  let prev = 0;
  for (const c of changes) {
    if (!Number.isFinite(c.at) || c.at <= prev) throw new Error(`Tempo changes must have increasing times above 0 s; got ${String(c.at)} s after ${prev} s.`);
    if (!Number.isFinite(c.bpm) || c.bpm <= 0) throw new Error(`The tempo from ${c.at} s must be a positive number of BPM, got ${String(c.bpm)}.`);
    prev = c.at;
  }
}

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

  // Dynamic programming beat tracker with a tight tempo prior around the tempo in force (targetBpm, then each tempo change).
  // lagAt[f] is the prior beat spacing in frames at frame f. A beat pair (j, i) expects the geometric mean of lagAt[j] and
  // lagAt[i], so a pair that straddles a change is allowed either spacing.
  checkTempoChanges(targetBpm, options.tempoChanges);
  const changes = options.tempoChanges ?? [];
  const lagAt = new Float64Array(len);
  let seg = -1;
  let lagMin = Infinity;
  let lagMax = 0;
  for (let f = 0; f < len; f++) {
    while (seg + 1 < changes.length && changes[seg + 1]!.at <= f / fps) seg++;
    lagAt[f] = (fps * 60) / (seg < 0 ? targetBpm : changes[seg]!.bpm);
    if (lagAt[f]! < lagMin) lagMin = lagAt[f]!;
    if (lagAt[f]! > lagMax) lagMax = lagAt[f]!;
  }
  const minLag = Math.max(1, Math.floor(lagMin * 0.88));
  const maxLag = Math.ceil(lagMax * 1.12);
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
      const targetLag = lagAt[j] === lagAt[i] ? lagAt[i]! : Math.sqrt(lagAt[j]! * lagAt[i]!);
      if (lag < Math.max(1, Math.floor(targetLag * 0.88)) || lag > Math.ceil(targetLag * 1.12)) continue;
      const logRatio = Math.log(lag / targetLag);
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
