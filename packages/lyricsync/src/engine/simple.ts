// src/engine/simple.ts
// The simplest training-free boundary solver, the starting point that is expanded one measured step at a time (docs/simple.md).
//
// A line's interior boundaries are one monotone chain of candidate times (the same candidates as the other solvers).
//   - A candidate scores one vote for every independent source that has an event within `voteWindowSec` of it: each forced-aligner boundary,
//     each pitch-tracker note start (corrected for the tracker's latency), each phoneme-boundary peak, each beat and the consensus estimate.
//   - A candidate loses `priorWeight` per sixteenth note of distance from the consensus estimate (capped).
//   - A syllable loses `durationWeight` times the log-ratio of its duration to the line's mean syllable duration.
// The path with the highest total score is taken (Viterbi). Nothing is fitted: the constants are hand-set.

import type { LineReview, SolveInput, SolveOutput } from '../types.ts';
import { applyPath, buildLineSkeleton, lowerBound, MIN_SYL_SEC, viterbiChain, type EvidenceEvents, type LineSkeleton } from './boundary_dp.ts';
import type { ConsensusLine } from './consensus.ts';
import type { LinePins } from './pins.ts';
import { fitLineExtents, prepareSolve, reviewLine } from './solve.ts';

export const SIMPLE_DESIGN = {
  /** An event this close to a candidate is one vote for it. */
  voteWindowSec: 0.035,
  /** Pitch trackers report a note start late (RMVPE) or early (HarmoF0) relative to a labelled syllable start; added to their times. */
  rmvpeLagSec: -0.012,
  harmoLagSec: 0.015,
  /** Phoneme-boundary peaks below this probability do not vote. */
  edgeMinProb: 0.35,
  /** Votes per source: what one source's agreement with a candidate is worth. */
  rmvpeVote: 1,
  harmoVote: 1,
  swiftVote: 1,
  edgeVote: 3,
  alignerVote: 0.5,
  beatVote: 1,
  /** The eighth-note grid votes too, shifted by the lag this song's detector-agreed onsets show against it (see eighthGrid). */
  eighthVote: 1,
  eighthWindowSec: 0.015,
  /** Detector onsets (an RMVPE and a HarmoF0 start this close) used to measure the grid lag, and how far from the grid they may sit. */
  agreeSec: 0.04,
  lagReachSec: 0.06,
  /** Onsets this close to a beat are the beat's, not an off-beat grid position. */
  offBeatSec: 0.025,
  /** Snap: a decoded boundary within beatSnapSec of a beat moves onto it (the annotation tool snaps labels within 25 ms; decoded boundaries err more, so the window is wider). A candidate within onBeatSec of a beat counts as on it. */
  beatSnapSec: 0.055,
  onBeatSec: 0.004,
  /** Minimum duration of a sung syllable (seconds). In singing, syllables are rarely under 80 ms. */
  minSylSec: 0.08,
  /** Score lost per sixteenth note between a candidate and the consensus estimate, and the cap in sixteenths. */
  priorWeight: 0.3,
  priorCapSixteenths: 3,
  /** A line end this close before the next line's start (or past it) is moved onto the next start: labelled lines tile. */
  joinGapSec: 0.4,
  /** The line's first and last boundary vote like interior ones, times this (0 = only the consensus distance); their distance term stays full weight and uncapped. */
  lineEdgeVoteScale: 1,
  durationWeight: 1.5,
  /** Score lost per sixteenth note that a syllable's duration is off a whole number of sixteenths: sung durations sit on the rhythmic grid. */
  phaseWeight: 1.6,
  /** Scale of the 16th-phase duration penalty for syllables inside a multi-syllable word relative to whole words (1 = same). Inner syllables have phonetic flexibility. */
  innerPhaseScale: 0.5,
  /** A pitch-note start inside a syllable (further than this from both its edges) is a note the syllable does not explain: score lost per such start, capped. */
  insideMarginSec: 0.03,
  insideWeight: 1,
  insideCap: 3,
  /** The aligner's phone posteriors: a syllable gains nucleusWeight times the mean posterior of its own vowel inside it, and loses silenceWeight times that of silence. */
  nucleusWeight: 12,
  silenceWeight: 1,
  /** Audio onset voter: the vocal stem's energy rise (pre-emphasised so frication counts) votes for a candidate only where an onset is followed by a pitch onset 20-110 ms later (a consonant, then the vowel the pitch trackers see) and no pitch onset is at the candidate itself. 0 = off. */
  audioVote: 1.5,
  audioRiseDb: 5,
  audioLagSec: 0.011,
} as const;

