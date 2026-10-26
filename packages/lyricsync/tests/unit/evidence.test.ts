// packages/lyricsync/tests/unit/evidence.test.ts
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resample, resampleBandLimited } from '../../src/audio/audio.ts';
import { detectEventPeaks, fillGaps, removeShort } from '../../src/evidence/events.ts';
import { despikeF0, smoothAndSegmentNotes } from '../../src/evidence/pitch.ts';
import { loadEvidence, saveEvidence } from '../../src/evidence/store.ts';
import { createNucleusResolver } from '../../src/evidence/nucleus.ts';
import { boundaryContexts } from '../../src/evidence/boundary.ts';
import type { ConsensusLine, SongEvidence } from '../../src/types.ts';
import { wavBytes } from '../helpers/wav.ts';

const times = (n: number): number[] => Array.from({ length: n }, (_, i) => i * 0.01);

function segment(hz: number[]) {
  const { cleanedHz, midiArr, vMask } = despikeF0(hz, times(hz.length));
  return smoothAndSegmentNotes(cleanedHz, midiArr, vMask, times(hz.length));
}

describe('pitch despiking and note segmentation', () => {
  test('a one-frame octave glitch and a short dropout inside a held note leave one clean note', () => {
    const hz = new Array<number>(40).fill(220);
    hz[20] = 440; // octave spike
    hz[30] = 0; // 3-frame dropout
    hz[31] = 0;
    hz[32] = 0;
    const notes = segment(hz);
    expect(notes.length).toBe(1);
    expect(notes[0]!.start).toBe(0);
    expect(notes[0]!.end).toBeCloseTo(0.4, 6);
    expect(notes[0]!.pitch).toBe(57);
    expect(notes[0]!.pitchHz).toBeCloseTo(220, 0);
  });

  test('a real pitch change splits the note at the change', () => {
    const hz = [...new Array<number>(30).fill(220), ...new Array<number>(30).fill(261.63)];
    const notes = segment(hz);
    expect(notes.length).toBe(2);
    expect(notes[0]!.end).toBeCloseTo(0.3, 6);
    expect(notes[1]!.start).toBeCloseTo(0.3, 6);
    expect(notes[1]!.pitch).toBe(60);
  });

  test('a blip shorter than the minimum note length is dropped, and a long dropout is not bridged', () => {
    const hz = [...new Array<number>(4).fill(220), ...new Array<number>(10).fill(0), ...new Array<number>(30).fill(220)];
    const notes = segment(hz);
    expect(notes.length).toBe(1);
    expect(notes[0]!.start).toBeCloseTo(0.14, 6);
  });
});

