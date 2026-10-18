// src/train/train.ts
// Trains the boundary DP weights (linear-chain CRF, Adagrad, soft targets) and reports leave-one-song-out generalisation.
//
// Two modes are trained independently, on the same priors the solver builds (`prepareSolve`), so train and test cannot drift:
//   anchored: every annotated line has its start/end pinned (the sliced alignments are used)
//   free:     nothing is pinned
// Each mode has two stages. Stage 2 is fit on each song's stage-1 output, where that stage-1 output comes from weights fit WITHOUT that song
// (out-of-fold), so stage 2 never sees an in-sample prior. With fewer than 3 songs a held-out evaluation is impossible and training throws.

import type { Anchors, ModeWeights, SlicedAlignment, SongEvidence, Weights } from '../types.ts';
import {
  accumulateNllGradient,
  applyProblems,
  buildProblems,
  decodeLine,
  featureCount,
  prepareProblem,
  vecToWeights,
  type BoundaryEvidence,
  type LineProblem,
} from '../engine/boundary_dp.ts';
import type { ConsensusLine } from '../engine/consensus.ts';
import type { LinePins } from '../engine/pins.ts';
import { prepareSolve } from '../engine/solve.ts';
import { emptyAnchors } from '../workspace/anchors.ts';

export type TrainMode = 'anchored' | 'free';

export interface TrainingSong {
  id: string;
  evidence: SongEvidence;
  /** Pins used in anchored mode: every annotated line's start/end. */
  anchors: Anchors;
  /** Sliced alignments for every anchored line. */
  sliced: Record<number, SlicedAlignment>;
  /** Ground-truth line per lyric line (same index as the lyrics); null for lines without annotation. */
  truth: Array<ConsensusLine | null>;
}

export interface TrainOptions {
  epochs?: number;
  lr?: number;
  l2?: number;
  /** Width of the soft training target in ms: candidates within a few ms of the annotation share it. */
  tauMs?: number;
  onProgress?: (message: string) => void;
}

export interface Mae {
  start: number;
  end: number;
  n: number;
}

export interface SongReport {
  id: string;
  consensus: Mae;
  stage1: Mae;
  stage2: Mae;
}

/** Both stages fit with the same data; `stage2` exists even for a mode that ends up shipping one stage, so held-out numbers can be compared. */
export interface FittedStages {
  stage1: Weights;
  stage2: Weights;
}

export interface TrainResult {
  mode: TrainMode;
  /** DP stages shipped for this mode: 2 only when stage 2 improved the held-out MAE. */
  stages: 1 | 2;
  /** Fit on all songs. These are the weights to ship. */
  weights: ModeWeights;
  /** Fit without the named song; evaluate that song with these for an honest number. */
  heldOut: Record<string, FittedStages>;
  songs: SongReport[];
  /** Overall held-out syllable MAE (mean of start and end, ms), weighted by syllable count. `shipped` is the stage count in `stages`. */
  overall: { consensus: number; stage1: number; stage2: number; shipped: number };
}

interface Example {
  prob: LineProblem;
  gt: number[];
  soft: Float64Array[];
}

interface SongData {
  id: string;
  prior: ConsensusLine[];
  truth: Array<ConsensusLine | null>;
  problems: LineProblem[];
  examples: Example[];
  ev: BoundaryEvidence;
  linePins: LinePins[];
}

interface Hyper {
  epochs: number;
  lr: number;
  l2: number;
  tauSec: number;
}

function sylCount(line: ConsensusLine): number {
  return line.words.reduce((s, w) => s + (w.syl && w.syl.length > 0 ? w.syl.length : 1), 0);
}

function gtBoundaries(line: ConsensusLine): number[] {
  const starts: number[] = [];
  let lastEnd = 0;
  for (const w of line.words) {
    for (const s of w.syl && w.syl.length > 0 ? w.syl : [[w.start, w.end] as [number, number]]) {
      starts.push(s[0]);
      lastEnd = s[1];
    }
  }
  starts.push(lastEnd);
  return starts;
}