const D = SIMPLE_DESIGN;

function hasWithin(events: number[], t: number, window: number): boolean {
  const i = lowerBound(events, t - window);
  return i < events.length && events[i]! <= t + window;
}

function shifted(times: number[], lag: number): number[] {
  return times.map((t) => t + lag);
}

interface LineEvents {
  rmvpe: number[];
  harmo: number[];
  edges: number[];
  eighths: number[];
  audio: number[];
  raws: Array<number[] | null>;
}

function nearestTo(sorted: number[], t: number): number {
  const i = lowerBound(sorted, t);
  if (i >= sorted.length) return sorted[sorted.length - 1]!;
  if (i === 0) return sorted[0]!;
  return t - sorted[i - 1]! < sorted[i]! - t ? sorted[i - 1]! : sorted[i]!;
}

/**
 * The song's eighth-note grid (midpoints between beats) shifted by its measured lag: the median signed distance of off-beat detector-agreed onsets
 * (RMVPE and HarmoF0 starts that agree, latency-corrected, averaged) from the nearest grid point. Singers attack slightly before the grid, and the
 * lag is a property of the performance, so it is measured per song from the detectors without labels. No agreed onsets near the grid means lag 0.
 */
function eighthGrid(e: EvidenceEvents): number[] {
  const grid = e.beats.slice(1).map((b, i) => (e.beats[i]! + b) / 2);
  const rmvpe = shifted(e.rmvpeStarts, D.rmvpeLagSec);
  const harmo = shifted(e.harmoStarts, D.harmoLagSec);
  const offsets: number[] = [];
  for (const r of rmvpe) {
    const h = nearestTo(harmo, r);
    if (Math.abs(h - r) > D.agreeSec) continue;
    const t = (r + h) / 2;
    if (Math.abs(nearestTo(e.beats, t) - t) <= D.offBeatSec) continue;
    const off = t - nearestTo(grid, t);
    if (Math.abs(off) <= D.lagReachSec) offsets.push(off);
  }
  offsets.sort((a, b) => a - b);
  const lag = offsets.length === 0 ? 0 : offsets[Math.floor(offsets.length / 2)]!;
  return grid.map((g) => g + lag);
}

/** Onsets of the vocal stem: peaks of the rise in 25 ms-window log energy (pre-emphasised signal), next 3 frames against the previous 3, at least audioRiseDb. */
function audioOnsets(audio: Float32Array, sampleRate: number): number[] {
  const hop = Math.round(sampleRate * 0.01);
  const win = Math.round(sampleRate * 0.025);
  const n = Math.floor((audio.length - win) / hop);
  const db = new Float64Array(Math.max(n, 0));
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let k = 1; k < win; k++) {
      const v = audio[f * hop + k]! - 0.97 * audio[f * hop + k - 1]!;
      e += v * v;
    }
    db[f] = 10 * Math.log10(e / win + 1e-9);
  }
  const rise = (f: number): number => (db[f]! + db[f + 1]! + db[f + 2]!) / 3 - (db[f - 1]! + db[f - 2]! + db[f - 3]!) / 3;
  const out: number[] = [];
  for (let f = 3; f < n - 3; f++) {
    const r = rise(f);
    if (r >= D.audioRiseDb && r >= rise(f - 1) && r > rise(f + 1)) out.push(f * 0.01 + 0.0125 + D.audioLagSec);
  }
  return out;
}

