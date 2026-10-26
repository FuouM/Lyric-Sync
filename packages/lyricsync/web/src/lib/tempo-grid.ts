// packages/lyricsync/web/src/lib/tempo-grid.ts
// Tempo maps in the web UI: the new-song wizard's preview (the beat grid that a base tempo, tempo changes and a first downbeat give;
// the beat tracker gets the same values as its tempo prior, so the grid only shows whether they land on the music) and the editor's
// tempo map from the dev server.
import { isRecord } from "../../../src/guards";

export const MIN_BPM = 40;
export const MAX_BPM = 260;

/** A tempo change as typed in the wizard: seconds and BPM. */
export interface TempoRow {
  at: string;
  bpm: string;
}

/** From `at` seconds on, the song's tempo is `bpm`. */
export interface TempoChange {
  at: number;
  bpm: number;
}

/** Beat number `beat` (0 = the first beat of the song) is fixed at `at` seconds: a bar line dragged onto the music. */
export interface BeatPin {
  beat: number;
  at: number;
}

/** A song's beat map (the dev server's /api/project/<id>/tempo): the BPM at the start, the tempo changes in time order, the fixed beats. */
export interface TempoMap {
  nearestBpm: number;
  tempoChanges: TempoChange[];
  beatPins: BeatPin[];
}

/** A tempo map from a server answer, or null when it has another shape. */
export function readTempoMap(raw: unknown): TempoMap | null {
  if (!isRecord(raw) || typeof raw.nearestBpm !== "number" || !Array.isArray(raw.tempoChanges) || !Array.isArray(raw.beatPins)) return null;
  const { tempoChanges, beatPins } = raw;
  if (!tempoChanges.every((c) => isRecord(c) && typeof c.at === "number" && typeof c.bpm === "number")) return null;
  if (!beatPins.every((p) => isRecord(p) && typeof p.beat === "number" && typeof p.at === "number")) return null;
  return {
    nearestBpm: raw.nearestBpm,
    tempoChanges: tempoChanges.map((c: { at: number; bpm: number }) => ({ at: c.at, bpm: c.bpm })),
    beatPins: beatPins.map((p: { beat: number; at: number }) => ({ beat: p.beat, at: p.at })),
  };
}

/** The rows as changes sorted by time, or the first problem. */
export function parseTempoRows(rows: readonly TempoRow[]): { changes: TempoChange[]; error: string | null } {
  const changes: TempoChange[] = [];
  for (const [i, r] of rows.entries()) {
    const at = r.at.trim() === "" ? NaN : Number(r.at);
    const bpm = r.bpm.trim() === "" ? NaN : Number(r.bpm);
    if (!(at > 0)) return { changes: [], error: `Tempo change ${i + 1}: the time is seconds into the song, above 0.` };
    if (!(bpm >= MIN_BPM && bpm <= MAX_BPM)) return { changes: [], error: `Tempo change ${i + 1}: ${MIN_BPM}–${MAX_BPM} BPM.` };
    changes.push({ at, bpm });
  }
  changes.sort((a, b) => a.at - b.at);
  for (let i = 1; i < changes.length; i++) {
    if (changes[i]!.at === changes[i - 1]!.at) return { changes: [], error: `Two tempo changes are at ${changes[i]!.at} s.` };
  }
  return { changes, error: null };
}

/** The tempo at `t`: the last change at or before it, else the base tempo. `changes` is sorted by time. */
export function tempoAt(t: number, bpm: number, changes: readonly TempoChange[]): number {
  let out = bpm;
  for (const c of changes) {
    if (c.at > t) break;
    out = c.bpm;
  }
  return out;
}

/**
 * Beat times in [0, end] of the grid whose beat 0 is at `downbeat`. Each stretch has its own period: the stretch of the
 * tempo at the downbeat, then one from each later change (a change starts a beat of its own). Before the downbeat the
 * grid goes back at the downbeat's tempo. `first` is the index of the downbeat in `times`.
 */
export function tempoGrid(
  downbeat: number,
  bpm: number,
  changes: readonly TempoChange[],
  end: number
): { times: number[]; first: number } {
  const stretches = [{ from: downbeat, bpm: tempoAt(downbeat, bpm, changes) }, ...changes.filter((c) => c.at > downbeat).map((c) => ({ from: c.at, bpm: c.bpm }))];
  const forward: number[] = [];
  for (const [i, s] of stretches.entries()) {
    const next = stretches[i + 1]?.from;
    const period = 60 / s.bpm;
    for (let k = 0; ; k++) {
      const t = s.from + k * period;
      if (t > end || (next !== undefined && t >= next)) break;
      forward.push(t);
    }
  }
  const back: number[] = [];
  const period = 60 / stretches[0]!.bpm;
  for (let k = 1; downbeat - k * period >= 0; k++) back.push(downbeat - k * period);
  back.reverse();
  return { times: [...back, ...forward], first: back.length };
}
