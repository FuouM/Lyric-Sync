// src/beat-grid.ts
// The song beat grid (beat times in seconds, generated/timing.ai.json "beats"): beat number <-> time. Linear between beats, linear
// past both ends with the first / last beat period. A grid of fewer than two beats uses 0.5 s per beat.
// No Node or Bun imports: the editor's browser code uses this module too.

/** Time in seconds of beat number `b` (may be fractional or outside the grid). */
export function beatTime(beats: readonly number[], b: number): number {
  const n = beats.length;
  if (n === 0) return b * 0.5;
  if (n === 1) return beats[0]! + b * 0.5;
  if (b <= 0) return beats[0]! + b * (beats[1]! - beats[0]!);
  if (b >= n - 1) return beats[n - 1]! + (b - (n - 1)) * (beats[n - 1]! - beats[n - 2]!);
  const i = Math.floor(b);
  return beats[i]! + (b - i) * (beats[i + 1]! - beats[i]!);
}

/** Fractional beat number at time `t` (the inverse of `beatTime`). */
export function beatAt(beats: readonly number[], t: number): number {
  const n = beats.length;
  if (n === 0) return t / 0.5;
  if (n === 1) return (t - beats[0]!) / 0.5;
  if (t <= beats[0]!) return (t - beats[0]!) / (beats[1]! - beats[0]!);
  if (t >= beats[n - 1]!) return n - 1 + (t - beats[n - 1]!) / (beats[n - 1]! - beats[n - 2]!);
  // The last beat at or before t: beats[lo] <= t < beats[hi].
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - beats[lo]!) / (beats[lo + 1]! - beats[lo]!);
}
