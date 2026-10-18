// packages/lyricsync/src/audio/types.ts
// Shared audio data structures.

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

export interface SpectrogramResult {
  data: Float32Array;
  numFrames: number;
  nMels: number;
  durationSec: number;
  fps: number;
}

export interface RmvpeSpectrogramResult {
  data: Float32Array;
  numFrames: number;
  nMels: number;
}
