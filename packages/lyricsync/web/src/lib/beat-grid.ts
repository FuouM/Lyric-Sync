// packages/lyricsync/web/src/lib/beat-grid.ts
// Bar 1 of the beat grid, as the video editor's stem timeline handles it (StemSyncViewer.setNearestBeatAsBar1 and
// AudioData.alignDownbeatsToOffset): the beat times never change; bar 1 is a beat, and every 4th beat from it (forwards and
// backwards) is a downbeat. The project keeps the bar-1 time in user_input/prompt.yaml as `first_downbeat_s`.
import { floorIndex } from "./doc-edit";

export const PROMPT_PATH = "user_input/prompt.yaml";

/** Same pattern the video editor's daemon uses to read and rewrite the key. */
const DOWNBEAT_LINE = /^([ \t]*first_downbeat(?:_s)?\s*:\s*)(.*)$/m;

export function readFirstDownbeat(prompt: string): number | null {
  const m = DOWNBEAT_LINE.exec(prompt);
  if (!m) return null;
  const v = Number(m[2]!.trim());
  return Number.isFinite(v) ? v : null;
}

/** prompt.yaml with `first_downbeat_s` set (the line replaced, or added after nearest_bpm / at the top). */
export function writeFirstDownbeat(prompt: string, seconds: number): string {
  const value = Number(seconds.toFixed(3));
  if (DOWNBEAT_LINE.test(prompt)) return prompt.replace(DOWNBEAT_LINE, `$1${value}`);
  const after = /^(nearest_bpm\s*:.*)$/m;
  return after.test(prompt) ? prompt.replace(after, `$1\nfirst_downbeat_s: ${value}`) : `first_downbeat_s: ${value}\n${prompt}`;
}

export function nearestBeatIndex(beats: readonly number[], t: number): number {
  const i = floorIndex(beats, t);
  if (i < 0) return 0;
  if (i + 1 < beats.length && beats[i + 1]! - t < t - beats[i]!) return i + 1;
  return i;
}

/** Downbeats with beat `bar1` as bar 1, and where bar 1 sits in them (earlier downbeats are pickup bars). */
export function gridFromBar1(beats: readonly number[], bar1: number): { downbeats: number[]; bar1Index: number } {
  const downbeats: number[] = [];
  for (let i = bar1 % 4; i < beats.length; i += 4) downbeats.push(beats[i]!);
  return { downbeats, bar1Index: Math.floor(bar1 / 4) };
}
