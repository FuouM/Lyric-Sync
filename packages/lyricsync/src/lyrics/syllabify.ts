// src/lyrics/syllabify.ts
// Splits a lyric word into the syllables that become the timing granularity of lyrics.json.
//  - English: the syllable COUNT is the number of vowel phones of the word's dictionary pronunciation; the orthographic SPLIT uses
//    vowel groups plus maximal-onset consonant placement ("loo|king", "de|spair"), the convention of the research annotations.
//    It is a heuristic (46-57% exact on the annotated songs, count 100%): write a word with explicit syllables ("re|con|cil|i|a|tion") whenever the split matters.
//  - Japanese: greedy longest-match morae against the dictionary (strict: every character must be covered).

import type { Language, LyricWord } from '../types.ts';
import { dictionaryG2P, EN_VOWEL_PHONES } from './dictionary.ts';

const ONSET_PAIRS: Record<string, true> = {
  pr: true, br: true, tr: true, dr: true, cr: true, kr: true, gr: true, fr: true, wr: true,
  pl: true, bl: true, cl: true, kl: true, fl: true, gl: true, sl: true,
  sp: true, st: true, sk: true, sc: true, sm: true, sn: true, sw: true, tw: true, kn: true,
  ch: true, sh: true, th: true, ph: true, wh: true,
};
const ONSET_TRIPLES: Record<string, true> = { str: true, spr: true, spl: true, scr: true, thr: true, shr: true };
/** Consonant runs that always stay with the preceding syllable. */
const CODA_RUNS: Record<string, true> = { ng: true, ck: true, tch: true, dge: true, nk: true };
const HIATUS_PAIRS: Record<string, true> = { ia: true, io: true, iu: true, ua: true, uo: true, eo: true, oe: true, ea: true, ie: true, ui: true, oa: true };
/** Next-group spellings that pull a preceding t/s/c/g/x into themselves ("na|tion", "mi|ssion" is handled by the double-letter rule). */
const ION_GROUPS: Record<string, true> = { io: true, ia: true, iou: true, iu: true, eou: true };

interface VowelGroup {
  start: number;
  end: number;
}

function isVowelLetter(s: string, i: number): boolean {
  const c = s[i]!;
  if ('aeiou'.includes(c)) return !(c === 'u' && i > 0 && s[i - 1] === 'q');
  if (c === 'y') return i > 0 && !(i + 1 < s.length && 'aeiou'.includes(s[i + 1]!));
  return false;
}

function vowelGroups(s: string): VowelGroup[] {
  const groups: VowelGroup[] = [];
  let i = 0;
  while (i < s.length) {
    if (!isVowelLetter(s, i)) {
      i++;
      continue;
    }
    const start = i;
    while (i < s.length && isVowelLetter(s, i)) i++;
    groups.push({ start, end: i });
  }
  return groups;
}

function isSilentTrailingE(s: string, g: VowelGroup, groupCount: number): boolean {
  if (groupCount < 2 || s.slice(g.start, g.end) !== 'e') return false;
  const rest = s.slice(g.end);
  return rest === '' || rest === 's' || rest === 'd';
}

/** Index in [e, b] where the syllable boundary falls inside the consonant run s[e..b) between two vowel groups. */
function boundaryInRun(s: string, e: number, b: number, nextGroup: string, nextEnd: number): number {
  if (b === e) return e;
  const run = s.slice(e, b);
  // maximal onset: a single consonant starts the next syllable ("loo|king", "ne|ver"); 'x' closes the previous one ("ex|ist")
  if (run.length === 1) return run === 'x' ? b : e;
  if (CODA_RUNS[run]) return b;
  for (let i = 0; i + 1 < run.length; i++) if (run[i] === run[i + 1]) return e + i + 1;
  if (ION_GROUPS[nextGroup] && 'tscgx'.includes(run[run.length - 1]!) && (nextEnd === s.length || 'ns'.includes(s[nextEnd]!))) return b - 1;
  let onset = 1;
  if (run.length >= 3 && ONSET_TRIPLES[run.slice(-3)]) onset = 3;
  else if (run.length >= 2 && ONSET_PAIRS[run.slice(-2)]) onset = 2;
  return e + (run.length - onset);
}