function lineEvents(sk: LineSkeleton, eighths: number[], audio: number[]): LineEvents {
  const e = sk.ev.events;
  return {
    rmvpe: shifted(e.rmvpeStarts, D.rmvpeLagSec),
    harmo: shifted(e.harmoStarts, D.harmoLagSec),
    edges: e.edgePeaks[0]!.t.filter((_, i) => e.edgePeaks[0]!.p[i]! >= D.edgeMinProb),
    eighths,
    audio,
    raws: sk.ev.rawBoundarySets(sk.lineIdx, sk.cands.length - 1),
  };
}

function unaryRows(sk: LineSkeleton, le: LineEvents): Float64Array[] {
  const { prior, s16 } = sk;
  const e = sk.ev.events;
  const m = sk.cands.length - 1;
  const { rmvpe, harmo, edges, eighths, audio, raws } = le;
  const near = (events: number[], c: number): number => (hasWithin(events, c, D.voteWindowSec) ? 1 : 0);
  return sk.cands.map((cands, j) => {
    const sixteenths = (c: number): number => Math.abs(c - prior[j]!) / s16[j]!;
    const outer = j === 0 || j === m;
    return Float64Array.from(cands, (c) => {
      let votes =
        D.rmvpeVote * near(rmvpe, c) + D.harmoVote * near(harmo, c) + D.swiftVote * near(e.swiftStarts, c) + D.edgeVote * near(edges, c) +
        D.beatVote * near(e.beats, c) + D.eighthVote * (hasWithin(eighths, c, D.eighthWindowSec) ? 1 : 0);
      if (D.audioVote > 0 && near(audio, c) === 1 && near(rmvpe, c) === 0 && near(harmo, c) === 0 && (hasWithin(rmvpe, c + 0.065, 0.045) || hasWithin(harmo, c + 0.065, 0.045))) votes += D.audioVote;
      for (const rb of raws) if (rb !== null && Math.abs(rb[j]! - c) <= D.voteWindowSec) votes += D.alignerVote;
      if (outer) return D.lineEdgeVoteScale * votes - sixteenths(c);
      return votes - D.priorWeight * Math.min(sixteenths(c), D.priorCapSixteenths);
    });
  });
}

/** Pair scores for boundary j-1 -> j, index q * B + k; -Infinity where the syllable would be shorter than MIN_SYL_SEC. */
function pairTables(sk: LineSkeleton, le: LineEvents): Float64Array[] {
  const meanDur = Math.max(sk.meanDur, 1e-3);
  const tables: Float64Array[] = [];
  for (let j = 1; j < sk.cands.length; j++) {
    const A = sk.cands[j - 1]!;
    const B = sk.cands[j]!;
    const isWord = sk.kinds[j - 1] !== 'in' && sk.kinds[j] !== 'in';
    const table = new Float64Array(A.length * B.length).fill(-Infinity);
    for (let q = 0; q < A.length; q++) {
      for (let k = 0; k < B.length; k++) {
        const dur = B[k]! - A[q]!;
        if (dur < D.minSylSec) continue;
        const lo = A[q]! + D.insideMarginSec;
        const hi = B[k]! - D.insideMarginSec;
        const inside = hi > lo ? Math.min(D.insideCap, lowerBound(le.rmvpe, hi) - lowerBound(le.rmvpe, lo) + lowerBound(le.harmo, hi) - lowerBound(le.harmo, lo)) : 0;
        const sixteenths = dur / sk.s16[j]!;
        const phones = sk.ev.segmentPhones(sk.sylRefs[j - 1]!.nucleus, A[q]!, B[k]!);
        const phaseScale = isWord ? 1 : D.innerPhaseScale;
        const phasePenalty = phaseScale * Math.abs(sixteenths - Math.round(sixteenths));
        table[q * B.length + k] =
          -D.durationWeight * Math.abs(Math.log(dur / meanDur)) - D.phaseWeight * phasePenalty - D.insideWeight * inside +
          D.nucleusWeight * phones.nucleus - D.silenceWeight * phones.silence;
      }
    }
    tables.push(table);
  }
  return tables;
}