describe('acoustic event helpers', () => {
  test('fillGaps closes a short silence between two segments and leaves a long one', () => {
    expect([...fillGaps(Uint8Array.from([0, 1, 1, 1, 0, 0, 1, 1, 1, 0]), 5)]).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    expect([...fillGaps(Uint8Array.from([0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0]), 5)]).toEqual([0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0]);
  });

  test('removeShort deletes segments shorter than the minimum and keeps long ones', () => {
    const labels = Uint8Array.from([0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    const out = [...removeShort(labels, 7)];
    expect(out.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(out.slice(9, 19)).toEqual(new Array<number>(10).fill(1));
  });

  test('detectEventPeaks keeps only the highest of peaks closer than the minimum distance', () => {
    const prob = Float32Array.from([0, 0.1, 0.5, 0.2, 0.1, 0.6, 0.1, 0, 0, 0, 0, 0, 0.7, 0.1, 0]);
    const peaks = detectEventPeaks(prob, 0.35, 4);
    expect(peaks.map((p) => p.index)).toEqual([5, 12]);
    expect(peaks[0]!.prob).toBeCloseTo(0.6, 6);
  });
});

describe('nucleus resolver', () => {
  test('maps an English syllable to its vowel phone in the base model vocabulary and Japanese syllables to their moras', () => {
    const en = createNucleusResolver('en');
    const moment = en.resolver('moment', 0, 'mo', 2);
    expect(moment.nucleus).toBeGreaterThan(0); // 'ow'
    expect(moment.first).toBeGreaterThan(0); // word-initial 'm'
    expect(moment.last).toBe(-1); // inner split: the last phone of this syllable is not known
    const ja = createNucleusResolver('ja');
    const ka = ja.resolver('kaze', 0, 'ka', 2);
    expect(ka.nucleus).toBeGreaterThan(0);
    expect(ka.first).toBeGreaterThan(0);
    expect(en.silenceId).toBe(0);
  });
});

describe('evidence store', () => {
  const line = (i: number): ConsensusLine => ({ i, text: 'hi', start: i, end: i + 1, words: [{ w: 'hi', start: i, end: i + 1, syl: [[i, i + 1]], sylText: ['hi'] }] });
  const evidence = (): SongEvidence => ({
    language: 'en',
    durationSec: 0.5,
    audio: new Float32Array(22050),
    sampleRate: 44100,
    swiftNotes: [{ start: 0.1, end: 0.2, pitchHz: 220, pitch: 57, confidence: 0.9 }],
    harmoNotes: [{ start: 0.15, end: 0.3, pitchHz: 222, pitch: 57 }],
    rmvpeNotes: [{ start: 0.1, end: 0.35, pitchHz: 221, pitch: 57, confidence: 1 }],
    f0Hz: [0, 220.5, 221.25, 0],
    edgeSets: [[{ t: 0.12, prob: 0.8 }], [{ t: 0.3, prob: 0.5 }, { t: 0.4, prob: 0.9 }]],
    breaths: [{ start: 0.4, end: 0.5, prob: 1 }],
    beats: [0, 0.25, 0.5],
    posteriors: { frames: 3, vocabSize: 4, data: Uint8Array.from([0, 255, 0, 0, 10, 20, 30, 40, 5, 5, 5, 240]), silenceId: 0 },
    nucleusFor: () => ({ nucleus: -1, first: -1, last: -1 }),
    fullBase: [line(0), line(1)],
    fullCombined: [line(0), line(1)],
    boundary: { fps: 100, dim: 2, frames: Float32Array.from([0.5, -1, 2, 0.25, 3.5, -0.125]), queries: { 0: [[1, 0], [0, 1]], 1: [[0.5, 0.5], [-1, 2]] } },
  });

  test('saved evidence loads back identical (audio re-decoded from the stem, resolver rebuilt)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricsync-store-'));
    const vocal = path.join(dir, 'vocal.wav');
    fs.writeFileSync(vocal, wavBytes(new Float32Array(22050), 44100));
    const original = evidence();
    saveEvidence(path.join(dir, 'ev'), original);
    const loaded = await loadEvidence(path.join(dir, 'ev'), vocal);
    expect(loaded.language).toBe('en');
    expect(loaded.swiftNotes).toEqual(original.swiftNotes);
    expect(loaded.harmoNotes).toEqual(original.harmoNotes);
    expect(loaded.rmvpeNotes).toEqual(original.rmvpeNotes);
    expect(loaded.f0Hz).toEqual(original.f0Hz);
    expect(loaded.edgeSets).toEqual(original.edgeSets);
    expect(loaded.breaths).toEqual(original.breaths);
    expect(loaded.beats).toEqual(original.beats);
    expect(loaded.fullBase).toEqual(original.fullBase);
    expect(loaded.fullCombined).toEqual(original.fullCombined);
    expect([...loaded.posteriors.data]).toEqual([...original.posteriors.data]);
    expect([...loaded.boundary.frames]).toEqual([...original.boundary.frames]);
    expect(loaded.boundary.queries).toEqual(original.boundary.queries);
    expect(loaded.boundary.dim).toBe(2);
    expect(loaded.posteriors.frames).toBe(3);
    expect(loaded.posteriors.vocabSize).toBe(4);
    expect(loaded.audio.length).toBe(22050);
    expect(typeof loaded.nucleusFor).toBe('function');
  });

  test('loading from a directory that was never saved is an error', async () => {
    await expect(loadEvidence(path.join(os.tmpdir(), 'lyricsync-missing-evidence'), 'x.wav')).rejects.toThrow(/meta\.json not found/);
  });
});

describe('band-limited resampling', () => {
  const tone = (hz: number): Float32Array => Float32Array.from({ length: 44100 }, (_, i) => Math.sin((2 * Math.PI * hz * i) / 44100));
  // RMS over the middle, away from the edges where the filter runs out of samples.
  const rms = (x: Float32Array): number => {
    const mid = x.subarray(Math.floor(x.length * 0.1), Math.floor(x.length * 0.9));
    return Math.sqrt(mid.reduce((s, v) => s + v * v, 0) / mid.length);
  };

  test('44.1 -> 16 kHz keeps a 1 kHz tone and removes a 10 kHz one, which linear interpolation folds back to 6 kHz', () => {
    const low = resampleBandLimited(tone(1000), 44100, 16000);
    expect(low.length).toBe(16000);
    expect(rms(low)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(rms(resampleBandLimited(tone(10000), 44100, 16000))).toBeLessThan(0.01);
    expect(rms(resample(tone(10000), 44100, 16000))).toBeGreaterThan(0.3);
  });
});

describe('boundaryContexts (Japanese)', () => {
  test('a closure mora ("p" of "ppoi") has the word\'s closure phone, not a lookup of its own text', () => {
    const lines = boundaryContexts({
      language: 'ja',
      lines: [{ index: 0, text: 'wakare ppoi', words: [{ w: 'wakare', syllables: ['wa', 'ka', 're'] }, { w: 'ppoi', syllables: ['p', 'po', 'i'] }] }],
    });
    expect(lines[0]!.syllables.map((s) => s.phones)).toEqual([['w', 'a'], ['k', 'a'], ['r', 'e'], ['cl'], ['p', 'o'], ['i']]);
    expect(lines[0]!.syllables.map((s) => s.wordStart)).toEqual([true, false, false, true, false, false]);
  });
});
