// src/engine/solve.ts
// The whole timing solve over in-memory evidence:
//   per line: consensus input (sliced alignment when the line is anchored, full-song alignment otherwise) with pinned boundaries written in
//   -> refineAlignment (multi-pitch-tracker + beat-grid + acoustic-edge consensus)
//   -> boundary CRF/DP stage 1 -> stage 2 (re-run on stage 1's output as the prior), MBR decoded, pinned boundaries exact.
// A line is ANCHORED (solved with the anchored weights and the per-line sliced alignments) iff both its edges are pinned; all other lines use the free weights.
// The training-free alternative over the same starting point lives in analytic.ts; it shares prepareSolve, fitLineExtents and reviewLine.

import type { LineReview, BoundaryReview, SolveInput, SolveOutput, SongEvidence, SlicedAlignment, WeightBundle } from '../types.ts';
import {
  BoundaryEvidence,
  applyPath,
  buildProblems,
  decodeLineMbr,
  nodeMarginals,
  weightsToVec,
  lowerBound,
  type BoundaryEvidenceInputs,
  type LineProblem,
  type LineSkeleton,
} from './boundary_dp.ts';
import { refineAlignment, type ConsensusLine } from './consensus.ts';
import { extractAndValidatePins, pinLineBoundaries, type LinePins } from './pins.ts';

const DEFAULT_LEGATO_GAP_SEC = 0.12;
const MIN_RESPACED_SYL_SEC = 0.02;
const MAX_UNCERTAIN_PER_LINE = 5;

/**
 * Raw forced-aligner sets feed DP features by POSITION (tags raw, raw2, raw3, ...), so the order is part of the trained weights:
 *   en: [fullBase, fullCombined, slicedBase, slicedCombined]    ja: [fullBase, slicedBase]
 * Sliced entries are null for lines that are not anchored; a null entry contributes no features and no candidates for that line.
 */
export function buildRawSets(evidence: SongEvidence, sliced: Record<number, SlicedAlignment>, lineCount: number): Array<Array<ConsensusLine | null>> {
  const slicedBase = Array.from({ length: lineCount }, (_, i) => sliced[i]?.base ?? null);
  if (evidence.language === 'ja') return [evidence.fullBase, slicedBase];
  if (!evidence.fullCombined) throw new Error('English evidence needs the combined-model full-song alignment (fullCombined).');
  const slicedCombined = Array.from({ length: lineCount }, (_, i) => sliced[i]?.combined ?? null);
  return [evidence.fullBase, evidence.fullCombined, slicedBase, slicedCombined];
}

export function boundaryEvidenceInputs(evidence: SongEvidence, rawSets: Array<Array<ConsensusLine | null>>): BoundaryEvidenceInputs {
  return {
    rmvpeNotes: evidence.rmvpeNotes,
    swiftNotes: evidence.swiftNotes,
    harmoNotes: evidence.harmoNotes,
    f0Hz: evidence.f0Hz,
    edgeSets: evidence.edgeSets,
    beats: evidence.beats,
    posteriors: evidence.posteriors,
    nucleusFor: evidence.nucleusFor,
    rawSets,
    audio: evidence.audio,
    sampleRate: evidence.sampleRate,
  };
}

function boundaryTimes(line: ConsensusLine): number[] {
  const t: number[] = [];
  for (const w of line.words) for (const s of w.syl ?? [[w.start, w.end]]) t.push(s[0]);
  const last = line.words[line.words.length - 1]!;
  t.push(last.syl && last.syl.length > 0 ? last.syl[last.syl.length - 1]![1] : last.end);
  return t;
}

/** A pitch-note start this far inside a syllable is singing the syllable does not explain. */
const INSIDE_MARGIN_SEC = 0.03;
/** A line alignment with at least this many unexplained note starts per syllable has collapsed (one syllable swallows the singing of the
 *  next ones), when the other aligner's alignment of the line has at most 1 / COLLAPSE_RATIO of that. */
const COLLAPSE_INSIDE_PER_SYL = 3;
const COLLAPSE_RATIO = 2;

/** Pitch-note starts strictly inside a line's syllables (boundary times t), per syllable. The last syllable is left out: a held line end
 *  carries melismas. */
