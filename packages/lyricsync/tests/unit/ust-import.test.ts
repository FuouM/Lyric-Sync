// packages/lyricsync/tests/unit/ust-import.test.ts
// UST parsing, placed notes, the ust.map.json check, the UST import and singers.json.
import { describe, expect, test } from 'bun:test';
import { beatTime } from '../../src/beat-grid.ts';
import { parseUst, type Ust } from '../../src/formats/ust.ts';
import { parseLyricsText } from '../../src/lyrics/parse.ts';
import { placedNotes } from '../../src/placed-notes.ts';
import { splitClip, type PlacementClip, type PlacementLane, type Placements } from '../../src/placements.ts';
import { calibratedFileFor, lyricsFileFor, parseSingers, type Singers } from '../../src/singers.ts';
import { checkUstMap, importUst, parseUstMap, type UstImportInput } from '../../src/ust-import.ts';

/** Shift_JIS for ASCII and hiragana (U+3041..U+3093 = 0x829F..0x82F1), enough for the test files. */
function sjis(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp >= 0x3041 && cp <= 0x3093) out.push(0x82, 0x9f + (cp - 0x3041));
    else throw new Error(`no Shift_JIS for ${ch} in the test encoder`);
  }
  return new Uint8Array(out);
}

const note = (n: number, len: number, lyric: string, pitch = 60) => `[#${String(n).padStart(4, '0')}]\r\nLength=${len}\r\nLyric=${lyric}\r\nNoteNum=${pitch}\r\n`;

// Ticks: R 0-480, ka 480-960, sa 960-1200, a 1200-1440 (held vowel), R 1440-1920, ta 1920-2880.
const UST_TEXT =
  '[#VERSION]\r\nUST Version1.2\r\n[#SETTING]\r\nTempo=120.00\r\nVoiceDir=%VOICE%voxA\r\n' +
  note(0, 480, 'R') +
  note(1, 480, 'か', 62) +
  note(2, 240, 'さ') +
  note(3, 240, 'あ') +
  note(4, 480, 'R') +
  note(5, 960, 'た', 64) +
  '[#TRACKEND]\r\n';
const UST = parseUst(sjis(UST_TEXT));

// A grid of 0.5 s per beat: time = beat / 2.
const BEATS = Array.from({ length: 64 }, (_, i) => i * 0.5);

const SINGERS: Singers = parseSingers({ v: 1, singers: [{ id: 'te', voiceDir: 'voxA', lead: true }, { id: 'ko', voiceDir: 'voxB' }] });

const clip = (id: string, atBeat: number | null, from: number, to: number): PlacementClip => ({ id, atBeat, from, to });
const laneOf = (clips: PlacementClip[], block = 'kasa ta'): PlacementLane => ({ id: 'a#1', ust: 'a.ust', block, clips });
const placementsOf = (...lanes: PlacementLane[]): Placements => ({ v: 2, lanes });
const usts = new Map<string, Ust>([['a.ust', UST]]);

describe('parseUst', () => {
  test('gives absolute ticks, rests, note numbers and the VoiceDir', () => {
    expect(UST.tempo).toBe(120);
    expect(UST.voiceDir).toBe('voxA');
    expect(UST.ticks).toBe(2880);
    expect(UST.notes.map((n) => [n.idx, n.tick, n.len, n.lyric, n.rest, n.note])).toEqual([
      [0, 0, 480, 'R', true, 60],
      [1, 480, 480, 'か', false, 62],
      [2, 960, 240, 'さ', false, 60],
      [3, 1200, 240, 'あ', false, 60],
      [4, 1440, 480, 'R', true, 60],
      [5, 1920, 960, 'た', false, 64],
    ]);
  });

  test('keeps the [#NNNN] number when the numbering has a gap', () => {
    const u = parseUst(sjis('[#SETTING]\r\nTempo=135\r\n' + note(0, 480, 'か') + note(7, 240, 'R') + note(8, 240, 'さ')));
    expect(u.notes.map((n) => [n.idx, n.tick])).toEqual([[0, 0], [7, 480], [8, 720]]);
  });

  test('throws without a tempo', () => {
    expect(() => parseUst(sjis('[#SETTING]\r\nVoiceDir=x\r\n' + note(0, 480, 'か')))).toThrow('Tempo');
  });
});

