// packages/lyricsync/src/audio/audio.ts
// Audio decoding, mono downmix, and resampling for Node and Bun.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DecodedAudio } from './types.ts';

/**
 * Parses uncompressed PCM WAV data from a Uint8Array or ArrayBuffer.
 * Supports 16-bit, 24-bit, 32-bit integer and 32-bit float PCM, mono or multi-channel.
 */
export function parseWav(buffer: Uint8Array | ArrayBuffer): DecodedAudio {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Validate RIFF header
  const riff = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  const wave = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Not a valid RIFF/WAVE file');
  }

  let offset = 12;
  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ') {
      audioFormat = view.getUint16(chunkDataOffset, true);
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize;
    if (chunkSize % 2 === 1) offset++; // Word alignment
  }

  if (dataOffset === -1) {
    throw new Error('WAV data chunk not found');
  }

  const bytesPerSample = bitsPerSample / 8;
  const numFrames = Math.floor(dataSize / (bytesPerSample * channels));
  const totalSamples = numFrames * channels;
  const samples = new Float32Array(totalSamples);

  let readIdx = dataOffset;
  let writeIdx = 0;

  if (audioFormat === 1) {
    // PCM integer
    if (bitsPerSample === 16) {
      for (let i = 0; i < totalSamples; i++) {
        samples[writeIdx++] = view.getInt16(readIdx, true) / 32768.0;
        readIdx += 2;
      }
    } else if (bitsPerSample === 24) {
      for (let i = 0; i < totalSamples; i++) {
        const b0 = bytes[readIdx] ?? 0;
        const b1 = bytes[readIdx + 1] ?? 0;
        const b2 = bytes[readIdx + 2] ?? 0;
        let val = (b2 << 16) | (b1 << 8) | b0;
        if (val & 0x800000) val |= ~0xffffff;
        samples[writeIdx++] = val / 8388608.0;
        readIdx += 3;
      }
    } else if (bitsPerSample === 32) {
      for (let i = 0; i < totalSamples; i++) {
        samples[writeIdx++] = view.getInt32(readIdx, true) / 2147483648.0;
        readIdx += 4;
      }
    } else {
      throw new Error(`Unsupported PCM bits per sample: ${bitsPerSample}`);
    }
  } else if (audioFormat === 3) {
    // 32-bit float
    for (let i = 0; i < totalSamples; i++) {
      samples[writeIdx++] = view.getFloat32(readIdx, true);
      readIdx += 4;
    }
  } else {
    throw new Error(`Unsupported WAV audio format code: ${audioFormat}`);
  }

  return {
    samples,
    sampleRate,
    channels,
    durationSec: numFrames / sampleRate,
  };
}

/**
 * Mixes multi-channel interleaved audio down to mono Float32Array.
 */
export function toMono(interleaved: Float32Array, channels: number): Float32Array {
  if (channels === 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const mono = new Float32Array(frames);
  const invChannels = 1.0 / channels;

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * channels;
    for (let c = 0; c < channels; c++) {
      sum += interleaved[base + c] ?? 0;
    }
    mono[f] = sum * invChannels;
  }

  return mono;
}

/**
 * High-quality linear polyphase resampler.
 * Converts 1D mono audio buffer from inRate to outRate.
 */
export function resample(
  samples: Float32Array,
  inRate: number,
  outRate: number
): Float32Array {
  if (inRate === outRate) return samples;

  const ratio = outRate / inRate;
  const outLength = Math.round(samples.length * ratio);
  const output = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i / ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    if (srcIdx >= samples.length - 1) {
      output[i] = samples[samples.length - 1] ?? 0;
    } else {
      const s0 = samples[srcIdx] ?? 0;
      const s1 = samples[srcIdx + 1] ?? 0;
      output[i] = s0 + frac * (s1 - s0);
    }
  }

  return output;
}

/**
 * Band-limited resampler: Kaiser-windowed sinc (beta 5, 10 zero crossings of the lower rate either side), cutoff at the lower Nyquist
 * frequency, as scipy's resample_poly. Use it where a model was trained on properly resampled audio (the boundary model); linear
 * interpolation (`resample`) folds everything above the new Nyquist frequency back into the band. Rates must be whole numbers of Hz.
 */
export function resampleBandLimited(samples: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return samples;
  if (!Number.isInteger(inRate) || !Number.isInteger(outRate)) throw new Error(`Sample rates must be whole numbers, got ${inRate} -> ${outRate}.`);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(inRate, outRate);
  const up = outRate / g;
  const down = inRate / g;
  const fc = 0.5 * Math.min(1, outRate / inRate); // cycles per input sample
  const half = Math.ceil(10 * Math.max(1, inRate / outRate));
  const taps = 2 * half;
  const beta = 5;
  const besselI0 = (v: number): number => {
    let s = 1;
    let t = 1;
    for (let k = 1; k < 30; k++) {
      t *= (v / (2 * k)) ** 2;
      s += t;
    }
    return s;
  };
  const norm = besselI0(beta);
  // table[p * taps + m]: weight of input sample c - half + 1 + m for an output whose position is c + p / up (input samples).
  const table = new Float32Array(up * taps);
  for (let p = 0; p < up; p++) {
    for (let m = 0; m < taps; m++) {
      const d = p / up + half - 1 - m;
      const r = d / half;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / norm;
      table[p * taps + m] = w * (d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d));
    }
  }
  const outLength = Math.round((samples.length * up) / down);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const c = Math.floor((i * down) / up);
    const p = (i * down) % up;
    const k0 = c - half + 1;
    let s = 0;
    const m0 = Math.max(0, -k0);
    const m1 = Math.min(taps, samples.length - k0);
    for (let m = m0; m < m1; m++) s += samples[k0 + m]! * table[p * taps + m]!;
    output[i] = s;
  }
  return output;
}

/** Decodes any non-WAV file to mono float32 at `targetRate` through the ffmpeg CLI; throws with ffmpeg's own message when it cannot. */
function decodeWithFfmpeg(resolved: string, targetRate: number): Float32Array {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', resolved, '-ac', '1', '-ar', targetRate.toString(), '-f', 'f32le', '-'], { maxBuffer: 1024 * 1024 * 500 });
  if (result.error) {
    throw new Error(`Decoding ${path.extname(resolved)} files needs ffmpeg on PATH, which could not be run (${result.error.message}). Install ffmpeg or provide a WAV file.`);
  }
  if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
    throw new Error(`ffmpeg could not decode ${resolved}: ${result.stderr?.toString().trim() || `exit code ${String(result.status)}`}`);
  }
  const floatCount = Math.floor(result.stdout.length / 4);
  const out = new Float32Array(floatCount);
  const view = new DataView(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
  for (let i = 0; i < floatCount; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * Loads an audio file from disk as mono float32 at `targetRate` (default 44100 Hz).
 * WAV files are decoded and resampled natively, so the result never depends on which tools are installed; every other format goes through ffmpeg.
 */
export async function loadAudioFile(filePath: string, targetRate = 44100): Promise<Float32Array> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`Audio file not found: ${resolved}`);
  if (path.extname(resolved).toLowerCase() !== '.wav') return decodeWithFfmpeg(resolved, targetRate);
  const decoded = parseWav(fs.readFileSync(resolved));
  const mono = toMono(decoded.samples, decoded.channels);
  return decoded.sampleRate === targetRate ? mono : resample(mono, decoded.sampleRate, targetRate);
}
