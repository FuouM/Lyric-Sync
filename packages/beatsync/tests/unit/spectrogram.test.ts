// packages/beatsync/tests/unit/spectrogram.test.ts
import { describe, expect, test } from 'bun:test';
import { computeLogMelSpectrogram, HOP_LENGTH, N_MELS } from '../../src/spectrogram.ts';

describe('Log-Mel Spectrogram Extraction', () => {
  test('returns empty result for empty signal', () => {
    const res = computeLogMelSpectrogram(new Float32Array(0));
    expect(res.numFrames).toBe(0);
    expect(res.data.length).toBe(0);
  });

  test('computes correct frame count and dimensions for synthetic 1-second sine wave', () => {
    const sampleRate = 22050;
    const duration = 1.0;
    const numSamples = Math.round(sampleRate * duration);
    const signal = new Float32Array(numSamples);

    // 440 Hz sine wave
    for (let i = 0; i < numSamples; i++) {
      signal[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }

    const res = computeLogMelSpectrogram(signal);

    // Expected frames: 1 + floor((numSamples + 1024 - 1024) / 441) = 1 + floor(22050 / 441) = 51 frames
    const expectedFrames = 1 + Math.floor(numSamples / HOP_LENGTH);
    expect(res.numFrames).toBe(expectedFrames);
    expect(res.nMels).toBe(N_MELS);
    expect(res.data.length).toBe(expectedFrames * N_MELS);
    expect(res.fps).toBe(50);

    // Verify non-zero energy in the spectrogram
    let maxVal = 0;
    for (let i = 0; i < res.data.length; i++) {
      if (res.data[i]! > maxVal) maxVal = res.data[i]!;
    }
    expect(maxVal).toBeGreaterThan(0.5);
  });
});
