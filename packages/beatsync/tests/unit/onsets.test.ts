// packages/beatsync/tests/unit/onsets.test.ts
import { describe, expect, test } from 'bun:test';
import { detectOnsets, highpass, ONSET_DEFAULTS } from '../../src/onsets.ts';

const SR = 44100;

/** Deterministic white noise in -1..1 (linear congruential generator). */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x80000000 - 1;
  };
}

/** Adds a hit at `time`: a sine of `hz` (or noise when hz is 0) with an exponential decay of `decay` seconds. */
function addHit(out: Float32Array, time: number, hz: number, decay: number, amp: number, seed = 1): void {
  const rand = noise(seed);
  const start = Math.round(time * SR);
  for (let i = 0; start + i < out.length && i < decay * 8 * SR; i++) {
    const t = i / SR;
    const tone = hz > 0 ? Math.sin(2 * Math.PI * hz * t) : rand();
    out[start + i] = out[start + i]! + amp * tone * Math.exp(-t / decay);
  }
}

function signal(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR));
}

function rms(samples: Float32Array): number {
  let sq = 0;
  for (const s of samples) sq += s * s;
  return Math.sqrt(sq / samples.length);
}

describe('detectOnsets', () => {
  test('kick-like hits are found within 5 ms of their start', () => {
    const times = [0.1, 0.52, 0.937, 1.4, 1.62];
    const x = signal(2);
    for (const t of times) addHit(x, t, 55, 0.08, 0.8);
    const onsets = detectOnsets(x, SR, ONSET_DEFAULTS.kick);
    expect(onsets.length).toBe(times.length);
    onsets.forEach(([t], i) => expect(Math.abs(t - times[i]!)).toBeLessThanOrEqual(0.005));
  });

  test('snare-like noise hits over a loud tail are found within 5 ms', () => {
    const times = [0.2, 0.5, 0.8, 1.1];
    const x = signal(1.5);
    times.forEach((t, i) => addHit(x, t, 0, 0.15, 0.6, i + 1));
    const onsets = detectOnsets(x, SR, ONSET_DEFAULTS.snare);
    expect(onsets.map(([t]) => t).length).toBe(times.length);
    onsets.forEach(([t], i) => expect(Math.abs(t - times[i]!)).toBeLessThanOrEqual(0.005));
  });

  test('dense hat hits are found within 5 ms at 48 kHz', () => {
    const sr = 48000;
    const times = Array.from({ length: 16 }, (_, i) => 0.05 + i * 0.105);
    const x = new Float32Array(Math.round(1.9 * sr));
    times.forEach((t, i) => {
      const rand = noise(i + 7);
      const start = Math.round(t * sr);
      for (let j = 0; j < 0.03 * sr; j++) x[start + j] = 0.4 * rand() * Math.exp(-j / sr / 0.01);
    });
    const onsets = detectOnsets(x, sr, ONSET_DEFAULTS.hat);
    expect(onsets.length).toBe(times.length);
    onsets.forEach(([t], i) => expect(Math.abs(t - times[i]!)).toBeLessThanOrEqual(0.005));
  });

  test('no double trigger inside the minimum gap; the stronger rise is kept', () => {
    const x = signal(1);
    addHit(x, 0.3, 0, 0.05, 0.8, 3);
    addHit(x, 0.33, 0, 0.05, 0.5, 4); // a flam 30 ms later, inside the 70 ms kick gap
    addHit(x, 0.6, 55, 0.08, 0.8);
    const onsets = detectOnsets(x, SR, ONSET_DEFAULTS.kick);
    expect(onsets.map(([t]) => t).length).toBe(2);
    expect(Math.abs(onsets[0]![0] - 0.3)).toBeLessThanOrEqual(0.005);
    for (let i = 1; i < onsets.length; i++) expect(onsets[i]![0] - onsets[i - 1]![0]).toBeGreaterThanOrEqual(ONSET_DEFAULTS.kick.minGapSeconds);
  });

  test('strength is the rise normalized to the loudest hit of the stem', () => {
    const x = signal(1.2);
    addHit(x, 0.2, 55, 0.05, 0.8);
    addHit(x, 0.7, 55, 0.05, 0.4);
    const onsets = detectOnsets(x, SR, ONSET_DEFAULTS.kick);
    expect(onsets.length).toBe(2);
    expect(onsets[0]![1]).toBe(1);
    expect(Math.abs(onsets[1]![1] - 0.5)).toBeLessThanOrEqual(0.05);
    expect(onsets.every(([, s]) => s >= 0 && s <= 1)).toBe(true);
  });

  test('silence and too-short input give no onsets', () => {
    expect(detectOnsets(signal(1), SR, ONSET_DEFAULTS.kick)).toEqual([]);
    expect(detectOnsets(signal(1), SR, ONSET_DEFAULTS.hat)).toEqual([]);
    expect(detectOnsets(new Float32Array(10), SR, ONSET_DEFAULTS.snare)).toEqual([]);
  });

  test('a steady tone gives at most its start', () => {
    const x = signal(1);
    for (let i = Math.round(0.1 * SR); i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const onsets = detectOnsets(x, SR, ONSET_DEFAULTS.snare);
    expect(onsets.length).toBe(1);
    expect(Math.abs(onsets[0]![0] - 0.1)).toBeLessThanOrEqual(0.005);
  });
});

describe('highpass', () => {
  test('removes low frequencies and keeps high frequencies', () => {
    const tone = (hz: number) => Float32Array.from({ length: SR }, (_, i) => Math.sin((2 * Math.PI * hz * i) / SR));
    const low = highpass(tone(100), SR, 3000).subarray(SR / 2);
    const high = highpass(tone(10000), SR, 3000).subarray(SR / 2);
    expect(rms(low)).toBeLessThan(0.01);
    expect(rms(high)).toBeGreaterThan(0.65);
  });
});
