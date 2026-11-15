// src/lyrics/scan.ts
// The one reading of a plain-text lyrics file's lines and word tokens, with their offsets in the text. The parser, the live
// lyrics check and the web editor all read the text through this, so they agree on which lines are sung and where each word
// is. No node imports: the browser loads this module.

import { normalizeBracedPhonesMapped } from './clean.ts';

export interface LyricToken {
  /** The token as the parser reads it: whitespace before an inline `{phones}` removed ("foom {f uw m}" -> "foom{f uw m}"). */
  text: string;
  /** The written word, `|`/`+` included, without its `{phones}`. */
  word: string;
  /** What is inside the `{...}` after the word, or null when there is none. */
  phones: string | null;
  /** Offset in the text of the token's first character; the word is `from` to `from + word.length`. */
  from: number;
  /** Offset in the text just past the token's last character. */
  to: number;
  /** Offset in the text of the `{` of the phones, or -1 when there are none. */
  phonesFrom: number;
}

interface LineSpan {
  /** 0-based line of the text. */
  lineNo: number;
  /** Offsets of the line in the text, line break excluded. */
  from: number;
  to: number;
}

export type ScannedLine = LineSpan &
  (
    | { kind: 'blank' | 'comment' }
    /** `@pron word = sounds like` (or `# @pron ...`): a hand-added pronunciation. */
    | { kind: 'pron'; word: string; value: string }
    | { kind: 'section'; name: string }
    /** A sung line. `index` counts sung lines only (0-based), as every lyric line number in the app does. */
    | { kind: 'lyric'; index: number; section?: string; tokens: LyricToken[] }
  );

const TOKEN_RE = /(?:[^\s{]|\{[^}]*\})+/g;
const BRACED_RE = /^([^{]+)\{([^}]*)\}$/;

/** Splits `word{phones}` into its parts; a token without a trailing `{...}` is all word. */
export function splitBracedToken(token: string): { word: string; phones: string | null } {
  const m = BRACED_RE.exec(token);
  return m ? { word: m[1]!, phones: m[2]! } : { word: token, phones: null };
}

function pronDirective(line: string): { word: string; value: string } | null {
  if (!/^#?\s*@pron\b/i.test(line)) return null;
  const eq = line.indexOf('=');
  if (eq === -1) return null;
  const word = line.slice(0, eq).replace(/^#?\s*@pron\s+/i, '').trim();
  if (!word || /\s/.test(word)) return null;
  return { word, value: line.slice(eq + 1).trim() };
}

function scanTokens(raw: string, lineFrom: number): LyricToken[] {
  const { text, at } = normalizeBracedPhonesMapped(raw);
  const tokens: LyricToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const { word, phones } = splitBracedToken(m[0]);
    tokens.push({
      text: m[0],
      word,
      phones,
      from: lineFrom + at[m.index]!,
      to: lineFrom + at[m.index + m[0].length - 1]! + 1,
      phonesFrom: phones === null ? -1 : lineFrom + at[m.index + word.length]!,
    });
  }
  return tokens;
}

/** Every line of a lyrics text (`\n` or `\r\n` breaks), classified, with the word tokens of the sung lines. */
export function scanLyricsText(text: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  let from = 0;
  let index = 0;
  let section: string | undefined;
  text.split('\n').forEach((raw, lineNo) => {
    const span = { lineNo, from, to: from + raw.length - (raw.endsWith('\r') ? 1 : 0) };
    const line = raw.trim();
    const pron = pronDirective(line);
    const header = /^\[(.+)\]$/.exec(line);
    if (line.length === 0) out.push({ ...span, kind: 'blank' });
    else if (pron) out.push({ ...span, kind: 'pron', ...pron });
    else if (line.startsWith('#')) out.push({ ...span, kind: 'comment' });
    else if (header) {
      section = header[1]!.trim();
      out.push({ ...span, kind: 'section', name: section });
    } else out.push({ ...span, kind: 'lyric', index: index++, ...(section !== undefined ? { section } : {}), tokens: scanTokens(raw, from) });
    from += raw.length + 1;
  });
  return out;
}

/** The sung lines of a lyrics text, in order (`lines[i].index === i`). */
export function scanLyricLines(text: string): Array<Extract<ScannedLine, { kind: 'lyric' }>> {
  return scanLyricsText(text).filter((l): l is Extract<ScannedLine, { kind: 'lyric' }> => l.kind === 'lyric');
}
