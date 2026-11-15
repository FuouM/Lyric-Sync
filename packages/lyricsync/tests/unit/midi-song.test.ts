// packages/lyricsync/tests/unit/midi-song.test.ts
import { describe, expect, test } from 'bun:test';
import { midiNotesFile } from '../../src/midi-song.ts';
import type { Midi } from '../../src/formats/midi.ts';

const midi: Midi = {
  format: 1,
  division: 96,
  ticks: 400,
  tempos: [{ tick: 0, usPerQuarter: 444444, bpm: 135 }],
  timeSignatures: [],
  tracks: [
    {
      index: 0,
      nameBytes: new Uint8Array([0xba, 0xcd, 0xcf, 0xd2]), // 和弦 in GBK
      programs: [{ tick: 0, channel: 2, program: 4 }, { tick: 192, channel: 2, program: 19 }],
      notes: [
        { channel: 2, pitch: 60, velocity: 90, tick: 0, endTick: 96, drum: false },
        { channel: 2, pitch: 62, velocity: 80, tick: 192, endTick: 288, drum: false },
        { channel: 9, pitch: 36, velocity: 100, tick: 96, endTick: 120, drum: true },
      ],
      texts: [],
      endTick: 400,
    },
  ],
};
// A beat grid at 0.5 s per beat, 4 s long.
const beats = Array.from({ length: 9 }, (_, i) => i * 0.5);

describe('midiNotesFile', () => {
  test('places notes on the beat grid with program, drum role and offset', () => {
    const f = midiNotesFile(midi, 'x.mid', beats, 4, { offsetBeats: 1, encoding: 'gbk' });
    expect(f.tracks[0]).toMatchObject({ name: '和弦', channels: [3, 10], notes: 3 });
    expect(f.notes.map((n) => [n.pitch, n.beat, n.start, n.end, n.program, n.role, n.channel])).toEqual([
      [60, 1, 0.5, 1, 4, null, 3],
      [36, 2, 1, 1.125, null, 'kick', 10],
      [62, 3, 1.5, 2, 19, null, 3],
    ]);
  });

  test('drops notes before beat 0 and after the song end, and honours a constant tempo', () => {
    const f = midiNotesFile(midi, 'x.mid', beats, 0.4, { offsetBeats: -1, bpm: 120 });
    expect(f.dropped).toBe(2);
    expect(f.notes.map((n) => [n.pitch, n.beat, n.start])).toEqual([[36, 0, 0]]);
    expect(f.grid).toBe(120);
  });
});
