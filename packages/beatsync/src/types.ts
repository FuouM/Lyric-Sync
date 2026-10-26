// packages/beatsync/src/types.ts
// Type definitions for beat and downbeat tracking and audio analysis.

import type { InferenceDevice } from './device.ts';

export interface BeatResult {
  beats: number[];
  downbeats: number[];
}

/** From `at` seconds on, the song's tempo is `bpm`. */
export interface TempoChange {
  at: number;
  bpm: number;
}

export interface PostprocessOptions {
  fps?: number;
  targetBpm?: number;
  /** Tempo changes after the start, strictly increasing in `at`, each `at` > 0. Validate with `checkTempoChanges`. */
  tempoChanges?: readonly TempoChange[];
  useDP?: boolean;
  firstDownbeatHint?: number;
}

export interface BeatAnalysis {
  beats: number[];
  downbeats: number[];
  bpm: number;
  beatPeriod: number;
  durationSec: number;
  inferenceTimeMs: number;
}

export interface BeatTrackerOptions {
  chunkSize?: number;
  borderSize?: number;
  fps?: number;
  /** Where the model runs (default `gpu`, which falls back to the CPU when the platform has no GPU provider). Results are the same on both. */
  device?: InferenceDevice;
  /** Tempo prior in BPM (required, see TrackBeatsOptions.targetBpm). */
  targetBpm: number;
  /** See TrackBeatsOptions.tempoChanges. */
  tempoChanges?: readonly TempoChange[];
}

export interface TrackBeatsOptions {
  /** Tempo prior in BPM at the start of the song. Required: beats are confined to about +/-12% of the tempo in force, so a wrong value yields wrong beats. */
  targetBpm: number;
  /** Tempo changes later in the song (a bridge in double time, a key-change ritardando...): from each `at` (seconds, increasing, > 0) the prior is that `bpm`. Around a change the prior is the geometric mean of the two tempos. */
  tempoChanges?: readonly TempoChange[];
  firstDownbeat?: number;
  /** See BeatTrackerOptions.device. */
  device?: InferenceDevice;
}

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

export interface SpectrogramResult {
  /** Log-mel spectrogram matrix, shape: [numFrames, 128] */
  data: Float32Array;
  numFrames: number;
  nMels: number;
  durationSec: number;
  fps: number;
}

/** Envelope keys computed from the full mix. */
export type MixEnvelopeKey = 'rms' | 'low' | 'mid' | 'high';
/** Envelope keys computed from the stems. */
export type StemEnvelopeKey = 'vocal' | 'drums' | 'bass' | 'other';
/** Onset keys of the features.json contract. */
export type OnsetKey = 'kick' | 'snare' | 'hat' | 'vocal';

/** Stem files per stem envelope. Each envelope is the sum of the RMS envelopes of its files. A key without files is not in the output. */
export type FeatureStems = Partial<Record<StemEnvelopeKey, string[]>>;

/**
 * The features.json v1 contract: envelopes at `fps` frames per second, each peak-normalized to 0..1 (max 1, or all 0 for silence).
 * Envelope length is ceil(mix samples * fps / mix sample rate). `onsets` hold only the keys that a detector computed: [time s, strength 0..1].
 */
export interface FeaturesDocument {
  v: 1;
  fps: number;
  envelopes: Record<MixEnvelopeKey, number[]> & Partial<Record<StemEnvelopeKey, number[]>>;
  onsets: Partial<Record<OnsetKey, Array<[number, number]>>>;
}
