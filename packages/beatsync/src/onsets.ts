// packages/beatsync/src/onsets.ts
// Onset detector for isolated drum stems (kick, snare, hat) of the features.json v1 contract.
//
// Method, for one mono stem at its own sample rate sr:
// 1. hat only: a 2nd-order Butterworth high-pass filter (RBJ biquad) at highpassHz.
// 2. Energy: frame n ends at sample (n + 1) * hop (hop = round(sr * hopSeconds)) and is the mean square of the last
//    round(sr * windowSeconds) samples. Level L[n] = 10 * log10(energy / max energy + 10^(floorDb / 10)) in dB.
// 3. Rise F[n] = max(0, L[n] - L[n - lag]) with lag = the window in frames.
// 4. Peaks: F[p] is the maximum of F in [p - lag, p + lag] (the first frame of equal values wins), F[p] >= the median of F
//    in [p - medianSeconds, p + medianSeconds] + marginDb, and L[p] >= gateDb.
// 5. Attack: m0 = the last frame with the minimum L in [p - 2 * lag, p - 1]. The onset frame m is the first frame after
//    m0 with L[m] >= L[m0] + min(3, F[p] / 2) dB. Onset time = m * hop / sr (the start of the last hop of frame m).
// 6. Minimum gap: onsets are taken in time order. An onset closer than minGapSeconds to the last kept onset replaces it
//    only when its rise F is larger.
// 7. Strength = sqrt(max energy in [m, m + 2 * lag]) - sqrt(energy[m0]), divided by the largest strength of the stem,
//    rounded to 3 decimals. Times are rounded to 3 decimals. A silent stem gives no onsets.

import type { DrumOnsetKey } from './types.ts';

export interface OnsetOptions {
  /** Hop between energy frames in seconds. */
  hopSeconds: number;
  /** Energy window in seconds (also the lag of the rise). */
  windowSeconds: number;
  /** Two onsets are at least this far apart. */
  minGapSeconds: number;
  /** High-pass cutoff in Hz before the energy, or 0 for none. */
  highpassHz: number;
  /** A peak rise must be this many dB above the local median rise. */
  marginDb: number;
  /** Half width of the local median window in seconds. */
  medianSeconds: number;
  /** Level floor in dB relative to the stem's maximum energy. */
  floorDb: number;
  /** A peak frame must be at least this level in dB relative to the stem's maximum energy. */
  gateDb: number;
}

const BASE: Omit<OnsetOptions, 'minGapSeconds' | 'highpassHz' | 'windowSeconds'> = {
  hopSeconds: 0.002,
  marginDb: 6,
  medianSeconds: 0.25,
  floorDb: -60,
  gateDb: -30,
};

/** Default detector settings per drum stem. */
export const ONSET_DEFAULTS: Record<DrumOnsetKey, OnsetOptions> = {
  kick: { ...BASE, windowSeconds: 0.01, minGapSeconds: 0.07, highpassHz: 0 },
  snare: { ...BASE, windowSeconds: 0.01, minGapSeconds: 0.07, highpassHz: 0 },
  hat: { ...BASE, windowSeconds: 0.006, minGapSeconds: 0.04, highpassHz: 3000 },
};

/** 2nd-order Butterworth high-pass filter (RBJ biquad, Q = 1/sqrt(2)). */
export function highpass(samples: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const alpha = Math.sin(w0) / Math.SQRT2;
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

function median(values: Float64Array, from: number, to: number): number {
  const slice = Array.from(values.subarray(from, to)).sort((a, b) => a - b);
  const mid = slice.length >> 1;
  return slice.length % 2 === 1 ? slice[mid]! : (slice[mid - 1]! + slice[mid]!) / 2;
}

/** Onsets of one mono drum stem as [time s, strength 0..1] pairs, sorted by time (see the file header for the method). */
export function detectOnsets(samples: Float32Array, sampleRate: number, options: OnsetOptions): Array<[number, number]> {
  const signal = options.highpassHz > 0 ? highpass(samples, sampleRate, options.highpassHz) : samples;
  const hop = Math.max(1, Math.round(sampleRate * options.hopSeconds));
  const win = Math.max(hop, Math.round(sampleRate * options.windowSeconds));
  const frames = Math.floor(signal.length / hop);
  if (frames === 0) return [];

  // Running sum of squares: energy of frame n = (sum of squares in [end - win, end)) / win.
  const prefix = new Float64Array(signal.length + 1);
  for (let i = 0; i < signal.length; i++) prefix[i + 1] = prefix[i]! + signal[i]! * signal[i]!;
  const energy = new Float64Array(frames);
  let maxEnergy = 0;
  for (let n = 0; n < frames; n++) {
    const end = (n + 1) * hop;
    energy[n] = (prefix[end]! - prefix[Math.max(0, end - win)]!) / win;
    if (energy[n]! > maxEnergy) maxEnergy = energy[n]!;
  }
  if (maxEnergy <= 0) return [];

  const floor = 10 ** (options.floorDb / 10);
  const level = new Float64Array(frames);
  for (let n = 0; n < frames; n++) level[n] = 10 * Math.log10(energy[n]! / maxEnergy + floor);
  const lag = Math.max(1, Math.round(win / hop));
  const rise = new Float64Array(frames);
  for (let n = lag; n < frames; n++) rise[n] = Math.max(0, level[n]! - level[n - lag]!);

  const medianHalf = Math.round((options.medianSeconds * sampleRate) / hop);
  const minGap = options.minGapSeconds * sampleRate;
  const kept: Array<{ sample: number; rise: number; strength: number }> = [];
  for (let p = lag; p < frames; p++) {
    const r = rise[p]!;
    if (r <= 0 || level[p]! < options.gateDb) continue;
    let isPeak = true;
    for (let q = Math.max(0, p - lag); q <= Math.min(frames - 1, p + lag) && isPeak; q++) {
      if (rise[q]! > r || (q < p && rise[q] === r)) isPeak = false;
    }
    if (!isPeak) continue;
    if (r < median(rise, Math.max(0, p - medianHalf), Math.min(frames, p + medianHalf + 1)) + options.marginDb) continue;

    let m0 = p - 1;
    for (let q = p - 1; q >= Math.max(0, p - 2 * lag); q--) if (level[q]! < level[m0]!) m0 = q;
    const target = level[m0]! + Math.min(3, r / 2);
    let m = m0 + 1;
    while (m < p && level[m]! < target) m++;
    let peakEnergy = 0;
    for (let q = m; q <= Math.min(frames - 1, m + 2 * lag); q++) if (energy[q]! > peakEnergy) peakEnergy = energy[q]!;
    const onset = { sample: m * hop, rise: r, strength: Math.max(0, Math.sqrt(peakEnergy) - Math.sqrt(energy[m0]!)) };

    const last = kept[kept.length - 1];
    if (last && onset.sample - last.sample < minGap) {
      if (onset.rise > last.rise) kept[kept.length - 1] = onset;
    } else {
      kept.push(onset);
    }
  }

  let maxStrength = 0;
  for (const o of kept) if (o.strength > maxStrength) maxStrength = o.strength;
  return kept.map((o) => [Number((o.sample / sampleRate).toFixed(3)), maxStrength > 0 ? Number((o.strength / maxStrength).toFixed(3)) : 0]);
}
