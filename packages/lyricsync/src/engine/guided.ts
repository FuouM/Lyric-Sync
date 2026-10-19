// src/engine/guided.ts
// The simple solver's vote-count chain (simple.ts) guided by the trained boundary model (evidence/boundary.ts): the guide proposes extra
// candidate times and adds a score to each candidate of a boundary. GUIDED_DESIGN holds the constants that go with the bundled model.

import type { BoundaryModelEvidence, LineReview, SolveInput, SolveOutput } from '../types.ts';
import { applyPath, buildLineSkeleton, chainMarginals, lowerBound, mbrPath, MIN_SYL_SEC, viterbiChain, type EvidenceEvents, type LineSkeleton } from './boundary_dp.ts';
import type { ConsensusLine } from './consensus.ts';
import type { LinePins } from './pins.ts';
import { fitLineExtents, marginalError, prepareSolve, reviewLine } from './solve.ts';

/** A trained model's say about one line's boundaries. Boundary j is the start of syllable j (end of j-1); pinned boundaries are never asked. */
export interface BoundaryGuide {
  /** Extra candidate times for boundary j. */
  candidates(sk: LineSkeleton, j: number): number[];
  /** Score added to each candidate of boundary j. */
  score(sk: LineSkeleton, j: number, cands: number[]): Float64Array;
}

/** How boundaryGuide turns the model's frame scores into candidate scores (set with the bundled model on the annotated songs). */
export const GUIDE_SCORING = {
  /** Score of a candidate = weight * the probability mass within massSec of it. */
  weight: 4.5,
  massSec: 0.035,
  /** Extra candidates per boundary: the strongest local maxima of P with at least minPeak of the top peak's probability. */
  maxPeaks: 3,
  minPeak: 0.3,
  /** Frames this far outside a boundary's candidate span still take part in its softmax. */
  marginSec: 0.1,
} as const;

export type GuideScoring = Record<keyof typeof GUIDE_SCORING, number>;

/**
 * The guide of the boundary model (evidence.boundary). For boundary j of a line the model scores every frame (embedding . query_j / sqrt(dim)
 * + the frame's own logit); a softmax over the frames spanning the boundary's candidates turns that into P(t).
 */
