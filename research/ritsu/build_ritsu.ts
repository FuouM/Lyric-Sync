// Builds lyricsync benchmark songs from the Namine Ritsu Normal singing database (50 a cappella Japanese songs with
// phone-level .lab labels and UST scores) into .cache/ritsu/projects/<song>/:
//   lyrics.json             lyricsync JSON lyrics (romaji, language ja), one word per mora (as GTSinger: one word per kana)
//   lyrics.calibrated.json  ground truth in the calibrated shape: syllable start = vowel onset (the annotated songs' convention),
//                           syllable end = the next syllable's start inside a run, the last phone's end before a rest
//   beats.json              the UST tempo grid (the recordings follow the score)
//   runs.json               the morae per run (rest to rest) for boundary-model training: start, end, vowel, phones, wordStart
// and the manifest .cache/ritsu/ritsu.training.json (workspaces in .cache/ritsu/workspaces/<song>).
// Lines: the .lab phrases split at rests >= 0.25 s (--gap); shorter rests stay inside a line (as breaths inside lyric lines);
// a line over 10 s splits at its longest rest.
// Label notes: GlottalStop / Edge (onset markers before a vowel) belong to the mora they precede; devoiced vowels (A I U E O)
// are the vowel; cl and N are morae of their own.
// usage: bun research/ritsu/build_ritsu.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

const DB = '.cache/ritsu_db/「波音リツ Normal」歌声データベース/DATABASE_normal';
const OUT = '.cache/ritsu';
const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);
const ONSET_MARKS = new Set(['GlottalStop', 'Edge']);
const SILENCE = new Set(['pau', 'sil', 'br']);
const gapArg = process.argv.indexOf('--gap');
const LINE_GAP_SEC = gapArg < 0 ? 0.25 : Number(process.argv[gapArg + 1]);
const MAX_LINE_SEC = 10;
interface Phone { s: number; e: number; p: string }
interface Mora { text: string; phones: string[]; start: number; vowel: number; end: number }

function readLab(file: string): Phone[] {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((l) => {
    const [s, e, p] = l.trim().split(/\s+/);
    // devoiced vowels are written in capitals
    const q = p!.length === 1 && VOWELS.has(p!.toLowerCase()) ? p!.toLowerCase() : p!;
    return { s: Number(s) / 1e7, e: Number(e) / 1e7, p: q };
  });
}

/** Romaji of each phone sequence the dictionary knows (shortest key wins). */
function reverseDictionary(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of fs.readFileSync('packages/lyricsync/models/hubert-base/japanese_dict_full.txt', 'utf8').split(/\r?\n/)) {
    const [key, phones] = line.split('\t');
    if (!key || !phones) continue;
    const k = phones.trim();
    const prev = map.get(k);
    if (prev === undefined || key.length < prev.length) map.set(k, key);
  }
  return map;
}

