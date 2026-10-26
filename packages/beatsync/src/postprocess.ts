// packages/beatsync/src/postprocess.ts
// Robust post-processor for Beat This! RoFormer model predictions.
// Implements regularized Dynamic Programming (Viterbi) beat tracking with tempo priors
// to eliminate erratic jumps, skipped beats, and syncopated double-peaks.

import type { BeatPin, BeatResult, PostprocessOptions, TempoChange } from './types.ts';

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

/** Throws unless the pins are usable: whole beat numbers, increasing, at times that are finite, 0 or more and increasing. */
export function checkBeatPins(pins: readonly BeatPin[] = []): void {
  let prevBeat = -1;
  let prevAt = -1;
  for (const p of pins) {
    if (!Number.isInteger(p.beat) || p.beat <= prevBeat) throw new Error(`Beat pins must have increasing whole beat numbers from 0; got beat ${String(p.beat)} after ${prevBeat}.`);
    if (!Number.isFinite(p.at) || p.at < 0 || p.at <= prevAt) throw new Error(`Beat pins must have increasing times of 0 s or more; got ${String(p.at)} s after ${prevAt} s.`);
    prevBeat = p.beat;
    prevAt = p.at;
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
  const pins = options.beatPins ?? [];
  checkBeatPins(pins);
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
  const priorLag = (j: number, i: number): number => (lagAt[j] === lagAt[i] ? lagAt[i]! : Math.sqrt(lagAt[j]! * lagAt[i]!));

  /** The best beat chain over the frames from `from` (a pinned beat the chain starts at; null: anywhere) to the end of the song. */
  const freeChain = (from: number | null): number[] => {
    const D = new Float32Array(len);
    const P = new Int32Array(len);
    for (let i = 0; i < len; i++) {
      D[i] = from === null ? beatProb[i]! : i === from ? 0 : -Infinity;
      P[i] = -1;
    }

    for (let i = 1; i < len; i++) {
      const searchStart = Math.max(0, i - maxLag);
      const searchEnd = Math.max(0, i - minLag);
      let bestScore = -Infinity;
      let bestPrev = -1;

      for (let j = searchStart; j <= searchEnd; j++) {
        const lag = i - j;
        const targetLag = priorLag(j, i);
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
    if (from !== null && maxTermScore === -Infinity) return [from]; // the pin is too close to the end for another beat

    const chain: number[] = [];
    let curr = bestTerminal;
    while (curr >= 0) {
      chain.push(curr);
      curr = P[curr]!;
    }
    return chain.reverse();
  };

  /**
   * The best chain of exactly `n` beat intervals from frame `from` (a pinned beat; null: anywhere) to frame `to` (a pinned beat).
   * Between two pins the spacing the pins imply is the prior; before the first pin it is the tempo prior.
   */
  const countedChain = (from: number | null, to: number, n: number, where: string): number[] => {
    if (n === 0) return [to];
    const lo = from ?? 0;
    const span = to - lo + 1;
    const impliedLag = from === null ? null : (to - from) / n;
    const [minL, maxL] = impliedLag === null ? [minLag, maxLag] : [Math.max(1, Math.floor(impliedLag * 0.88)), Math.ceil(impliedLag * 1.12)];
    let prev = new Float64Array(span).fill(-Infinity);
    if (from === null) for (let f = 0; f < span; f++) prev[f] = beatProb[f]!;
    else prev[0] = 0;
    const parents: Int32Array[] = [];
    for (let j = 1; j <= n; j++) {
      const cur = new Float64Array(span).fill(-Infinity);
      const parent = new Int32Array(span).fill(-1);
      for (let f = 0; f < span; f++) {
        const i = lo + f;
        let best = -Infinity;
        let bestFrom = -1;
        for (let p = Math.max(lo, i - maxL); p <= i - minL; p++) {
          const base = prev[p - lo]!;
          if (base === -Infinity) continue;
          const lag = i - p;
          const target = impliedLag ?? priorLag(p, i);
          if (lag < Math.max(1, Math.floor(target * 0.88)) || lag > Math.ceil(target * 1.12)) continue;
          const logRatio = Math.log(lag / target);
          const score = base - lambda * (logRatio * logRatio);
          if (score > best) {
            best = score;
            bestFrom = p - lo;
          }
        }
        if (bestFrom >= 0) {
          cur[f] = beatProb[i]! + best;
          parent[f] = bestFrom;
        }
      }
      parents.push(parent);
      prev = cur;
    }
    if (prev[span - 1] === -Infinity) throw new Error(`The beat pins leave no room for ${n} beat${n === 1 ? '' : 's'} ${where}.`);
    const chain = [to];
    let f = span - 1;
    for (let j = n - 1; j >= 0; j--) {
      f = parents[j]![f]!;
      chain.push(lo + f);
    }
    return chain.reverse();
  };

  let frames: number[];
  if (pins.length === 0) frames = freeChain(null);
  else {
    // Pinned beats are fixed; between two pins (and before the first) the beat count is fixed too, so the beat numbers of the pins
    // stay valid when the rest is re-fitted. After the last pin the chain is free.
    const pinFrames = pins.map((p) => Math.round(p.at * fps));
    pinFrames.forEach((f, k) => {
      if (f < 0 || f >= len || (k > 0 && f <= pinFrames[k - 1]!)) throw new Error(`Beat pin ${k + 1} (beat ${pins[k]!.beat} at ${pins[k]!.at} s) is outside the song or not after the pin before it.`);
    });
    frames = countedChain(null, pinFrames[0]!, pins[0]!.beat, `before beat ${pins[0]!.beat}`);
    for (let k = 1; k < pins.length; k++) {
      frames.push(...countedChain(pinFrames[k - 1]!, pinFrames[k]!, pins[k]!.beat - pins[k - 1]!.beat, `between beats ${pins[k - 1]!.beat} and ${pins[k]!.beat}`).slice(1));
    }
    frames.push(...freeChain(pinFrames[pinFrames.length - 1]!).slice(1));
  }

  // Convert to seconds
  const invFps = 1.0 / fps;
  const beats = frames.map((f) => parseFloat((f * invFps).toFixed(3)));
  for (const p of pins) beats[p.beat] = parseFloat(p.at.toFixed(3)); // a pinned beat is where the pin says, not on a frame

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