function insideStartsPerSyllable(t: number[], noteStarts: number[]): number {
  let inside = 0;
  for (let j = 0; j + 2 < t.length; j++) {
    const lo = t[j]! + INSIDE_MARGIN_SEC;
    const hi = t[j + 1]! - INSIDE_MARGIN_SEC;
    if (hi > lo) inside += lowerBound(noteStarts, hi) - lowerBound(noteStarts, lo);
  }
  return inside / (t.length - 1);
}

function sameSyllables(a: ConsensusLine, b: ConsensusLine): boolean {
  return a.words.length === b.words.length && a.words.every((w, i) => (w.syl?.length ?? 1) === (b.words[i]!.syl?.length ?? 1));
}

/** The line's consensus input: the primary aligner's alignment, or the other aligner's when the primary one collapsed and the other did not. */
function lineInput(primary: ConsensusLine, other: ConsensusLine | null | undefined, noteStarts: number[]): ConsensusLine {
  if (!other || !sameSyllables(primary, other)) return primary;
  const p = insideStartsPerSyllable(boundaryTimes(primary), noteStarts);
  return p >= COLLAPSE_INSIDE_PER_SYL && p >= COLLAPSE_RATIO * insideStartsPerSyllable(boundaryTimes(other), noteStarts) ? other : primary;
}

/**
 * Interior pins can contradict the alignment: a pinned boundary may land past its neighbours. Runs of unpinned boundaries that are no longer a valid
 * tiling are re-laid while keeping the syllables' ORIGINAL durations in proportion: between two pins they are squeezed or stretched to fit,
 * before the first pin / after the last pin they are shifted so the run keeps its original syllable lengths starting from the pin.
 * `original` are the boundary times before any pin was written in.
 */
function respaceAroundPins(line: ConsensusLine, pins: Array<number | undefined>, original: number[]): void {
  const times = boundaryTimes(line);
  const m = times.length - 1;
  const dur = (j: number): number => Math.max(MIN_RESPACED_SYL_SEC, original[j + 1]! - original[j]!);
  const broken = (from: number, to: number): boolean => {
    for (let j = from + 1; j <= to; j++) if (times[j]! < times[j - 1]! + MIN_RESPACED_SYL_SEC) return true;
    return false;
  };
  const pinned = pins.map((p, j) => (p !== undefined ? j : -1)).filter((j) => j >= 0);
  const first = pinned[0]!;
  const last = pinned[pinned.length - 1]!;
  if (first > 0 && broken(0, first)) for (let j = first - 1; j >= 0; j--) times[j] = times[j + 1]! - dur(j);
  if (last < m && broken(last, m)) for (let j = last + 1; j <= m; j++) times[j] = times[j - 1]! + dur(j - 1);
  for (let k = 0; k + 1 < pinned.length; k++) {
    const a = pinned[k]!;
    const b = pinned[k + 1]!;
    if (b - a < 2 || !broken(a, b)) continue;
    const weights = Array.from({ length: b - a }, (_, i) => dur(a + i));
    const total = weights.reduce((s, x) => s + x, 0);
    let acc = times[a]!;
    for (let j = a + 1; j < b; j++) {
      acc += ((times[b]! - times[a]!) * weights[j - a - 1]!) / total;
      times[j] = acc;
    }
  }
  let flat = 0;
  for (const w of line.words) {
    const syl = w.syl ?? [[w.start, w.end]];
    for (let s = 0; s < syl.length; s++, flat++) syl[s] = [times[flat]!, times[flat + 1]!];
    w.syl = syl;
    w.start = syl[0]![0];
    w.end = syl[syl.length - 1]![1];
  }
  line.start = times[0]!;
  line.end = times[m]!;
}

function pinInputLine(line: ConsensusLine, pins: Array<number | undefined>): void {
  if (pins.every((p) => p === undefined)) return;
  // Interior pins can contradict the alignment; edge-only pins leave the alignment untouched (the validated research path).
  const interior = pins.some((p, j) => p !== undefined && j > 0 && j < pins.length - 1);
  const original = interior ? boundaryTimes(line) : [];
  pinLineBoundaries(line, pins);
  if (interior) {
    respaceAroundPins(line, pins, original);
    pinLineBoundaries(line, pins);
  }
}

