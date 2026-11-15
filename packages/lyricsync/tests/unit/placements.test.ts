// packages/lyricsync/tests/unit/placements.test.ts
import { describe, expect, test } from 'bun:test';
import { clipTickRange, defaultPlacements, parsePlacements, parseRenderIndex, splitClip, type PlacementLane, type RenderIndex } from '../../src/placements.ts';

const render = (ust: string) => ({ ust, wav: ust.replace(/\.ust$/, '.wav'), singer: 'teto', fallback: false, tempo: 120, ticks: 1920, leadSamples: 2205, seconds: 4.05, ustSha256: 'ab' });

const INDEX: RenderIndex = parseRenderIndex({ v: 1, tool: 'utau', toolVersion: '1', sampleRate: 44100, renders: [render('ust/verse1.ust'), render('ust/chorus.ust')] });

// tempo 120, 44100 Hz: 45.9375 samples per tick. Lead 2205 samples = -48 ticks; 4.05 s = 178605 samples = 3840 ticks after the lead.
const R = clipTickRange(INDEX.renders[0]!, 44100);
const clip = (id: string, over: Record<string, unknown> = {}) => ({ id, atBeat: 8, from: 0, to: 1920, ...over });
const lane = (id: string, ust: string, clips: unknown[] = [clip(`${id}/1`)]) => ({ id, ust, block: '', clips });
const file = (...lanes: unknown[]) => ({ v: 2, lanes });

describe('parseRenderIndex', () => {
  test('names the file, entry and field of a bad render', () => {
    const bad = { ...render('a.ust'), leadSamples: '2205' };
    expect(() => parseRenderIndex({ v: 1, tool: 'utau', toolVersion: '1', sampleRate: 44100, renders: [render('b.ust'), bad] })).toThrow(
      'generated/renders/index.json: renders[1].leadSamples must be a number.',
    );
  });
});

describe('clipTickRange', () => {
  test('starts at the lead-in (negative) and ends at the wav end', () => {
    expect(R.min).toBeCloseTo(-48, 9);
    expect(R.max).toBeCloseTo(3840, 9);
  });
});

describe('parsePlacements', () => {
  test('rejects v1 files', () => {
    expect(() => parsePlacements({ v: 1, lanes: [] })).toThrow('user_input/placements.json: "v" must be 2.');
  });

  test('rejects duplicate lane ids', () => {
    expect(() => parsePlacements(file(lane('x#1', 'ust/verse1.ust'), lane('x#1', 'ust/chorus.ust')))).toThrow('user_input/placements.json: lanes[1].id "x#1" is used twice.');
  });

  test('rejects a lane whose ust is not in the render index', () => {
    expect(() => parsePlacements(file(lane('gone#1', 'ust/gone.ust')), INDEX)).toThrow('lanes[0].ust "ust/gone.ust" is not in generated/renders/index.json');
  });

  test('rejects from >= to', () => {
    expect(() => parsePlacements(file(lane('a', 'ust/verse1.ust', [clip('a/1'), clip('a/2', { from: 100, to: 100 })])))).toThrow(
      'user_input/placements.json: lanes[0].clips[1].from must be less than to.',
    );
  });

  test('rejects from/to outside the wav when the index is given', () => {
    const early = file(lane('a', 'ust/verse1.ust', [clip('a/1', { from: -49 })]));
    const late = file(lane('a', 'ust/verse1.ust', [clip('a/1', { to: 3841 })]));
    expect(() => parsePlacements(early, INDEX)).toThrow('lanes[0].clips[0].from -49 is before the start of the wav');
    expect(() => parsePlacements(late, INDEX)).toThrow('lanes[0].clips[0].to 3841 is after the end of the wav');
    expect(() => parsePlacements(early)).not.toThrow();
    expect(() => parsePlacements(file(lane('a', 'ust/verse1.ust', [clip('a/1', { from: R.min, to: R.max })])), INDEX)).not.toThrow();
  });

  test('rejects duplicate clip ids in a lane', () => {
    expect(() => parsePlacements(file(lane('a', 'ust/verse1.ust', [clip('a/1'), clip('a/1', { from: 1920, to: 3000 })])))).toThrow(
      'user_input/placements.json: lanes[0].clips[1].id "a/1" is used twice in the lane.',
    );
  });

  test('accepts atBeat null and rejects a non-number atBeat', () => {
    expect(parsePlacements(file(lane('a', 'ust/verse1.ust', [clip('a/1', { atBeat: null })])), INDEX).lanes[0]!.clips[0]!.atBeat).toBeNull();
    expect(() => parsePlacements(file(lane('a', 'ust/verse1.ust', [clip('a/1', { atBeat: '8' })])))).toThrow(
      'user_input/placements.json: lanes[0].clips[0].atBeat must be a number or null.',
    );
  });

  test('keeps unknown fields on round-trip', () => {
    const raw = { v: 2, note: 'take 2', lanes: [{ ...lane('a', 'ust/verse1.ust', [clip('a/1', { gainDb: -3 })]), color: 'red' }] };
    expect(parsePlacements(JSON.parse(JSON.stringify(parsePlacements(raw, INDEX))), INDEX)).toEqual(raw as never);
  });
});

describe('defaultPlacements', () => {
  test('gives one lane per render with one parked clip over the whole wav', () => {
    const p = defaultPlacements(INDEX);
    expect(p.lanes.map((l) => [l.id, l.ust, l.block, l.clips.map((c) => [c.id, c.atBeat, c.from, c.to])])).toEqual([
      ['verse1#1', 'ust/verse1.ust', '', [['verse1#1/1', null, R.min, R.max]]],
      ['chorus#1', 'ust/chorus.ust', '', [['chorus#1/1', null, R.min, R.max]]],
    ]);
    expect(() => parsePlacements(p, INDEX)).not.toThrow();
  });
});

describe('splitClip', () => {
  const base: PlacementLane = { id: 'v#1', ust: 'ust/verse1.ust', block: 'A', clips: [clip('v#1/1', { atBeat: 12 }), clip('v#1/5', { atBeat: 40, from: 1920, to: 3000 })] };

  test('keeps atBeat on both halves and gives the new half the next id', () => {
    const out = splitClip(base, 'v#1/1', 960.5);
    expect(out.clips).toEqual([clip('v#1/1', { atBeat: 12, to: 960.5 }), clip('v#1/6', { atBeat: 12, from: 960.5 }), base.clips[1]!]);
    expect(base.clips[0]!.to).toBe(1920);
    expect(out.block).toBe('A');
  });

  test('throws on a cut at or outside an edge', () => {
    expect(() => splitClip(base, 'v#1/1', 0)).toThrow('not inside');
    expect(() => splitClip(base, 'v#1/1', 1920)).toThrow('not inside');
    expect(() => splitClip(base, 'v#1/1', 2500)).toThrow('not inside');
    expect(() => splitClip(base, 'nope', 10)).toThrow('has no clip');
  });
});