/** Score tempo grid from a UST: one beat per quarter (480 ticks), tempo changes per note. */
function ustBeats(file: string, duration: number): { bpm: number; beats: number[]; noteStarts: number[] } {
  const text = new TextDecoder('shift_jis').decode(fs.readFileSync(file));
  let tempo = Number(/\[#SETTING\][\s\S]*?Tempo=([\d.]+)/.exec(text)![1]);
  const bpm0 = tempo;
  const segments: Array<{ tick: number; tempo: number }> = [{ tick: 0, tempo }];
  const noteTicks: number[] = [];
  let tick = 0;
  for (const block of text.split(/\r?\n(?=\[#\d{4}\])/).slice(1)) {
    const len = Number(/Length=(\d+)/.exec(block)![1]);
    const t = /Tempo=([\d.]+)/.exec(block);
    if (t && Number(t[1]) !== tempo) {
      tempo = Number(t[1]);
      segments.push({ tick, tempo });
    }
    if (/Lyric=(?!R\s)/.test(`${block}\n`)) noteTicks.push(tick);
    tick += len;
  }
  const timeOf = (k: number): number => {
    let sec = 0;
    for (let i = 0; i < segments.length; i++) {
      const a = segments[i]!.tick;
      const b = Math.min(k, segments[i + 1]?.tick ?? Infinity);
      if (b <= a) break;
      sec += ((b - a) / 480) * (60 / segments[i]!.tempo);
    }
    return sec;
  };
  const beats: number[] = [];
  for (let k = 0; timeOf(k) < duration; k += 480) beats.push(Math.round(timeOf(k) * 10000) / 10000);
  return { bpm: bpm0, beats, noteStarts: noteTicks.map(timeOf) };
}

function morae(phones: Phone[], romaji: Map<string, string>, song: string): Mora[][] {
  // runs: stretches between rests
  const runs: Phone[][] = [];
  let cur: Phone[] = [];
  for (const ph of phones) {
    if (SILENCE.has(ph.p)) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(ph);
  }
  if (cur.length) runs.push(cur);
  return runs.map((run) => {
    const out: Mora[] = [];
    let pend: Phone[] = [];
    for (const ph of run) {
      pend.push(ph);
      if (!VOWELS.has(ph.p) && ph.p !== 'N' && ph.p !== 'cl') continue;
      const named = pend.filter((x) => !ONSET_MARKS.has(x.p)).map((x) => x.p);
      const key = named.join(' ');
      const text = romaji.get(key);
      if (text === undefined) throw new Error(`${song}: no romaji for phones "${key}" at ${ph.s.toFixed(2)} s`);
      out.push({ text, phones: named, start: pend[0]!.s, vowel: ph.s, end: ph.e });
      pend = [];
    }
    if (pend.length) {
      // trailing consonant without a vowel before a rest: it extends the last mora
      if (!out.length) throw new Error(`${song}: run without a mora at ${pend[0]!.s.toFixed(2)} s`);
      console.warn(`${song}: trailing ${pend.map((x) => x.p).join(' ')} at ${pend[0]!.s.toFixed(2)} s joins the previous mora`);
      out.at(-1)!.end = pend.at(-1)!.e;
    }
    return out;
  });
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const romaji = reverseDictionary();
const manifest: Array<{ id: string; workspace: string; calibrated: string; skipLines: number[] }> = [];
const lineDur: number[] = [];
const onsetToNote: number[] = [];
let nSyl = 0;
for (const song of fs.readdirSync(DB).sort()) {
  const dir = path.join(DB, song);
  const phones = readLab(path.join(dir, `${song}.lab`));
  const duration = phones.at(-1)!.e;
  const runs = morae(phones, romaji, song);
  // lines: consecutive runs whose rest is shorter than LINE_GAP_SEC; a line longer than MAX_LINE_SEC splits at its longest rest
  const grouped: Mora[][][] = [];
  runs.forEach((run, i) => {
    const gap = i === 0 ? Infinity : run[0]!.start - runs[i - 1]!.at(-1)!.end;
    if (gap >= LINE_GAP_SEC) grouped.push([run]);
    else grouped.at(-1)!.push(run);
  });
  const lines: Mora[][][] = [];
  const place = (line: Mora[][]): void => {
    if (line.length < 2 || line.at(-1)!.at(-1)!.end - line[0]![0]!.start <= MAX_LINE_SEC) {
      lines.push(line);
      return;
    }
    let cut = 1;
    for (let k = 2; k < line.length; k++) if (line[k]![0]!.start - line[k - 1]!.at(-1)!.end > line[cut]![0]!.start - line[cut - 1]!.at(-1)!.end) cut = k;
    place(line.slice(0, cut));
    place(line.slice(cut));
  };
  grouped.forEach(place);
  const calLines = lines.map((line, li) => {
    const words = line.flatMap((run) => run.map((m, k) => {
      const end = k + 1 < run.length ? run[k + 1]!.vowel : m.end;
      return { w: m.text, start: r3(m.vowel), end: r3(end), syl: [[r3(m.vowel), r3(end)]], sylText: [m.text], calibrated: true };
    }));
    lineDur.push(words.at(-1)!.end - words[0]!.start);
    nSyl += words.length;
    return { i: li, text: words.map((w) => w.w).join(' '), start: words[0]!.start, end: words.at(-1)!.end, calibrated: true, words };
  });
  const out = path.join(OUT, 'projects', song);
  fs.mkdirSync(out, { recursive: true });
  const lyrics = { language: 'ja', lines: lines.map((line) => ({ text: line.flat().map((m) => m.text).join(' '), words: line.flat().map((m) => m.text) })) };
  fs.writeFileSync(path.join(out, 'lyrics.json'), `${JSON.stringify(lyrics, null, 1)}\n`);
  fs.writeFileSync(path.join(out, 'lyrics.calibrated.json'), `${JSON.stringify({ format: 'words', fps: 60, method: 'golden_ritsu_lab', lines: calLines }, null, 1)}\n`);
  // boundary-model training labels (scripts/ritsu/build_ritsu_ds.py), in build_dataset.py's run format with absolute times
  const runsJson = runs.map((run) => run.map((m) => ({ start: r3(m.start), end: r3(m.end), vowel: r3(m.vowel), phones: m.phones, wordStart: true })));
  fs.writeFileSync(path.join(out, 'runs.json'), `${JSON.stringify(runsJson)}\n`);
  const { bpm, beats, noteStarts } = ustBeats(path.join(dir, `${song}.ust`), duration);
  fs.writeFileSync(path.join(out, 'beats.json'), `${JSON.stringify({ v: 1, model: 'ust_score', bpm, beat_period: r3(60 / bpm), duration: r3(duration), beats, downbeats: beats.filter((_, i) => i % 4 === 0) })}\n`);
  // sanity: vowel onsets against the nearest score note start
  for (const m of runs.flat()) {
    let best = Infinity;
    for (const t of noteStarts) best = Math.min(best, Math.abs(t - m.vowel));
    onsetToNote.push(best);
  }
  manifest.push({ id: song, workspace: `workspaces/${song}`, calibrated: `projects/${song}/lyrics.calibrated.json`, skipLines: [] });
}
fs.writeFileSync(path.join(OUT, 'ritsu.training.json'), `${JSON.stringify({ songs: manifest }, null, 1)}\n`);
const q = (xs: number[], f: number): string => [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))]!.toFixed(3);
console.log(`${manifest.length} songs, ${lineDur.length} lines, ${nSyl} syllables`);
console.log(`line duration s: q10 ${q(lineDur, 0.1)} q50 ${q(lineDur, 0.5)} q90 ${q(lineDur, 0.9)} max ${q(lineDur, 1)}`);
console.log(`|vowel onset - nearest UST note start| s: q50 ${q(onsetToNote, 0.5)} q90 ${q(onsetToNote, 0.9)} q99 ${q(onsetToNote, 0.99)}`);
