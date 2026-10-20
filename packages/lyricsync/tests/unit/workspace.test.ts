// packages/lyricsync/tests/unit/workspace.test.ts
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeAudioKey, computeEvidenceKey } from '../../src/workspace/manifest.ts';
import { Session } from '../../src/workspace/session.ts';
import { wavBytes } from '../helpers/wav.ts';

describe('evidence key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricsync-key-'));
  const vocal = path.join(dir, 'vocal.wav');
  const beats = path.join(dir, 'beats.json');
  fs.writeFileSync(vocal, wavBytes(new Float32Array(22050), 22050));
  fs.writeFileSync(beats, JSON.stringify({ beats: [0, 0.5, 1, 1.5, 2] }));
  fs.writeFileSync(path.join(dir, 'lyrics.txt'), 'hello world');
  const { session } = Session.init({ dir: path.join(dir, 'ws'), vocalPath: vocal, lyricsPath: path.join(dir, 'lyrics.txt'), language: 'en', beats: { kind: 'file', path: beats } });
  const key = (): string => computeEvidenceKey(session.paths.dir, session.manifest, session.definition);

  test('a beats file rewritten with the same content (a checkout) keeps the key; other content changes it', () => {
    const before = key();
    const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(beats, JSON.stringify({ beats: [0, 0.5, 1, 1.5, 2] }));
    fs.utimesSync(beats, later, later);
    expect(key()).toBe(before);
    fs.writeFileSync(beats, JSON.stringify({ beats: [0, 0.5, 1, 1.5, 2.5] }));
    expect(key()).not.toBe(before);
  });

  test('replacing the vocal stem changes the key', () => {
    const before = key();
    fs.writeFileSync(vocal, wavBytes(new Float32Array(44100), 22050));
    expect(key()).not.toBe(before);
  });

  test('a song folder copied elsewhere (new mtimes) keeps its key, with portable relative paths', () => {
    const before = key();
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricsync-copy-'));
    fs.cpSync(dir, copy, { recursive: true });
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(path.join(copy, 'vocal.wav'), later, later);
    const moved = Session.open(path.join(copy, 'ws'));
    expect(moved.manifest.vocal).toBe('../vocal.wav');
    expect(computeEvidenceKey(moved.paths.dir, moved.manifest, moved.definition)).toBe(before);
  });
});

