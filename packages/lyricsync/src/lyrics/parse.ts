// src/lyrics/parse.ts
// Lyrics input -> LyricsDefinition.
//
// Plain text (.txt):
//   [Verse 1]                 section header (optional; applies to the lines below)
//   # comment                 ignored, as are blank lines
//   one lyric line per line   words separated by spaces; "re|con|cil|i|a|tion" gives explicit syllables;
//                             "(i)" marks a backing-vocal word (kept in the text, ignored by the dictionary)
// JSON (.json):
//   { "language": "en", "lines": [ "plain text line", { "section": "chorus", "text": "optional", "words": [ "free", { "w": "any", "syllables": ["an","y"], "phones": ["eh","n","iy"] } ] } ] }
//   Use JSON for explicit pronunciations (`phones`) of words the dictionary lacks; the text parser takes them as a separate
//   `pronunciations` map (pronunciationKey(word) -> phones).
// Every sung line of the song must be present, in order: the forced aligner consumes the lyrics as one continuous text.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRecord, isStringArray } from '../guards.ts';
import type { Language, LyricLine, LyricsDefinition, LyricWord } from '../types.ts';
import { dictionaryG2P } from './dictionary.ts';
import { resolveSyllables } from './syllabify.ts';

/** Hand-added pronunciations, keyed by pronunciationKey(word). */
export type Pronunciations = Record<string, string[]>;

/** The key a word's pronunciation is stored under: lowercase, surrounding punctuation trimmed (as the dictionary lookup does). */
export function pronunciationKey(word: string): string {
  return word.toLowerCase().replace(/^[.,?!:;"'()\[\]{}]+|[.,?!:;"'()\[\]{}]+$/g, '');
}

export interface LyricsIssue {
  /** 0-based lyric line index (headers, comments and blank lines are not counted). */
  line: number;
  word: string;
  message: string;
  /** True when the word has no pronunciation (neither dictionary nor `pronunciations`); add one to fix it. */
  unknown: boolean;
}

export interface AutoSplitNote {
  line: number;
  word: string;
  syllables: string[];
}

export interface ParsedLyrics {
  definition: LyricsDefinition;
  /** Multi-syllable words whose syllables were derived (not written explicitly); review these. */
  autoSplit: AutoSplitNote[];
}

interface RawWord {
  w: string;
  explicit: string[] | null;
  phones?: string[];
}

interface RawLine {
  section?: string;
  text?: string;
  words: RawWord[];
}

function tokenToRawWord(token: string, where: string): RawWord {
  if (!/[A-Za-z]/.test(token)) throw new Error(`${where}: token "${token}" has no letters.`);
  if (!token.includes('|')) return { w: token, explicit: null };
  const parts = token.split('|');
  if (parts.some((p) => p.length === 0)) throw new Error(`${where}: token "${token}" has an empty syllable.`);
  return { w: parts.join(''), explicit: parts };
}

/** A `[Section]` header and how many lyric lines follow it before the next header (0 for an instrumental section). */
export interface SectionOutline {
  name: string;
  lines: number;
}

function parseTextLines(text: string): { lines: RawLine[]; outline: SectionOutline[] } {
  const lines: RawLine[] = [];
  const outline: SectionOutline[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) return;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      outline.push({ name: header[1]!.trim(), lines: 0 });
      return;
    }
    const words = line.split(/\s+/).map((tok) => tokenToRawWord(tok, `line ${i + 1}`));
    const section = outline.at(-1);
    if (section) section.lines++;
    lines.push({ section: section?.name, words });
  });
  return { lines, outline };
}

/** Every `[Section]` header of a lyrics text in order, empty (instrumental) ones included. */
export function lyricsSectionOutline(text: string): SectionOutline[] {
  return parseTextLines(text).outline;
}

function parseJsonLines(raw: unknown): { language: Language | null; lines: RawLine[] } {
  if (!isRecord(raw) || !Array.isArray(raw.lines)) throw new Error('Lyrics JSON must be an object with a "lines" array.');
  let language: Language | null = null;
  if (raw.language !== undefined) {
    if (raw.language !== 'en' && raw.language !== 'ja') throw new Error(`Lyrics JSON language must be "en" or "ja", got ${JSON.stringify(raw.language)}.`);
    language = raw.language;
  }
  const lines = raw.lines.map((entry: unknown, i: number): RawLine => {
    const where = `lines[${i}]`;
    if (typeof entry === 'string') {
      const words = entry.trim().split(/\s+/).filter((t) => t.length > 0).map((tok) => tokenToRawWord(tok, where));
      return { words };
    }
    if (!isRecord(entry) || !Array.isArray(entry.words)) throw new Error(`${where} must be a string or an object with a "words" array.`);
    const words = entry.words.map((w: unknown, wi: number): RawWord => {
      const wh = `${where}.words[${wi}]`;
      if (typeof w === 'string') return tokenToRawWord(w, wh);
      if (!isRecord(w) || typeof w.w !== 'string') throw new Error(`${wh} must be a string or an object with a string "w".`);
      const explicit = w.syllables === undefined ? null : isStringArray(w.syllables) ? w.syllables : null;
      if (w.syllables !== undefined && explicit === null) throw new Error(`${wh}.syllables must be an array of strings.`);
      if (w.phones !== undefined && !isStringArray(w.phones)) throw new Error(`${wh}.phones must be an array of strings.`);
      return { w: w.w, explicit, phones: w.phones };
    });
    return {
      section: typeof entry.section === 'string' ? entry.section : undefined,
      text: typeof entry.text === 'string' ? entry.text : undefined,
      words,
    };
  });
  return { language, lines };
}