/** exp(-|c - gt| / tau) per candidate (normalised); tau 0 gives the one-hot closest-candidate target. */
function softTarget(prob: LineProblem, gt: number[], hard: number[], tauSec: number): Float64Array[] {
  return prob.cands.map((cs, j) => {
    const q = new Float64Array(cs.length);
    if (tauSec <= 0 || cs.length === 1) {
      q[hard[j]!] = 1;
      return q;
    }
    let sum = 0;
    cs.forEach((c, k) => (sum += q[k] = Math.exp(-Math.abs(c - gt[j]!) / tauSec)));
    for (let k = 0; k < q.length; k++) q[k] = q[k]! / sum;
    return q;
  });
}

/** Builds DP problems and training examples around a prior (the consensus output, or a previous stage's output). */
function makeSong(base: Pick<SongData, 'id' | 'truth' | 'ev' | 'linePins'>, prior: ConsensusLine[], hyper: Hyper): SongData {
  const problems = buildProblems(prior, base.ev, base.linePins.map((p) => p.pins));
  const examples: Example[] = [];
  const noWeights = new Float64Array(0);
  problems.forEach((prob, li) => {
    const truthLine = base.truth[li];
    if (!truthLine || sylCount(prior[li]!) !== sylCount(truthLine) || prob.sylRefs.length < 2) return;
    const gt = gtBoundaries(truthLine);
    const closeness = prob.cands.map((cs, j) => cs.map((c) => -Math.abs(c - gt[j]!) * 1000));
    const target = decodeLine(prob, noWeights, closeness);
    examples.push({ prob, gt, soft: softTarget(prob, gt, target, hyper.tauSec) });
  });
  return { ...base, prior, problems, examples };
}

/** Adagrad on the L2-regularised CRF negative log-likelihood. */
function fit(examples: Example[], size: number, hyper: Hyper): Float64Array {
  const w = new Float64Array(size);
  const g2 = new Float64Array(size);
  const grad = new Float64Array(size);
  const order = examples.map((_, i) => i);
  let seed = 777;
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let ep = 0; ep < hyper.epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const idx of order) {
      const ex = examples[idx]!;
      grad.fill(0);
      accumulateNllGradient(ex.prob, w, ex.soft, grad);
      for (let k = 0; k < size; k++) {
        const g = grad[k]!;
        if (g === 0 && w[k] === 0) continue;
        const gk = g + hyper.l2 * w[k]!;
        g2[k] = g2[k]! + gk * gk;
        w[k] = w[k]! - (hyper.lr * gk) / (Math.sqrt(g2[k]!) + 1e-8);
      }
    }
  }
  return w;
}

function metric(gen: ConsensusLine[], truth: Array<ConsensusLine | null>): Mae {
  let s = 0;
  let e = 0;
  let n = 0;
  for (let li = 0; li < Math.min(gen.length, truth.length); li++) {
    const cl = truth[li];
    if (!cl) continue;
    const gl = gen[li]!;
    for (let wi = 0; wi < Math.min(gl.words.length, cl.words.length); wi++) {
      const gw = gl.words[wi]!;
      const cw = cl.words[wi]!;
      const cs = cw.syl ?? [[cw.start, cw.end] as [number, number]];
      const gs = gw.syl ?? [[gw.start, gw.end] as [number, number]];
      for (let si = 0; si < Math.min(cs.length, gs.length); si++) {
        s += Math.abs(gs[si]![0] - cs[si]![0]);
        e += Math.abs(gs[si]![1] - cs[si]![1]);
        n++;
      }
    }
  }
  return { start: (s / n) * 1000, end: (e / n) * 1000, n };
}

/** Stage 2 re-runs the DP with a song's stage-1 output as its prior. */
function toStage2(d: SongData, w1: Float64Array, hyper: Hyper): SongData {
  const next = makeSong(d, applyProblems(d.prior, d.problems, w1), hyper);
  next.problems.forEach(prepareProblem);
  return next;
}

