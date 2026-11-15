// src/fixed-grid.ts
// The beat grid of a song with one constant tempo (prompt.yaml `grid: fixed`): no beat tracker, no audio model. Beat k is at
// firstDownbeat + k * 60 / bpm, for every k whose time is in the song (k may be negative: the pickup beats before bar 1).
// Every 4th beat from bar 1 is a downbeat (4/4). Times are rounded to 1e-6 s.
// No Node or Bun imports: the editor's browser code can use this module too.
import type { BeatsDocument } from './workspace/session.ts';

/** Half of the 1 ms rounding of `duration` in timing.ai.json: a beat this far past the duration is still inside the song. */
const END_SLACK = 0.0005;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * The fixed grid of a song `duration` seconds long. `firstDownbeat` is the time of bar 1 (seconds, 0 or more). Throws on a tempo
 * that is not positive, a negative first downbeat, or a duration that is not positive.
 */
export function fixedBeatGrid(bpm: number, firstDownbeat: number, duration: number): BeatsDocument {
  if (!(bpm > 0) || !Number.isFinite(bpm)) throw new Error(`grid: fixed needs a positive nearest_bpm (got ${bpm}).`);
  if (!(firstDownbeat >= 0) || !Number.isFinite(firstDownbeat)) throw new Error(`grid: fixed needs first_downbeat_s of 0 or more (got ${firstDownbeat}).`);
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error(`grid: fixed needs a song duration above 0 (got ${duration}).`);
  const period = 60 / bpm;
  // Beat k is inside the song when 0 <= firstDownbeat + k * period <= duration (plus the slack at the end; at the start 1e-9 absorbs float noise).
  const first = -Math.floor(firstDownbeat / period + 1e-9);
  const last = Math.floor((duration + END_SLACK - firstDownbeat) / period);
  const beats: number[] = [];
  const downbeats: number[] = [];
  for (let k = first; k <= last; k++) {
    const t = round6(firstDownbeat + k * period);
    beats.push(t);
    if (((k % 4) + 4) % 4 === 0) downbeats.push(t);
  }
  return { v: 1, model: 'fixed', duration: Number(duration.toFixed(3)), bpm, beat_period: period, beats, downbeats };
}
