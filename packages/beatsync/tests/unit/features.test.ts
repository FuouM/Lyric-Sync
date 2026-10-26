// packages/beatsync/tests/unit/features.test.ts
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bandEnvelopes, computeFeatures, frameCount, peakNormalize, rmsEnvelope } from '../../src/features.ts';

const SR = 44100;

/** Silence of `seconds` with a sine of `hz` between `from` and `to` seconds. */
function sineBurst(seconds: number, hz: number, from: number, to: number, amp = 0.5, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = Math.round(from * sampleRate); i < Math.round(to * sampleRate); i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

function argmax(values: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i;
  return best;
}

/** 16-bit PCM mono WAV. */
function wavBytes(samples: Float32Array, sampleRate = SR): Uint8Array {
  const buffer = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(buffer.buffer);
  buffer.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + samples.length * 2, true);
  buffer.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  buffer.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), true));
  return buffer;
}

describe('frameCount', () => {
  test('is ceil(samples * fps / sampleRate)', () => {
    expect(frameCount(SR, SR)).toBe(100);
    expect(frameCount(SR + 1, SR)).toBe(101);
    expect(frameCount(441, SR)).toBe(1);
    expect(frameCount(440, SR)).toBe(1);
    expect(frameCount(0, SR)).toBe(0);
    expect(frameCount(22050 * 3 + 100, 22050)).toBe(301);
  });
});

describe('rmsEnvelope', () => {
  test('a sine burst gives its RMS inside the burst and 0 outside', () => {
    const samples = sineBurst(2, 441, 0.5, 1.0);
    const env = rmsEnvelope({ samples, sampleRate: SR }, 200);
    expect(env.length).toBe(200);
    // Frame 60 covers 0.60-0.61 s, inside the burst: RMS of a 0.5 sine is 0.5 / sqrt(2).
    expect(env[60]!).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(env[10]!).toBe(0);
    expect(env[150]!).toBe(0);
  });

  test('frames after the end of the audio are 0', () => {
    const samples = new Float32Array(SR / 2).fill(0.25);
    const env = rmsEnvelope({ samples, sampleRate: SR }, 100);
    expect(env[49]!).toBeCloseTo(0.25, 6);
    expect(env[50]!).toBe(0);
    expect(env[99]!).toBe(0);
  });

  test('frame edges stay exact at a sample rate that is not a multiple of 100', () => {
    // 22050 Hz: 220.5 samples per frame. A click at 9.995 s must land in frame 999, not drift.
    const sr = 22050;
    const samples = new Float32Array(sr * 10);
    samples[Math.round(9.995 * sr)] = 1;
    const env = rmsEnvelope({ samples, sampleRate: sr }, frameCount(samples.length, sr));
    expect(env.length).toBe(1000);
    expect(argmax(env)).toBe(999);
  });
});

describe('bandEnvelopes', () => {
  test('a low sine lands in the low band and a high sine in the high band, at the burst time', () => {
    const low = sineBurst(2, 100, 1.0, 1.2);
    const high = sineBurst(2, 6000, 0.4, 0.6);
    const mixed = low.map((s, i) => s + high[i]!);
    const bands = bandEnvelopes({ samples: mixed, sampleRate: SR }, 200);
    const lowPeak = argmax(bands.low);
    const highPeak = argmax(bands.high);
    expect(lowPeak).toBeGreaterThanOrEqual(100);
    expect(lowPeak).toBeLessThan(120);
    expect(highPeak).toBeGreaterThanOrEqual(40);
    expect(highPeak).toBeLessThan(60);
    // The mid band sees almost nothing from either sine.
    expect(Math.max(...bands.mid)).toBeLessThan(0.05 * Math.max(...bands.low));
  });
});

describe('peakNormalize', () => {
  test('max becomes exactly 1 and values stay in 0..1', () => {
    const out = peakNormalize([0, 0.2, 0.8, 0.4]);
    expect(out).toEqual([0, 0.25, 1, 0.5]);
  });

  test('silence gives zeros, not NaN', () => {
    const out = peakNormalize(new Float64Array(5));
    expect(out).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('computeFeatures', () => {
  test('writes every envelope with the mix length; a silent stem gives zeros; a stem without files is left out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatsync-features-'));
    try {
      const seconds = 1.234;
      const mix = sineBurst(seconds, 441, 0.3, 0.5);
      fs.writeFileSync(path.join(dir, 'mix.wav'), wavBytes(mix));
      fs.writeFileSync(path.join(dir, 'vocal.wav'), wavBytes(sineBurst(seconds, 220, 0.8, 0.9)));
      fs.writeFileSync(path.join(dir, 'drums.wav'), wavBytes(new Float32Array(mix.length)));
      const doc = await computeFeatures(path.join(dir, 'mix.wav'), {
        vocal: [path.join(dir, 'vocal.wav')],
        drums: [path.join(dir, 'drums.wav')],
      });
      expect(doc.v).toBe(1);
      expect(doc.fps).toBe(100);
      expect(doc.onsets).toEqual({});
      expect(Object.keys(doc.envelopes).sort()).toEqual(['drums', 'high', 'low', 'mid', 'rms', 'vocal']);
      const n = Math.ceil(seconds * 100);
      for (const [key, env] of Object.entries(doc.envelopes)) {
        expect(env.length, key).toBe(n);
        expect(env.every((v) => v >= 0 && v <= 1), key).toBe(true);
      }
      expect(Math.max(...doc.envelopes.rms)).toBe(1);
      expect(argmax(doc.envelopes.rms)).toBeGreaterThanOrEqual(30);
      expect(argmax(doc.envelopes.rms)).toBeLessThan(50);
      expect(argmax(doc.envelopes.vocal!)).toBeGreaterThanOrEqual(80);
      expect(argmax(doc.envelopes.vocal!)).toBeLessThan(90);
      expect(doc.envelopes.drums!.every((v) => v === 0)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing stem file is an error that names the file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatsync-features-'));
    try {
      fs.writeFileSync(path.join(dir, 'mix.wav'), wavBytes(new Float32Array(4410)));
      await expect(computeFeatures(path.join(dir, 'mix.wav'), { bass: [path.join(dir, 'bass.wav')] })).rejects.toThrow('bass.wav');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