interface StageResult {
  lines: ConsensusLine[];
  problems: LineProblem[];
  /** Weight vector per line; null where that line's mode has no weights for this stage (the line passes through unchanged). */
  vectors: Array<Float64Array | null>;
}

function runStage(lines: ConsensusLine[], ev: BoundaryEvidence, linePins: LinePins[], stage: 'stage1' | 'stage2', weights: WeightBundle): StageResult {
  const problems = buildProblems(lines, ev, linePins.map((p) => p.pins));
  // weightsToVec interns every named feature, so it runs after the problems have interned theirs
  const anchored = weights.anchored[stage];
  const free = weights.free[stage];
  const anchoredVec = anchored ? weightsToVec(anchored) : null;
  const freeVec = free ? weightsToVec(free) : null;
  const vectors = linePins.map((p) => (p.isAnchored ? anchoredVec : freeVec));
  const out = structuredClone(lines);
  out.forEach((line, li) => {
    const prob = problems[li]!;
    const wv = vectors[li];
    if (!wv || prob.sylRefs.length < 2) return;
    applyPath(line, prob, decodeLineMbr(prob, wv));
  });
  return { lines: out, problems, vectors };
}

/** Expected distance (seconds) of a time from boundary j's candidates under the chain marginals; null without marginals. */
export function marginalError(prob: LineSkeleton, marginals: Float64Array[] | null): ((j: number, time: number) => number) | null {
  if (!marginals) return null;
  return (j, time) => {
    const cands = prob.cands[j]!;
    const marg = marginals[j]!;
    let e = 0;
    for (let k = 0; k < cands.length; k++) e += marg[k]! * Math.abs(time - cands[k]!);
    return e;
  };
}

/** A line's review: `errorSec(j, time)` is the expected error of boundary j at its decoded time (null = no uncertainty estimate, 0 ms). */
export function reviewLine(prob: LineSkeleton, errorSec: ((j: number, time: number) => number) | null, finalLine: ConsensusLine, lp: LinePins): LineReview {
  const times: number[] = [];
  for (const w of finalLine.words) for (const s of w.syl ?? [[w.start, w.end]]) times.push(s[0]);
  times.push(finalLine.end);
  const boundaries: BoundaryReview[] = times.map((time, j) => {
    const pinned = lp.pins[j] !== undefined;
    const expectedErrorMs = errorSec && !pinned ? errorSec(j, time) * 1000 : 0;
    return { boundary: j, time, expectedErrorMs, anchored: pinned, syllable: prob.sylRefs[j]?.text ?? '' };
  });
  const free = boundaries.filter((b) => !b.anchored);
  const mean = free.length === 0 ? 0 : free.reduce((s, b) => s + b.expectedErrorMs, 0) / free.length;
  return {
    line: lp.lineIndex,
    mode: lp.isAnchored ? 'anchored' : 'free',
    meanExpectedErrorMs: mean,
    uncertain: [...free].sort((a, b) => b.expectedErrorMs - a.expectedErrorMs).slice(0, MAX_UNCERTAIN_PER_LINE),
  };
}

/** Everything the DP stages start from: the pinned, consensus-refined lines, each line's pins and the shared boundary evidence. */
export interface PreparedSolve {
  consensus: ConsensusLine[];
  linePins: LinePins[];
  ev: BoundaryEvidence;
}

