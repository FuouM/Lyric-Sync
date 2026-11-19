// packages/beatsync/src/exact-grid.ts
// The beat grid of one exact tempo, without the beat tracker: beat k is at firstDownbeat + k * 60 / bpm, for every k whose time
// is in the song (k may be negative: the pickup beats before bar 1). Every 4th beat from bar 1 is a downbeat (4/4).
// Times are rounded to 1e-6 s. No imports: browser code can use this module too.

/** Half of the 1 ms rounding of a duration written with 3 decimals: a beat this far past the duration is still inside the song. */
const END_SLACK = 0.0005;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export interface ExactBeatGrid {
  beats: number[];
  downbeats: number[];
  /** 60 / bpm, not rounded. */
  beatPeriod: number;
}

/**
 * The exact grid of a song `durationSec` seconds long at `bpm`, with bar 1 at `firstDownbeat` seconds (0 or more). Throws on a
 * tempo that is not positive, a negative first downbeat, or a duration that is not positive.
 */
export function exactBeatGrid(bpm: number, firstDownbeat: number, durationSec: number): ExactBeatGrid {
  if (!(bpm > 0) || !Number.isFinite(bpm)) throw new Error(`The exact tempo must be a positive BPM, got ${String(bpm)}.`);
  if (!(firstDownbeat >= 0) || !Number.isFinite(firstDownbeat)) throw new Error(`The first downbeat must be 0 s or more, got ${String(firstDownbeat)}.`);
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) throw new Error(`The song duration must be above 0 s, got ${String(durationSec)}.`);
  const period = 60 / bpm;
  // Beat k is inside the song when 0 <= firstDownbeat + k * period <= duration (plus the slack at the end; at the start 1e-9 absorbs float noise).
  const first = -Math.floor(firstDownbeat / period + 1e-9);
  const last = Math.floor((durationSec + END_SLACK - firstDownbeat) / period);
  const beats: number[] = [];
  const downbeats: number[] = [];
  for (let k = first; k <= last; k++) {
    const t = round6(firstDownbeat + k * period);
    beats.push(t);
    if (((k % 4) + 4) % 4 === 0) downbeats.push(t);
  }
  return { beats, downbeats, beatPeriod: period };
}
