// packages/lyricsync/tests/unit/tap-tempo.test.ts
import { describe, expect, test } from 'bun:test';
import { addTap, fitTaps, type Tap } from '../../web/src/lib/tap-tempo.ts';

/** Taps on a 0.5 s (120 BPM) beat from 3.2 s, with a deterministic ±15 ms jitter. */
const beatTime = (k: number) => 3.2 + 0.5 * k + 0.015 * Math.sin(k * 2.7);

describe('tap tempo', () => {
  test('the fit keeps improving past 16 taps, and skipped beats and double taps do not throw it off', () => {
    let taps: Tap[] = [];
    for (let k = 0; k < 64; k++) {
      if (k === 20 || k === 21 || k === 40) continue; // skipped beats
      taps = addTap(taps, beatTime(k));
      if (k === 30) taps = addTap(taps, beatTime(k) + 0.08); // double tap
    }
    expect(taps.map((p) => p.beat)).toEqual([...Array(64).keys()].filter((k) => k !== 20 && k !== 21 && k !== 40));
    const fit = fitTaps(taps)!;
    expect(Math.abs(fit.bpm - 120)).toBeLessThan(0.05);
    expect(Math.abs(fit.origin - 3.2)).toBeLessThan(0.01);
    expect(fit.bpmError).toBeLessThan(fitTaps(taps.slice(0, 16))!.bpmError / 4);
  });
});
