// Research harness for song-adaptive timing: load a calibrated song, solve with a subset of its syllables pinned, score the rest.
// Songs are read from <songs-dir> (default .cache/adapt/songs, scratch copies: solves write sliced/ and out/ there). Run from the repo root.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Anchors, ConsensusLine, SongEvidence } from '../../packages/lyricsync/src/types.ts';
import { emptyAnchors, setBoundary } from '../../packages/lyricsync/src/workspace/anchors.ts';
import { Session } from '../../packages/lyricsync/src/workspace/session.ts';

export const SONG_IDS = ['god_ish', 'breaked_neuro', 'breaked_jazzpop', 'pdoom'] as const;

export interface Syl {
  /** Index in the flattened syllable list. */
  k: number;
  line: number;
  /** Boundary index within the line (start of this syllable). */
  j: number;
  /** Syllables in the line. */
  m: number;
  word: number;
  /** Position of the syllable in its word. */
  si: number;
  text: string;
  ts: number;
  te: number;
  flagged: boolean;
}

export interface Song {
  id: string;
  dir: string;
  session: Session;
  syls: Syl[];
  lines: ConsensusLine[];
  /** Strictly increasing beat times (seconds). */
  beats: number[];
  evidence: SongEvidence;
}

export function argFlag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}

export async function loadSong(id: string): Promise<Song> {
  const dir = path.resolve(argFlag('--songs-dir', '.cache/adapt/songs'), id);
  const session = Session.open(path.join(dir, 'lyricsync'));
  const cal: { lines: ConsensusLine[] } = JSON.parse(fs.readFileSync(path.join(dir, 'user_input', 'lyrics.calibrated.json'), 'utf8'));
  if (cal.lines.length !== session.definition.lines.length) throw new Error(`${id}: ${cal.lines.length} calibrated lines vs ${session.definition.lines.length} lyric lines`);
  const syls: Syl[] = [];
  cal.lines.forEach((l, line) => {
    const m = l.words.reduce((n, w) => n + w.syl!.length, 0);
    let j = 0;
    l.words.forEach((w, word) =>
      w.syl!.forEach((s, si) =>
        syls.push({
          k: syls.length, line, j: j++, m, word, si, text: w.sylText?.[si] ?? '', ts: s[0], te: s[1],
          flagged: w.sylCalibrated?.[si] === true || w.calibrated === true || l.calibrated === true,
        }),
      ),
    );
  });
  const beatDoc: { beats: number[] } = JSON.parse(fs.readFileSync(path.join(dir, 'generated', 'timing.ai.json'), 'utf8'));
  const evidence = await session.loadEvidence();
  return { id, dir, session, syls, lines: cal.lines, beats: beatDoc.beats, evidence };
}

/** Pins the start of every syllable in `pins`, plus the line end when the line's last syllable is pinned. Line edges both pinned -> anchored mode. */
export function pinAnchors(song: Song, pins: Iterable<Syl>, opts: { lineEnds?: boolean } = {}): Anchors {
  const a = emptyAnchors();
  for (const s of pins) {
    setBoundary(a, song.session.definition, s.line, s.j, s.ts);
    if (opts.lineEnds !== false && s.j === s.m - 1) setBoundary(a, song.session.definition, s.line, s.m, s.te);
  }
  return a;
}

export type Times = Array<[number, number]>;

export function flatten(lines: ConsensusLine[]): Times {
  return lines.flatMap((l) => l.words.flatMap((w) => w.syl!.map((s): [number, number] => [s[0], s[1]])));
}

export async function solve(song: Song, anchors: Anchors, snap = true): Promise<Times> {
  const r = await song.session.solve({ anchors, snapToBeats: snap, device: argFlag('--device', 'gpu') === 'cpu' ? 'cpu' : 'gpu' });
  return flatten(r.lyrics.lines);
}

export interface Stat { n: number; mae: number; startMae: number; med: number; p90: number; gt50: number; gt150: number }

/** Syllable error = mean(|d start|, |d end|) in ms, as in the repository's benchmarks. `which` picks the scored syllables. */
export function score(song: Song, out: Times, which: (s: Syl) => boolean = () => true): Stat {
  const e: number[] = [];
  const st: number[] = [];
  for (const s of song.syls) {
    if (!which(s)) continue;
    const o = out[s.k]!;
    st.push(Math.abs(o[0] - s.ts) * 1000);
    e.push(((Math.abs(o[0] - s.ts) + Math.abs(o[1] - s.te)) / 2) * 1000);
  }
  const sorted = [...e].sort((a, b) => a - b);
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
  const mean = (x: number[]): number => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
  return { n: e.length, mae: mean(e), startMae: mean(st), med: q(0.5), p90: q(0.9), gt50: e.filter((x) => x > 50).length / Math.max(1, e.length), gt150: e.filter((x) => x > 150).length / Math.max(1, e.length) };
}

/** Per-syllable errors (ms) of the scored syllables, as in score(). */
export function errors(song: Song, out: Times, which: (s: Syl) => boolean = () => true): number[] {
  return song.syls.filter(which).map((s) => ((Math.abs(out[s.k]![0] - s.ts) + Math.abs(out[s.k]![1] - s.te)) / 2) * 1000);
}

/** Pooled summary of error lists: mean, mean with each error capped at 500 ms (one broken line cannot dominate), median, share over 50 / 150 ms. */
export function pooled(e: number[]): string {
  const s = [...e].sort((a, b) => a - b);
  const mean = e.reduce((a, b) => a + b, 0) / Math.max(1, e.length);
  const clip = e.reduce((a, b) => a + Math.min(b, 500), 0) / Math.max(1, e.length);
  return `n=${String(e.length).padStart(5)} mae ${mean.toFixed(1).padStart(6)} clip500 ${clip.toFixed(1).padStart(6)} med ${s[Math.floor(s.length / 2)]!.toFixed(1).padStart(5)} >50ms ${(e.filter((x) => x > 50).length / e.length * 100).toFixed(0).padStart(3)}% >150ms ${(e.filter((x) => x > 150).length / e.length * 100).toFixed(0).padStart(3)}%`;
}

export const fmt = (s: Stat): string =>
  `n=${String(s.n).padStart(4)} mae ${s.mae.toFixed(1).padStart(6)} startMae ${s.startMae.toFixed(1).padStart(6)} med ${s.med.toFixed(1).padStart(5)} p90 ${s.p90.toFixed(0).padStart(4)} >50ms ${(s.gt50 * 100).toFixed(0).padStart(3)}% >150ms ${(s.gt150 * 100).toFixed(0).padStart(3)}%`;

/** Deterministic PRNG (LCG) so a curve point is reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Beat position of time t: integer part = beat index, fraction = phase (linear between beats; extrapolated at the ends). */
export function beatPos(beats: number[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  if (t <= beats[0]!) return (t - beats[0]!) / (beats[1]! - beats[0]!);
  if (t >= beats[hi]!) return hi + (t - beats[hi]!) / (beats[hi]! - beats[hi - 1]!);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - beats[lo]!) / (beats[hi]! - beats[lo]!);
}

export function timeAt(beats: number[], pos: number): number {
  const lo = Math.max(0, Math.min(beats.length - 2, Math.floor(pos)));
  return beats[lo]! + (pos - lo) * (beats[lo + 1]! - beats[lo]!);
}
