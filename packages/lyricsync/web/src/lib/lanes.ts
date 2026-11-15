// packages/lyricsync/web/src/lib/lanes.ts
// Vocal lanes: the rendered vocal tracks (generated/renders/index.json) placed on the song beat grid (user_input/placements.json).
// A lane holds clips. A clip plays the UST ticks [from, to) of its render, with UST tick 0 at tick0 = beatTime(atBeat) on the beat grid
// (linear between beats, linear past both ends). Inside a clip the render tempo is fixed: tick t is at tick0 + t * secPerTick, and
// it is sample leadSamples + t * samplesPerTick of the wav.
import type { PlacementClip, PlacementLane, Placements, RenderEntry, RenderIndex } from "../../../src/placements";
import { beatAt, beatTime } from "../../../src/beat-grid";
import { UST_TICKS_PER_BEAT } from "../../../src/formats/ust";
import { nearestBeatIndex } from "./beat-grid";

/** The lane warns when the grid tempo under it differs from the render's UST tempo by more than this fraction. */
export const TEMPO_TOLERANCE = 0.005;

export type LaneSnap = "beat" | "bar" | "free";

/** The snap mode of a clip move or a razor cut: beat by default, Shift = bar, Alt = free. */
export const laneSnapMode = (e: { shiftKey: boolean; altKey: boolean }): LaneSnap => (e.altKey ? "free" : e.shiftKey ? "bar" : "beat");

/** A snapped time and the snap target type ("BEAT", "BAR", "CLIP"; "" = not snapped). */
export interface SnapResult {
  time: number;
  label: string;
}

/** Time `t` on the beat grid: the nearest beat, the nearest bar (Shift), or `t` itself (free). */
export function snapToGrid(beats: readonly number[], downbeats: readonly number[], t: number, mode: LaneSnap): SnapResult {
  if (mode === "free") return { time: t, label: "" };
  if (mode === "bar" && downbeats.length > 0 && beats.length > 0) {
    const di = nearestBeatIndex(downbeats, t);
    const bar = downbeats[di]!;
    // A bar far outside the grid: count whole bars of 4 beats from the nearest downbeat.
    const base = nearestBeatIndex(beats, bar);
    const off = Math.round(beatAt(beats, t) - base);
    return { time: beatTime(beats, base + Math.round(off / 4) * 4), label: "BAR" };
  }
  return { time: beatTime(beats, Math.round(beatAt(beats, t))), label: "BEAT" };
}

/**
 * Time `t` snapped for a clip move or a razor cut: the grid target (`snapToGrid`), or a clip edge of `edges` within `tolerance`
 * seconds of `t` when it is nearer. Free mode does not snap at all.
 */
export function snapClipTime(
  beats: readonly number[],
  downbeats: readonly number[],
  t: number,
  mode: LaneSnap,
  edges: readonly number[],
  tolerance: number
): SnapResult {
  if (mode === "free") return { time: t, label: "" };
  let best = snapToGrid(beats, downbeats, t, mode);
  let d = Math.abs(best.time - t);
  for (const e of edges) {
    const de = Math.abs(e - t);
    if (de <= tolerance && de < d) {
      best = { time: e, label: "CLIP" };
      d = de;
    }
  }
  return best;
}

/** Seconds per UST tick of a render (fixed render tempo). */
export const secPerTick = (render: RenderEntry): number => 60 / render.tempo / UST_TICKS_PER_BEAT;

/** Song times of a placed clip and the part of the wav it plays. */
export interface ClipTime {
  /** Song time of UST tick 0. */
  tick0: number;
  /** Song time where the clip starts and ends. */
  start: number;
  end: number;
  /** Seconds from wav sample 0 to the first sample the clip plays (sample(from) / sampleRate). */
  offset: number;
  /** Clip length in seconds. */
  duration: number;
}

/** Times of clip ticks [from, to) with tick 0 at beat `atBeat`. */
export function clipTime(beats: readonly number[], atBeat: number, clip: Pick<PlacementClip, "from" | "to">, render: RenderEntry, sampleRate: number): ClipTime {
  const spt = secPerTick(render);
  const tick0 = beatTime(beats, atBeat);
  return {
    tick0,
    start: tick0 + clip.from * spt,
    end: tick0 + clip.to * spt,
    offset: render.leadSamples / sampleRate + clip.from * spt,
    duration: (clip.to - clip.from) * spt,
  };
}

/**
 * The move anchor of a clip: its first musical point, tick `max(from, 0)`. A clip that holds tick 0 anchors there (not at its silent
 * lead-in); a clip cut after tick 0 anchors at its cut.
 */
export const anchorTick = (clip: { from: number }): number => Math.max(clip.from, 0);

/** `atBeat` that puts tick `tick` of a clip at song time `t`, for a render of `spt` seconds per tick. */
export const atBeatForTick = (beats: readonly number[], t: number, tick: number, spt: number): number => beatAt(beats, t - tick * spt);

/** Mean grid tempo (BPM) over `lengthBeats` beats from beat `fromBeat`. */
export function gridBpmOver(beats: readonly number[], fromBeat: number, lengthBeats: number): number {
  const span = Math.max(1, lengthBeats);
  return (60 * span) / (beatTime(beats, fromBeat + span) - beatTime(beats, fromBeat));
}

/** The tempo warning of a placed clip, or null when the grid under the clip follows the UST tempo within 0.5 %. */
export function tempoWarning(beats: readonly number[], atBeat: number, clip: Pick<PlacementClip, "from" | "to">, render: RenderEntry): string | null {
  if (beats.length < 2 || render.tempo <= 0) return null;
  const grid = gridBpmOver(beats, atBeat + clip.from / UST_TICKS_PER_BEAT, (clip.to - clip.from) / UST_TICKS_PER_BEAT);
  const diff = Math.abs(grid - render.tempo) / render.tempo;
  if (diff <= TEMPO_TOLERANCE) return null;
  return `The grid tempo here is ${grid.toFixed(2)} BPM, the UST tempo is ${render.tempo} BPM (${(diff * 100).toFixed(1)} % off). A fixed-tempo render cannot follow the grid.`;
}

/** A free id for one more lane of `lane`'s UST: its id prefix (the text before `#<n>`) and the highest number in use + 1. */
export function nextLaneId(p: Placements, lane: PlacementLane): string {
  const base = lane.id.replace(/#\d+$/, "");
  let n = 0;
  for (const l of p.lanes) {
    const m = /#(\d+)$/.exec(l.id);
    if (m && l.id.slice(0, m.index) === base) n = Math.max(n, Number(m[1]));
  }
  return `${base}#${n + 1}`;
}

/** A lane is a duplicate (removable) when another lane plays the same UST. */
export const isDuplicate = (p: Placements, lane: PlacementLane): boolean => p.lanes.some((l) => l !== lane && l.ust === lane.ust);

/** The lyric blocks in use (first romaji line of a block, D24), sorted. */
export const blockNames = (p: Placements | null): string[] =>
  [...new Set((p?.lanes ?? []).map((l) => l.block).filter((s) => s !== ""))].sort();

export const renderOf = (index: RenderIndex, ust: string): RenderEntry | undefined => index.renders.find((r) => r.ust === ust);