describe('Session.setSyllables', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricsync-split-'));
    const vocal = path.join(dir, 'vocal.wav');
    const beats = path.join(dir, 'beats.json');
    fs.writeFileSync(vocal, wavBytes(new Float32Array(22050), 22050));
    fs.writeFileSync(beats, JSON.stringify({ beats: [0, 0.5, 1, 1.5, 2] }));
    // syllables: look|ing (0,1) at (2) the (3) walls (4); boundaries 0..5
    fs.writeFileSync(path.join(dir, 'lyrics.txt'), 'look|ing at the walls');
    return Session.init({ dir: path.join(dir, 'ws'), vocalPath: vocal, lyricsPath: path.join(dir, 'lyrics.txt'), language: 'en', beats: { kind: 'file', path: beats } }).session;
  };

  test('pins outside the re-split word keep their times at shifted indices; pins inside it are dropped', () => {
    const session = setup();
    session.saveAnchors({ version: 1, lines: { '0': { start: 1, end: 3, boundaries: { '1': 1.2, '2': 1.5, '3': 2, '4': 2.4 } } } });
    const keyBefore = computeEvidenceKey(session.paths.dir, session.manifest, session.definition);
    session.setSyllables([{ line: 0, word: 2, syllables: ['th', 'e', 'e'] }]);
    expect(session.definition.lines[0]!.words[2]!.syllables).toEqual(['th', 'e', 'e']);
    // "the" spanned boundaries 3..4; it now spans 3..6, so "walls" starts at 6.
    expect(session.loadAnchors().lines['0']).toEqual({ start: 1, end: 3, boundaries: { '1': 1.2, '2': 1.5, '3': 2, '6': 2.4 } });
    expect(Session.open(session.paths.dir).definition.lines[0]!.words[2]!.syllables).toEqual(['th', 'e', 'e']);
    expect(computeEvidenceKey(session.paths.dir, session.manifest, session.definition)).not.toBe(keyBefore);

    session.setSyllables([{ line: 0, word: 0, syllables: ['looking'] }]);
    // Merging look|ing drops the boundary inside it; its end (the start of "at", 1.5) stays pinned.
    expect(session.loadAnchors().lines['0']).toEqual({ start: 1, end: 3, boundaries: { '1': 1.5, '2': 2, '5': 2.4 } });
  });

  test('an invalid split is rejected before anything is written', () => {
    const session = setup();
    const before = fs.readFileSync(session.paths.definition, 'utf8');
    expect(() => session.setSyllables([{ line: 0, word: 1, syllables: ['a t'] }])).toThrow(/no spaces/);
    expect(() => session.setSyllables([{ line: 0, word: 9, syllables: ['x'] }])).toThrow(/no word 9/);
    expect(fs.readFileSync(session.paths.definition, 'utf8')).toBe(before);
  });

  test('prepare performs an incremental update when only syllables change', async () => {
    const session = setup();
    const evDir = session.paths.evidence;
    fs.mkdirSync(evDir, { recursive: true });

    const audioKey = computeAudioKey(session.paths.dir, session.manifest);
    fs.writeFileSync(path.join(evDir, 'meta.json'), JSON.stringify({ version: 2, audioKey, sampleRate: 44100 }), 'utf8');
    fs.writeFileSync(path.join(evDir, 'notes.json'), JSON.stringify({ swiftNotes: [], harmoNotes: [], rmvpeNotes: [] }), 'utf8');
    fs.writeFileSync(path.join(evDir, 'posteriors.bin'), new Uint8Array(10));
    fs.writeFileSync(path.join(evDir, 'boundary.bin'), new Uint8Array(16));

    const fullBase = [
      {
        i: 0,
        text: 'look|ing at the walls',
        start: 0,
        end: 2,
        words: [
          { w: 'looking', start: 0, end: 0.8, conf: 0.95, syl: [[0, 0.4], [0.4, 0.8]], sylText: ['look', 'ing'] },
          { w: 'at', start: 0.8, end: 1.0, conf: 0.95, syl: [[0.8, 1.0]], sylText: ['at'] },
          { w: 'the', start: 1.0, end: 1.2, conf: 0.95, syl: [[1.0, 1.2]], sylText: ['the'] },
          { w: 'walls', start: 1.2, end: 1.8, conf: 0.95, syl: [[1.2, 1.8]], sylText: ['walls'] },
        ],
      },
    ];
    fs.writeFileSync(path.join(evDir, 'alignments.json'), JSON.stringify({ fullBase, fullCombined: fullBase }), 'utf8');

    // Resplit "walls" from ['walls'] to ['wa', 'alls']
    session.setSyllables([{ line: 0, word: 3, syllables: ['wa', 'alls'] }]);
    expect(session.status().evidenceFresh).toBe(false);

    const res = await session.prepare();
    expect(res.skipped).toBe(false);
    expect(res.incremental).toBe(true);
    expect(session.status().evidenceFresh).toBe(true);

    const updatedAlignments = JSON.parse(fs.readFileSync(path.join(evDir, 'alignments.json'), 'utf8'));
    const updatedWalls = updatedAlignments.fullBase[0].words[3];
    expect(updatedWalls.sylText).toEqual(['wa', 'alls']);
    expect(updatedWalls.syl).toEqual([[1.2, 1.5], [1.5, 1.8]]);

    const queries = JSON.parse(fs.readFileSync(path.join(evDir, 'boundary.json'), 'utf8'));
    expect(queries['0']).toBeDefined();
  });
});