describe('placedNotes', () => {
  test('drops the notes outside every placed clip and rests', () => {
    const notes = placedNotes(placementsOf(laneOf([clip('a#1/1', 10, 900, 3000), clip('a#1/2', null, -48, 900)])), usts, SINGERS, BEATS);
    expect(notes.map((n) => n.idx)).toEqual([2, 3, 5]);
    expect(notes[0]).toEqual({ lane: 'a#1', clip: 'a#1/1', ust: 'a.ust', singer: 'te', idx: 2, kana: 'さ', pitch: 60, beat: 12, start: 6, end: 6.25 });
  });

  test('a split clip keeps the notes on both sides at the same beats; the note at the cut ends at the cut', () => {
    const whole = laneOf([clip('a#1/1', 10, -48, 2880)]);
    const split = splitClip(whole, 'a#1/1', 1300);
    const a = placedNotes(placementsOf(whole), usts, SINGERS, BEATS);
    const b = placedNotes(placementsOf(split), usts, SINGERS, BEATS);
    expect(b.map((n) => [n.idx, n.beat])).toEqual(a.map((n) => [n.idx, n.beat]));
    expect(b.map((n) => n.clip)).toEqual(['a#1/1', 'a#1/1', 'a#1/1', 'a#1/2']);
    // Note 3 (ticks 1200-1440) is in the first half, cut at tick 1300: beat 10 + 1300/480.
    expect(b[2]!.end).toBeCloseTo(beatTime(BEATS, 10 + 1300 / 480), 6);
  });

  test('a moved half moves its notes', () => {
    const split = splitClip(laneOf([clip('a#1/1', 10, -48, 2880)]), 'a#1/1', 1500);
    const moved = { ...split, clips: [split.clips[0]!, { ...split.clips[1]!, atBeat: 14 }] };
    const notes = placedNotes(placementsOf(moved), usts, SINGERS, BEATS);
    const ta = notes.find((n) => n.idx === 5)!;
    expect(ta.beat).toBe(14 + 4);
    expect(ta.start).toBe(9);
    expect(notes.find((n) => n.idx === 1)!.beat).toBe(11);
  });

  test('a note held by two overlapping clips counts once, in the clip with the lowest index', () => {
    const notes = placedNotes(placementsOf(laneOf([clip('a#1/1', 10, 0, 2880), clip('a#1/2', 30, 900, 2880)])), usts, SINGERS, BEATS);
    expect(notes.map((n) => [n.idx, n.clip])).toEqual([[1, 'a#1/1'], [2, 'a#1/1'], [3, 'a#1/1'], [5, 'a#1/1']]);
  });

  test('a UST whose VoiceDir has no singer gets singer null; notes sort by start', () => {
    const other = parseUst(sjis(UST_TEXT.replace('voxA', 'voxZ')));
    const p = placementsOf({ ...laneOf([clip('b#1/1', 0, 0, 2880)]), id: 'b#1', ust: 'b.ust' }, laneOf([clip('a#1/1', 1, 0, 2880)]));
    const notes = placedNotes(p, new Map([...usts, ['b.ust', other]]), SINGERS, BEATS);
    expect(notes.filter((n) => n.lane === 'b#1').every((n) => n.singer === null)).toBe(true);
    expect(notes.map((n) => n.start)).toEqual([...notes.map((n) => n.start)].sort((x, y) => x - y));
  });
});

