// packages/lyricsync/src/audio/spectrogram.ts
// Mel Spectrogram extraction for RMVPE vocal pitch estimation.

import * as fs from 'node:fs';
import type { RmvpeSpectrogramResult } from './types.ts';

export const N_FFT = 1024;
export const N_FREQS = N_FFT / 2 + 1; // 513
export const RMVPE_SAMPLE_RATE = 16000;
export const RMVPE_HOP_LENGTH = 160;
export const RMVPE_N_MELS = 128;
export const RMVPE_PAD_AMOUNT = 512;

// -------------------------------------------------------------
// Precomputed Tables for 1024-point Radix-2 FFT
// -------------------------------------------------------------
const LOG2_N = 10;
const BIT_REV = new Uint16Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  let rev = 0;
  for (let j = 0; j < LOG2_N; j++) {
    if ((i >> j) & 1) rev |= (1 << (LOG2_N - 1 - j));
  }
  BIT_REV[i] = rev;
}

const COS_TABLE = new Float32Array(N_FFT / 2);
const SIN_TABLE = new Float32Array(N_FFT / 2);
for (let i = 0; i < N_FFT / 2; i++) {
  const theta = (-2 * Math.PI * i) / N_FFT;
  COS_TABLE[i] = Math.cos(theta);
  SIN_TABLE[i] = Math.sin(theta);
}

// Periodic Hann window: w[n] = 0.5 * (1 - cos(2*pi*n / N))
const HANN_WINDOW = new Float32Array(N_FFT);
for (let n = 0; n < N_FFT; n++) {
  HANN_WINDOW[n] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * n) / N_FFT));
}

/**
 * In-place 1024-point Cooley-Tukey Radix-2 FFT.
 */
function fft1024(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < N_FFT; i++) {
    const j = BIT_REV[i] ?? 0;
    if (j > i) {
      const tr = re[i] ?? 0; re[i] = re[j] ?? 0; re[j] = tr;
      const ti = im[i] ?? 0; im[i] = im[j] ?? 0; im[j] = ti;
    }
  }

  for (let halfSize = 1; halfSize < N_FFT; halfSize <<= 1) {
    const step = halfSize << 1;
    const tableStep = N_FFT / step;
    for (let k = 0; k < halfSize; k++) {
      const wr = COS_TABLE[k * tableStep] ?? 1;
      const wi = SIN_TABLE[k * tableStep] ?? 0;
      for (let i = k; i < N_FFT; i += step) {
        const j = i + halfSize;
        const rj = re[j] ?? 0;
        const ij = im[j] ?? 0;
        const tr = wr * rj - wi * ij;
        const ti = wr * ij + wi * rj;
        const ri = re[i] ?? 0;
        const ii = im[i] ?? 0;
        re[j] = ri - tr;
        im[j] = ii - ti;
        re[i] = ri + tr;
        im[i] = ii + ti;
      }
    }
  }
}

/**
 * Loads RMVPE 128x513 HTK Mel filterbank matrix from disk.
 */
export function loadRmvpeMelFilterbank(melFbPath: string): Float32Array {
  if (!fs.existsSync(melFbPath)) {
    throw new Error(`RMVPE Mel filterbank binary not found at: ${melFbPath}`);
  }
  const buf = fs.readFileSync(melFbPath);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Non-zero entries of each mel band of a [128, 513] filterbank, in frequency order: skipping zero weights leaves every sum unchanged. */
interface SparseBands {
  start: Int32Array;
  bins: Int32Array;
  weights: Float32Array;
}
const sparseBandsOf = new WeakMap<Float32Array, SparseBands>();
function sparseBands(melBasis: Float32Array): SparseBands {
  let s = sparseBandsOf.get(melBasis);
  if (s) return s;
  const bins: number[] = [];
  const weights: number[] = [];
  const start = new Int32Array(RMVPE_N_MELS + 1);
  for (let m = 0; m < RMVPE_N_MELS; m++) {
    start[m] = bins.length;
    for (let k = 0; k < N_FREQS; k++) {
      const w = melBasis[m * N_FREQS + k] ?? 0;
      if (w !== 0) {
        bins.push(k);
        weights.push(w);
      }
    }
  }
  start[RMVPE_N_MELS] = bins.length;
  s = { start, bins: Int32Array.from(bins), weights: Float32Array.from(weights) };
  sparseBandsOf.set(melBasis, s);
  return s;
}

/**
 * Computes the 128-bin HTK Mel Spectrogram for RMVPE at 16 kHz.
 * Outputs tensor with layout [128, numFrames].
 */
export function computeRmvpeMelSpectrogram(
  signal: Float32Array,
  melBasis: Float32Array
): RmvpeSpectrogramResult {
  const signalLen = signal.length;
  if (signalLen === 0) {
    return { data: new Float32Array(0), numFrames: 0, nMels: RMVPE_N_MELS };
  }

  // Center zero-pad: 512 left, 512 right
  const paddedLen = signalLen + 2 * RMVPE_PAD_AMOUNT;
  const padded = new Float32Array(paddedLen);
  padded.set(signal, RMVPE_PAD_AMOUNT);

  const numFrames = 1 + Math.floor((paddedLen - N_FFT) / RMVPE_HOP_LENGTH);
  const outSpectrogram = new Float32Array(RMVPE_N_MELS * numFrames);

  const bands = sparseBands(melBasis);
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  const mag = new Float32Array(N_FREQS);

  for (let f = 0; f < numFrames; f++) {
    const frameStart = f * RMVPE_HOP_LENGTH;

    for (let i = 0; i < N_FFT; i++) {
      re[i] = (padded[frameStart + i] ?? 0) * (HANN_WINDOW[i] ?? 0);
      im[i] = 0.0;
    }

    fft1024(re, im);

    for (let k = 0; k < N_FREQS; k++) {
      const r = re[k] ?? 0;
      const m = im[k] ?? 0;
      mag[k] = Math.sqrt(r * r + m * m);
    }

    for (let m = 0; m < RMVPE_N_MELS; m++) {
      let melVal = 0.0;
      for (let j = bands.start[m]!, end = bands.start[m + 1]!; j < end; j++) {
        melVal += bands.weights[j]! * mag[bands.bins[j]!]!;
      }
      outSpectrogram[m * numFrames + f] = Math.log(Math.max(1e-5, melVal));
    }
  }

  return {
    data: outSpectrogram,
    numFrames,
    nMels: RMVPE_N_MELS,
  };
}
