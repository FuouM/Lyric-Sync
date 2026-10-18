// packages/lyricsync/tests/e2e/pipeline.test.ts
// Real-model plumbing test on a synthetic vocal (sine glides). It does not assess alignment quality (a tone is not singing); it proves that the whole
// workflow runs on the shipped models and weights and that its contracts hold: structure, exact pins, anchored mode, caching, staleness.
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session } from '../../src/workspace/session.ts';
import { emptyAnchors, setBoundary, setLineBounds } from '../../src/workspace/anchors.ts';
import { wavBytes } from '../helpers/wav.ts';

const SAMPLE_RATE = 22050;
const DURATION = 16;

function syntheticVocal(): Float32Array {
  const out = new Float32Array(SAMPLE_RATE * DURATION);
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const note = 220 * 2 ** (Math.floor(t / 0.5) % 5 / 12);
    const env = 0.3 * Math.min(1, (t % 0.5) * 20) * Math.min(1, (0.5 - (t % 0.5)) * 20);
    out[i] = env * (Math.sin(2 * Math.PI * note * t) + 0.4 * Math.sin(4 * Math.PI * note * t));
  }
  return out;
}

describe('lyricsync workflow on the shipped models', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricsync-e2e-'));
  const vocal = path.join(dir, 'vocal.wav');
  const beats = path.join(dir, 'beats.json');
  const lyrics = path.join(dir, 'lyrics.txt');
  fs.writeFileSync(vocal, wavBytes(syntheticVocal(), SAMPLE_RATE));
  fs.writeFileSync(beats, JSON.stringify({ beats: Array.from({ length: DURATION * 2 }, (_, i) => i * 0.5) }));
  fs.writeFileSync(lyrics, ['la la la la', 'hello world la', 'la la hello', 'world la la la'].join('\n'));
  const ws = path.join(dir, 'ws');

  test('init -> prepare -> free solve produces a valid, self-consistent lyrics.json', async () => {
    const { session } = Session.init({ dir: ws, vocalPath: vocal, lyricsPath: lyrics, language: 'en', beats: { kind: 'file', path: beats } });
    expect((await session.prepare()).skipped).toBe(false);
    expect((await session.prepare()).skipped).toBe(true);
    const result = await session.solve();
    expect(result.lyrics.format).toBe('words');
    expect(result.lyrics.lines.length).toBe(4);
    for (const line of result.lyrics.lines) {
      expect(line.end).toBeGreaterThan(line.start);
      let prev = line.start;
      for (const w of line.words) {
        for (const s of w.syl ?? []) {
          expect(s[0]).toBeGreaterThanOrEqual(prev - 1e-9);
          expect(s[1]).toBeGreaterThan(s[0]);
          prev = s[1];
        }
      }
    }
    expect(result.review.every((r) => r.mode === 'free')).toBe(true);
    expect(fs.existsSync(session.paths.lyricsOut)).toBe(true);
  }, 600_000);

  test('pins are exact, a line with both edges pinned is solved in anchored mode, and its alignment is cached', async () => {
    const session = Session.open(ws);
    const anchors = session.loadAnchors();
    setLineBounds(anchors, session.definition, 1, 4.0, 7.0);
    setBoundary(anchors, session.definition, 1, 2, 5.55);
    session.saveAnchors(anchors);
    const result = await session.solve();
    const line = result.lyrics.lines[1]!;
    expect(line.start).toBe(4.0);
    expect(line.end).toBe(7.0);
    expect(line.words[1]!.syl![0]![0]).toBe(5.55);
    expect(result.review[1]!.mode).toBe('anchored');
    expect(result.review[0]!.mode).toBe('free');
    expect(line.words[0]!.sylCalibrated).toBeUndefined(); // no syllable of line 1's first word has both edges pinned
    expect(fs.existsSync(path.join(session.paths.sliced, '1.json'))).toBe(true);
  }, 600_000);

  test('solve({ anchors }) uses the given anchors instead of anchors.json, leaves it untouched, and repeated solves agree', async () => {
    const session = Session.open(ws);
    const saved = fs.readFileSync(session.paths.anchors, 'utf8');
    const anchors = emptyAnchors();
    setLineBounds(anchors, session.definition, 2, 8.0, 10.0);
    const first = await session.solve({ anchors });
    expect(first.lyrics.lines[2]!.start).toBe(8.0);
    expect(first.lyrics.lines[2]!.end).toBe(10.0);
    expect(first.review[2]!.mode).toBe('anchored');
    expect(first.review[1]!.mode).toBe('free'); // line 1 is pinned in anchors.json, not in the given anchors
    expect(fs.readFileSync(session.paths.anchors, 'utf8')).toBe(saved);
    const second = await session.solve({ anchors });
    expect(second.lyrics).toEqual(first.lyrics);
  }, 600_000);

  test('changing the vocal stem after prepare is an error, not a silent recompute', async () => {
    const session = Session.open(ws);
    fs.writeFileSync(vocal, wavBytes(syntheticVocal().subarray(0, SAMPLE_RATE * (DURATION - 1)), SAMPLE_RATE));
    await expect(session.solve()).rejects.toThrow(/changed since "prepare"/);
  }, 600_000);
});
