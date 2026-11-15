// packages/lyricsync/tests/unit/fixed-grid.test.ts
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fixedBeatGrid } from '../../src/fixed-grid.ts';
import { writeFixedGrid } from '../../src/grid-song.ts';
import { readSongPrompt } from '../../src/song-folder.ts';
import { wavBytes } from '../helpers/wav.ts';

describe('fixedBeatGrid', () => {
  test('135 BPM from 0 s: beat 384 ends the 170.667 s song, every 4th beat is a downbeat', () => {
    const g = fixedBeatGrid(135, 0, 170.667);
    expect(g.model).toBe('fixed');
    expect(g.beats).toHaveLength(385);
    expect(g.downbeats).toHaveLength(97);
    expect(g.beats[0]).toBe(0);
    expect(g.beats[1]).toBe(0.444444);
    expect(g.beats.at(-1)).toBe(170.666667);
    expect(g.downbeats.slice(0, 3)).toEqual([0, 1.777778, 3.555556]);
    expect(g.downbeats.at(-1)).toBe(g.beats.at(-1)!);
    expect(g.beat_period).toBeCloseTo(60 / 135, 12);
    expect(g.duration).toBe(170.667);
    for (let k = 0; k < g.beats.length; k++) expect(Math.abs(g.beats[k]! - (k * 60) / 135)).toBeLessThanOrEqual(5e-7);
  });

  test('a beat past the end of the song is left out', () => {
    const g = fixedBeatGrid(120, 0, 2.4);
    expect(g.beats).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(g.downbeats).toEqual([0, 2]);
  });

  test('a first downbeat after 0 s keeps the pickup beats; bar 1 is a downbeat, earlier bars count back', () => {
    const g = fixedBeatGrid(120, 1.25, 5);
    expect(g.beats).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75]);
    // Bar 1 at 1.25 s; the beat 4 before it (-0.75 s) would be a downbeat but is before 0 s, so the first downbeat listed is 1.25.
    expect(g.downbeats).toEqual([1.25, 3.25]);
  });

  test('pickup bars: downbeats before bar 1 fall on every 4th beat back', () => {
    const g = fixedBeatGrid(60, 6, 12);
    expect(g.beats[0]).toBe(0);
    expect(g.downbeats).toEqual([2, 6, 10]);
  });

  test('bad input is an error', () => {
    expect(() => fixedBeatGrid(0, 0, 10)).toThrow('nearest_bpm');
    expect(() => fixedBeatGrid(120, -1, 10)).toThrow('first_downbeat_s');
    expect(() => fixedBeatGrid(120, 0, 0)).toThrow('duration');
  });
});

describe('prompt.yaml grid', () => {
  const song = (extra: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-grid-'));
    fs.mkdirSync(path.join(dir, 'user_input'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), '{}');
    fs.writeFileSync(path.join(dir, 'user_input', 'prompt.yaml'), `nearest_bpm: 135\n${extra}files:\n  song: mix.wav\n`);
    return dir;
  };
  test('absent means tracked; fixed and tracked are read; another value is an error', () => {
    expect(readSongPrompt(song('')).grid).toBe('tracked');
    expect(readSongPrompt(song('grid: fixed\n')).grid).toBe('fixed');
    expect(readSongPrompt(song('grid: tracked\n')).grid).toBe('tracked');
    expect(() => readSongPrompt(song('grid: free\n'))).toThrow('grid must be');
  });

  test('writes timing.ai.json from the mix duration, with the pins and tempo changes ignored', async () => {
    const dir = song('grid: fixed\nfirst_downbeat_s: 0\ntempo_changes:\n  - at: 3\n    bpm: 90\nbeat_pins:\n  - beat: 4\n    at: 9\n');
    fs.writeFileSync(path.join(dir, 'user_input', 'mix.wav'), wavBytes(new Float32Array(44100 * 4 + 22050), 44100));
    fs.writeFileSync(path.join(dir, 'user_input', 'prompt.yaml'), fs.readFileSync(path.join(dir, 'user_input', 'prompt.yaml'), 'utf8').replace('nearest_bpm: 135', 'nearest_bpm: 120'));
    const { doc, file } = await writeFixedGrid(dir);
    expect(doc.duration).toBe(4.5);
    expect(doc.beats).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).downbeats).toEqual([0, 2, 4]);
  });

  test('a song without grid: fixed is refused', async () => {
    await expect(writeFixedGrid(song(''))).rejects.toThrow('grid: fixed');
  });
});