function build(rawLines: RawLine[], language: Language): ParsedLyrics {
  if (rawLines.length === 0) throw new Error('The lyrics contain no lines.');
  const autoSplit: AutoSplitNote[] = [];
  const lines: LyricLine[] = rawLines.map((rl, index) => {
    if (rl.words.length === 0) throw new Error(`Lyric line ${index} has no words.`);
    const words: LyricWord[] = rl.words.map((rw) => {
      const syllables = resolveSyllables({ w: rw.w, phones: rw.phones }, rw.explicit, language);
      if (rw.explicit === null && syllables.length > 1) autoSplit.push({ line: index, word: rw.w, syllables });
      const word: LyricWord = { w: rw.w, syllables };
      if (rw.phones) word.phones = rw.phones;
      return word;
    });
    const line: LyricLine = { index, text: rl.text ?? words.map((w) => w.w).join(' '), words };
    if (rl.section) line.section = rl.section;
    return line;
  });
  return { definition: { language, lines }, autoSplit };
}

function withPronunciations(lines: RawLine[], pronunciations: Pronunciations): RawLine[] {
  for (const l of lines) {
    for (const w of l.words) {
      const phones = pronunciations[pronunciationKey(w.w)];
      if (phones && !w.phones) w.phones = phones;
    }
  }
  return lines;
}

export function parseLyricsText(text: string, language: Language, pronunciations: Pronunciations = {}): ParsedLyrics {
  return build(withPronunciations(parseTextLines(text).lines, pronunciations), language);
}

/** Every word problem of a lyrics text at once (parseLyricsText stops at the first). Line-level syntax errors still throw. */
export function lintLyricsText(text: string, language: Language, pronunciations: Pronunciations = {}): LyricsIssue[] {
  const g2p = dictionaryG2P(language);
  const issues: LyricsIssue[] = [];
  withPronunciations(parseTextLines(text).lines, pronunciations).forEach((rl, line) => {
    for (const rw of rl.words) {
      try {
        resolveSyllables({ w: rw.w, phones: rw.phones }, rw.explicit, language);
      } catch (e: unknown) {
        const unknown = !rw.phones && g2p.phonesForWord(rw.w) === null;
        issues.push({ line, word: rw.w, message: e instanceof Error ? e.message : String(e), unknown });
      }
    }
  });
  return issues;
}

export function parseLyricsJson(raw: unknown, language: Language): ParsedLyrics {
  const parsed = parseJsonLines(raw);
  if (parsed.language !== null && parsed.language !== language) {
    throw new Error(`Lyrics JSON declares language "${parsed.language}" but the workspace language is "${language}".`);
  }
  return build(parsed.lines, language);
}

/** Reads a .txt or .json lyrics file. */
export function readLyricsFile(file: string, language: Language): ParsedLyrics {
  if (!fs.existsSync(file)) throw new Error(`Lyrics file not found: ${file}`);
  const content = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return parseLyricsJson(JSON.parse(content) as unknown, language);
  if (ext === '.txt') return parseLyricsText(content, language);
  throw new Error(`Unsupported lyrics file type "${ext}" (expected .txt or .json): ${file}`);
}

/** Validates a definition read back from disk (lyrics.def.json, possibly hand-edited) and returns it typed. Pronunciations were resolved when it was first parsed. */
export function parseStoredDefinition(raw: unknown): LyricsDefinition {
  if (!isRecord(raw) || (raw.language !== 'en' && raw.language !== 'ja') || !Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new Error('Malformed lyrics definition: expected {"language":"en"|"ja","lines":[...]} with at least one line.');
  }
  const language = raw.language;
  const lines = raw.lines.map((l: unknown, i: number): LyricLine => {
    if (!isRecord(l) || typeof l.text !== 'string' || !Array.isArray(l.words) || l.words.length === 0) throw new Error(`Lyrics definition line ${i} is malformed (needs text and words).`);
    if (l.index !== i) throw new Error(`Lyrics definition line ${i} has index ${String(l.index)}.`);
    const words = l.words.map((w: unknown, wi: number): LyricWord => {
      if (!isRecord(w) || typeof w.w !== 'string' || !isStringArray(w.syllables) || w.syllables.length === 0) {
        throw new Error(`Lyrics definition line ${i} word ${wi} is malformed (needs w and a non-empty syllables array).`);
      }
      if (w.phones !== undefined && !isStringArray(w.phones)) throw new Error(`Lyrics definition line ${i} word ${wi}: phones must be an array of strings.`);
      const word: LyricWord = { w: w.w, syllables: w.syllables };
      if (w.phones) word.phones = w.phones;
      return word;
    });
    const line: LyricLine = { index: i, text: l.text, words };
    if (typeof l.section === 'string') line.section = l.section;
    return line;
  });
  return { language, lines };
}
