// packages/beatsync/src/features.ts
// Audio feature envelopes for video tools (the features.json v1 contract).
//
// Frames: frame f covers the samples [floor(f * sr / fps), floor((f + 1) * sr / fps)) of a file at sample rate sr.
// The frame count is ceil(mix samples * fps / mix sample rate), so the last frame can be partial.
// rms: the RMS of the mono samples in the frame (mono = mean of the channels). A frame after the end of a file is 0.
// low / mid / high: the band magnitude of the mix. The mix is resampled to 22050 Hz, and a 1024-point Hann-window FFT
//   is centred on the frame centre (zeros outside the signal). Band magnitude = sqrt(sum of |X(k)|^2 over the band bins).
//   Band edges in BAND_EDGES_HZ: a bin k belongs to a band when lo <= k * 22050 / 1024 < hi.
// Stem envelopes: the sum of the RMS envelopes of the files of one stem key.
// Every envelope is then divided by its own maximum (peak normalization) and rounded to 4 decimals. A silent input gives zeros.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadAudioFile, parseWav, resample, toMono } from './audio.ts';
import { fft1024, HANN_WINDOW, N_FFT, N_FREQS, SPECTROGRAM_SAMPLE_RATE } from './spectrogram.ts';
import type { FeaturesDocument, FeatureStems, StemEnvelopeKey } from './types.ts';

/** Frames per second of every envelope. */
export const FEATURES_FPS = 100;

/** Band edges of the low, mid and high envelopes in Hz: [lo, hi). The high band ends at the Nyquist frequency of 22050 Hz audio. */
export const BAND_EDGES_HZ = {
  low: [20, 250],
  mid: [250, 4000],
  high: [4000, SPECTROGRAM_SAMPLE_RATE / 2 + 1],
} as const;

/** Mono audio at its own sample rate. */
export interface MonoAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface BandEnvelopes {
  low: Float64Array;
  mid: Float64Array;
  high: Float64Array;
}

const STEM_KEYS: StemEnvelopeKey[] = ['vocal', 'drums', 'bass', 'other'];

/** Number of frames that cover `numSamples` samples: ceil(numSamples * fps / sampleRate). */
export function frameCount(numSamples: number, sampleRate: number, fps = FEATURES_FPS): number {
  return Math.ceil((numSamples * fps) / sampleRate);
}

/** Raw (not normalized) RMS per frame. The output has `frames` values; frames after the end of the audio are 0. */
export function rmsEnvelope(audio: MonoAudio, frames: number, fps = FEATURES_FPS): Float64Array {
  const { samples, sampleRate } = audio;
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = Math.floor((f * sampleRate) / fps);
    const end = Math.min(Math.floor(((f + 1) * sampleRate) / fps), samples.length);
    if (end <= start) break;
    let sq = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i]!;
      sq += s * s;
    }
    out[f] = Math.sqrt(sq / (end - start));
  }
  return out;
}

function bandBins(lo: number, hi: number): [number, number] {
  const binHz = SPECTROGRAM_SAMPLE_RATE / N_FFT;
  let first = N_FREQS;
  let last = -1;
  for (let k = 0; k < N_FREQS; k++) {
    const hz = k * binHz;
    if (hz >= lo && hz < hi) {
      if (k < first) first = k;
      last = k;
    }
  }
  return [first, last + 1];
}

/** Raw (not normalized) low, mid and high band magnitudes per frame (see the file header for the method). */
export function bandEnvelopes(audio: MonoAudio, frames: number, fps = FEATURES_FPS): BandEnvelopes {
  const signal = resample(audio.samples, audio.sampleRate, SPECTROGRAM_SAMPLE_RATE);
  const bands = [bandBins(...BAND_EDGES_HZ.low), bandBins(...BAND_EDGES_HZ.mid), bandBins(...BAND_EDGES_HZ.high)] as const;
  const out: BandEnvelopes = { low: new Float64Array(frames), mid: new Float64Array(frames), high: new Float64Array(frames) };
  const targets = [out.low, out.mid, out.high] as const;
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  const half = N_FFT / 2;
  for (let f = 0; f < frames; f++) {
    const centre = Math.round(((f + 0.5) * SPECTROGRAM_SAMPLE_RATE) / fps);
    const start = centre - half;
    for (let i = 0; i < N_FFT; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < signal.length ? signal[idx]! * HANN_WINDOW[i]! : 0;
      im[i] = 0;
    }
    fft1024(re, im);
    for (let b = 0; b < 3; b++) {
      const [first, end] = bands[b]!;
      let power = 0;
      for (let k = first; k < end; k++) power += re[k]! * re[k]! + im[k]! * im[k]!;
      targets[b]![f] = Math.sqrt(power);
    }
  }
  return out;
}

/** Divides by the maximum and rounds to 4 decimals. The maximum becomes exactly 1. All-zero input stays all zeros. */
export function peakNormalize(values: ArrayLike<number>): number[] {
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! > max) max = values[i]!;
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) out[i] = max > 0 ? Number((values[i]! / max).toFixed(4)) : 0;
  return out;
}

/** Loads a file as mono audio. WAV files keep their sample rate. Other formats are decoded by ffmpeg at 44100 Hz. */
export async function loadMonoAudio(filePath: string): Promise<MonoAudio> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`Audio file not found: ${resolved}`);
  if (path.extname(resolved).toLowerCase() !== '.wav') return { samples: await loadAudioFile(resolved, 44100), sampleRate: 44100 };
  const decoded = parseWav(fs.readFileSync(resolved));
  return { samples: toMono(decoded.samples, decoded.channels), sampleRate: decoded.sampleRate };
}

/**
 * Computes the features.json v1 document. `rms`, `low`, `mid`, `high` come from the mix. Each stem key with files gives one envelope.
 * Every envelope has frameCount(mix) values. `onsets` is empty: beatsync has no onset detector yet.
 */
export async function computeFeatures(mixPath: string, stems: FeatureStems = {}): Promise<FeaturesDocument> {
  const mix = await loadMonoAudio(mixPath);
  const frames = frameCount(mix.samples.length, mix.sampleRate);
  const bands = bandEnvelopes(mix, frames);
  const envelopes: FeaturesDocument['envelopes'] = {
    rms: peakNormalize(rmsEnvelope(mix, frames)),
    low: peakNormalize(bands.low),
    mid: peakNormalize(bands.mid),
    high: peakNormalize(bands.high),
  };
  for (const key of STEM_KEYS) {
    const files = stems[key];
    if (!files || files.length === 0) continue;
    const sum = new Float64Array(frames);
    for (const file of files) {
      const env = rmsEnvelope(await loadMonoAudio(file), frames);
      for (let i = 0; i < frames; i++) sum[i] = sum[i]! + env[i]!;
    }
    envelopes[key] = peakNormalize(sum);
  }
  return { v: 1, fps: FEATURES_FPS, envelopes, onsets: {} };
}
