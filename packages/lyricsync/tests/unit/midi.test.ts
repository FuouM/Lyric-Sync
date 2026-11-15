// packages/lyricsync/tests/unit/midi.test.ts
import { describe, expect, test } from 'bun:test';
import { decodeMidiText, midiDrumRole, midiTickToSeconds, midiTrackName, parseMidi } from '../../src/formats/midi.ts';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number): number[] => [(n >> 8) & 255, n & 255];
function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (n >>= 7; n > 0; n >>= 7) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const track = (events: number[][]): number[] => {
  const body = [...events.flat(), 0, 0xff, 0x2f, 0];
  return [...ascii('MTrk'), ...be32(body.length), ...body];
};
const file = (format: number, division: number, tracks: number[][]): Uint8Array =>
  new Uint8Array([...ascii('MThd'), ...be32(6), ...be16(format), ...be16(tracks.length), ...be16(division), ...tracks.flat()]);
const meta = (delta: number, type: number, data: number[]): number[] => [...vlq(delta), 0xff, type, ...vlq(data.length), ...data];

describe('parseMidi', () => {
  test('reads notes with running status and note on velocity 0 as off', () => {
    const t = track([
      [0, 0x90, 60, 100], // note on
      [48, 62, 90], // running status: note on 62
      [48, 60, 0], // running status: velocity 0 = off of 60
      [48, 62, 0],
    ]);
    const m = parseMidi(file(0, 96, [t]));
    expect(m.format).toBe(0);
    expect(m.tracks[0]!.notes).toEqual([
      { channel: 0, pitch: 60, velocity: 100, tick: 0, endTick: 96, drum: false },
      { channel: 0, pitch: 62, velocity: 90, tick: 48, endTick: 144, drum: false },
    ]);
  });

  test('pairs overlapping notes of the same pitch first in, first out', () => {
    const t = track([
      [0, 0x90, 60, 100],
      [10, 0x90, 60, 80],
      [10, 0x80, 60, 0],
      [10, 0x80, 60, 0],
    ]);
    const notes = parseMidi(file(0, 96, [t])).tracks[0]!.notes;
    expect(notes.map((n) => [n.tick, n.endTick, n.velocity])).toEqual([
      [0, 20, 100],
      [10, 30, 80],
    ]);
  });

  test('closes an unfinished note at the end of the track and flags channel 10 as drums', () => {
    const t = track([[0, 0x99, 36, 127], [96, 0x91, 40, 50]]);
    const tr = parseMidi(file(0, 96, [t])).tracks[0]!;
    expect(tr.notes[0]).toMatchObject({ channel: 9, drum: true, tick: 0, endTick: 96 });
    expect(tr.notes[1]).toMatchObject({ channel: 1, drum: false, endTick: 96 });
    expect(tr.endTick).toBe(96);
  });

  test('merges the tempo map over tracks and converts ticks to seconds', () => {
    const conductor = track([
      meta(0, 0x51, [0x07, 0xa1, 0x20]), // 500000 us = 120 BPM
      meta(0, 0x58, [3, 2, 24, 8]), // 3/4
      meta(96, 0x51, [0x03, 0xd0, 0x90]), // 250000 us = 240 BPM at tick 96
    ]);
    const other = track([meta(0, 0x03, ascii('Bass')), [0, 0xc2, 33], [0, 0x92, 40, 90]]);
    const m = parseMidi(file(1, 96, [conductor, other]));
    expect(m.tempos.map((t) => [t.tick, t.bpm])).toEqual([[0, 120], [96, 240]]);
    expect(m.timeSignatures).toEqual([{ tick: 0, numerator: 3, denominator: 4 }]);
    expect(midiTickToSeconds(m, 96)).toBeCloseTo(0.5, 9);
    expect(midiTickToSeconds(m, 192)).toBeCloseTo(0.75, 9);
    expect(midiTickToSeconds(m, 48)).toBeCloseTo(0.25, 9);
    expect(midiTrackName(m.tracks[1]!)).toBe('Bass');
    expect(m.tracks[1]!.programs).toEqual([{ tick: 0, channel: 2, program: 33 }]);
  });

  test('defaults to 120 BPM without a tempo event', () => {
    const m = parseMidi(file(0, 480, [track([[0, 0x90, 60, 1]])]));
    expect(m.tempos).toEqual([{ tick: 0, usPerQuarter: 500000, bpm: 120 }]);
    expect(midiTickToSeconds(m, 960)).toBeCloseTo(1, 9);
  });

  test('keeps text as bytes and decodes UTF-8 and Shift_JIS', () => {
    const sjis = [0x83, 0x65, 0x83, 0x67]; // テト
    const utf8 = [...new TextEncoder().encode('テト')];
    const m = parseMidi(file(1, 96, [track([meta(0, 0x03, sjis), meta(5, 0x05, utf8), meta(5, 0x01, ascii('x'))])]));
    const tr = m.tracks[0]!;
    expect(tr.nameBytes).toEqual(new Uint8Array(sjis));
    expect(midiTrackName(tr)).toBe('テト');
    expect(tr.texts.map((t) => [t.kind, t.tick])).toEqual([['name', 0], ['lyric', 5], ['text', 10]]);
    expect(decodeMidiText(tr.texts[1]!.bytes)).toBe('テト');
    expect(decodeMidiText(new Uint8Array(sjis), 'shift_jis')).toBe('テト');
  });

  test('rejects broken input with a clear message', () => {
    expect(() => parseMidi(new Uint8Array(20))).toThrow('MThd');
    expect(() => parseMidi(file(2, 96, [track([])]))).toThrow('format 2');
    expect(() => parseMidi(file(0, 0xe728, [track([])]))).toThrow('SMPTE');
    const cut = file(0, 96, [track([[0, 0x90, 60, 100]])]);
    expect(() => parseMidi(cut.subarray(0, cut.length - 6))).toThrow('MIDI');
  });

  test('names drum roles by key', () => {
    expect([35, 36, 38, 40, 42, 44, 46, 49, 51, 41, 60].map(midiDrumRole)).toEqual(['kick', 'kick', 'snare', 'snare', 'hat', 'hat', 'hat', 'crash', 'ride', 'tom', 'other']);
  });
});
