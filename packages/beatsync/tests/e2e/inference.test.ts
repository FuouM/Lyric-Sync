// packages/beatsync/tests/e2e/inference.test.ts
import { describe, expect, test } from 'bun:test';
import { trackBeats } from '../../src/tracker.ts';

function synthesizeClickTrackWav(
  durationSec: number,
  bpm: number,
  sampleRate = 22050
): Float32Array {
  const totalSamples = Math.round(durationSec * sampleRate);
  const signal = new Float32Array(totalSamples);
  const beatInterval = 60.0 / bpm; // 0.5s for 120 bpm
  const clickDuration = 0.05; // 50 ms click burst
  const clickSamples = Math.round(clickDuration * sampleRate);

  let beatTime = 0.0;
  let beatIndex = 0;
  while (beatTime < durationSec) {
    const startSample = Math.round(beatTime * sampleRate);
    const isDownbeat = beatIndex % 4 === 0;
    const freq = isDownbeat ? 1000 : 700; // higher pitch for downbeat

    for (let i = 0; i < clickSamples && startSample + i < totalSamples; i++) {
      const t = i / sampleRate;
      const envelope = Math.exp(-t * 80); // percussive exponential decay
      const tone = Math.sin(2 * Math.PI * freq * t);
      signal[startSample + i] = (signal[startSample + i] ?? 0) + tone * envelope * 0.8;
    }

    beatTime += beatInterval;
    beatIndex++;
  }

  return signal;
}

describe('End-to-end Beat This! Tracking', () => {
  test('tracks 20s 120 BPM click track within 3% BPM and >=80% beats matched within 70ms', async () => {
    const duration = 20.0;
    const targetBpm = 120.0;
    const sampleRate = 22050;
    const signal = synthesizeClickTrackWav(duration, targetBpm, sampleRate);

    // True beat times
    const beatInterval = 60.0 / targetBpm;
    const trueBeats: number[] = [];
    for (let t = 0.0; t < duration; t += beatInterval) {
      trueBeats.push(parseFloat(t.toFixed(3)));
    }

    const analysis = await trackBeats(
      { samples: signal, sampleRate },
      { targetBpm: 120.0, firstDownbeat: 0.0 }
    );

    expect(analysis.beats.length).toBeGreaterThan(0);

    // Assert estimated BPM within 3% of 120 (116.4 - 123.6)
    const bpmDiffPercent = Math.abs(analysis.bpm - targetBpm) / targetBpm;
    expect(bpmDiffPercent).toBeLessThan(0.03);

    // Match true beats within 70 ms
    let matchedCount = 0;
    for (const tb of trueBeats) {
      const matched = analysis.beats.some((b) => Math.abs(b - tb) <= 0.07);
      if (matched) matchedCount++;
    }

    const matchRatio = matchedCount / trueBeats.length;
    expect(matchRatio).toBeGreaterThanOrEqual(0.8);
  }, 30000); // 30s timeout for model inference
});
