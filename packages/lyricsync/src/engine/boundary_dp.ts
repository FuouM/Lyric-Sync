// src/engine/boundary_dp.ts
// Structured-prediction syllable boundary refinement.
//
// Human syllable annotations tile each line: syllable i ends exactly where syllable i+1 starts.
// Alignment therefore reduces to choosing one monotone sequence of interior boundaries per line.
// Every boundary is drawn from a candidate set (acoustic edges, pitch-note onsets/offsets, the
// musical sub-beat grid, raw forced-aligner boundaries and the current estimate) and scored by a
// linear model over multi-source evidence plus pairwise duration plausibility. The best path is
// found with Viterbi; weights are trained with a structured averaged perceptron
// (src/train/train.ts).

import type { ConsensusLine, ConsensusNote } from './consensus.ts';

export type FeatureVec = Array<[string, number]>;
export type Weights = Record<string, number>;

/** Sparse feature vector over interned feature ids. */
export interface CompactFeat {
  ids: Int32Array;
  vals: Float32Array;
}

const featureIdByName = new Map<string, number>();
const featureNameById: string[] = [];

export function featureId(name: string): number {
  let id = featureIdByName.get(name);
  if (id === undefined) {
    id = featureNameById.length;
    featureIdByName.set(name, id);
    featureNameById.push(name);
  }
  return id;
}

export function featureCount(): number {
  return featureNameById.length;
}

export function compactFeatures(f: FeatureVec): CompactFeat {
  const ids = new Int32Array(f.length);
  const vals = new Float32Array(f.length);
  f.forEach(([name, v], i) => {
    ids[i] = featureId(name);
    vals[i] = v;
  });
  return { ids, vals };
}

/** Dense weight vector over every feature interned so far; unknown names in `w` are interned with their weight. */
export function weightsToVec(w: Weights): Float64Array {
  for (const name of Object.keys(w)) featureId(name);
  const vec = new Float64Array(featureCount());
  for (const [name, v] of Object.entries(w)) vec[featureId(name)] = v;
  return vec;
}

export function vecToWeights(vec: Float64Array): Weights {
  const out: Weights = {};
  for (let i = 0; i < vec.length && i < featureNameById.length; i++) {
    if (vec[i] !== 0) out[featureNameById[i]!] = Math.round(vec[i]! * 1e5) / 1e5;
  }
  return out;
}

export interface BoundaryEvidenceInputs {
  rmvpeNotes: ConsensusNote[];
  swiftNotes: ConsensusNote[];
  harmoNotes: ConsensusNote[];
  /** RMVPE f0 contour in Hz at 100 fps from t=0 (0 = unvoiced). */
  f0Hz: number[];
  /** Phoneme-boundary edge peaks, one list per independently trained forced-alignment model. */
  edgeSets: Array<Array<{ t: number; prob: number }>>;
  beats: number[];
  /** Frame-wise phoneme posteriors of the base forced-aligner model (uint8, frame-major, 10 ms frames). */
  posteriors: { frames: number; vocabSize: number; data: Uint8Array; silenceId: number };
  nucleusFor: NucleusResolver;
  /** Raw forced-aligner lines (pre-consensus). Sliced entries for unanchored lines may be null. */
  rawSets: Array<Array<ConsensusLine | null>>;
  /** Vocal audio mono samples; enables RMS onset features. */
  audio?: Float32Array;
  sampleRate?: number;
}

export type BoundaryDpInputs = BoundaryEvidenceInputs;

/** Sorted event lists of the evidence; phoneme-boundary peaks carry their probabilities and the subset with probability >= 0.4. */
export interface EvidenceEvents {
  rmvpeStarts: number[];
  rmvpeEnds: number[];
  swiftStarts: number[];
  swiftEnds: number[];
  harmoStarts: number[];
  harmoEnds: number[];
  beats: number[];
  edgePeaks: Array<{ t: number[]; p: number[]; strong: number[] }>;
}

type BoundaryKind = 'lineStart' | 'lineEnd' | 'word' | 'in';

/** Model-vocabulary phone ids of a syllable (-1 when unknown): vowel nucleus, first and last phone. */
export interface SyllablePhones {
  nucleus: number;
  first: number;
  last: number;
}
export type NucleusResolver = (word: string, sylIdx: number, sylText: string, sylCount: number) => SyllablePhones;

interface SyllableRef {
  wordIdx: number;
  sylIdx: number;
  text: string;
  nucleus: number;
  firstPhone: number;
  lastPhone: number;
}

/** A line's candidate boundaries without any scored features: the starting point both solvers share. */
export interface LineSkeleton {
  lineIdx: number;
  /** Boundary count = syllables + 1. Boundary j is the start of syllable j (end of j-1). */
  prior: number[];
  kinds: BoundaryKind[];
  s16: number[];
  cands: number[][];
  sylRefs: SyllableRef[];
  ev: BoundaryEvidence;
  /** Mean syllable duration of the line (line extent / syllables). */
  meanDur: number;
}

export interface LineProblem extends LineSkeleton {
  unary: CompactFeat[][];
  /** Lazily built pair-feature tables, index j connects boundary j-1 to j. */
  pairTables: Array<PairTable | undefined>;
}

const WINDOW_SEC = 0.8;
const LINE_EDGE_WINDOW_SEC = 1.0;
const NEIGHBOR_SLACK_SEC = 0.8;
export const MIN_SYL_SEC = 0.03;
const DEDUPE_SEC = 0.003;

const DIST_EDGES = [-8, -6, -4, -3, -2, -1.5, -1, -0.75, -0.5, -0.35, -0.2, -0.1, -0.03, 0.03, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const DUR_EDGES = [0.5, 0.8, 1.1, 1.5, 2.0, 3.0, 4.5, 7.0];
const RATIO_EDGES = [-1, -0.5, -0.2, 0.2, 0.5, 1];
const PHASE_EDGES = [0.05, 0.1, 0.2, 0.35];
const PROB_EDGES = [0.05, 0.15, 0.3, 0.5, 0.7, 0.85];
const PROB_DIFF_EDGES = [-0.5, -0.2, -0.05, 0.05, 0.2, 0.5];
const VOICED_EDGES = [0.2, 0.6, 0.9];
const JUMP_EDGES = [0.3, 0.7, 1.2, 2, 4];
const MS_EDGES = [-60, -40, -25, -15, -8, -3, 3, 8, 15, 25, 40, 60];
const WIDE_MS_EDGES = [-120, -90, -60, -40, -25, -15, -8, -3, 3, 8, 15, 25, 40, 60, 90, 120];

function bucket(edges: number[], v: number): number {
  let i = 0;
  while (i < edges.length && v >= edges[i]!) i++;
  return i;
}

export function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearestDist(arr: number[], t: number): number {
  if (arr.length === 0) return Infinity;
  const i = lowerBound(arr, t);
  let best = Infinity;
  if (i < arr.length) best = Math.abs(arr[i]! - t);
  if (i > 0) best = Math.min(best, Math.abs(arr[i - 1]! - t));
  return best;
}

function inRange(arr: number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lowerBound(arr, lo); i < arr.length && arr[i]! <= hi; i++) out.push(arr[i]!);
  return out;
}

