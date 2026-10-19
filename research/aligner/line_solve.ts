// Research solver for the line aligner (research/aligner): the consensus prior places each line and gives every boundary its candidate span
// (buildLineSkeleton, as the guided solver); inside the spans the line's boundaries are decoded jointly at 10 ms frames with the model's
// own scores only: unary = E_t . q_j / sqrt(d) + g_t of one head, pair = the learned duration MLP. No votes, no hand constants.
// Then the guided solver's post-processing: beat snap (optional), line-end join / rest, overlap clip.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyPath, buildLineSkeleton } from '../../packages/lyricsync/src/engine/boundary_dp.ts';
import type { ConsensusLine } from '../../packages/lyricsync/src/engine/consensus.ts';
import { audioOnsets, clipLineOverlaps, eighthGrid, GUIDED_DESIGN, joinLineEnds, lineEvents, pairTables, unaryRows, type GuidedDesign } from '../../packages/lyricsync/src/engine/guided.ts';
import { fitLineExtents, prepareSolve } from '../../packages/lyricsync/src/engine/solve.ts';
import type { SolveInput } from '../../packages/lyricsync/src/types.ts';

export type Head = 'onset' | 'vowel';
const MIN_DUR = 3;
const MAX_DUR = 400;
const NEG = -1e9;
/** Frames either side of a boundary's candidate span that the chain may use (as the guide's softmax margin). */
const MARGIN = 10;

interface Mlp { w1: number[][]; b1: number[]; w2: number[][]; b2: number[] }
export interface LineModelExport {
  fps: number;
  dim: number;
  frames: Record<Head, Float32Array>;
  total: number;
  lines: Map<number, { q: Record<Head, number[][]>; codes: number[][] }>;
  pair: Record<Head, Mlp>;
}

export function loadLineExport(workspace: string, dir: string): LineModelExport {
  const meta = JSON.parse(fs.readFileSync(path.join(workspace, dir, 'line.json'), 'utf8')) as {
    fps: number; dim: number; frames: number; lines: Array<{ index: number; q: Record<Head, number[][]>; codes: number[][] }>;
  };
  const read = (h: Head): Float32Array => {
    const buf = fs.readFileSync(path.join(workspace, dir, `frames_${h}.f32`));
    const out = new Float32Array(buf.byteLength / 4);
    new Uint8Array(out.buffer).set(buf);
    if (out.length !== meta.frames * (meta.dim + 1)) throw new Error(`frames_${h}.f32: ${out.length} floats, expected ${meta.frames * (meta.dim + 1)}`);
    return out;
  };
  return {
    fps: meta.fps,
    dim: meta.dim,
    total: meta.frames,
    frames: { onset: read('onset'), vowel: read('vowel') },
    lines: new Map(meta.lines.map((l) => [l.index, { q: l.q, codes: l.codes }])),
    pair: JSON.parse(fs.readFileSync(path.join(workspace, dir, 'pair.json'), 'utf8')) as Record<Head, Mlp>,
  };
}

function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/** Pair score of every duration 0..MAX_DUR frames for one syllable (NEG below MIN_DUR); mirrors LineAligner.pair_table. */
function pairTable(mlp: Mlp, code: number[], meanDur: number, fps: number): Float64Array {
  const out = new Float64Array(MAX_DUR + 1).fill(NEG);
  const hidden = mlp.b1.length;
  for (let d = MIN_DUR; d <= MAX_DUR; d++) {
    const ratio = Math.log(d / Math.max(meanDur, 1));
    const x = [Math.log(d / fps), ratio, ratio * ratio, d < 12 ? 1 : 0, ...code];
    let y = mlp.b2[0]!;
    for (let k = 0; k < hidden; k++) {
      let z = mlp.b1[k]!;
      const w = mlp.w1[k]!;
      for (let i = 0; i < x.length; i++) z += w[i]! * x[i]!;
      y += mlp.w2[0]![k]! * (0.5 * z * (1 + erf(z / Math.SQRT2)));
    }
    out[d] = y;
  }
  return out;
}

function nearestBeat(beats: number[], t: number): number | undefined {
  let best: number | undefined;
  for (const b of beats) if (best === undefined || Math.abs(b - t) < Math.abs(best - t)) best = b;
  return best;
}

/** votes > 0: the guided solver's evidence votes and prior term (unaryRows, no guide) are added to the model's unary, times `votes`.
 *  pairVotes > 0: its syllable terms (pairTables: duration, 16th phase, notes inside, nucleus posterior) are added to the pair, times `pairVotes`. */
