// src/engine/analytic.ts
// Training-free boundary solver. Same starting point as the trained solver (prepareSolve: pins, consensus lines, evidence) and the same
// candidate boundaries, but every candidate is scored by a small explicit model instead of learned weights.
//
// A line's interior boundaries are one monotone chain of candidate times. A candidate's score is a sum of independent pieces of evidence:
//   - the consensus estimate (distance in sixteenth notes, capped),
//   - each forced-aligner boundary, each pitch-note onset / offset and each phoneme-boundary peak near it (exponential kernels),
//   - being on a beat (the annotation tool snaps boundaries to beats, see LyricsTimingEditor.findSnapTarget),
//   - an energy rise, and the previous syllable's phones fading / the next one's rising across it.
// A pair of neighbouring candidates adds a duration model: close to the consensus duration and to the line's mean syllable length, a multiple of a
// sixteenth note, not shorter than a sung syllable, containing the syllable's nucleus phone and no silence, and no unexplained pitch-note onsets inside.
// Decoding is minimum-Bayes-risk: the chain's node posteriors (temperature 1) pick the path with the least expected absolute error.
//
// Every constant below is a physical tolerance or a stated modelling choice, set by hand from measurements on the sample songs (docs/analytic.md).
// None is fitted by an optimiser, so adding songs changes nothing here; the trained solver is the one that learns from annotated songs.

import type { LineReview, SolveInput, SolveOutput } from '../types.ts';
import { applyPath, buildLineSkeleton, chainMarginals, lowerBound, mbrPath, MIN_SYL_SEC, type EvidenceEvents, type LineSkeleton, type ScoreTables } from './boundary_dp.ts';
import type { ConsensusLine } from './consensus.ts';
import { fitLineExtents, marginalError, prepareSolve, reviewLine } from './solve.ts';

export const ANALYTIC_DESIGN = {
  /** A boundary within this distance of a beat was snapped onto it by the annotation tool, so evidence this close to a beat supports the beat itself. */
  beatSnapSec: 0.025,
  /** A candidate counts as being on a beat within this distance. */
  onBeatSec: 0.004,
  beatBonus: 3,
  beatBonusTauSec: 0.004,

  /** Penalty per sixteenth note between a candidate and the consensus estimate, capped. */
  priorWeight: 0.5,
  priorCapSixteenths: 3,

  rawWeight: 0.5,
  rawTauSec: 0.015,

  /** Pitch-note onsets (start of a note) vote with `pitchStartWeight`, offsets with `pitchEndWeight`. */
  pitchStartWeight: 1,
  pitchEndWeight: 0.5,
  pitchTauSec: 0.015,
  pitchReachSec: 0.15,
  /** Where the annotators put a boundary relative to each tracker's note onset: RMVPE reports onsets about 12 ms late, HarmoF0 about 15 ms early. */
  rmvpeLagSec: -0.012,
  harmoLagSec: 0.015,
  swiftLagSec: 0,

  /** Phoneme-boundary peaks (both models): the best peak within `edgeReachSec`, weighted by its probability. */
  edgeWeight: 2.5,
  edgeTauSec: 0.03,
  edgeMinProb: 0.2,
  edgePickTauSec: 0.012,
  edgeReachSec: 0.06,

  riseWeight: 0.3,
  riseSpanSec: 0.04,
  phoneWeight: 0.5,
  nucleusWindowSec: 0.05,
  edgePhoneWindowSec: 0.04,

  ratioWeight: 0.2,
  uniformWeight: 1.5,
  phaseWeight: 2,
  shortWeight: 2,
  shortSec: 0.12,
  nucleusWeight: 2,
  silenceWeight: 1,

  /** Penalty per pitch-note onset (RMVPE, HarmoF0, Swift-F0) or strong phoneme-boundary peak that falls strictly inside a syllable, at most `insideCap` of each. */
  insideRmvpe: 1,
  insideHarmo: 1,
  insideSwift: 0.5,
  insideEdge: 0.25,
  insideCap: 3,
  insideMarginSec: 0.03,
  insideEdgeMarginSec: 0.04,
} as const;

