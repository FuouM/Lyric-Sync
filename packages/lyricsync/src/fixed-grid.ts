// src/fixed-grid.ts
// The beat grid of a song with one constant tempo (prompt.yaml `grid: fixed`): no beat tracker, no audio model. The grid itself is
// beatsync's exactBeatGrid (beat k at firstDownbeat + k * 60 / bpm, pickup beats included, every 4th beat from bar 1 a downbeat).
import { exactBeatGrid } from 'beatsync';
import type { BeatsDocument } from './workspace/session.ts';

/**
 * The fixed grid of a song `duration` seconds long. `firstDownbeat` is the time of bar 1 (seconds, 0 or more). Throws on a tempo
 * that is not positive, a negative first downbeat, or a duration that is not positive.
 */
export function fixedBeatGrid(bpm: number, firstDownbeat: number, duration: number): BeatsDocument {
  if (!(bpm > 0) || !Number.isFinite(bpm)) throw new Error(`grid: fixed needs a positive nearest_bpm (got ${bpm}).`);
  if (!(firstDownbeat >= 0) || !Number.isFinite(firstDownbeat)) throw new Error(`grid: fixed needs first_downbeat_s of 0 or more (got ${firstDownbeat}).`);
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error(`grid: fixed needs a song duration above 0 (got ${duration}).`);
  const { beats, downbeats, beatPeriod } = exactBeatGrid(bpm, firstDownbeat, duration);
  return { v: 1, model: 'fixed', duration: Number(duration.toFixed(3)), bpm, beat_period: beatPeriod, beats, downbeats };
}
