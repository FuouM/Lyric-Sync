// packages/beatsync/src/types.ts
// Type definitions for beat and downbeat tracking and audio analysis.

export interface BeatResult {
  beats: number[];
  downbeats: number[];
}

export interface PostprocessOptions {
  fps?: number;
  targetBpm?: number;
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
  executionProvider?: 'cpu' | 'cuda' | 'webgpu';
  /** Tempo prior in BPM (required, see TrackBeatsOptions.targetBpm). */
  targetBpm: number;
}

export interface TrackBeatsOptions {
  /** Tempo prior in BPM. Required: beats are confined to about +/-12% of this tempo, so a wrong value yields wrong beats. */
  targetBpm: number;
  firstDownbeat?: number;
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
