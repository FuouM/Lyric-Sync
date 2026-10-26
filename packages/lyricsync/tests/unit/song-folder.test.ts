// packages/lyricsync/tests/unit/song-folder.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findSongDir,
  readCalibratedLyrics,
  readFeatures,
  readPromptManifest,
  readSongPrompt,
  readTimingAi,
  songFolderPaths,
  songInputs,
} from '../../src/song-folder.ts';

let root: string;
let dir: string;

function put(rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

const PROMPT = [
  'project_code: demo',
  'song_name: "demo"',
  'nearest_bpm: 120',
  'first_downbeat_s: 0.25',
  'files:',
  '  song: "[full] Demo.wav"',
  '  lyrics: lyrics.txt',
  '  stems:',
  '    folder: stems',
  '    vocal:',
  '      chorus: "chorus.wav"',
  '      main_vocal: "main.wav"',
  '    drums: "drums.wav"',
  '    other: ["keys.wav", "pad.wav"]',
  '',
].join('\n');

const TIMING = { v: 1, model: 'beat_this', duration: 2.5, bpm: 120, beat_period: 0.5, beats: [0.25, 0.75, 1.25], downbeats: [0.25] };

const CALIBRATED = {
  format: 'words',
  sections: [{ id: 'verse_0', name: 'Verse', start: 0, end: 2.5 }],
  lines: [{ i: 0, text: 'hello', start: 0.3, end: 0.9, words: [{ w: 'hello', start: 0.3, end: 0.9, syl: [[0.3, 0.6], [0.6, 0.9]], sylText: ['hel', 'lo'] }] }],
};

const FEATURES = { v: 1, fps: 100, envelopes: { rms: [0, 1], low: [0, 1], mid: [1, 0.5], high: [0, 0], vocal: [0.2, 1] }, onsets: {} };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricsync-song-folder-'));
  dir = path.join(root, 'demo');
  put('project.json', '{}');
  put('user_input/prompt.yaml', PROMPT);
  put('user_input/[full] Demo.wav', '');
  put('user_input/stems/main.wav', '');
  put('user_input/lyrics.sync.json', JSON.stringify({ language: 'en', lines: [] }));
  put('user_input/lyrics.calibrated.json', JSON.stringify(CALIBRATED));
  put('generated/timing.ai.json', JSON.stringify(TIMING));
  put('generated/features.json', JSON.stringify(FEATURES));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('song folder paths and prompt', () => {
  test('finds the folder by id in a root', () => {
    expect(findSongDir([path.join(root, 'none'), root], 'demo')).toBe(dir);
    expect(findSongDir(root, 'missing')).toBeNull();
  });

  test('resolves every file of the layout', () => {
    const p = songFolderPaths(dir);
    expect(path.relative(dir, p.promptFile)).toBe(path.join('user_input', 'prompt.yaml'));
    expect(path.relative(dir, p.calibratedFile)).toBe(path.join('user_input', 'lyrics.calibrated.json'));
    expect(path.relative(dir, p.timingFile)).toBe(path.join('generated', 'timing.ai.json'));
    expect(path.relative(dir, p.featuresFile)).toBe(path.join('generated', 'features.json'));
    expect(path.relative(dir, p.workspaceDir)).toBe('lyricsync');
  });

  test('reads prompt.yaml with mix, stems and tempo hints', () => {
    const prompt = readSongPrompt(dir);
    const rel = (p: string) => path.relative(dir, p);
    expect(rel(prompt.mixPath)).toBe(path.join('user_input', '[full] Demo.wav'));
    expect(prompt.lyricsTextPath && rel(prompt.lyricsTextPath)).toBe(path.join('user_input', 'lyrics.txt'));
    expect(prompt.stems.vocal.map(rel)).toEqual([path.join('user_input', 'stems', 'main.wav'), path.join('user_input', 'stems', 'chorus.wav')]);
    expect(prompt.stems.mainVocal && rel(prompt.stems.mainVocal)).toBe(path.join('user_input', 'stems', 'main.wav'));
    expect(prompt.stems.drums.map(rel)).toEqual([path.join('user_input', 'stems', 'drums.wav')]);
    expect(prompt.stems.bass).toEqual([]);
    expect(prompt.stems.other.map(rel)).toEqual([path.join('user_input', 'stems', 'keys.wav'), path.join('user_input', 'stems', 'pad.wav')]);
    expect(prompt.nearestBpm).toBe(120);
    expect(prompt.firstDownbeat).toBe(0.25);
    expect(prompt.projectCode).toBe('demo');
  });

  test('a plain vocal file name is the main vocal', () => {
    put('user_input/prompt.yaml', 'files:\n  song: mix.wav\n  stems:\n    vocal: "v.wav"\n');
    const prompt = readSongPrompt(dir);
    expect(prompt.stems.vocal).toEqual([path.join(dir, 'user_input', 'stems', 'v.wav')]);
    expect(prompt.stems.mainVocal).toBe(path.join(dir, 'user_input', 'stems', 'v.wav'));
    expect(prompt.nearestBpm).toBeNull();
  });

  test('prompt.yaml without files.song is an error', () => {
    put('user_input/prompt.yaml', 'files:\n  lyrics: lyrics.txt\n');
    expect(() => readSongPrompt(dir)).toThrow('needs files.song');
  });

  test('tempo_changes, as the wizard writes them, are read in order; without them there are none', () => {
    expect(readSongPrompt(dir).tempoChanges).toEqual([]);
    put('user_input/prompt.yaml', PROMPT.replace('files:', 'tempo_changes:\n  - at: 62.5\n    bpm: 140\n  - at: 130\n    bpm: 96.5\nfiles:'));
    expect(readSongPrompt(dir).tempoChanges).toEqual([{ at: 62.5, bpm: 140 }, { at: 130, bpm: 96.5 }]);
    expect(readPromptManifest(root, 'demo').tempoChanges).toEqual([{ at: 62.5, bpm: 140 }, { at: 130, bpm: 96.5 }]);
  });

  test('a tempo change without a number is an error', () => {
    put('user_input/prompt.yaml', PROMPT.replace('files:', 'tempo_changes:\n  - at: 62.5\nfiles:'));
    expect(() => readSongPrompt(dir)).toThrow('tempo_changes');
  });

  test('readPromptManifest and songInputs keep the editor contract', () => {
    const manifest = readPromptManifest(root, 'demo');
    expect(manifest.songPath).toBe(path.join(dir, 'user_input', '[full] Demo.wav'));
    expect(manifest.nearestBpm).toBe(120);
    const inputs = songInputs(root, 'demo');
    expect(inputs.language).toBe('en');
    expect(inputs.vocalPath).toBe(path.join(dir, 'user_input', 'stems', 'main.wav'));
    expect(inputs.beatsFile).toBe(path.join(dir, 'generated', 'timing.ai.json'));
  });
});

describe('typed readers', () => {
  test('read the four input files', () => {
    expect(readTimingAi(dir)).toEqual(TIMING);
    const cal = readCalibratedLyrics(dir);
    expect(cal.sections[0]!.name).toBe('Verse');
    expect(cal.lines[0]!.words[0]!.sylText).toEqual(['hel', 'lo']);
    const features = readFeatures(dir);
    expect(features.fps).toBe(100);
    expect(features.envelopes.vocal).toEqual([0.2, 1]);
    expect(features.envelopes.drums).toBeUndefined();
  });

  test.each([
    ['user_input/prompt.yaml', () => readSongPrompt(dir)],
    ['generated/timing.ai.json', () => readTimingAi(dir)],
    ['user_input/lyrics.calibrated.json', () => readCalibratedLyrics(dir)],
    ['generated/features.json', () => readFeatures(dir)],
  ] as const)('a missing %s is an error that names the file', (rel, read) => {
    fs.rmSync(path.join(dir, rel));
    expect(read).toThrow(path.join(dir, rel));
  });

  test('timing.ai.json without beats is an error', () => {
    put('generated/timing.ai.json', JSON.stringify({ ...TIMING, beats: undefined }));
    expect(() => readTimingAi(dir)).toThrow('beats[]');
  });

  test('features.json with an out-of-range value, unequal lengths or a missing mix envelope is an error', () => {
    put('generated/features.json', JSON.stringify({ ...FEATURES, envelopes: { ...FEATURES.envelopes, rms: [0, 1.5] } }));
    expect(() => readFeatures(dir)).toThrow('envelopes.rms');
    put('generated/features.json', JSON.stringify({ ...FEATURES, envelopes: { ...FEATURES.envelopes, vocal: [1] } }));
    expect(() => readFeatures(dir)).toThrow('envelopes.vocal has 1 frames');
    const { high: _high, ...noHigh } = FEATURES.envelopes;
    put('generated/features.json', JSON.stringify({ ...FEATURES, envelopes: noHigh }));
    expect(() => readFeatures(dir)).toThrow('envelopes.high is missing');
  });

  test('features.json onsets must be [time, strength] pairs', () => {
    put('generated/features.json', JSON.stringify({ ...FEATURES, onsets: { vocal: [[1.2, 0.5]] } }));
    expect(readFeatures(dir).onsets.vocal).toEqual([[1.2, 0.5]]);
    put('generated/features.json', JSON.stringify({ ...FEATURES, onsets: { kick: [[1.2]] } }));
    expect(() => readFeatures(dir)).toThrow('onsets.kick');
  });
});
