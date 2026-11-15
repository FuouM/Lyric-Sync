// packages/lyricsync/web/src/lib/tap-tempo.ts
// Tap tempo for the new-song wizard. Each tap is put on a beat of the grid the earlier taps give (a skipped beat leaves a gap,
// a double tap is dropped), and the tempo and phase are a least-squares line through every tap of the measurement. The error of
// the tempo then keeps falling as one taps (as n^-1.5 for n taps), where a median of the last few intervals stops improving.

/** A tap: its time in seconds and the beat it is put on (0 = the first tap's beat). */
export interface Tap {
  t: number;
  beat: number;
}

export interface TapFit {
  /** Seconds per beat. */
  period: number;
  bpm: number;
  /** Time of beat 0 on the fitted grid (seconds, the taps' clock). */
  origin: number;
  /** RMS distance of the taps from the fitted grid, as a fraction of a beat. */
  jitter: number;
  /** Standard error of `bpm` (0 with two taps). */
  bpmError: number;
}

/** The least-squares beat grid through the taps, or null while they cover fewer than two beats. */
export function fitTaps(taps: readonly Tap[]): TapFit | null {
  const n = taps.length;
  if (n < 2) return null;
  let mk = 0;
  let mt = 0;
  for (const p of taps) {
    mk += p.beat / n;
    mt += p.t / n;
  }
  let skk = 0;
  let skt = 0;
  for (const p of taps) {
    skk += (p.beat - mk) ** 2;
    skt += (p.beat - mk) * (p.t - mt);
  }
  if (skk === 0 || skt <= 0) return null;
  const period = skt / skk;
  const origin = mt - period * mk;
  let ss = 0;
  for (const p of taps) ss += (p.t - origin - period * p.beat) ** 2;
  const sePeriod = n > 2 ? Math.sqrt(ss / (n - 2) / skk) : 0;
  return { period, bpm: 60 / period, origin, jitter: Math.sqrt(ss / n) / period, bpmError: (60 * sePeriod) / period ** 2 };
}

/** The taps with one at `t` added on its beat; unchanged when `t` is within half a beat of the last tap (a double tap). */
export function addTap(taps: readonly Tap[], t: number): Tap[] {
  if (taps.length === 0) return [{ t, beat: 0 }];
  const last = taps[taps.length - 1]!;
  const fit = fitTaps(taps);
  if (fit === null) return t > last.t ? [...taps, { t, beat: last.beat + 1 }] : [...taps];
  if (Math.abs(t - last.t) < fit.period / 2) return [...taps];
  return [...taps, { t, beat: Math.round((t - fit.origin) / fit.period) }];
}
