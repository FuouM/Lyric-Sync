// packages/beatsync/tests/unit/postprocess.test.ts
import { describe, expect, test } from 'bun:test';
import { checkBeatPins, checkTempoChanges, postprocessBeats, postprocessMinimal } from '../../src/postprocess.ts';
import { beatsFromLogits } from '../../src/tracker.ts';

describe('postprocessBeats', () => {
  test('returns empty beats for empty input', () => {
    const res = postprocessBeats(new Float32Array(0), new Float32Array(0));
    expect(res.beats).toEqual([]);
    expect(res.downbeats).toEqual([]);
  });

  test('extracts beats accurately on hand-made logits with targetBpm', () => {
    const fps = 50;
    const bpm = 120; // 0.5s per beat => 25 frames per beat
    const totalFrames = 200; // 4 seconds
    const beatLogits = new Float32Array(totalFrames).fill(-10.0);
    const downbeatLogits = new Float32Array(totalFrames).fill(-10.0);

    // Place sharp peaks at frames 25, 50, 75, 100, 125, 150, 175
    const beatFrames = [25, 50, 75, 100, 125, 150, 175];
    for (const f of beatFrames) {
      beatLogits[f] = 10.0;
    }
    // Downbeat at frame 25 and 125 (every 4 beats)
    downbeatLogits[25] = 10.0;
    downbeatLogits[125] = 10.0;

    const res = postprocessBeats(beatLogits, downbeatLogits, {
      fps,
      targetBpm: bpm,
      useDP: true,
      firstDownbeatHint: 0.5, // 25 / 50 = 0.5s
    });

    expect(res.beats.length).toBeGreaterThanOrEqual(6);
    // 25 / 50 = 0.5, 50 / 50 = 1.0, 75 / 50 = 1.5, etc.
    expect(res.beats).toContain(0.5);
    expect(res.beats).toContain(1.0);
    expect(res.beats).toContain(1.5);
    expect(res.beats).toContain(2.0);
    expect(res.downbeats).toContain(0.5);
  });

  test('follows a stepped tempo change given as tempoChanges', () => {
    const fps = 50;
    // 120 BPM (25 frames) until 6 s, then 150 BPM (20 frames) until 12 s.
    const frames: number[] = [];
    for (let f = 25; f <= 300; f += 25) frames.push(f);
    for (let f = 320; f <= 600; f += 20) frames.push(f);
    const beatLogits = new Float32Array(650).fill(-10.0);
    const downbeatLogits = new Float32Array(650).fill(-10.0);
    for (const f of frames) beatLogits[f] = 10.0;

    const res = postprocessBeats(beatLogits, downbeatLogits, { fps, targetBpm: 120, tempoChanges: [{ at: 6, bpm: 150 }], useDP: true });

    // The DP also lays beats over the silent stretches at both ends; every peak must be a beat, and the stretch between the first and last peak keeps each tempo.
    for (const f of frames) expect(res.beats).toContain(f / fps);
    expect(res.beats.filter((b) => b >= 0.5 && b <= 12)).toEqual(frames.map((f) => f / fps));
  });

  test('beatsFromLogits tries another tempo prior on the same logits: median tempo, period and duration come with the beats', () => {
    const beat = new Float32Array(400).fill(-10.0);
    for (let f = 25; f < 400; f += 25) beat[f] = 10.0;
    const logits = { fps: 50, beat, downbeat: new Float32Array(400).fill(-10.0), durationSec: 8, inferenceTimeMs: 0 };

    const res = beatsFromLogits(logits, { targetBpm: 120 });
    expect(res.bpm).toBe(120);
    expect(res.beatPeriod).toBeCloseTo(0.5, 3);
    expect(res.durationSec).toBe(8);
    expect(res.beats).toContain(2.5);
  });

  describe('beat pins', () => {
    // On-beat peaks every 25 frames (0.5 s) and weaker off-beat peaks 12 frames later: a click track with a syncopated shadow.
    const frames = 400;
    const beat = new Float32Array(frames).fill(-10.0);
    for (let f = 25; f < frames; f += 25) beat[f] = 10.0;
    for (let f = 12; f < frames; f += 25) beat[f] = 2.0;
    const down = new Float32Array(frames).fill(-10.0);
    const track = (beatPins?: Array<{ beat: number; at: number }>) => postprocessBeats(beat, down, { fps: 50, targetBpm: 120, useDP: true, ...(beatPins ? { beatPins } : {}) }).beats;

    test('a pin on the beat the tracker found changes nothing', () => {
      const free = track();
      expect(track([{ beat: 2, at: free[2]! }, { beat: 6, at: free[6]! }])).toEqual(free);
    });

    test('a pinned beat is exactly where the pin says, even between frames; the counts before and between pins stay', () => {
      const free = track();
      const moved = track([{ beat: 4, at: 2.243 }, { beat: 8, at: 4.5 }]);
      expect(moved[4]).toBe(2.243);
      expect(moved[8]).toBe(4.5);
      // Beats 0..4 end on the pin; the stretch after it follows the off-beat train the pin sits on
      expect(moved.slice(0, 5)).toHaveLength(5);
      expect(moved.slice(5, 8).every((t, k) => t > moved[4 + k]! && t < moved[8]!)).toBe(true);
      for (let i = 1; i < moved.length; i++) expect(moved[i]!).toBeGreaterThan(moved[i - 1]!);
      expect(free[8]).not.toBe(4.5);
    });

    test('pins that leave no room for the beats between them are an error', () => {
      expect(() => track([{ beat: 10, at: 0.2 }])).toThrow(/no room/);
      expect(() => track([{ beat: 2, at: 1.0 }, { beat: 40, at: 1.5 }])).toThrow(/no room/);
    });

    test('checkBeatPins wants whole, increasing beat numbers and increasing times', () => {
      expect(() => checkBeatPins([{ beat: 0, at: 0 }, { beat: 4, at: 2 }])).not.toThrow();
      expect(() => checkBeatPins([{ beat: 1.5, at: 1 }])).toThrow('whole beat');
      expect(() => checkBeatPins([{ beat: 4, at: 2 }, { beat: 4, at: 3 }])).toThrow('increasing');
      expect(() => checkBeatPins([{ beat: 4, at: 2 }, { beat: 5, at: 2 }])).toThrow('increasing');
      expect(() => checkBeatPins([{ beat: 4, at: -1 }])).toThrow('increasing');
    });
  });

  test('checkTempoChanges rejects unusable tempos and unordered changes', () => {
    expect(() => checkTempoChanges(120, [{ at: 30, bpm: 90 }, { at: 60, bpm: 100 }])).not.toThrow();
    expect(() => checkTempoChanges(0)).toThrow('targetBpm');
    expect(() => checkTempoChanges(120, [{ at: 0, bpm: 90 }])).toThrow('increasing');
    expect(() => checkTempoChanges(120, [{ at: 60, bpm: 90 }, { at: 30, bpm: 100 }])).toThrow('increasing');
    expect(() => checkTempoChanges(120, [{ at: 60, bpm: 90 }, { at: 60, bpm: 100 }])).toThrow('increasing');
    expect(() => checkTempoChanges(120, [{ at: 30, bpm: -5 }])).toThrow('positive');
  });

  test('postprocessMinimal extracts local peaks properly', () => {
    const len = 50;
    const b = new Float32Array(len).fill(-5);
    const db = new Float32Array(len).fill(-5);
    b[10] = 5;
    b[25] = 5;
    b[40] = 5;
    db[10] = 5;

    const res = postprocessMinimal(b, db, 50);
    expect(res.beats).toEqual([0.2, 0.5, 0.8]);
    expect(res.downbeats).toEqual([0.2]);
  });
});
