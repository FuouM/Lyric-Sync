// src/lyrics/repeats.ts
// The lyrics editor's in-memory word dictionary: a word that is marked with `|` (or, in Japanese, `+`) somewhere in the text
// is entered with that markup, and every unmarked copy of the word is offered the same markup. The dictionary is rebuilt from
// the current text on every call, so it can never be out of date: edit the marked copy and the suggestion changes with it.
// Nothing is stored and nothing is applied here; the editor applies a suggestion when the user accepts it.

import type { Language } from '../types.ts';
import type { AutoSplitNote } from './parse.ts';

/** An unmarked copy of a word that has markup elsewhere. */
export interface RepeatTarget {
  /** 0-based lyric line (headers, comments, blank lines and @pron lines are not counted, as in the lyrics parser). */
  line: number;
  /** Offset of the token's first character in the text. */
  tokenFrom: number;
  /** The word's letters in the text (punctuation at the edges excluded). */
  from: number;
  to: number;
}

export interface RepeatSuggestion {
  /** The word's letters, lowercase. */
  word: string;
  /** The markup as written, lowercase ("ko+n|ni|chi|wa"). */
  pattern: string;
  targets: RepeatTarget[];
}

/** `pattern`'s separators put between the letters of `letters` (same word, other case): ("ko+n|ni", "KonNi") -> "Ko+n|Ni". */
export function applyPattern(pattern: string, letters: string): string {
  let out = '';
  let i = 0;
  for (const ch of pattern) out += ch === '|' || ch === '+' ? ch : (letters[i++] ?? '');
  return out;
}

/**
 * Words with one consistent markup in the text and unmarked copies elsewhere. A word marked two different ways has no
 * suggestion (the user wrote both on purpose). Copies the automatic split already gives the same syllables are left out:
 * accepting would change nothing. `autoSplit` is the parser's list of auto-split words (ParsedLyrics.autoSplit).
 */
export function findRepeatSuggestions(text: string, language: Language, autoSplit: readonly AutoSplitNote[] = []): RepeatSuggestion[] {
  const coreShape = language === 'ja' ? /^[A-Za-z'|+]+$/ : /^[A-Za-z'|]+$/;
  const separator = language === 'ja' ? /[|+]/ : /\|/;
  const patterns = new Map<string, Set<string>>();
  const copies = new Map<string, RepeatTarget[]>();
  const order: string[] = [];

  let lyricLine = -1;
  let lineFrom = 0;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    const isLyric = trimmed !== '' && !trimmed.startsWith('#') && !/^\[.+\]$/.test(trimmed) && !/^#?\s*@pron\b/i.test(trimmed);
    if (isLyric) {
      lyricLine++;
      for (const m of raw.matchAll(/(?:[^\s{]|\{[^}]*\})+/g)) {
        const token = m[0];
        if (token.includes('{')) continue;
        const first = token.search(/[A-Za-z']/);
        if (first === -1) continue;
        let last = token.length - 1;
        while (!/[A-Za-z']/.test(token[last]!)) last--;
        const core = token.slice(first, last + 1);
        if (!coreShape.test(core) || /[|+]{2}/.test(core)) continue;
        const word = core.replace(/[|+]/g, '').toLowerCase();
        if (!patterns.has(word)) {
          patterns.set(word, new Set());
          copies.set(word, []);
          order.push(word);
        }
        if (separator.test(core)) patterns.get(word)!.add(core.toLowerCase());
        else {
          const from = lineFrom + m.index + first;
          copies.get(word)!.push({ line: lyricLine, tokenFrom: lineFrom + m.index, from, to: from + core.length });
        }
      }
    }
    lineFrom += raw.length + 1;
  }

  const out: RepeatSuggestion[] = [];
  for (const word of order) {
    const marked = patterns.get(word)!;
    if (marked.size !== 1) continue;
    const pattern = [...marked][0]!;
    const targets = copies.get(word)!.filter((t) => !isAutoSplitAs(autoSplit, t.line, word, pattern));
    if (targets.length > 0) out.push({ word, pattern, targets });
  }
  return out;
}

/** True when the parser already splits `word` on `line` into exactly the syllables of `pattern` (which has no join). */
function isAutoSplitAs(autoSplit: readonly AutoSplitNote[], line: number, word: string, pattern: string): boolean {
  if (pattern.includes('+')) return false;
  return autoSplit.some(
    (n) =>
      n.line === line &&
      n.word.replace(/[^A-Za-z']/g, '').toLowerCase() === word &&
      n.syllables.map((s) => s.replace(/[^A-Za-z']/g, '').toLowerCase()).join('|') === pattern
  );
}
