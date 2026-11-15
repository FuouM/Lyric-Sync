// src/placed-notes.ts
// The UST notes the placed clips play, on the song beat grid (generated/notes.json).
// A sung note at tick t, length l, counts when a placed clip of its lane holds t (from <= t < to). When clips overlap, the clip with
// the lowest index has it. Its song beat is clip.atBeat + t / 480; start = beatTime(beat), end = beatTime(clip.atBeat + min(t + l, to) / 480).
// Rests are not listed.
// No Node or Bun imports: the editor's browser code uses this module too.
import { beatTime } from "./beat-grid.ts";
import { UST_TICKS_PER_BEAT, type Ust } from "./formats/ust.ts";
import type { Placements } from "./placements.ts";
import { singerOfVoiceDir, type Singers } from "./singers.ts";

export interface PlacedNote {
  lane: string;
  clip: string;
  ust: string;
  /** The singer id of the UST's VoiceDir; null when no singer has it (or the song has no singers.json). */
  singer: string | null;
  /** The UST note number ([#NNNN]). */
  idx: number;
  kana: string;
  pitch: number;
  /** Song beat of the note start. */
  beat: number;
  start: number;
  end: number;
}

export interface NotesFile {
  v: 1;
  notes: PlacedNote[];
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * Every sung note that a placed clip plays, sorted by start, then lane id. `usts` maps lane.ust to its parsed UST; a lane whose UST
 * is missing throws. `beats` is the song beat grid (seconds).
 */
export function placedNotes(placements: Placements, usts: ReadonlyMap<string, Ust>, singers: Singers | null, beats: readonly number[]): PlacedNote[] {
  const out: PlacedNote[] = [];
  for (const lane of placements.lanes) {
    const ust = usts.get(lane.ust);
    if (!ust) throw new Error(`Lane "${lane.id}": UST "${lane.ust}" was not read.`);
    const singer = singers ? (singerOfVoiceDir(singers, ust.voiceDir)?.id ?? null) : null;
    for (const n of ust.notes) {
      if (n.rest) continue;
      const clip = lane.clips.find((c) => c.atBeat !== null && c.from <= n.tick && n.tick < c.to);
      if (!clip) continue;
      const at = clip.atBeat!;
      const beat = at + n.tick / UST_TICKS_PER_BEAT;
      const endTick = Math.min(n.tick + n.len, clip.to);
      out.push({
        lane: lane.id,
        clip: clip.id,
        ust: lane.ust,
        singer,
        idx: n.idx,
        kana: n.lyric,
        pitch: n.note,
        beat: round6(beat),
        start: round6(beatTime(beats, beat)),
        end: round6(beatTime(beats, at + endTick / UST_TICKS_PER_BEAT)),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
}
