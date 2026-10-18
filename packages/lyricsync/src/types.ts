// src/types.ts
// Shared contracts between the lyricsync layers:
//   lyrics/    text -> LyricsDefinition
//   evidence/  audio + definition -> SongEvidence (+ per-line SlicedAlignment on demand)
//   engine/    SongEvidence + anchors + weights -> SolveOutput
//   workspace/ on-disk session state, anchors, review loop
// Times are seconds unless a name says otherwise.

import type { ConsensusLine, ConsensusNote } from './engine/consensus.ts';
import type { NucleusResolver } from './engine/boundary_dp.ts';

export type { ConsensusLine, ConsensusNote, ConsensusWord } from './engine/consensus.ts';
export type { NucleusResolver } from './engine/boundary_dp.ts';

/** Languages with a dictionary, a forced-aligner vocabulary and trained DP weights. */
export type Language = 'en' | 'ja';

// ---------------------------------------------------------------------------------------------
// Lyrics input
// ---------------------------------------------------------------------------------------------

export interface LyricWord {
  /** Display text as written, e.g. "don't" or "(i)". Parentheses mark backing vocals and are ignored by G2P. */
  w: string;
  /** Syllable texts, at least one; joined they spell the word. The timing granularity of the output. */
  syllables: string[];
  /** Optional explicit pronunciation (dictionary phone names: lowercase ARPAbet for en, mora phones such as "k a" for ja) that replaces the dictionary lookup. Needed for words the dictionary lacks. */
  phones?: string[];
}

export interface LyricLine {
  /** 0-based line index in the song; stable identity used by anchors. */
  index: number;
  section?: string;
  text: string;
  words: LyricWord[];
}

export interface LyricsDefinition {
  language: Language;
  lines: LyricLine[];
}

// ---------------------------------------------------------------------------------------------
// Audio-derived evidence
// ---------------------------------------------------------------------------------------------

export interface AcousticEdge {
  t: number;
  prob: number;
}

export interface AcousticBreath {
  start: number;
  end: number;
  prob?: number;
}

/** Frame-wise phone posteriors (softmax, uint8, frame-major, 10 ms frames) of the base forced-aligner model. */
export interface Posteriorgram {
  frames: number;
  vocabSize: number;
  data: Uint8Array;
  silenceId: number;
}

/** Output of the trained syllable-boundary model (evidence/boundary.ts) for the vocal and the lyric lines. */
export interface BoundaryModelEvidence {
  /** Frames per second of `frames` (100). */
  fps: number;
  /** Width of a frame embedding and of a query. */
  dim: number;
  /** Frame-major (frames, dim + 1): each frame's embedding, then its context-free boundary logit. */
  frames: Float32Array;
  /** Key = line index: one query per boundary j = 0..syllables of the line (j = syllable start, the last = line end). */
  queries: Record<number, number[][]>;
}

/**
 * Everything audio-derived the engine needs. Produced by the evidence layer, serialised into the workspace.
 * `audio` is the vocal stem, mono, 44100 Hz.
 */
export interface SongEvidence {
  language: Language;
  durationSec: number;
  audio: Float32Array;
  sampleRate: 44100;
  swiftNotes: ConsensusNote[];
  harmoNotes: ConsensusNote[];
  rmvpeNotes: ConsensusNote[];
  /** RMVPE f0 contour in Hz at 100 fps from t=0 (0 = unvoiced). */
  f0Hz: number[];
  /** Phoneme-boundary edge peaks: [0] = base model, [1] = combined model. Both always present. */
  edgeSets: [AcousticEdge[], AcousticEdge[]];
  /** Breath pauses from the base model. */
  breaths: AcousticBreath[];
  /** Musical beat times from the beatsync package. */
  beats: number[];
  posteriors: Posteriorgram;
  /** Maps a syllable to model-vocabulary phone ids; built from the bundled dictionary and the base vocab. */
  nucleusFor: NucleusResolver;
  /** Full-song forced alignment (no timing hints), one ConsensusLine per lyric line. Base model. */
  fullBase: ConsensusLine[];
  /** Same with the combined model. English only; null for other languages. */
  fullCombined: ConsensusLine[] | null;
  /** The trained boundary model's frames and queries (the guided solver's guide). */
  boundary: BoundaryModelEvidence;
}

/** Forced alignment of one line cut to its anchored start/end (+/-0.1 s of audio padding). */
export interface SlicedAlignment {
  base: ConsensusLine;
  /** English only; null for other languages. */
  combined: ConsensusLine | null;
}

// ---------------------------------------------------------------------------------------------
// Anchors (user-known timings that the solver must honour)
// ---------------------------------------------------------------------------------------------

/**
 * Pins for one lyric line. `boundaries[j]` is the absolute time of boundary j, where boundary j is the
 * start of the line's j-th syllable (flat index across the line's words) and boundary m (m = syllable count) is the line end.
 * `start` is boundary 0, `end` is boundary m; they are kept as named fields because line anchors are the common case.
 */
export interface LineAnchor {
  start?: number;
  end?: number;
  boundaries?: Record<string, number>;
}

export interface Anchors {
  version: 1;
  /** Key = line index as a string. */
  lines: Record<string, LineAnchor>;
}

// ---------------------------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------------------------

export type Weights = Record<string, number>;

/** Weights of one mode. `stage2` is null when a second DP stage did not improve held-out accuracy for that mode (see weights/index.json). */
export interface ModeWeights {
  stage1: Weights;
  stage2: Weights | null;
}

/** `anchored` weights are used for lines whose start AND end are pinned; `free` weights for every other line. */
export interface WeightBundle {
  anchored: ModeWeights;
  free: ModeWeights;
}

/** How boundaries are scored: the vote-count solver guided by the bundled boundary model (the default), learned DP weights shipped with the
 *  package, the explicit training-free model, or its simplest vote-count form. */
export type SolveMethod = 'guided' | 'trained' | 'analytic' | 'simple';

export interface SolveOptions {
  /** Max gap in seconds for legato bridging in the consensus stage. Default 0.12. */
  legatoGap?: number;
}

export interface SolveInput {
  evidence: SongEvidence;
  anchors: Anchors;
  /** Sliced alignments keyed by line index. Required for every line whose start and end are both anchored. */
  sliced: Record<number, SlicedAlignment>;
  weights: WeightBundle;
  options?: SolveOptions;
}

export interface BoundaryReview {
  /** Boundary index within the line (see LineAnchor). */
  boundary: number;
  time: number;
  /** Posterior-expected absolute error of the chosen time, in ms (minimum-Bayes-risk decode). Lower is more certain. */
  expectedErrorMs: number;
  anchored: boolean;
  /** Text of the syllable that starts at this boundary ("" for the line end). */
  syllable: string;
}

export interface LineReview {
  line: number;
  mode: 'anchored' | 'free';
  /** Sum of boundary expected errors / boundary count, in ms. Rank lines by this to decide what a human should check next. */
  meanExpectedErrorMs: number;
  /** Unpinned boundaries sorted by expectedErrorMs descending, at most 5. */
  uncertain: BoundaryReview[];
}

export interface SolveOutput {
  /** Re-timed lines in the repository's lyrics.json line shape (i, text, start, end, words[{w, start, end, conf, syl, sylText}]). */
  lines: ConsensusLine[];
  review: LineReview[];
}

/** Final document written as lyrics.json. */
export interface LyricsJson {
  format: 'words';
  fps: 60;
  method: 'lyricsync';
  lines: ConsensusLine[];
}
