// packages/beatsync/src/spectrogram.ts
// Pure TypeScript implementation of Log-Mel Spectrogram extraction matching Beat This! (torchaudio).
// Parameters: sample_rate=22050, n_fft=1024, hop_length=441 (50 fps), f_min=30, f_max=11000,
// n_mels=128, mel_scale="slaney", normalized="frame_length" (1/sqrt(1024)), log_multiplier=1000.

import * as fs from 'node:fs';
import { modelPath } from './paths.ts';
import type { SpectrogramResult } from './types.ts';

export const N_FFT = 1024;
export const HOP_LENGTH = 441; // 50 Hz frame rate at 22050 Hz
export const N_MELS = 128;
export const F_MIN = 30.0;
export const F_MAX = 11000.0;
export const SPECTROGRAM_SAMPLE_RATE = 22050;
const SAMPLE_RATE = SPECTROGRAM_SAMPLE_RATE;
export const LOG_MULTIPLIER = 1000.0;
export const N_FREQS = N_FFT / 2 + 1; // 513
export const PAD_AMOUNT = N_FFT / 2; // 512 (reflect pad)
export const INV_SQRT_N_FFT = 1.0 / Math.sqrt(N_FFT); // 1/32

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
    const j = BIT_REV[i]!;
    if (j > i) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }

  for (let halfSize = 1; halfSize < N_FFT; halfSize <<= 1) {
    const step = halfSize << 1;
    const tableStep = N_FFT / step;
    for (let k = 0; k < halfSize; k++) {
      const wr = COS_TABLE[k * tableStep]!;
      const wi = SIN_TABLE[k * tableStep]!;
      for (let i = k; i < N_FFT; i += step) {
        const j = i + halfSize;
        const tr = wr * re[j]! - wi * im[j]!;
        const ti = wr * im[j]! + wi * re[j]!;
        re[j] = re[i]! - tr;
        im[j] = im[i]! - ti;
        re[i] = re[i]! + tr;
        im[i] = im[i]! + ti;
      }
    }
  }
}

// -------------------------------------------------------------
// Slaney Mel Filterbank (bundled)
// -------------------------------------------------------------
/** The Slaney mel filterbank matrix of size [513, 128], read from the bundled models/mel_fb_513x128.bin (an error naming the file if it is missing). */
export function createSlaneyMelFilterbank(): Float32Array {
  const buf = fs.readFileSync(modelPath('mel_fb_513x128.bin'));
  const fb = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (fb.length !== N_FREQS * N_MELS) throw new Error(`mel_fb_513x128.bin has ${fb.length} values, expected ${N_FREQS * N_MELS}.`);
  return fb;
}

let cachedFilterbank: Float32Array | null = null;
function getMelFilterbank(): Float32Array {
  if (!cachedFilterbank) {
    cachedFilterbank = createSlaneyMelFilterbank();
  }
  return cachedFilterbank;
}

/**
 * Computes the Log-Mel Spectrogram of a 1D audio signal at 22050 Hz.
 */
export function computeLogMelSpectrogram(signal: Float32Array): SpectrogramResult {
  const signalLen = signal.length;
  if (signalLen === 0) {
    return { data: new Float32Array(0), numFrames: 0, nMels: N_MELS, durationSec: 0, fps: 50 };
  }

  const filterbank = getMelFilterbank();

  // 1. Reflect padding (512 samples on left and right)
  const paddedLen = signalLen + 2 * PAD_AMOUNT;
  const padded = new Float32Array(paddedLen);

  // Left reflect pad
  for (let i = 0; i < PAD_AMOUNT; i++) {
    const srcIdx = PAD_AMOUNT - i;
    padded[i] = signal[Math.min(srcIdx, signalLen - 1)]!;
  }

  // Middle signal
  padded.set(signal, PAD_AMOUNT);

  // Right reflect pad
  for (let i = 0; i < PAD_AMOUNT; i++) {
    const srcIdx = signalLen - 2 - i;
    padded[PAD_AMOUNT + signalLen + i] = signal[Math.max(0, srcIdx)]!;
  }

  // Number of frames: 1 + floor((paddedLen - N_FFT) / HOP_LENGTH)
  const numFrames = 1 + Math.floor((paddedLen - N_FFT) / HOP_LENGTH);
  const outSpectrogram = new Float32Array(numFrames * N_MELS);

  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  const mag = new Float32Array(N_FREQS);

  for (let f = 0; f < numFrames; f++) {
    const frameStart = f * HOP_LENGTH;

    for (let i = 0; i < N_FFT; i++) {
      re[i] = padded[frameStart + i]! * HANN_WINDOW[i]!;
      im[i] = 0.0;
    }

    fft1024(re, im);

    for (let k = 0; k < N_FREQS; k++) {
      const r = re[k]!;
      const m = im[k]!;
      mag[k] = Math.sqrt(r * r + m * m) * INV_SQRT_N_FFT;
    }

    const outFrameOffset = f * N_MELS;
    for (let m = 0; m < N_MELS; m++) {
      let melVal = 0.0;
      for (let k = 0; k < N_FREQS; k++) {
        const weight = filterbank[k * N_MELS + m]!;
        if (weight > 0.0) {
          melVal += mag[k]! * weight;
        }
      }
      outSpectrogram[outFrameOffset + m] = Math.log1p(LOG_MULTIPLIER * melVal);
    }
  }

  return {
    data: outSpectrogram,
    numFrames,
    nMels: N_MELS,
    durationSec: signalLen / SAMPLE_RATE,
    fps: 50,
  };
}