const D = ANALYTIC_DESIGN;

/** Signed distance (event - t) to the nearest event within `reach`, or undefined. */
function nearestWithin(events: number[], t: number, reach: number): number | undefined {
  const i = lowerBound(events, t);
  let best: number | undefined;
  if (i < events.length) best = events[i]! - t;
  if (i > 0 && (best === undefined || Math.abs(events[i - 1]! - t) < Math.abs(best))) best = events[i - 1]! - t;
  return best !== undefined && Math.abs(best) <= reach ? best : undefined;
}

function nearestDistance(events: number[], t: number): number {
  const d = nearestWithin(events, t, Infinity);
  return d === undefined ? Infinity : Math.abs(d);
}

function countBetween(events: number[], lo: number, hi: number): number {
  return hi > lo ? Math.min(D.insideCap, lowerBound(events, hi) - lowerBound(events, lo)) : 0;
}

function unaryRow(sk: LineSkeleton, j: number, events: EvidenceEvents): Float64Array {
  const { ev, prior, s16, sylRefs } = sk;
  const m = sylRefs.length;
  const cands = sk.cands[j]!;
  const raws = ev.rawBoundarySets(sk.lineIdx, m).map((b) => (b ? b[j]! : null));
  const nucL = j > 0 ? sylRefs[j - 1]!.nucleus : -1;
  const nucR = j < m ? sylRefs[j]!.nucleus : -1;
  const lastL = j > 0 ? sylRefs[j - 1]!.lastPhone : -1;
  const firstR = j < m ? sylRefs[j]!.firstPhone : -1;
  const pitch: Array<[number[], number, number]> = [
    [events.rmvpeStarts, D.pitchStartWeight, D.rmvpeLagSec],
    [events.rmvpeEnds, D.pitchEndWeight, D.rmvpeLagSec],
    [events.harmoStarts, D.pitchStartWeight, D.harmoLagSec],
    [events.harmoEnds, D.pitchEndWeight, D.harmoLagSec],
    [events.swiftStarts, D.pitchStartWeight, D.swiftLagSec],
    [events.swiftEnds, D.pitchEndWeight, D.swiftLagSec],
  ];
  return Float64Array.from(cands, (c) => {
    const beatDistance = nearestDistance(events.beats, c);
    const snap = beatDistance <= D.onBeatSec ? D.beatSnapSec : 0;
    const kernel = (d: number, tau: number): number => Math.exp(-Math.max(0, Math.abs(d) - snap) / tau);
    let s = -D.priorWeight * Math.min(Math.abs(c - prior[j]!) / s16[j]!, D.priorCapSixteenths);
    for (const rb of raws) if (rb !== null) s += D.rawWeight * kernel(c - rb, D.rawTauSec);
    for (const [times, weight, lag] of pitch) {
      const d = nearestWithin(times, c, D.pitchReachSec);
      if (d !== undefined) s += weight * kernel(d + lag, D.pitchTauSec);
    }
    for (const peaks of events.edgePeaks.slice(0, 2)) {
      let bestScore = -1;
      let bestDistance = 0;
      let bestProb = 0;
      for (let i = lowerBound(peaks.t, c - D.edgeReachSec); i < peaks.t.length && peaks.t[i]! <= c + D.edgeReachSec; i++) {
        const p = peaks.p[i]!;
        if (p < D.edgeMinProb) continue;
        const d = Math.abs(peaks.t[i]! - c);
        const pick = p * Math.exp(-d / D.edgePickTauSec);
        if (pick > bestScore) {
          bestScore = pick;
          bestDistance = d;
          bestProb = p;
        }
      }
      if (bestScore >= 0) s += D.edgeWeight * bestProb * kernel(bestDistance, D.edgeTauSec);
    }
    s += D.beatBonus * Math.exp(-beatDistance / D.beatBonusTauSec);
    s += D.riseWeight * ev.rmsRise(c, D.riseSpanSec);
    s += D.phoneWeight * (
      ev.phoneFade(nucL, c, D.nucleusWindowSec) + ev.phoneRise(nucR, c, D.nucleusWindowSec) +
      ev.phoneFade(lastL, c, D.edgePhoneWindowSec) + ev.phoneRise(firstR, c, D.edgePhoneWindowSec)
    );
    return s;
  });
}