/**
 * The annotation tool snaps a boundary within beatSnapSec of a beat onto that beat, so a decoded boundary (including a line's first and last; pinned ones
 * have a single candidate and cannot move) that close to a beat is moved to the candidate on it, when the syllables beside it stay at least MIN_SYL_SEC long.
 */
function snapToBeats(sk: LineSkeleton, path: number[]): number[] {
  const beats = sk.ev.events.beats;
  const snapped = [...path];
  for (let j = 0; j < path.length; j++) {
    const c = sk.cands[j]![path[j]!]!;
    const i = lowerBound(beats, c);
    const beat = i > 0 && (i >= beats.length || c - beats[i - 1]! < beats[i]! - c) ? beats[i - 1]! : beats[i];
    if (beat === undefined || Math.abs(beat - c) > D.beatSnapSec) continue;
    let best = -1;
    sk.cands[j]!.forEach((t, k) => {
      if (Math.abs(t - beat) <= D.onBeatSec && (best < 0 || Math.abs(t - beat) < Math.abs(sk.cands[j]![best]! - beat))) best = k;
    });
    if (best < 0) continue;
    const t = sk.cands[j]![best]!;
    const before = j === 0 ? -Infinity : sk.cands[j - 1]![snapped[j - 1]!]!;
    const after = j === path.length - 1 ? Infinity : sk.cands[j + 1]![snapped[j + 1]!]!;
    if (t - before >= D.minSylSec && after - t >= D.minSylSec) snapped[j] = best;
  }
  return snapped;
}

/**
 * Labelled lines tile: a line ends where the next one starts unless there is a real pause. A line end that was not pinned and lies less than
 * joinGapSec before the next line's start (or after it) is moved onto that start, when the last syllable keeps at least MIN_SYL_SEC.
 */
function joinLineEnds(lines: ConsensusLine[], linePins: LinePins[]): void {
  for (const lp of linePins) {
    const next = lines[lp.lineIndex + 1];
    if (next === undefined || lp.pins[lp.syllableCount] !== undefined) continue;
    const line = lines[lp.lineIndex]!;
    const word = line.words[line.words.length - 1]!;
    const last = word.syl![word.syl!.length - 1]!;
    const target = next.words[0]!.syl![0]![0];
    if (target - last[1] >= D.joinGapSec || target - last[0] < MIN_SYL_SEC) continue;
    last[1] = target;
    word.end = target;
  }
}

/** The whole timing solve with the simple model. Same inputs and output shape as `solve`, minus `weights`; no per-boundary confidence (the review reports none). */
export function solveSimple(input: Omit<SolveInput, 'weights'>): SolveOutput {
  const { consensus, linePins, ev } = prepareSolve(input);
  const eighths = eighthGrid(ev.events);
  const audio = D.audioVote > 0 ? audioOnsets(input.evidence.audio, input.evidence.sampleRate) : [];
  const lines: ConsensusLine[] = structuredClone(consensus);
  const skeletons = linePins.map((lp) => {
    const line = lines[lp.lineIndex]!;
    const skeleton = buildLineSkeleton(line, lp.lineIndex, ev, lp.pins);
    const le = lineEvents(skeleton, eighths, audio);
    applyPath(line, skeleton, snapToBeats(skeleton, viterbiChain(skeleton.cands, unaryRows(skeleton, le), pairTables(skeleton, le))));
    return skeleton;
  });
  joinLineEnds(lines, linePins);
  fitLineExtents(lines);
  const review: LineReview[] = linePins.map((lp, i) => reviewLine(skeletons[i]!, null, lines[lp.lineIndex]!, lp));
  return { lines, review };
}