export function boundaryGuide(model: BoundaryModelEvidence, scoring: GuideScoring = GUIDE_SCORING): BoundaryGuide {
  const { fps, dim, frames, queries } = model;
  const stride = dim + 1;
  const total = frames.length / stride;
  const scale = 1 / Math.sqrt(dim);
  const cache = new Map<string, { f0: number; p: Float64Array }>();

  /** P over the frames spanning the boundary's candidates (cached per line and boundary). */
  function distribution(sk: LineSkeleton, j: number, cands: number[]): { f0: number; p: Float64Array } {
    const key = `${sk.lineIdx}:${j}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const lineQueries = queries[sk.lineIdx];
    if (!lineQueries || lineQueries.length !== sk.cands.length) {
      throw new Error(`The boundary model has no queries for line ${sk.lineIdx} (or a different syllable count): run "lyricsync prepare" again.`);
    }
    const q = lineQueries[j]!;
    const f0 = Math.max(0, Math.floor((cands[0]! - scoring.marginSec) * fps));
    const f1 = Math.min(total - 1, Math.ceil((cands[cands.length - 1]! + scoring.marginSec) * fps));
    const p = new Float64Array(f1 - f0 + 1);
    let max = -Infinity;
    for (let f = f0; f <= f1; f++) {
      let s = frames[f * stride + dim]!;
      for (let k = 0; k < dim; k++) s += frames[f * stride + k]! * q[k]! * scale;
      p[f - f0] = s;
      if (s > max) max = s;
    }
    let z = 0;
    for (let i = 0; i < p.length; i++) z += p[i] = Math.exp(p[i]! - max);
    for (let i = 0; i < p.length; i++) p[i]! /= z;
    const out = { f0, p };
    cache.set(key, out);
    return out;
  }

  return {
    candidates(sk, j) {
      const d = distribution(sk, j, sk.cands[j]!);
      const peaks: number[] = [];
      for (let i = 0; i < d.p.length; i++) {
        if ((i === 0 || d.p[i]! > d.p[i - 1]!) && (i === d.p.length - 1 || d.p[i]! >= d.p[i + 1]!)) peaks.push(i);
      }
      peaks.sort((a, b) => d.p[b]! - d.p[a]!);
      const top = peaks.length > 0 ? d.p[peaks[0]!]! : 0;
      return peaks.filter((i) => d.p[i]! >= scoring.minPeak * top).slice(0, scoring.maxPeaks).map((i) => (d.f0 + i) / fps);
    },
    score(sk, j, cands) {
      const d = distribution(sk, j, cands);
      return Float64Array.from(cands, (c) => {
        const lo = Math.max(0, Math.ceil((c - scoring.massSec) * fps) - d.f0);
        const hi = Math.min(d.p.length - 1, Math.floor((c + scoring.massSec) * fps) - d.f0);
        let s = 0;
        for (let i = lo; i <= hi; i++) s += d.p[i]!;
        return scoring.weight * s;
      });
    },
  };
}

export const GUIDED_DESIGN = {
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
  /** Swift-F0 note starts do not vote: with the boundary model they cost accuracy (scripts/gtsinger/ablate_guided.ts). */
  swiftVote: 0,
  edgeVote: 3,
  /** The second (combined-model) phoneme-boundary edge set votes too: edge1Vote on lines whose first and last boundary are pinned (anchors
   *  fix the line's extent), edge1FreeVote on the others (where it costs accuracy). */
  edge1Vote: 2,
  edge1FreeVote: 0,
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
  /** Snap: a decoded boundary within beatSnapSec of a beat moves onto it. A candidate within onBeatSec of a beat counts as on it. */
  beatSnapSec: 0.055,
  onBeatSec: 0.004,
  /** Minimum duration of a sung syllable (seconds). */
  minSylSec: 0.08,
  /** Score lost per sixteenth note between a candidate and the consensus estimate, and the cap in sixteenths. */
  priorWeight: 0.3,
  priorCapSixteenths: 3,
  /** A line end this close before the next line's start (or past it) is moved onto the next start: labelled lines tile. */
  joinGapSec: 0.4,
  /** A voice stop (pitch notes) at least this long before the next line is a rest: the line ends there (see joinLineEnds). 0 = off. */
  restMinSec: 1,
  /** The line's first and last boundary vote like interior ones, times this. */
  lineEdgeVoteScale: 1,
  durationWeight: 1.5,
  /** Score lost per sixteenth note that a syllable's duration is off a whole number of sixteenths. */
  phaseWeight: 1.6,
  /** Scale of the 16th-phase duration penalty for syllables inside a multi-syllable word relative to whole words. */
  innerPhaseScale: 0.5,
  /** A pitch-note start inside a syllable (further than this from both its edges) is a note the syllable does not explain: score lost per start, capped. */
  insideMarginSec: 0.03,
  insideWeight: 1,
  insideCap: 3,
  /** The aligner's phone posteriors: a syllable gains nucleusWeight times the mean posterior of its own vowel inside it, and loses silenceWeight times that of silence. */
  nucleusWeight: 12,
  silenceWeight: 0,
  /** Audio onset voter (see simple.ts). 0 = off. */
  audioVote: 1.5,
  audioRiseDb: 5,
  audioLagSec: 0.011,
  /** Decoding: each line takes the path with the least expected absolute error under the chain's posterior, its scores divided by this
   *  temperature (see docs/guided.md); 0 = the single best path (Viterbi). */
  mbrTemp: 0.25,
} as const;

/** The constants of one solve: GUIDED_DESIGN with any overrides (research sweeps). */
export type GuidedDesign = Record<keyof typeof GUIDED_DESIGN, number>;

function hasWithin(events: number[], t: number, window: number): boolean {
  const i = lowerBound(events, t - window);
  return i < events.length && events[i]! <= t + window;
}

function shifted(times: number[], lag: number): number[] {
  return times.map((t) => t + lag);
}

export interface LineEvents {
  rmvpe: number[];
  harmo: number[];
  edges: number[];
  edges1: number[];
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

export function eighthGrid(e: EvidenceEvents, D: GuidedDesign): number[] {
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

export function audioOnsets(audio: Float32Array, sampleRate: number, D: GuidedDesign): number[] {
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

export function lineEvents(sk: LineSkeleton, eighths: number[], audio: number[], D: GuidedDesign): LineEvents {
  const e = sk.ev.events;
  return {
    rmvpe: shifted(e.rmvpeStarts, D.rmvpeLagSec),
    harmo: shifted(e.harmoStarts, D.harmoLagSec),
    edges: e.edgePeaks[0]!.t.filter((_, i) => e.edgePeaks[0]!.p[i]! >= D.edgeMinProb),
    edges1: e.edgePeaks[1] ? e.edgePeaks[1].t.filter((_, i) => e.edgePeaks[1]!.p[i]! >= D.edgeMinProb) : [],
    eighths,
    audio,
    raws: sk.ev.rawBoundarySets(sk.lineIdx, sk.cands.length - 1),
  };
}

/** Adds the guide's candidates to every unpinned boundary (kept inside the skeleton's own candidate range). */
function addGuideCandidates(sk: LineSkeleton, pins: Array<number | undefined>, guide: BoundaryGuide): void {
  sk.cands.forEach((cands, j) => {
    if (pins[j] !== undefined || cands.length === 0) return;
    const lo = cands[0]!;
    const hi = cands[cands.length - 1]!;
    const extra = guide.candidates(sk, j).filter((t) => t >= lo && t <= hi && !cands.some((c) => Math.abs(c - t) < 0.002));
    if (extra.length > 0) sk.cands[j] = [...cands, ...extra].sort((a, b) => a - b);
  });
}

export function unaryRows(sk: LineSkeleton, le: LineEvents, pins: Array<number | undefined>, guide: BoundaryGuide | null, D: GuidedDesign): Float64Array[] {
  const { prior, s16 } = sk;
  const e = sk.ev.events;
  const m = sk.cands.length - 1;
  const { rmvpe, harmo, edges, edges1, eighths, audio, raws } = le;
  const near = (events: number[], c: number): number => (hasWithin(events, c, D.voteWindowSec) ? 1 : 0);
  const pinnedLine = pins[0] !== undefined && pins[m] !== undefined;
  return sk.cands.map((cands, j) => {
    const sixteenths = (c: number): number => Math.abs(c - prior[j]!) / s16[j]!;
    const outer = j === 0 || j === m;
    const row = Float64Array.from(cands, (c) => {
      let votes =
        D.rmvpeVote * near(rmvpe, c) + D.harmoVote * near(harmo, c) + D.swiftVote * near(e.swiftStarts, c) + D.edgeVote * near(edges, c) +
        (pinnedLine ? D.edge1Vote : D.edge1FreeVote) * near(edges1, c) + D.beatVote * near(e.beats, c) + D.eighthVote * (hasWithin(eighths, c, D.eighthWindowSec) ? 1 : 0);
      if (D.audioVote > 0 && near(audio, c) === 1 && near(rmvpe, c) === 0 && near(harmo, c) === 0 && (hasWithin(rmvpe, c + 0.065, 0.045) || hasWithin(harmo, c + 0.065, 0.045))) votes += D.audioVote;
      for (const rb of raws) if (rb !== null && Math.abs(rb[j]! - c) <= D.voteWindowSec) votes += D.alignerVote;
      if (outer) return D.lineEdgeVoteScale * votes - sixteenths(c);
      return votes - D.priorWeight * Math.min(sixteenths(c), D.priorCapSixteenths);
    });
    if (guide !== null && pins[j] === undefined) {
      const add = guide.score(sk, j, cands);
      for (let k = 0; k < row.length; k++) row[k]! += add[k]!;
    }
    return row;
  });
}

export function pairTables(sk: LineSkeleton, le: LineEvents, D: GuidedDesign): Float64Array[] {
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

function snapToBeats(sk: LineSkeleton, path: number[], D: GuidedDesign): number[] {
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
    if (t - before < D.minSylSec || after - t < D.minSylSec) continue;
    snapped[j] = best;
  }
  return snapped;
}

/** Where the voice stops after a syllable [a, b]: the end of the run of pitch notes that overlaps it, following on through notes starting
 *  within 50 ms of the run's end, never past `limit`. undefined when no note overlaps the syllable. */
function voicedUntil(notes: Array<{ start: number; end: number }>, a: number, b: number, limit: number): number | undefined {
  let v: number | undefined;
  for (const n of notes) if (n.start < b && n.end > a && (v === undefined || n.end > v)) v = n.end;
  if (v === undefined) return undefined;
  const sorted = notes.filter((n) => n.start >= a).sort((x, y) => x.start - y.start);
  for (const n of sorted) {
    if (n.start > v + 0.05 || n.start >= limit) break;
    if (n.end > v) v = n.end;
  }
  return Math.min(v, limit);
}

/** A line's last syllable either runs into the next line (labelled lines tile) or ends where the voice stops before a rest: with restMinSec > 0
 *  a rest is a voice stop (the pitch notes overlapping the syllable end) at least that long before the next line, and the syllable ends there;
 *  otherwise a gap shorter than joinGapSec closes. */
export function joinLineEnds(lines: ConsensusLine[], linePins: LinePins[], notes: Array<{ start: number; end: number }>, D: GuidedDesign): void {
  for (const lp of linePins) {
    if (lp.pins[lp.syllableCount] !== undefined) continue;
    const next = lines[lp.lineIndex + 1];
    const line = lines[lp.lineIndex]!;
    const word = line.words[line.words.length - 1]!;
    const last = word.syl![word.syl!.length - 1]!;
    const target = next === undefined ? Infinity : next.words[0]!.syl![0]![0];
    if (D.restMinSec > 0) {
      const v = voicedUntil(notes, last[0], last[1], target);
      if (v !== undefined && target - v >= D.restMinSec) {
        last[1] = Math.max(last[0] + MIN_SYL_SEC, v);
        word.end = last[1];
        continue;
      }
    }
    if (next === undefined || target - last[1] >= D.joinGapSec || target - last[0] < MIN_SYL_SEC) continue;
    last[1] = target;
    word.end = target;
  }
}

/** Lines may not overlap: an unpinned line's boundaries stay after the previous line's last syllable start (plus a minimal syllable for each
 *  boundary before it), so its first syllable cannot start inside that syllable's onset. */
function keepAfter(sk: LineSkeleton, pins: Array<number | undefined>, bound: number, D: GuidedDesign): void {
  sk.cands.forEach((cands, j) => {
    if (pins[j] !== undefined) return;
    const lo = bound + j * D.minSylSec;
    const kept = cands.filter((t) => t >= lo);
    sk.cands[j] = kept.length > 0 ? kept : [lo];
  });
}

/** The last syllable of a line ends no later than the next line's first syllable starts, unless the user pinned that end. */
export function clipLineOverlaps(lines: ConsensusLine[], endPinned: Set<number>): void {
  for (let k = 1; k < lines.length; k++) {
    if (endPinned.has(k - 1)) continue;
    const word = lines[k - 1]!.words[lines[k - 1]!.words.length - 1]!;
    const last = word.syl![word.syl!.length - 1]!;
    const next = lines[k]!.words[0]!.syl![0]![0];
    if (last[1] <= next) continue;
    last[1] = Math.max(next, last[0]);
    word.end = last[1];
  }
}

/** Best path (mbrTemp 0) or minimum-expected-error path at temperature mbrTemp. */
function decodeChain(cands: number[][], u: Float64Array[], pair: Float64Array[], D: GuidedDesign): number[] {
  if (D.mbrTemp <= 0) return viterbiChain(cands, u, pair);
  const t = D.mbrTemp;
  return mbrPath(cands, chainMarginals(cands, { u: u.map((r) => r.map((x) => x / t)), pair: pair.map((r) => r.map((x) => x / t)) }));
}

/** The whole timing solve with the guided model. Same inputs and output shape as `solveSimple`, plus the guide (null = votes only) and optional constant overrides. */
export function solveGuided(input: Omit<SolveInput, 'weights'> & { guide: BoundaryGuide | null; design?: Partial<GuidedDesign> }): SolveOutput {
  const D: GuidedDesign = { ...GUIDED_DESIGN, ...input.design };
  const { consensus, linePins, ev } = prepareSolve(input);
  const eighths = eighthGrid(ev.events, D);
  const audio = D.audioVote > 0 ? audioOnsets(input.evidence.audio, input.evidence.sampleRate, D) : [];
  const lines: ConsensusLine[] = structuredClone(consensus);
  // In time order: each line is constrained by the one before it, already decoded.
  const solved: Array<{ skeleton: LineSkeleton; marginals: Float64Array[] }> = new Array(linePins.length);
  const order = linePins.map((_, i) => i).sort((a, b) => linePins[a]!.lineIndex - linePins[b]!.lineIndex);
  const pinnedEnd = new Map(linePins.flatMap((lp) => (lp.pins[lp.syllableCount] === undefined ? [] : [[lp.lineIndex, lp.pins[lp.syllableCount]!] as const])));
  for (const i of order) {
    const lp = linePins[i]!;
    const line = lines[lp.lineIndex]!;
    const skeleton = buildLineSkeleton(line, lp.lineIndex, ev, lp.pins);
    if (input.guide !== null) addGuideCandidates(skeleton, lp.pins, input.guide);
    const prev = lines[lp.lineIndex - 1];
    if (prev !== undefined) {
      const prevSyl = prev.words[prev.words.length - 1]!.syl!;
      // After the previous line's last syllable start, and after its end when the user pinned that end.
      keepAfter(skeleton, lp.pins, Math.max(prevSyl[prevSyl.length - 1]![0] + D.minSylSec, pinnedEnd.get(lp.lineIndex - 1) ?? -Infinity), D);
    }
    const le = lineEvents(skeleton, eighths, audio, D);
    const u = unaryRows(skeleton, le, lp.pins, input.guide, D);
    const pair = pairTables(skeleton, le, D);
    const path = decodeChain(skeleton.cands, u, pair, D);
    applyPath(line, skeleton, snapToBeats(skeleton, path, D));
    // The review's uncertainty: the chain's own posterior, its scores read as log-potentials (on the annotated songs the mean expected error
    // comes out close to the real one, and it ranks lines about as well as the trained method's CRF posterior).
    const marginals = chainMarginals(skeleton.cands, { u, pair });
    solved[i] = { skeleton, marginals };
  }
  joinLineEnds(lines, linePins, [...input.evidence.rmvpeNotes, ...input.evidence.harmoNotes], D);
  clipLineOverlaps(lines, new Set(pinnedEnd.keys()));
  fitLineExtents(lines);
  const review: LineReview[] = linePins.map((lp, i) => reviewLine(solved[i]!.skeleton, marginalError(solved[i]!.skeleton, solved[i]!.marginals), lines[lp.lineIndex]!, lp));
  return { lines, review };
}
