// packages/beatsync/tests/unit/audio.test.ts
import { describe, expect, test } from 'bun:test';
import { parseWav, toMono, resample } from '../../src/audio.ts';

function buildWavBuffer(samples: Float32Array, sampleRate: number, channels: number): Uint8Array {
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const bufferSize = 44 + dataSize;
  const buffer = new Uint8Array(bufferSize);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // RIFF identifier
  buffer.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  buffer.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // "fmt " chunk
  buffer.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true); // Chunk size 16
  view.setUint16(20, 1, true);  // Audio format 1 (PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // 16 bits per sample

  // "data" chunk
  buffer.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, Math.round(val), true);
    offset += 2;
  }

  return buffer;
}

describe('WAV Parsing', () => {
  test('parses 16-bit mono WAV buffer correctly', () => {
    const origSamples = new Float32Array([0.0, 0.5, -0.5, 0.99]);
    const wavBytes = buildWavBuffer(origSamples, 44100, 1);
    const decoded = parseWav(wavBytes);

    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(4);
    expect(decoded.durationSec).toBeCloseTo(4 / 44100, 5);
    expect(decoded.samples[0]!).toBeCloseTo(0.0, 2);
    expect(decoded.samples[1]!).toBeCloseTo(0.5, 2);
    expect(decoded.samples[2]!).toBeCloseTo(-0.5, 2);
    expect(decoded.samples[3]!).toBeCloseTo(0.99, 2);
  });

  test('parses 16-bit stereo WAV buffer correctly', () => {
    const origSamples = new Float32Array([0.1, -0.1, 0.2, -0.2]); // 2 frames stereo
    const wavBytes = buildWavBuffer(origSamples, 22050, 2);
    const decoded = parseWav(wavBytes);

    expect(decoded.sampleRate).toBe(22050);
    expect(decoded.channels).toBe(2);
    expect(decoded.samples.length).toBe(4);
    expect(decoded.durationSec).toBeCloseTo(2 / 22050, 5);
  });
});

describe('Mono Mixdown & Resampling', () => {
  test('mixes stereo to mono correctly', () => {
    const stereo = new Float32Array([0.4, 0.2, -0.6, 0.2]);
    const mono = toMono(stereo, 2);

    expect(mono.length).toBe(2);
    expect(mono[0]!).toBeCloseTo(0.3, 5);
    expect(mono[1]!).toBeCloseTo(-0.2, 5);
  });

  test('resamples audio with expected length and identity', () => {
    const input = new Float32Array([0.0, 0.5, 1.0, 0.5, 0.0]);
    // Identity resample
    const same = resample(input, 22050, 22050);
    expect(same).toBe(input);

    // Upsample 2x
    const up = resample(input, 22050, 44100);
    expect(up.length).toBe(10);
    expect(up[0]!).toBeCloseTo(0.0, 4);

    // Downsample 2x
    const down = resample(input, 44100, 22050);
    expect(down.length).toBe(Math.round(5 * 0.5));
  });
});
