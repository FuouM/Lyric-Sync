// packages/beatsync/tests/unit/postprocess.test.ts
import { describe, expect, test } from 'bun:test';
import { postprocessBeats, postprocessMinimal } from '../../src/postprocess.ts';

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
