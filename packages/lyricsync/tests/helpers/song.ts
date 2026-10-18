// packages/lyricsync/tests/helpers/song.ts
// Synthetic two-line song: line 0 "hello world" (2+2 syllables), line 1 "good night moon" (1+1+1). Evidence is minimal but real-shaped.
import type { ConsensusLine, SlicedAlignment, SongEvidence } from '../../src/types.ts';

export function line(i: number, text: string, words: Array<{ w: string; syl: number[] }>): ConsensusLine {
  return {
    i,
    text,
    start: words[0]!.syl[0]!,
    end: words[words.length - 1]!.syl[words[words.length - 1]!.syl.length - 1]!,
    words: words.map((w) => {
      const syl: Array<[number, number]> = [];
      for (let k = 0; k + 1 < w.syl.length; k++) syl.push([w.syl[k]!, w.syl[k + 1]!]);
      return { w: w.w, start: w.syl[0]!, end: w.syl[w.syl.length - 1]!, conf: 0.9, syl, sylText: w.w.length > 0 ? syl.map((_, k) => `${w.w}${k}`) : [] };
    }),
  };
}

// line 0: boundaries 1.0 1.5 2.0 2.5 3.0 ; line 1: boundaries 4.0 4.5 5.0 5.5
export const full = (): ConsensusLine[] => [
  line(0, 'hello world', [{ w: 'hello', syl: [1.0, 1.5, 2.0] }, { w: 'world', syl: [2.0, 2.5, 3.0] }]),
  line(1, 'good night moon', [{ w: 'good', syl: [4.0, 4.5] }, { w: 'night', syl: [4.5, 5.0] }, { w: 'moon', syl: [5.0, 5.5] }]),
];

// a slightly different alignment for anchored lines, as the sliced model would produce
export const slicedLine0 = (): ConsensusLine => line(0, 'hello world', [{ w: 'hello', syl: [1.0, 1.55, 2.05] }, { w: 'world', syl: [2.05, 2.55, 3.0] }]);

export const slicedLines0 = (): Record<number, SlicedAlignment> => ({ 0: { base: slicedLine0(), combined: slicedLine0() } });

export const notes = (starts: number[]): SongEvidence['rmvpeNotes'] => starts.slice(0, -1).map((s, i) => ({ start: s, end: starts[i + 1]!, pitchHz: 220, confidence: 0.9 }));

export function evidence(overrides: Partial<SongEvidence> = {}): SongEvidence {
  return {
    language: 'en',
    durationSec: 12,
    audio: new Float32Array(44100 * 12),
    sampleRate: 44100,
    swiftNotes: notes([1.0, 1.5, 2.0, 2.5, 3.0]),
    harmoNotes: notes([4.0, 4.5, 5.0, 5.5]),
    rmvpeNotes: [...notes([1.0, 1.5, 2.0, 2.5, 3.0]), ...notes([4.0, 4.5, 5.0, 5.5])],
    f0Hz: new Array<number>(1200).fill(220),
    edgeSets: [[{ t: 2.02, prob: 0.8 }], []],
    breaths: [],
    beats: Array.from({ length: 24 }, (_, i) => i * 0.5),
    posteriors: { frames: 0, vocabSize: 1, data: new Uint8Array(0), silenceId: 0 },
    nucleusFor: () => ({ nucleus: -1, first: -1, last: -1 }),
    fullBase: full(),
    fullCombined: full(),
    // A model with no opinion: every frame scores 0 for every query.
    boundary: { fps: 100, dim: 1, frames: new Float32Array(1200 * 2), queries: { 0: [[0], [0], [0], [0], [0]], 1: [[0], [0], [0], [0]] } },
    ...overrides,
  };
}

/** Boundary times of a result line: every syllable start, then the line end. */
export function times(lines: ConsensusLine[], li: number): number[] {
  return lines[li]!.words.flatMap((w) => (w.syl ?? []).map((s) => s[0])).concat(lines[li]!.end);
}