function fitGroupCount(s: string, groups: VowelGroup[], target: number, word: string): VowelGroup[] {
  const out = groups.map((g) => ({ ...g }));
  while (out.length > target) {
    const last = out[out.length - 1]!;
    if (isSilentTrailingE(s, last, out.length)) {
      out.pop();
      continue;
    }
    const lone = out.findIndex((g, i) => i > 0 && i < out.length - 1 && g.end - g.start === 1 && s[g.start] === 'e');
    if (lone === -1) throw new Error(`Cannot split "${word}" into ${target} syllables automatically (${out.length} vowel groups). Write it with explicit syllables, e.g. "ab|cd".`);
    out.splice(lone, 1);
  }
  while (out.length < target) {
    let best = -1;
    let bestScore = -1;
    out.forEach((g, i) => {
      if (g.end - g.start < 2) return;
      const hiatus = Object.keys(HIATUS_PAIRS).some((p) => s.slice(g.start, g.end).includes(p));
      const score = (hiatus ? 10 : 1) + g.end - g.start;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    if (best === -1) throw new Error(`Cannot split "${word}" into ${target} syllables automatically (${out.length} vowel groups). Write it with explicit syllables, e.g. "ab|cd".`);
    const g = out[best]!;
    const text = s.slice(g.start, g.end);
    const pair = Object.keys(HIATUS_PAIRS).find((p) => text.includes(p));
    const cut = g.start + (pair ? text.indexOf(pair) + 1 : 1);
    out.splice(best, 1, { start: g.start, end: cut }, { start: cut, end: g.end });
  }
  return out;
}

/** Splits an English word into `vowelPhones.length` syllables. `vowelPhones` are the dictionary vowel phones in order. */
export function syllabifyEnglish(word: string, vowelPhones: string[]): string[] {
  const match = /^([^A-Za-z']*)(.*?)([^A-Za-z']*)$/.exec(word)!;
  const lead = match[1]!;
  const core = match[2]!;
  const trail = match[3]!;
  const n = vowelPhones.length;
  if (n <= 1 || core.length === 0) return [word];
  const s = core.toLowerCase();
  const groups = fitGroupCount(s, vowelGroups(s), n, word);
  const cuts: number[] = [];
  for (let k = 0; k + 1 < groups.length; k++) {
    const g = groups[k]!;
    const next = groups[k + 1]!;
    cuts.push(boundaryInRun(s, g.end, next.start, s.slice(next.start, next.end), next.end));
  }
  const parts: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    parts.push(core.slice(from, cut));
    from = cut;
  }
  parts.push(core.slice(from));
  parts[0] = lead + parts[0];
  parts[parts.length - 1] = parts[parts.length - 1]! + trail;
  return parts;
}

/** Splits a romaji word into morae (strict). */
export function syllabifyJapanese(word: string): string[] {
  const match = /^([^A-Za-z']*)(.*?)([^A-Za-z']*)$/.exec(word)!;
  const morae = dictionaryG2P('ja').splitMoraeStrict(match[2]!);
  if (!morae) throw new Error(`Cannot split "${word}" into morae: some characters are not romaji morae of the dictionary. Write it with explicit syllables ("ko|yo|i") or fix the spelling.`);
  const parts = morae.map((m) => m.text);
  parts[0] = match[1]! + parts[0];
  parts[parts.length - 1] = parts[parts.length - 1]! + match[3]!;
  return parts;
}

/**
 * Resolves a word's syllables. `explicit` (written with `|`, or a JSON syllables array) wins; otherwise the dictionary pronunciation decides.
 * English syllable TEXTS may be respelled ("fay|ding") since only their letters' onset/coda classes are used; Japanese syllables must be single
 * morae whose phones add up to the word's pronunciation.
 * Throws for words that have neither explicit phones nor a dictionary entry.
 */
export function resolveSyllables(word: Pick<LyricWord, 'w' | 'phones'>, explicit: string[] | null, language: Language): string[] {
  const g2p = dictionaryG2P(language);
  const phones = word.phones ?? g2p.phonesForWord(word.w);
  if (!phones || phones.length === 0) {
    throw new Error(`No pronunciation for "${word.w}" (language ${language}): it is not in the dictionary. Give the word explicit phones in a JSON lyrics file, or respell it as a dictionary word.`);
  }
  if (explicit) {
    if (language === 'ja') {
      const asPhones = explicit.flatMap((syl) => {
        const morae = g2p.splitMoraeStrict(syl.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, ''));
        if (!morae || morae.length !== 1) throw new Error(`Syllable "${syl}" of "${word.w}" is not a single mora of the Japanese dictionary.`);
        return morae[0]!.phones;
      });
      if (asPhones.join(' ') !== phones.join(' ')) throw new Error(`Syllables ${JSON.stringify(explicit)} of "${word.w}" do not match its pronunciation (${phones.join(' ')}).`);
    }
    return explicit;
  }
  if (language === 'ja') return syllabifyJapanese(word.w);
  return syllabifyEnglish(word.w, phones.filter((p) => EN_VOWEL_PHONES[p]));
}
