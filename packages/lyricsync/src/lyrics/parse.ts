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
import { dictionaryG2P, pronounceAs } from './dictionary.ts';
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

function tokenToRawWord(token: string, where: string, language?: Language): RawWord {
  let wordToken = token;
  let phones: string[] | undefined;

  // Direct phoneme syntax: word{p h o n e s} or syl|la|ble{ph1 | ph2}
  const braceMatch = /^([^{]+)\{([^}]+)\}$/.exec(token);
  if (braceMatch) {
    wordToken = braceMatch[1]!;
    const pronInput = braceMatch[2]!.trim();
    if (pronInput.length > 0 && language) {
      if (pronInput.includes('|')) {
        const phoneChunks = pronInput.split('|').map((c) => c.trim());
        const sylParts = wordToken.split('|');
        if (sylParts.length !== phoneChunks.length) {
          throw new Error(
            `${where} ("${token}"): syllable count (${sylParts.length}) in "${wordToken}" does not match phoneme chunks (${phoneChunks.length}) in "{${pronInput}}".`
          );
        }
        try {
          phones = phoneChunks.flatMap((chunk, idx) => {
            if (chunk.length === 0) throw new Error(`empty phoneme chunk at index ${idx + 1}`);
            return pronounceAs(chunk, language);
          });
        } catch (e: unknown) {
          throw new Error(`${where} ("${token}"): ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        try {
          phones = pronounceAs(pronInput, language);
        } catch (e: unknown) {
          throw new Error(`${where} ("${token}"): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  if (!/[A-Za-z]/.test(wordToken)) throw new Error(`${where}: token "${wordToken}" has no letters.`);
  if (!wordToken.includes('|')) return { w: wordToken, explicit: null, phones };
  const parts = wordToken.split('|');
  if (parts.some((p) => p.length === 0)) throw new Error(`${where}: token "${wordToken}" has an empty syllable.`);
  return { w: parts.join(''), explicit: parts, phones };
}

/** A `[Section]` header and how many lyric lines follow it before the next header (0 for an instrumental section). */
export interface SectionOutline {
  name: string;
  lines: number;
}

function parseTextLines(text: string, language?: Language): { lines: RawLine[]; outline: SectionOutline[]; pronunciations: Pronunciations } {
  const lines: RawLine[] = [];
  const outline: SectionOutline[] = [];
  const pronunciations: Pronunciations = {};

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line.length === 0) return;

    // Direct pronunciation directive: @pron word = p h o n e s   or   # @pron word = sounds like
    const pronMatch = /^#?\s*@pron\s+([^\s=]+)\s*=\s*(.+)$/i.exec(line);
    if (pronMatch) {
      if (language) {
        const key = pronunciationKey(pronMatch[1]!);
        try {
          pronunciations[key] = pronounceAs(pronMatch[2]!.trim(), language);
        } catch (e: unknown) {
          throw new Error(`line ${i + 1} (@pron ${pronMatch[1]}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }

    if (line.startsWith('#')) return;

    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      outline.push({ name: header[1]!.trim(), lines: 0 });
      return;
    }

    // Normalize optional space between word and {phones}: "foom {f uw m}" -> "foom{f uw m}"
    const normalizedLine = line.replace(/(\S+)\s+\{([^}]+)\}/g, '$1{$2}');
    const tokens = normalizedLine.match(/(?:[^\s{]|\{[^}]*\})+/g) ?? [];
    const words = tokens.map((tok) => tokenToRawWord(tok, `line ${i + 1}`, language));
    const section = outline.at(-1);
    if (section) section.lines++;
    lines.push({ section: section?.name, words });
  });
  return { lines, outline, pronunciations };
}

/** Every `[Section]` header of a lyrics text in order, empty (instrumental) ones included. */
export function lyricsSectionOutline(text: string): SectionOutline[] {
  const outline: SectionOutline[] = [];
  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || /^#?\s*@pron\b/i.test(line)) return;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      outline.push({ name: header[1]!.trim(), lines: 0 });
      return;
    }
    const section = outline.at(-1);
    if (section) section.lines++;
  });
  return outline;
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
  const parsed = parseTextLines(text, language);
  const combined = { ...parsed.pronunciations, ...pronunciations };
  return build(withPronunciations(parsed.lines, combined), language);
}

/** Every word problem of a lyrics text at once (parseLyricsText stops at the first). Line-level syntax errors still throw. */
export function lintLyricsText(text: string, language: Language, pronunciations: Pronunciations = {}): LyricsIssue[] {
  const issues: LyricsIssue[] = [];
  const parsed = parseTextLines(text, language);
  const combined = { ...parsed.pronunciations, ...pronunciations };
  withPronunciations(parsed.lines, combined).forEach((rl, line) => {
    for (const rw of rl.words) {
      try {
        resolveSyllables({ w: rw.w, phones: rw.phones }, rw.explicit, language);
      } catch (e: unknown) {
        const unknown = !rw.phones && dictionaryG2P(language).phonesForWord(rw.w) === null;
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