/** Stage-2 weights for `train`, fit on out-of-fold stage-1 priors (each song's stage 1 uses weights fit without that song). */
function fitStage2(train: SongData[], size: number, hyper: Hyper): Float64Array {
  const s2 = train.map((t) => toStage2(t, fit(train.filter((o) => o.id !== t.id).flatMap((o) => o.examples), size, hyper), hyper));
  return fit(s2.flatMap((d) => d.examples), featureCount(), hyper);
}

function overall(parts: Mae[]): number {
  const total = parts.reduce((s, p) => s + p.n, 0);
  const start = parts.reduce((s, p) => s + p.start * p.n, 0) / total;
  const end = parts.reduce((s, p) => s + p.end * p.n, 0) / total;
  return (start + end) / 2;
}

export function trainMode(songs: TrainingSong[], mode: TrainMode, options: TrainOptions = {}): TrainResult {
  if (songs.length < 3) throw new Error(`Training needs at least 3 annotated songs to report a held-out result (got ${songs.length}).`);
  const say = options.onProgress ?? (() => {});
  const hyper: Hyper = { epochs: options.epochs ?? 3, lr: options.lr ?? 0.1, l2: options.l2 ?? 0.2, tauSec: (options.tauMs ?? 4) / 1000 };

  const data: SongData[] = songs.map((song) => {
    const anchors = mode === 'anchored' ? song.anchors : emptyAnchors();
    const sliced = mode === 'anchored' ? song.sliced : {};
    const { consensus, linePins, ev } = prepareSolve({ evidence: song.evidence, anchors, sliced });
    return makeSong({ id: song.id, truth: song.truth, ev, linePins }, consensus, hyper);
  });
  for (const d of data) d.problems.forEach(prepareProblem);
  const size = featureCount();
  say(`${mode}: ${data.reduce((s, d) => s + d.examples.length, 0)} training lines, ${size} features`);

  const reports: SongReport[] = [];
  const heldOut: Record<string, FittedStages> = {};
  for (const held of data) {
    const train = data.filter((d) => d.id !== held.id);
    const w1 = fit(train.flatMap((d) => d.examples), size, hyper);
    const gen1 = applyProblems(held.prior, held.problems, w1);
    const w2 = fitStage2(train, size, hyper);
    const held2 = toStage2(held, w1, hyper);
    const gen2 = applyProblems(held2.prior, held2.problems, w2);
    heldOut[held.id] = { stage1: vecToWeights(w1), stage2: vecToWeights(w2) };
    const report: SongReport = { id: held.id, consensus: metric(held.prior, held.truth), stage1: metric(gen1, held.truth), stage2: metric(gen2, held.truth) };
    reports.push(report);
    say(`${mode} held-out ${held.id}: consensus ${((report.consensus.start + report.consensus.end) / 2).toFixed(2)} ms, stage 1 ${((report.stage1.start + report.stage1.end) / 2).toFixed(2)} ms, stage 2 ${((report.stage2.start + report.stage2.end) / 2).toFixed(2)} ms`);
  }

  const all1 = fit(data.flatMap((d) => d.examples), size, hyper);
  const all2 = fitStage2(data, size, hyper);
  const heldOut1 = overall(reports.map((r) => r.stage1));
  const heldOut2 = overall(reports.map((r) => r.stage2));
  // A second stage ships only if it improves the held-out result: it can compound stage-1 errors (it did in free mode on the reference songs).
  const stages = heldOut2 < heldOut1 ? 2 : 1;
  return {
    mode,
    stages,
    weights: { stage1: vecToWeights(all1), stage2: stages === 2 ? vecToWeights(all2) : null },
    heldOut,
    songs: reports,
    overall: { consensus: overall(reports.map((r) => r.consensus)), stage1: heldOut1, stage2: heldOut2, shipped: stages === 2 ? heldOut2 : heldOut1 },
  };
}