describe('ust.map.json check and import', () => {
  const LYRICS = parseLyricsText('[Verse]\nka|sa ta\n', 'ja');
  const GOOD = [['か', 'ka'], ['さ', 'sa'], ['あ', '~'], ['た', 'ta']];
  const input = (rows: string[][], lyrics = LYRICS): UstImportInput => ({
    map: parseUstMap({ v: 1, lanes: { 'a#1': [{ line: 0, notes: rows }] }, sections: [{ name: 'Verse', bar: 2 }] }),
    placements: placementsOf(laneOf([clip('a#1/1', 10, -48, 2880)])),
    usts,
    singers: SINGERS,
    lyrics: new Map([['te', lyrics]]),
  });
  const messages = (rows: string[][], lyrics = LYRICS) => checkUstMap(input(rows, lyrics)).map((i) => [i.lane, i.line, i.note, i.message]);

  test('a correct map passes', () => {
    expect(checkUstMap(input(GOOD))).toEqual([]);
  });

  test('a wrong ustKana fails with lane, line and note', () => {
    const rows = GOOD.map((r) => [...r]);
    rows[1]![0] = 'ざ';
    expect(messages(rows)).toEqual([['a#1', 0, 2, 'row 1: ustKana "ざ" but the UST note lyric is "さ".']]);
  });

  test('syllables out of order fail', () => {
    const rows = [['か', 'sa'], ['さ', 'ka'], ['あ', '~'], ['た', 'ta']];
    expect(messages(rows).map((m) => m.slice(0, 3))).toEqual([['a#1', 0, 1], ['a#1', 0, 2]]);
    expect(messages(rows)[0]![3]).toContain('syllable 0 of the line is "ka"');
  });

  test('an unused syllable fails', () => {
    const rows = [['か', 'ka'], ['さ', 'sa'], ['あ', '~'], ['た', '_']];
    expect(messages(rows)).toEqual([['a#1', 0, null, 'syllables 2 to 2 of the line (ta) are not used.']]);
  });

  test('a sung note that the map does not list fails', () => {
    const lyrics = parseLyricsText('ka|sa\n', 'ja');
    const rows = [['か', 'ka'], ['さ', 'sa'], ['あ', '~']];
    expect(messages(rows, lyrics)).toEqual([['a#1', null, 5, '1 sung UST notes from note 5 on are not listed.']]);
  });

  test('a lyric line that no lane maps fails', () => {
    const lyrics = parseLyricsText('ka|sa ta\nta\n', 'ja');
    expect(messages(GOOD, lyrics)).toEqual([[null, 1, null, 'line 1 of singer "te" is not mapped by any lane.']]);
  });

  test('"~" or "_" among several targets fails', () => {
    const rows = [['か', 'ka'], ['さ', 'sa', '~'], ['あ', '~'], ['た', 'ta']];
    expect(messages(rows)[0]!.slice(0, 3)).toEqual(['a#1', 0, 2]);
  });

  test('the import pins every syllable; "~" extends the end; the lead file gets the sections', () => {
    const notes = placedNotes(input(GOOD).placements, usts, SINGERS, BEATS);
    const [file] = importUst(input(GOOD), notes, { downbeats: [0, 2, 4, 6], duration: 30 });
    expect(file!.file).toBe('user_input/lyrics.calibrated.json');
    const [kasa, ta] = file!.doc.lines[0]!.words;
    // ka: tick 480-960 = beats 11-12; sa: 960-1200 plus the held a 1200-1440 = beats 12-13.
    expect(kasa!.syl).toEqual([[5.5, 6], [6, 6.5]]);
    expect(kasa!.sylCalibrated).toEqual([true, true]);
    expect(ta!.syl).toEqual([[7, 8]]);
    expect(file!.doc.lines[0]).toMatchObject({ i: 0, start: 5.5, end: 8 });
    expect(file!.doc.sections).toEqual([{ id: 'verse_0', name: 'Verse', start: 2, end: 30 }]);
  });

  test('a row with two targets splits its note evenly and leaves both syllables unpinned', () => {
    const lyrics = parseLyricsText('ka|sa ta|a\n', 'ja');
    const rows = [['か', 'ka'], ['さ', 'sa'], ['あ', '~'], ['た', 'ta', 'a']];
    expect(checkUstMap(input(rows, lyrics))).toEqual([]);
    const notes = placedNotes(input(rows, lyrics).placements, usts, SINGERS, BEATS);
    const [file] = importUst(input(rows, lyrics), notes, { downbeats: [0, 2], duration: 30 });
    const [kasa, taa] = file!.doc.lines[0]!.words;
    // ta: tick 1920-2880 = 7 s to 8 s, split at 7.5 s.
    expect(taa!.syl).toEqual([[7, 7.5], [7.5, 8]]);
    expect(taa!.sylCalibrated).toEqual([false, false]);
    expect(kasa!.sylCalibrated).toEqual([true, true]);
  });

  test('a syllable whose notes are not placed stops the import', () => {
    const inp = { ...input(GOOD), placements: placementsOf(laneOf([clip('a#1/1', 10, -48, 1500)])) };
    const notes = placedNotes(inp.placements, usts, SINGERS, BEATS);
    expect(() => importUst(inp, notes, { downbeats: [0, 2], duration: 30 })).toThrow('line 0, syllable 2 "ta": no placed note (a#1 note #0005)');
  });

  test('the map shape is checked', () => {
    expect(() => parseUstMap({ v: 1, lanes: { 'a#1': [{ line: 0, notes: [['か']] }] } })).toThrow('[ustKana, target]');
    expect(() => parseUstMap({ v: 1, lanes: {}, sections: [{ name: 'A', bar: 5 }, { name: 'B', bar: 5 }] })).toThrow('must be after');
  });
});

describe('singers.json', () => {
  test('needs exactly one lead', () => {
    expect(() => parseSingers({ v: 1, singers: [{ id: 'a', voiceDir: 'x' }, { id: 'b', voiceDir: 'y' }] })).toThrow('exactly one');
    expect(() => parseSingers({ v: 1, singers: [{ id: 'a', voiceDir: 'x', lead: true }, { id: 'b', voiceDir: 'y', lead: true }] })).toThrow('found 2');
  });

  test('rejects a voiceDir used twice and a bad id', () => {
    expect(() => parseSingers({ v: 1, singers: [{ id: 'a', voiceDir: 'x', lead: true }, { id: 'b', voiceDir: 'x' }] })).toThrow('"x" is used twice');
    expect(() => parseSingers({ v: 1, singers: [{ id: 'A-1', voiceDir: 'x', lead: true }] })).toThrow('[a-z0-9_]+');
  });

  test('the lead uses the default file names, the others their id', () => {
    const [te, ko] = SINGERS.singers;
    expect([calibratedFileFor(te!), lyricsFileFor(te!)]).toEqual(['user_input/lyrics.calibrated.json', 'user_input/lyrics.txt']);
    expect([calibratedFileFor(ko!), lyricsFileFor(ko!)]).toEqual(['user_input/lyrics.calibrated.ko.json', 'user_input/lyrics.ko.txt']);
  });
});