/** Pair scores for boundary j-1 -> j, index q * B + k; -Infinity where the syllable would be shorter than MIN_SYL_SEC. */
function pairTable(sk: LineSkeleton, j: number, events: EvidenceEvents): Float64Array {
  const A = sk.cands[j - 1]!;
  const B = sk.cands[j]!;
  const priorDur = Math.max(sk.prior[j]! - sk.prior[j - 1]!, 1e-3);
  const meanDur = Math.max(sk.meanDur, 1e-3);
  const nucleus = sk.sylRefs[j - 1]!.nucleus;
  const strongEdges = events.edgePeaks[0]!.strong;
  const table = new Float64Array(A.length * B.length).fill(-Infinity);
  for (let q = 0; q < A.length; q++) {
    for (let k = 0; k < B.length; k++) {
      const a = A[q]!;
      const b = B[k]!;
      const dur = b - a;
      if (dur < MIN_SYL_SEC) continue;
      const sixteenths = dur / sk.s16[j]!;
      const phones = sk.ev.segmentPhones(nucleus, a, b);
      const lo = a + D.insideMarginSec;
      const hi = b - D.insideMarginSec;
      table[q * B.length + k] =
        -D.ratioWeight * Math.abs(Math.log(dur / priorDur)) -
        D.uniformWeight * Math.abs(Math.log(dur / meanDur)) -
        D.phaseWeight * Math.abs(sixteenths - Math.round(sixteenths)) -
        D.shortWeight * Math.max(0, Math.log(D.shortSec / dur)) +
        D.nucleusWeight * phones.nucleus - D.silenceWeight * phones.silence -
        D.insideRmvpe * countBetween(events.rmvpeStarts, lo, hi) -
        D.insideHarmo * countBetween(events.harmoStarts, lo, hi) -
        D.insideSwift * countBetween(events.swiftStarts, lo, hi) -
        D.insideEdge * countBetween(strongEdges, a + D.insideEdgeMarginSec, b - D.insideEdgeMarginSec);
    }
  }
  return table;
}

/** Unary rows and pair tables of one line, ready for the shared chain (viterbi, marginals, MBR). */
export function analyticTables(sk: LineSkeleton): ScoreTables {
  const events = sk.ev.events;
  if (events.edgePeaks.length < 2) throw new Error('The analytic solver needs two phoneme-boundary edge sets (base and combined model); the evidence has fewer.');
  const u = sk.cands.map((_, j) => unaryRow(sk, j, events));
  const pair: Float64Array[] = [];
  for (let j = 1; j < sk.cands.length; j++) pair.push(pairTable(sk, j, events));
  return { u, pair };
}

/** The whole timing solve without trained weights. Same inputs and output shape as `solve`, minus `weights`. */
export function solveAnalytic(input: Omit<SolveInput, 'weights'>): SolveOutput {
  const { consensus, linePins, ev } = prepareSolve(input);
  const lines: ConsensusLine[] = structuredClone(consensus);
  const solved = linePins.map((lp) => {
    const line = lines[lp.lineIndex]!;
    const skeleton = buildLineSkeleton(line, lp.lineIndex, ev, lp.pins);
    const marginals = chainMarginals(skeleton.cands, analyticTables(skeleton));
    applyPath(line, skeleton, mbrPath(skeleton.cands, marginals));
    return { skeleton, marginals };
  });
  fitLineExtents(lines);
  const review: LineReview[] = linePins.map((lp, i) => reviewLine(solved[i]!.skeleton, marginalError(solved[i]!.skeleton, solved[i]!.marginals), lines[lp.lineIndex]!, lp));
  return { lines, review };
}