export function solveLineModel(input: Omit<SolveInput, 'weights'> & { model: LineModelExport; head: Head; design?: Partial<GuidedDesign>; votes?: number; pairVotes?: number }): { lines: ConsensusLine[] } {
  const D: GuidedDesign = { ...GUIDED_DESIGN, ...input.design };
  const M = input.model;
  const fr = M.frames[input.head];
  const stride = M.dim + 1;
  const scale = 1 / Math.sqrt(M.dim);
  const votes = input.votes ?? 0;
  const pairVotes = input.pairVotes ?? 0;
  const { consensus, linePins, ev } = prepareSolve(input);
  const lines: ConsensusLine[] = structuredClone(consensus);
  const order = linePins.map((_, i) => i).sort((a, b) => linePins[a]!.lineIndex - linePins[b]!.lineIndex);
  const pinnedEnd = new Map(linePins.flatMap((lp) => (lp.pins[lp.syllableCount] === undefined ? [] : [[lp.lineIndex, lp.pins[lp.syllableCount]!] as const])));
  const beats = input.evidence.beats;
  const eighths = votes > 0 || pairVotes > 0 ? eighthGrid(ev.events, D) : [];
  const audio = (votes > 0 || pairVotes > 0) && D.audioVote > 0 ? audioOnsets(input.evidence.audio, input.evidence.sampleRate, D) : [];
  for (const i of order) {
    const lp = linePins[i]!;
    const line = lines[lp.lineIndex]!;
    const sk = buildLineSkeleton(line, lp.lineIndex, ev, lp.pins);
    const lm = M.lines.get(lp.lineIndex);
    if (!lm || lm.q[input.head].length !== sk.cands.length) throw new Error(`line model has no queries for line ${lp.lineIndex} (or another syllable count)`);
    const prev = lines[lp.lineIndex - 1];
    const prevSyl = prev?.words[prev.words.length - 1]!.syl!;
    const bound = prevSyl ? Math.max(prevSyl[prevSyl.length - 1]![0] + D.minSylSec, pinnedEnd.get(lp.lineIndex - 1) ?? -Infinity) : -Infinity;
    const m = sk.cands.length - 1;
    // Each boundary's frames (a pinned boundary: its exact time, as one frame) and their unary scores.
    const wins: number[][] = [];
    const times: number[][] = [];
    const un: Float64Array[] = [];
    for (let j = 0; j <= m; j++) {
      const pin = lp.pins[j];
      if (pin !== undefined) {
        wins.push([Math.round(pin * M.fps)]);
        times.push([pin]);
        un.push(Float64Array.of(0));
        continue;
      }
      const c = sk.cands[j]!;
      const lo = Math.max(0, Math.floor(c[0]! * M.fps) - MARGIN, Number.isFinite(bound) ? Math.ceil((bound + j * D.minSylSec) * M.fps) : 0);
      const hi = Math.min(M.total - 1, Math.ceil(c[c.length - 1]! * M.fps) + MARGIN);
      const w: number[] = [];
      for (let f = lo; f <= Math.max(lo, hi); f++) w.push(Math.min(f, M.total - 1));
      const q = lm.q[input.head][j]!;
      wins.push(w);
      times.push(w.map((f) => f / M.fps));
      un.push(Float64Array.from(w, (f) => {
        let s = fr[f * stride + M.dim]!;
        for (let k = 0; k < M.dim; k++) s += fr[f * stride + k]! * q[k]! * scale;
        return s;
      }));
    }
    let handPairs: Float64Array[] | null = null;
    if (votes > 0 || pairVotes > 0) {
      const prior = sk.cands;
      sk.cands = times;
      const le = lineEvents(sk, eighths, audio, D);
      if (votes > 0) unaryRows(sk, le, lp.pins, null, D).forEach((row, j) => row.forEach((v, k) => { un[j]![k]! += votes * v; }));
      if (pairVotes > 0) handPairs = pairTables(sk, le, D);
      sk.cands = prior;
    }
    const meanDur = sk.meanDur * M.fps;
    const pairs = lm.codes.map((code) => pairTable(M.pair[input.head], code, meanDur, M.fps));
    // Viterbi over frames.
    let score = Float64Array.from(un[0]!);
    const back: Int32Array[] = [];
    for (let j = 1; j <= m; j++) {
      const A = wins[j - 1]!;
      const B = wins[j]!;
      const P = pairs[j - 1]!;
      const H = handPairs?.[j - 1];
      const next = new Float64Array(B.length).fill(NEG);
      const arg = new Int32Array(B.length);
      for (let b = 0; b < B.length; b++) {
        for (let a = 0; a < A.length; a++) {
          const d = B[b]! - A[a]!;
          if (d < MIN_DUR || score[a]! <= NEG / 2) continue;
          let s = score[a]! + P[Math.min(d, MAX_DUR)]!;
          if (H) s += pairVotes * H[a * B.length + b]!;
          if (s > next[b]!) { next[b] = s; arg[b] = a; }
        }
        next[b]! += un[j]![b]!;
      }
      back.push(arg);
      score = next;
    }
    const path = new Array<number>(m + 1);
    let cur = 0;
    for (let k = 1; k < score.length; k++) if (score[k]! > score[cur]!) cur = k;
    for (let j = m; j >= 0; j--) {
      path[j] = cur;
      if (j > 0) cur = back[j - 1]![cur]!;
    }
    const t = path.map((k, j) => times[j]![k]!);
    // Beat snap: an unpinned boundary within beatSnapSec of a beat moves onto it when its neighbours stay minSylSec away.
    if (D.beatSnapSec > 0) {
      for (let j = 0; j <= m; j++) {
        if (lp.pins[j] !== undefined) continue;
        const b = nearestBeat(beats, t[j]!);
        if (b === undefined || Math.abs(b - t[j]!) > D.beatSnapSec) continue;
        if ((j > 0 && b - t[j - 1]! < D.minSylSec) || (j < m && t[j + 1]! - b < D.minSylSec)) continue;
        t[j] = b;
      }
    }
    sk.cands = t.map((x) => [x]);
    applyPath(line, sk, t.map(() => 0));
  }
  joinLineEnds(lines, linePins, [...input.evidence.rmvpeNotes, ...input.evidence.harmoNotes], D);
  clipLineOverlaps(lines, new Set(pinnedEnd.keys()));
  fitLineExtents(lines);
  return { lines };
}