export function prepareSolve(input: Omit<SolveInput, 'weights'>): PreparedSolve {
  const { evidence, anchors, sliced } = input;
  const lineCount = evidence.fullBase.length;

  // Consensus input per line, pins resolved against its syllable structure. The base model's alignment, unless it collapsed on the line and
  // the combined model's did not (see lineInput).
  const noteStarts = [...evidence.rmvpeNotes, ...evidence.harmoNotes].map((n) => n.start).sort((a, b) => a - b);
  const inputs: ConsensusLine[] = [];
  for (let i = 0; i < lineCount; i++) inputs.push(structuredClone(lineInput(evidence.fullBase[i]!, evidence.fullCombined?.[i], noteStarts)));
  let linePins = extractAndValidatePins(inputs, anchors, sliced);
  for (const lp of linePins) {
    const s = sliced[lp.lineIndex]!;
    if (lp.isAnchored) inputs[lp.lineIndex] = structuredClone(lineInput(s.base, s.combined, noteStarts));
  }
  linePins = extractAndValidatePins(inputs, anchors, sliced);
  linePins.forEach((lp) => pinInputLine(inputs[lp.lineIndex]!, lp.pins));
  // If unpinned lines sit past a follower line's pinned start, rescale them so they sit before the pin.
  for (let i = inputs.length - 2; i >= 0; i--) {
    const nextStart = inputs[i + 1]!.start;
    const cur = inputs[i]!;
    if (cur.end > nextStart) {
      const prevEnd = i > 0 ? inputs[i - 1]!.end : 0;
      const available = nextStart - prevEnd;
      if (available > 0.05) {
        const curDur = cur.end - cur.start;
        const scale = Math.min(1, (available - 0.02) / Math.max(0.01, curDur));
        const newStart = Math.max(prevEnd + 0.01, nextStart - curDur * scale - 0.01);
        const newEnd = nextStart - 0.01;
        const tOld = boundaryTimes(cur);
        const t0 = tOld[0]!;
        const span = Math.max(1e-4, tOld[tOld.length - 1]! - t0);
        const tNew = tOld.map((t) => newStart + ((t - t0) / span) * (newEnd - newStart));
        let flat = 0;
        for (const w of cur.words) {
          const syl = w.syl ?? [[w.start, w.end]];
          for (let s = 0; s < syl.length; s++, flat++) syl[s] = [tNew[flat]!, tNew[flat + 1]!];
          w.syl = syl;
          w.start = syl[0]![0];
          w.end = syl[syl.length - 1]![1];
        }
        cur.start = newStart;
        cur.end = newEnd;
      }
    }
  }

  const consensus = refineAlignment(inputs, {
    swiftNotes: evidence.swiftNotes,
    harmoNotes: evidence.harmoNotes,
    rmvpeNotes: evidence.rmvpeNotes,
    beats: evidence.beats,
    // The weights were trained against a consensus stage without raw audio (default RMS priors); the DP below does use the audio.
    sampleRate: evidence.sampleRate,
    legatoGap: input.options?.legatoGap ?? DEFAULT_LEGATO_GAP_SEC,
    breaths: evidence.breaths,
    edges: evidence.edgeSets[0],
  });
  linePins.forEach((lp) => pinLineBoundaries(consensus[lp.lineIndex]!, lp.pins));
  const ev = new BoundaryEvidence(boundaryEvidenceInputs(evidence, buildRawSets(evidence, sliced, lineCount)));
  return { consensus, linePins, ev };
}

export function solve(input: SolveInput): SolveOutput {
  const { consensus, linePins, ev } = prepareSolve(input);
  const stage1 = runStage(consensus, ev, linePins, 'stage1', input.weights);
  const usesStage2 = linePins.some((p) => (p.isAnchored ? input.weights.anchored : input.weights.free).stage2 !== null);
  const stage2 = usesStage2 ? runStage(stage1.lines, ev, linePins, 'stage2', input.weights) : stage1;
  fitLineExtents(stage2.lines);
  const review = linePins.map((lp) => {
    const i = lp.lineIndex;
    // review against the stage that decoded this line last (a mode without stage-2 weights was decoded by stage 1)
    const last = stage2.vectors[i] ? stage2 : stage1;
    const prob = last.problems[i]!;
    const marginals = prob.sylRefs.length < 2 ? null : nodeMarginals(prob, last.vectors[i]!);
    return reviewLine(prob, marginalError(prob, marginals), stage2.lines[i]!, lp);
  });
  return { lines: stage2.lines, review };
}

/** The DP retimes syllables and words but not the line fields; makes every line's extent agree with its own first and last syllable (a no-op for pinned lines). */
export function fitLineExtents(lines: ConsensusLine[]): void {
  for (const line of lines) {
    const first = line.words[0]!;
    const last = line.words[line.words.length - 1]!;
    line.start = first.syl?.[0]?.[0] ?? first.start;
    line.end = last.syl && last.syl.length > 0 ? last.syl[last.syl.length - 1]![1] : last.end;
  }
}