function sortedUnique(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

interface F0Stats {
  voicedFrac: number;
  count: number;
  medianSemitone: number;
}

/** 10 ms-frame f0 contour; unvoiced frames are 0 Hz. */
class F0Track {
  private semitones: Float64Array;
  private voiced: Uint8Array;

  constructor(pitchHz: number[]) {
    this.semitones = new Float64Array(pitchHz.length);
    this.voiced = new Uint8Array(pitchHz.length);
    for (let i = 0; i < pitchHz.length; i++) {
      if (pitchHz[i]! > 40) {
        this.voiced[i] = 1;
        this.semitones[i] = 12 * Math.log2(pitchHz[i]! / 55);
      }
    }
  }

  stats(a: number, b: number): F0Stats {
    const fa = Math.max(0, Math.round(a * 100));
    const fb = Math.min(this.voiced.length, Math.round(b * 100));
    const vals: number[] = [];
    let total = 0;
    for (let i = fa; i < fb; i++) {
      total++;
      if (this.voiced[i]) vals.push(this.semitones[i]!);
    }
    if (total === 0) return { voicedFrac: 0, count: 0, medianSemitone: 0 };
    vals.sort((x, y) => x - y);
    return { voicedFrac: vals.length / total, count: vals.length, medianSemitone: vals.length ? vals[vals.length >> 1]! : 0 };
  }
}

/** Frame-wise phoneme posteriors with per-phone prefix sums for O(1) interval means. */
class Posteriorgram {
  readonly silenceId: number;
  private frames: number;
  private vocabSize: number;
  private data: Uint8Array;
  private prefix = new Map<number, Float32Array>();

  constructor(post: BoundaryDpInputs['posteriors']) {
    this.frames = post.frames;
    this.vocabSize = post.vocabSize;
    this.data = post.data;
    this.silenceId = post.silenceId;
  }

  private prefixFor(phone: number): Float32Array {
    let p = this.prefix.get(phone);
    if (!p) {
      p = new Float32Array(this.frames + 1);
      for (let t = 0; t < this.frames; t++) p[t + 1] = p[t]! + this.data[t * this.vocabSize + phone]! / 255;
      this.prefix.set(phone, p);
    }
    return p;
  }

  /** Mean posterior of `phone` over [a, b) seconds (0 when the interval is empty). */
  meanProb(phone: number, a: number, b: number): number {
    const fa = Math.max(0, Math.min(this.frames, Math.round(a * 100)));
    const fb = Math.max(0, Math.min(this.frames, Math.round(b * 100)));
    if (fb <= fa) return 0;
    const p = this.prefixFor(phone);
    return (p[fb]! - p[fa]!) / (fb - fa);
  }
}

class RmsEnvelope {
  private prefix: Float64Array;
  private frames: number;
  private frameSec: number;

  constructor(audio: Float32Array, sampleRate: number, frameSec = 0.01) {
    this.frameSec = frameSec;
    const hop = Math.round(sampleRate * frameSec);
    this.frames = Math.floor(audio.length / hop);
    this.prefix = new Float64Array(this.frames + 1);
    for (let f = 0; f < this.frames; f++) {
      let e = 0;
      const base = f * hop;
      for (let k = 0; k < hop; k++) {
        const x = audio[base + k]!;
        e += x * x;
      }
      this.prefix[f + 1] = this.prefix[f]! + e / hop;
    }
  }

  /** Mean RMS over [a, b) seconds. */
  mean(a: number, b: number): number {
    const fa = Math.max(0, Math.min(this.frames, Math.round(a / this.frameSec)));
    const fb = Math.max(0, Math.min(this.frames, Math.round(b / this.frameSec)));
    if (fb <= fa) return 0;
    return Math.sqrt((this.prefix[fb]! - this.prefix[fa]!) / (fb - fa));
  }
}

function codaClass(text: string): string {
  const t = text.toLowerCase().replace(/[^a-z']/g, '');
  if (t.length === 0) return 'c';
  const last = t[t.length - 1]!;
  if (/[aeiouy]/.test(last)) return 'v';
  if (/[mnl]/.test(last)) return 'n';
  if (/[sfhzxv]/.test(last)) return 'f';
  if (/[tkpdbgc]/.test(last)) return 'p';
  return 'c';
}

function onsetClass(text: string): string {
  const t = text.toLowerCase().replace(/[^a-z']/g, '');
  if (t.length === 0) return 'c';
  if (/^[aeiou]/.test(t)) return 'v';
  if (/^(sh|ch|th|ts|s|f|h|t|k|p|c|x)/.test(t)) return 'u';
  if (/^[yw]/.test(t)) return 'g';
  return 'c';
}

export class BoundaryEvidence {
  private rs: number[];
  private re: number[];
  private ss: number[];
  private se: number[];
  private hs: number[];
  private he: number[];
  private edgeSets: Array<{ t: number[]; p: number[]; strong: number[] }>;
  private grid16: number[] = [];
  private beatsArr: number[];
  private eighths: number[] = [];
  private rms: RmsEnvelope | null;
  private f0: F0Track;
  private post: Posteriorgram;
  readonly nucleusFor: NucleusResolver;
  private rawLinesStore: Array<Array<ConsensusLine | null>>;
  private rawTimes: number[][];
  private rmvpeN: ConsensusNote[];
  private rmvpeNS: number[];
  private harmoN: ConsensusNote[];
  private harmoNS: number[];

  constructor(inputs: BoundaryEvidenceInputs) {
    const starts = (n: ConsensusNote[]) => sortedUnique(n.map((x) => x.start));
    const ends = (n: ConsensusNote[]) => sortedUnique(n.map((x) => x.end));
    this.rs = starts(inputs.rmvpeNotes);
    this.re = ends(inputs.rmvpeNotes);
    this.ss = starts(inputs.swiftNotes);
    this.se = ends(inputs.swiftNotes);
    const harmo = inputs.harmoNotes.filter((h) => !h.pitchHz || h.pitchHz >= 100);
    this.hs = starts(harmo);
    this.he = ends(harmo);
    this.edgeSets = inputs.edgeSets.map((set) => {
      const sorted = [...set].sort((a, b) => a.t - b.t);
      return { t: sorted.map((e) => e.t), p: sorted.map((e) => e.prob), strong: sorted.filter((e) => e.prob >= 0.4).map((e) => e.t) };
    });
    this.beatsArr = sortedUnique(inputs.beats);
    for (let i = 0; i < this.beatsArr.length - 1; i++) {
      const a = this.beatsArr[i]!;
      const d = this.beatsArr[i + 1]! - a;
      for (let k = 0; k < 4; k++) this.grid16.push(a + (d * k) / 4);
      this.eighths.push(a + d / 2);
    }
    const rawTimes = (lines: Array<ConsensusLine | null>): number[] => {
      const out: number[] = [];
      for (const l of lines) {
        if (!l) continue;
        for (const w of l.words ?? []) {
          for (const s of w.syl && w.syl.length > 0 ? w.syl : [[w.start, w.end] as [number, number]]) {
            out.push(s[0], s[1]);
          }
        }
      }
      return sortedUnique(out);
    };
    this.rawTimes = inputs.rawSets.map(rawTimes);
    this.rawLinesStore = inputs.rawSets;
    const byStart = (n: ConsensusNote[]) => [...n].sort((a, b) => a.start - b.start);
    this.rmvpeN = byStart(inputs.rmvpeNotes);
    this.rmvpeNS = this.rmvpeN.map((n) => n.start);
    this.harmoN = byStart(harmo);
    this.harmoNS = this.harmoN.map((n) => n.start);
    this.rms = inputs.audio ? new RmsEnvelope(inputs.audio, inputs.sampleRate ?? 44100) : null;
    this.f0 = new F0Track(inputs.f0Hz);
    this.post = new Posteriorgram(inputs.posteriors);
    this.nucleusFor = inputs.nucleusFor;
  }

  /** Local beat duration around time t (seconds). */
  beatDur(t: number): number {
    const b = this.beatsArr;
    if (b.length < 2) return 0.5;
    const i = Math.min(b.length - 2, Math.max(0, lowerBound(b, t) - 1));
    return Math.max(0.2, b[i + 1]! - b[i]!);
  }

  /** Raw forced-aligner boundaries (set 0 or 1) for a line, index-aligned with the m syllables (m+1 boundaries). */
  rawBoundarySets(lineIdx: number, m: number): Array<number[] | null> {
    return this.rawLinesStore.map((_, set) => this.rawBoundaries(lineIdx, m, set));
  }

  rawBoundaries(lineIdx: number, m: number, set: number): number[] | null {
    const line = this.rawLinesStore[set]?.[lineIdx];
    if (!line) return null;
    const out: number[] = [];
    let last = 0;
    for (const w of line.words ?? []) {
      for (const s of w.syl && w.syl.length > 0 ? w.syl : [[w.start, w.end] as [number, number]]) {
        out.push(s[0]);
        last = s[1];
      }
    }
    out.push(last);
    return out.length === m + 1 ? out : null;
  }

  private coveredBy(notes: ConsensusNote[], starts: number[], t: number): boolean {
    const i = lowerBound(starts, t + 1e-9) - 1;
    for (let k = i; k >= 0 && k > i - 3; k--) {
      if (notes[k]!.end > t) return true;
    }
    return false;
  }

  /** Segment features: how strongly the syllable's nucleus phone is active inside [a, b]. */
  nucleusSegmentFeatures(nucleus: number, a: number, b: number, kind: BoundaryKind): FeatureVec {
    const out: FeatureVec = [];
    const margin = b - a > 0.12 ? 0.03 : 0;
    const mean = nucleus >= 0 ? this.post.meanProb(nucleus, a + margin, b - margin) : -1;
    const sil = this.post.meanProb(this.post.silenceId, a + margin, b - margin);
    if (mean >= 0) {
      const nb = bucket(PROB_EDGES, mean);
      out.push([`nuc:${nb}`, 1], [`${kind}:nuc:${nb}`, 1], ['nucMean', mean], [`${kind}:nucMean`, mean]);
      const innerStart = this.post.meanProb(nucleus, a, Math.min(b, a + 0.06));
      const innerEnd = this.post.meanProb(nucleus, Math.max(a, b - 0.06), b);
      out.push(['nucEdge', Math.min(innerStart, innerEnd)]);
    } else {
      out.push(['nuc:none', 1]);
    }
    const sb = bucket(PROB_EDGES, sil);
    out.push([`sil:${sb}`, 1], [`${kind}:sil:${sb}`, 1], ['silMean', sil]);
    return out;
  }

  /** Boundary features on the phone adjacent to the boundary: left syllable's last phone fades, right syllable's first phone rises. */
  edgePhoneFeatures(c: number, lastL: number, firstR: number, kind: BoundaryKind): FeatureVec {
    const out: FeatureVec = [];
    const w = 0.04;
    if (lastL >= 0) {
      const drop = this.post.meanProb(lastL, c - w, c) - this.post.meanProb(lastL, c, c + w);
      const db = bucket(PROB_DIFF_EDGES, drop);
      out.push([`LPd:${db}`, 1], [`${kind}:LPd:${db}`, 1], ['LPdc', drop]);
    }
    if (firstR >= 0) {
      const rise = this.post.meanProb(firstR, c, c + w) - this.post.meanProb(firstR, c - w, c);
      const rb = bucket(PROB_DIFF_EDGES, rise);
      out.push([`FPr:${rb}`, 1], [`${kind}:FPr:${rb}`, 1], ['FPrc', rise]);
      out.push(['FPon', this.post.meanProb(firstR, c, c + w)]);
    }
    return out;
  }

  /** Boundary features: left nucleus fades / right nucleus rises across c. */
  nucleusBoundaryFeatures(c: number, nucL: number, nucR: number, kind: BoundaryKind): FeatureVec {
    const out: FeatureVec = [];
    const w = 0.05;
    if (nucL >= 0) {
      const drop = this.post.meanProb(nucL, c - w, c) - this.post.meanProb(nucL, c, c + w);
      const db = bucket(PROB_DIFF_EDGES, drop);
      out.push([`Ld:${db}`, 1], [`${kind}:Ld:${db}`, 1], ['Ldc', drop]);
    }
    if (nucR >= 0) {
      const rise = this.post.meanProb(nucR, c, c + w) - this.post.meanProb(nucR, c - w, c);
      const rb = bucket(PROB_DIFF_EDGES, rise);
      out.push([`Rr:${rb}`, 1], [`${kind}:Rr:${rb}`, 1], ['Rrc', rise]);
    }
    return out;
  }

  /** Pairwise features from pitch-note onsets / strong edges lying strictly inside a syllable interval. */
  countFeatures(a: number, b: number, kind: BoundaryKind): FeatureVec {
    const count = (arr: number[], lo: number, hi: number) => (hi > lo ? Math.min(3, lowerBound(arr, hi) - lowerBound(arr, lo)) : 0);
    const nr = count(this.rs, a + 0.03, b - 0.03);
    const nh = count(this.hs, a + 0.03, b - 0.03);
    const ns = count(this.ss, a + 0.03, b - 0.03);
    const edgeCounts: FeatureVec = [];
    this.edgeSets.forEach((set, s) => {
      const n = count(set.strong, a + 0.04, b - 0.04);
      edgeCounts.push([`nes${s}:${n}`, 1], [`${kind}:nes${s}:${n}`, 1]);
    });
    return [
      ...edgeCounts,
      [`nrs:${nr}`, 1], [`${kind}:nrs:${nr}`, 1],
      [`nhs:${nh}`, 1], [`${kind}:nhs:${nh}`, 1],
      [`nss:${ns}`, 1],
      [`nrh:${nr}${nh}`, 1],
    ];
  }

  candidatesNear(p: number, win: number, lineIdx?: number): number[] {
    const lo = p - win;
    const hi = p + win;
    const ordered: number[] = [p];
    for (const set of this.edgeSets) {
      for (let i = lowerBound(set.t, lo); i < set.t.length && set.t[i]! <= hi; i++) {
        if (set.p[i]! >= 0.2) ordered.push(set.t[i]!);
      }
    }
    const rawTimes = lineIdx !== undefined
      ? this.rawTimes.filter((_, s) => this.rawLinesStore[s]?.[lineIdx] != null)
      : this.rawTimes;
    for (const arr of [this.rs, this.re, this.hs, this.he, this.ss, this.se, this.grid16, this.eighths, ...rawTimes]) {
      ordered.push(...inRange(arr, lo, hi));
    }
    const kept: number[] = [];
    for (const t of ordered) {
      const tr = Math.round(t * 1000) / 1000;
      if (kept.some((k) => Math.abs(k - tr) < DEDUPE_SEC)) continue;
      kept.push(tr);
    }
    return kept.sort((a, b) => a - b);
  }

  features(c: number, p: number, s16: number, kind: BoundaryKind, onset: string, coda: string, rawBs: Array<number | null>, nucL: number, nucR: number, lastL: number, firstR: number, uniB: number): FeatureVec {
    const f: FeatureVec = [];
    const d = (c - p) / s16;
    const db = bucket(DIST_EDGES, d);
    f.push([`d:${db}`, 1], [`${kind}:d:${db}`, 1], [`${onset}:d:${db}`, 1]);
    const isPrior = Math.abs(c - p) < 0.0005 ? 1 : 0;
    if (isPrior) f.push(['prior', 1], [`${kind}:prior`, 1]);
    rawBs.forEach((rb, s) => {
      if (rb === null) return;
      const tag = s === 0 ? 'rawd' : `raw${s + 1}d`;
      const bk = bucket(DIST_EDGES, (c - rb) / s16);
      f.push([`${tag}:${bk}`, 1], [`${kind}:${tag}:${bk}`, 1], [`${onset}:${tag}:${bk}`, 1]);
    });
    for (let a = 0; a < rawBs.length; a++) {
      for (let b2 = a + 1; b2 < rawBs.length; b2++) {
        if (rawBs[a] === null || rawBs[b2] === null) continue;
        const ab = bucket(DIST_EDGES, (rawBs[b2]! - rawBs[a]!) / s16);
        const tag = a === 0 && b2 === 1 ? 'rawAgree' : `rawAgree${a}${b2}`;
        f.push([`${tag}:${ab}`, 1], [`${kind}:${tag}:${ab}`, 1]);
      }
    }
    const ud = bucket(DIST_EDGES, (c - uniB) / s16);
    f.push([`uniD:${ud}`, 1], [`${kind}:uniD:${ud}`, 1]);

    const prox = (name: string, arr: number[], tol: number) => {
      const dist = nearestDist(arr, c);
      const v = dist < tol ? 1 - dist / tol : 0;
      if (v > 0) f.push([name, v], [`${kind}:${name}`, v]);
      return v;
    };
    let pitchAgree = 0;
    for (const [name, arr] of [['rs', this.rs], ['re', this.re], ['ss', this.ss], ['se', this.se], ['hs', this.hs], ['he', this.he]] as const) {
      if (prox(name, arr, 0.02) > 0) pitchAgree++;
    }
    f.push([`agree:${pitchAgree}`, 1], [`${kind}:agree:${pitchAgree}`, 1]);

    // phoneme-boundary edge probability per model: strongest edge within 12 ms weighted by closeness
    const edgeBests: number[] = [];
    this.edgeSets.forEach((set, s) => {
      let best = 0;
      for (let i = lowerBound(set.t, c - 0.012); i < set.t.length && set.t[i]! <= c + 0.012; i++) {
        const w = set.p[i]! * (1 - Math.abs(set.t[i]! - c) / 0.012);
        if (w > best) best = w;
      }
      edgeBests.push(best);
      if (best > 0) {
        f.push([`edge${s}`, best], [`${kind}:edge${s}`, best], [`${onset}:edge${s}`, best]);
        if (best >= 0.5) f.push([`edge${s}>=.5`, 1], [`${kind}:edge${s}>=.5`, 1]);
      }
    });
    const edgesPresent = edgeBests.filter((b) => b > 0).length;
    f.push([`edgeN:${edgesPresent}`, 1], [`${kind}:edgeN:${edgesPresent}`, 1]);
    if (edgesPresent === edgeBests.length) {
      const all = Math.min(...edgeBests);
      f.push(['edgeAll', all], [`${kind}:edgeAll`, all], [`${onset}:edgeAll`, all]);
    }

    rawBs.forEach((rb, s) => {
      if (rb === null) return;
      const arr = this.rawTimes[s];
      if (arr) prox(s === 0 ? 'raw' : `raw${s + 1}`, arr, 0.02);
    });
    const g16 = nearestDist(this.grid16, c);
    const g8 = nearestDist(this.eighths, c);
    const gb = nearestDist(this.beatsArr, c);
    if (g16 < 0.006) f.push(['on16', 1], [`${kind}:on16`, 1]);
    if (g8 < 0.006) f.push(['on8', 1], [`${kind}:on8`, 1]);
    if (gb < 0.006) f.push(['onBeat', 1], [`${kind}:onBeat`, 1]);
    if (g16 >= 0.006 && g16 < 0.025) f.push(['near16', 1 - g16 / 0.025], [`${kind}:near16`, 1 - g16 / 0.025]);
    const signedOffset = (name: string, arr: number[], span: number) => {
      const i = lowerBound(arr, c);
      let best = Infinity;
      if (i < arr.length) best = arr[i]! - c;
      if (i > 0 && Math.abs(arr[i - 1]! - c) < Math.abs(best)) best = arr[i - 1]! - c;
      const b = Math.abs(best) <= span ? bucket(MS_EDGES, best * 1000) : -1;
      f.push([`${name}:${b}`, 1], [`${kind}:${name}:${b}`, 1]);
    };
    signedOffset('go', this.grid16, 0.06);
    signedOffset('ro', this.rs, 0.06);
    signedOffset('ho', this.hs, 0.06);
    const wideOffset = (name: string, arr: number[], tags: string[]) => {
      const i = lowerBound(arr, c);
      let best = Infinity;
      if (i < arr.length) best = arr[i]! - c;
      if (i > 0 && Math.abs(arr[i - 1]! - c) < Math.abs(best)) best = arr[i - 1]! - c;
      const b = Math.abs(best) <= 0.14 ? bucket(WIDE_MS_EDGES, best * 1000) : -1;
      for (const tag of tags) f.push([`${name}:${tag}:${b}`, 1]);
    };
    wideOffset('Wrs', this.rs, [kind, onset]);
    wideOffset('Wre', this.re, [kind, coda]);
    wideOffset('Whs', this.hs, [kind, onset]);
    this.edgeSets.forEach((set, s) => {
      signedOffset(`e${s}o`, set.strong, 0.06);
      wideOffset(`We${s}`, set.strong, [kind, onset]);
    });
    wideOffset('Weo', this.edgeSets[0]!.strong, [onset, coda]);
    f.push(...this.nucleusBoundaryFeatures(c, nucL, nucR, kind));
    f.push(...this.edgePhoneFeatures(c, lastL, firstR, kind));

    const fb = this.f0.stats(c - 0.06, c - 0.005);
    const fa = this.f0.stats(c + 0.005, c + 0.06);
    const vb = bucket(VOICED_EDGES, fb.voicedFrac);
    const va = bucket(VOICED_EDGES, fa.voicedFrac);
    f.push([`vv:${vb}${va}`, 1], [`${kind}:vv:${vb}${va}`, 1], [`${onset}:vv:${vb}${va}`, 1], [`${coda}>${onset}:vv:${vb}${va}`, 1]);
    if (fb.count >= 2 && fa.count >= 2) {
      const jb = bucket(JUMP_EDGES, Math.abs(fa.medianSemitone - fb.medianSemitone));
      f.push([`jump:${jb}`, 1], [`${kind}:jump:${jb}`, 1], [`${onset}:jump:${jb}`, 1]);
    } else {
      f.push(['jump:na', 1], [`${kind}:jump:na`, 1]);
    }

    if (this.rms) {
      const before = this.rms.mean(c - 0.04, c);
      const after = this.rms.mean(c, c + 0.04);
      const eps = 1e-4;
      const rise = Math.max(-2, Math.min(2, Math.log((after + eps) / (before + eps))));
      f.push(['rise', rise], [`${kind}:rise`, rise], [`${onset}:rise`, rise]);
      f.push(['absRise', Math.abs(rise)], [`${kind}:absRise`, Math.abs(rise)]);
      for (const [tag, span] of [['rise2', 0.02], ['rise8', 0.08]] as const) {
        const r = Math.max(-2, Math.min(2, Math.log((this.rms.mean(c, c + span) + eps) / (this.rms.mean(c - span, c) + eps))));
        f.push([tag, r], [`${kind}:${tag}`, r]);
      }
      let isMax = 1;
      for (const dt of [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03]) {
        const cc = c + dt;
        const rr = Math.log((this.rms.mean(cc, cc + 0.04) + eps) / (this.rms.mean(cc - 0.04, cc) + eps));
        if (rr > rise + 1e-9) isMax = 0;
      }
      if (isMax && rise > 0.15) f.push(['riseMax', 1], [`${kind}:riseMax`, 1]);
    }

    const covR = (this.coveredBy(this.rmvpeN, this.rmvpeNS, c - 0.03) ? 2 : 0) + (this.coveredBy(this.rmvpeN, this.rmvpeNS, c + 0.03) ? 1 : 0);
    const covH = (this.coveredBy(this.harmoN, this.harmoNS, c - 0.03) ? 2 : 0) + (this.coveredBy(this.harmoN, this.harmoNS, c + 0.03) ? 1 : 0);
    f.push([`covR:${covR}`, 1], [`${kind}:covR:${covR}`, 1], [`covH:${covH}`, 1], [`${kind}:covH:${covH}`, 1]);
    return f;
  }

  /** Every sorted event list the boundary scorers read. */
  get events(): EvidenceEvents {
    return {
      rmvpeStarts: this.rs,
      rmvpeEnds: this.re,
      swiftStarts: this.ss,
      swiftEnds: this.se,
      harmoStarts: this.hs,
      harmoEnds: this.he,
      beats: this.beatsArr,
      edgePeaks: this.edgeSets,
    };
  }

  /** How much `phone` fades across c: mean posterior over the `w` seconds before c minus the `w` seconds after (0 for an unknown phone). */
  phoneFade(phone: number, c: number, w: number): number {
    return phone < 0 ? 0 : this.post.meanProb(phone, c - w, c) - this.post.meanProb(phone, c, c + w);
  }

  /** How much `phone` rises across c: mean posterior over the `w` seconds after c minus the `w` seconds before (0 for an unknown phone). */
  phoneRise(phone: number, c: number, w: number): number {
    return phone < 0 ? 0 : this.post.meanProb(phone, c, c + w) - this.post.meanProb(phone, c - w, c);
  }

  /** Log energy ratio after/before c over windows of `span` seconds, clipped to [-2, 2]; 0 when the evidence has no audio. */
  rmsRise(c: number, span: number): number {
    if (!this.rms) return 0;
    const eps = 1e-4;
    return Math.max(-2, Math.min(2, Math.log((this.rms.mean(c, c + span) + eps) / (this.rms.mean(c - span, c) + eps))));
  }

  /** Mean posterior of the syllable's nucleus phone (0 when unknown) and of silence inside the segment [a, b]. */
  segmentPhones(nucleus: number, a: number, b: number): { nucleus: number; silence: number } {
    const margin = b - a > 0.12 ? 0.03 : 0;
    return {
      nucleus: nucleus >= 0 ? this.post.meanProb(nucleus, a + margin, b - margin) : 0,
      silence: this.post.meanProb(this.post.silenceId, a + margin, b - margin),
    };
  }
}

export function pairFeaturesFor(prob: LineProblem, j: number, a: number, b: number): FeatureVec {
  const kind = prob.kinds[j - 1]! === 'lineStart' ? prob.kinds[j]! : prob.kinds[j - 1]!;
  const priorDur = prob.prior[j]! - prob.prior[j - 1]!;
  const base = pairwiseFeatures(b - a, priorDur, prob.s16[j]!, kind);
  const ub = bucket(RATIO_EDGES, Math.log(Math.max(b - a, 1e-3) / Math.max(prob.meanDur, 1e-3)));
  base.push([`uni:${ub}`, 1], [`${kind}:uni:${ub}`, 1]);
  base.push(...prob.ev.countFeatures(a, b, kind));
  base.push(...prob.ev.nucleusSegmentFeatures(prob.sylRefs[j - 1]!.nucleus, a, b, kind));
  return base;
}

export function pairwiseFeatures(dur: number, priorDur: number, s16: number, kind: BoundaryKind): FeatureVec {
  const dn = dur / s16;
  const db = bucket(DUR_EDGES, dn);
  const rb = bucket(RATIO_EDGES, Math.log(Math.max(dur, 1e-3) / Math.max(priorDur, 1e-3)));
  const frac = Math.abs(dn - Math.round(dn));
  const pb = bucket(PHASE_EDGES, frac);
  return [[`dur:${db}`, 1], [`${kind}:dur:${db}`, 1], [`rat:${rb}`, 1], [`${kind}:rat:${rb}`, 1], [`ph:${pb}`, 1], [`${kind}:ph:${pb}`, 1]];
}

function flattenLine(line: ConsensusLine, nucleusFor: NucleusResolver): { sylRefs: SyllableRef[]; starts: number[]; ends: number[]; wordStarts: boolean[] } {
  const sylRefs: SyllableRef[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const wordStarts: boolean[] = [];
  line.words.forEach((w, wi) => {
    const syls = w.syl && w.syl.length > 0 ? w.syl : [[w.start, w.end] as [number, number]];
    const texts = w.sylText ?? [];
    const wordText = w.w ?? w.text ?? w.word ?? '';
    syls.forEach((s, si) => {
      const text = texts[si] ?? wordText;
      const ph = nucleusFor(wordText, si, text, syls.length);
      sylRefs.push({ wordIdx: wi, sylIdx: si, text, nucleus: ph.nucleus, firstPhone: ph.first, lastPhone: ph.last });
      starts.push(s[0]);
      ends.push(s[1]);
      wordStarts.push(si === 0);
    });
  });
  return { sylRefs, starts, ends, wordStarts };
}

/** Candidate boundaries of one line, pins honoured (a pinned boundary has exactly one candidate). Nothing is scored. */
export function buildLineSkeleton(
  line: ConsensusLine,
  lineIdx: number,
  ev: BoundaryEvidence,
  pins?: Array<number | undefined>
): LineSkeleton {
  const { sylRefs, starts, ends, wordStarts } = flattenLine(line, ev.nucleusFor);
  const m = sylRefs.length;
  const prior: number[] = [];
  const kinds: BoundaryKind[] = [];
  for (let j = 0; j <= m; j++) {
    if (j === 0) prior.push(starts[0]!);
    else if (j === m) prior.push(ends[m - 1]!);
    else prior.push((ends[j - 1]! + starts[j]!) / 2);
    kinds.push(j === 0 ? 'lineStart' : j === m ? 'lineEnd' : wordStarts[j]! ? 'word' : 'in');
  }
  const s16 = prior.map((p) => ev.beatDur(p) / 4);
  const meanDur = (prior[m]! - prior[0]!) / m;
  const cands: number[][] = [];
  for (let j = 0; j <= m; j++) {
    const lo = j > 0 ? prior[j - 1]! : prior[0]! - LINE_EDGE_WINDOW_SEC;
    const hi = j < m ? prior[j + 1]! : prior[m]! + LINE_EDGE_WINDOW_SEC;
    const win = j === 0 || j === m ? LINE_EDGE_WINDOW_SEC : WINDOW_SEC;
    const pin = pins?.[j];
    cands.push(pin !== undefined ? [pin] : ev.candidatesNear(prior[j]!, win, lineIdx).filter((c) => c > lo - NEIGHBOR_SLACK_SEC && c < hi + NEIGHBOR_SLACK_SEC));
  }
  return { lineIdx, prior, kinds, s16, cands, sylRefs, ev, meanDur };
}

export function buildLineProblem(
  line: ConsensusLine,
  lineIdx: number,
  ev: BoundaryEvidence,
  pins?: Array<number | undefined>
): LineProblem {
  const skeleton = buildLineSkeleton(line, lineIdx, ev, pins);
  const { prior, kinds, s16, cands, sylRefs, meanDur } = skeleton;
  const m = sylRefs.length;
  const rawSets = ev.rawBoundarySets(lineIdx, m);
  const unary: CompactFeat[][] = [];
  for (let j = 0; j <= m; j++) {
    const onset = j < m ? onsetClass(sylRefs[j]!.text) : 'e';
    const coda = j > 0 ? codaClass(sylRefs[j - 1]!.text) : 'e';
    const nucL = j > 0 ? sylRefs[j - 1]!.nucleus : -1;
    const nucR = j < m ? sylRefs[j]!.nucleus : -1;
    const lastL = j > 0 ? sylRefs[j - 1]!.lastPhone : -1;
    const firstR = j < m ? sylRefs[j]!.firstPhone : -1;
    const rawBs = rawSets.map((b) => (b ? b[j]! : null));
    unary.push(cands[j]!.map((c) => compactFeatures(ev.features(c, prior[j]!, s16[j]!, kinds[j]!, onset, coda, rawBs, nucL, nucR, lastL, firstR, prior[0]! + j * meanDur))));
  }
  return { ...skeleton, unary, pairTables: new Array(m + 1).fill(undefined) };
}

/** Pair-feature table for boundary j-1 -> j: pair (q, k) owns features [offsets[q*B+k], offsets[q*B+k+1]); empty = invalid. */
interface PairTable {
  offsets: Int32Array;
  ids: Int32Array;
  vals: Float32Array;
}

function pairTable(prob: LineProblem, j: number): PairTable {
  const cached = prob.pairTables[j];
  if (cached) return cached;
  const A = prob.cands[j - 1]!;
  const B = prob.cands[j]!;
  const offsets = new Int32Array(A.length * B.length + 1);
  const ids: number[] = [];
  const vals: number[] = [];
  for (let q = 0; q < A.length; q++) {
    for (let k = 0; k < B.length; k++) {
      if (B[k]! - A[q]! >= MIN_SYL_SEC) {
        for (const [name, v] of pairFeaturesFor(prob, j, A[q]!, B[k]!)) {
          ids.push(featureId(name));
          vals.push(v);
        }
      }
      offsets[q * B.length + k + 1] = ids.length;
    }
  }
  const table = { offsets, ids: Int32Array.from(ids), vals: Float32Array.from(vals) };
  prob.pairTables[j] = table;
  return table;
}

/** Materialises every pair table (training reuses them across epochs). */
export function prepareProblem(prob: LineProblem): void {
  for (let j = 1; j < prob.cands.length; j++) pairTable(prob, j);
}

function dot(f: CompactFeat, wv: Float64Array): number {
  let s = 0;
  for (let i = 0; i < f.ids.length; i++) {
    const id = f.ids[i]!;
    if (id < wv.length) s += wv[id]! * f.vals[i]!;
  }
  return s;
}

export interface ScoreTables {
  /** unary[j][k] */
  u: Float64Array[];
  /** pair[j-1][q*B+k], -Infinity when invalid */
  pair: Float64Array[];
}

function scoreTables(prob: LineProblem, wv: Float64Array): ScoreTables {
  const n = prob.cands.length;
  const u = prob.unary.map((row) => Float64Array.from(row, (f) => dot(f, wv)));
  const pair: Float64Array[] = [];
  for (let j = 1; j < n; j++) {
    const t = pairTable(prob, j);
    const out = new Float64Array(t.offsets.length - 1).fill(-Infinity);
    for (let p = 0; p < out.length; p++) {
      const lo = t.offsets[p]!;
      const hi = t.offsets[p + 1]!;
      if (hi === lo) continue;
      let s = 0;
      for (let i = lo; i < hi; i++) {
        const id = t.ids[i]!;
        if (id < wv.length) s += wv[id]! * t.vals[i]!;
      }
      out[p] = s;
    }
    pair.push(out);
  }
  return { u, pair };
}

function tracePath(bp: Int32Array[], lastBest: number): number[] {
  const n = bp.length;
  const path = new Array<number>(n);
  let cur = lastBest;
  for (let j = n - 1; j >= 0; j--) {
    path[j] = cur;
    cur = bp[j]![cur] ?? 0;
  }
  return path;
}

/** Best path of a max-sum chain given the candidate lists, unary rows and pair tables (-Infinity marks an invalid pair). */
export function viterbiChain(cands: number[][], u: Float64Array[], pair: Float64Array[], soft = false): number[] {
  const n = cands.length;
  const dp: Float64Array[] = [Float64Array.from(u[0]!)];
  const bp: Int32Array[] = [new Int32Array(u[0]!.length).fill(-1)];
  for (let j = 1; j < n; j++) {
    const K = cands[j]!.length;
    const P = cands[j - 1]!.length;
    const row = new Float64Array(K).fill(-Infinity);
    const back = new Int32Array(K).fill(-1);
    for (let k = 0; k < K; k++) {
      for (let q = 0; q < P; q++) {
        const prev = dp[j - 1]![q]!;
        const ps = pair[j - 1]![q * K + k]!;
        if (prev === -Infinity || ps === -Infinity) continue;
        const v = prev + ps + u[j]![k]!;
        if (v > row[k]!) {
          row[k] = v;
          back[k] = q;
        }
      }
    }
    dp.push(row);
    bp.push(back);
  }
  const last = dp[n - 1]!;
  let best = 0;
  for (let k = 1; k < last.length; k++) if (last[k]! > last[best]!) best = k;
  // No feasible path (pins and candidates that cannot satisfy the minimum syllable length): decode with the invalid pairs as a large penalty that
  // grows with the overlap, so the line gets its least-violating times instead of NaN, which would also poison every line after it.
  if (last[best] === -Infinity && !soft) {
    const relaxed = pair.map((table, j) => {
      const A = cands[j]!;
      const B = cands[j + 1]!;
      return Float64Array.from(table, (v, p) => (v === -Infinity ? -1e4 * (1 + Math.max(0, A[Math.floor(p / B.length)]! - B[p % B.length]!)) : v));
    });
    return viterbiChain(cands, u, relaxed, true);
  }
  return tracePath(bp, best);
}

/** MAP path. `extraUnary` lets training inject a loss-augmentation term. */
export function decodeLine(prob: LineProblem, wv: Float64Array, extraUnary?: number[][]): number[] {
  const { u, pair } = scoreTables(prob, wv);
  if (extraUnary) u.forEach((row, j) => row.forEach((_, k) => (row[k] = row[k]! + (extraUnary[j]?.[k] ?? 0))));
  return viterbiChain(prob.cands, u, pair);
}

function logSumExpOver(count: number, term: (i: number) => number): number {
  let m = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = term(i);
    if (v > m) m = v;
  }
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (let i = 0; i < count; i++) s += Math.exp(term(i) - m);
  return m + Math.log(s);
}

interface ForwardBackward {
  tables: ScoreTables;
  alpha: Float64Array[];
  beta: Float64Array[];
  logZ: number;
}

/** Forward and backward log messages of a chain given its candidate lists and score tables. */
function forwardBackwardTables(cands: number[][], tables: ScoreTables): ForwardBackward {
  const { u, pair } = tables;
  const n = cands.length;
  const alpha: Float64Array[] = [Float64Array.from(u[0]!)];
  for (let j = 1; j < n; j++) {
    const K = cands[j]!.length;
    const P = cands[j - 1]!.length;
    const row = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const lse = logSumExpOver(P, (q) => alpha[j - 1]![q]! + pair[j - 1]![q * K + k]!);
      row[k] = lse === -Infinity ? -Infinity : u[j]![k]! + lse;
    }
    alpha.push(row);
  }
  const beta: Float64Array[] = new Array(n);
  beta[n - 1] = new Float64Array(cands[n - 1]!.length);
  for (let j = n - 2; j >= 0; j--) {
    const K = cands[j + 1]!.length;
    const P = cands[j]!.length;
    const row = new Float64Array(P);
    for (let q = 0; q < P; q++) row[q] = logSumExpOver(K, (k) => pair[j]![q * K + k]! + u[j + 1]![k]! + beta[j + 1]![k]!);
    beta[j] = row;
  }
  const last = alpha[n - 1]!;
  const logZ = logSumExpOver(last.length, (k) => last[k]!);
  return { tables, alpha, beta, logZ };
}

function forwardBackward(prob: LineProblem, wv: Float64Array): ForwardBackward {
  return forwardBackwardTables(prob.cands, scoreTables(prob, wv));
}

function marginalsOf({ alpha, beta, logZ }: ForwardBackward): Float64Array[] {
  return alpha.map((row, j) => Float64Array.from(row, (a, k) => {
    const lm = a + beta[j]![k]! - logZ;
    return Number.isFinite(lm) ? Math.exp(lm) : 0;
  }));
}

/** Posterior node marginals p(boundary j = candidate k) of the linear-chain model. */
export function nodeMarginals(prob: LineProblem, wv: Float64Array): Float64Array[] {
  return marginalsOf(forwardBackward(prob, wv));
}

/** The same marginals for explicit score tables, so any scorer can reuse the chain. */
export function chainMarginals(cands: number[][], tables: ScoreTables): Float64Array[] {
  return marginalsOf(forwardBackwardTables(cands, tables));
}

/**
 * Adds (E_model[features] - E_target[features]) to `grad` (gradient of the cross-entropy to `target`, a per-boundary
 * distribution over candidates that factorises across boundaries; a one-hot target is the usual CRF negative log-likelihood).
 */
export function accumulateNllGradient(prob: LineProblem, wv: Float64Array, target: Float64Array[], grad: Float64Array): void {
  const { tables, alpha, beta, logZ } = forwardBackward(prob, wv);
  const { u, pair } = tables;
  const n = prob.cands.length;
  const addCompact = (ids: Int32Array, vals: Float32Array, lo: number, hi: number, scale: number) => {
    for (let i = lo; i < hi; i++) grad[ids[i]!] = grad[ids[i]!]! + scale * vals[i]!;
  };
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < prob.cands[j]!.length; k++) {
      const lm = alpha[j]![k]! + beta[j]![k]! - logZ;
      if (lm < -30 || !Number.isFinite(lm)) continue;
      const f = prob.unary[j]![k]!;
      addCompact(f.ids, f.vals, 0, f.ids.length, Math.exp(lm));
    }
  }
  for (let j = 1; j < n; j++) {
    const t = pairTable(prob, j);
    const K = prob.cands[j]!.length;
    const P = prob.cands[j - 1]!.length;
    for (let q = 0; q < P; q++) {
      for (let k = 0; k < K; k++) {
        const ps = pair[j - 1]![q * K + k]!;
        if (ps === -Infinity) continue;
        const lm = alpha[j - 1]![q]! + ps + u[j]![k]! + beta[j]![k]! - logZ;
        if (lm < -30 || !Number.isFinite(lm)) continue;
        const p = q * K + k;
        addCompact(t.ids, t.vals, t.offsets[p]!, t.offsets[p + 1]!, Math.exp(lm));
      }
    }
  }
  for (let j = 0; j < n; j++) {
    const qj = target[j]!;
    for (let k = 0; k < qj.length; k++) {
      if (qj[k]! < 1e-6) continue;
      const f = prob.unary[j]![k]!;
      addCompact(f.ids, f.vals, 0, f.ids.length, -qj[k]!);
    }
    if (j === 0) continue;
    const t = pairTable(prob, j);
    const qp = target[j - 1]!;
    for (let q = 0; q < qp.length; q++) {
      if (qp[q]! < 1e-6) continue;
      for (let k = 0; k < qj.length; k++) {
        const w = qp[q]! * qj[k]!;
        if (w < 1e-8) continue;
        const p = q * qj.length + k;
        addCompact(t.ids, t.vals, t.offsets[p]!, t.offsets[p + 1]!, -w);
      }
    }
  }
}

/** Rewrites line word/syllable timings from the chosen boundaries (contiguous tiling). */
export function applyPath(line: ConsensusLine, prob: LineSkeleton, path: number[]): void {
  const times = path.map((k, j) => prob.cands[j]![k]!);
  const m = prob.sylRefs.length;
  for (let j = 0; j < m; j++) {
    const ref = prob.sylRefs[j]!;
    const word = line.words[ref.wordIdx]!;
    if (!word.syl || word.syl.length === 0) word.syl = [[word.start, word.end]];
    word.syl[ref.sylIdx] = [times[j]!, times[j + 1]!];
  }
  for (const word of line.words) {
    if (word.syl && word.syl.length > 0) {
      word.start = word.syl[0]![0];
      word.end = word.syl[word.syl.length - 1]![1];
    }
  }
}

/** Minimum-expected-absolute-error path: max-sum chain over -E|c - X_j| under the posterior node marginals of any scorer. */
export function mbrPath(cands: number[][], marginals: Float64Array[]): number[] {
  const n = cands.length;
  const loss = cands.map((cs, j) => Float64Array.from(cs, (c) => {
    let s = 0;
    for (let k2 = 0; k2 < cs.length; k2++) s += marginals[j]![k2]! * Math.abs(c - cs[k2]!);
    return -s;
  }));
  const pair: Float64Array[] = [];
  for (let j = 1; j < n; j++) {
    const A = cands[j - 1]!;
    const B = cands[j]!;
    const tbl = new Float64Array(A.length * B.length).fill(-Infinity);
    // Two pinned boundaries (one candidate each) are the user's word, however short the syllable between them.
    const forced = A.length === 1 && B.length === 1;
    for (let q = 0; q < A.length; q++) for (let k = 0; k < B.length; k++) if (B[k]! - A[q]! >= (forced ? 0 : MIN_SYL_SEC)) tbl[q * B.length + k] = 0;
    pair.push(tbl);
  }
  return viterbiChain(cands, loss, pair);
}

/** MBR decoding under the trained linear model. */
export function decodeLineMbr(prob: LineProblem, wv: Float64Array): number[] {
  return mbrPath(prob.cands, nodeMarginals(prob, wv));
}

export function buildProblems(
  lines: ConsensusLine[],
  ev: BoundaryEvidence,
  pinsPerLine?: Array<Array<number | undefined>>
): LineProblem[] {
  return lines.map((line, li) => buildLineProblem(line, li, ev, pinsPerLine?.[li]));
}

/** Decodes every line of `problems` (built from `lines`) with MBR and returns re-timed copies of the lines. */
export function applyProblems(lines: ConsensusLine[], problems: LineProblem[], wv: Float64Array): ConsensusLine[] {
  const out = structuredClone(lines);
  out.forEach((line, li) => {
    const prob = problems[li]!;
    if (prob.sylRefs.length < 2) return;
    applyPath(line, prob, decodeLineMbr(prob, wv));
  });
  return out;
}

export function refineBoundariesDP(
  lines: ConsensusLine[],
  evOrInputs: BoundaryEvidence | BoundaryDpInputs,
  weights: Weights,
  pinsPerLine?: Array<Array<number | undefined>>
): ConsensusLine[] {
  const ev = evOrInputs instanceof BoundaryEvidence ? evOrInputs : new BoundaryEvidence(evOrInputs);
  return applyProblems(lines, buildProblems(lines, ev, pinsPerLine), weightsToVec(weights));
}
