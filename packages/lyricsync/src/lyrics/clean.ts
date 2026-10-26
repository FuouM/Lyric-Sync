// packages/lyricsync/src/lyrics/clean.ts
// String cleaning helpers for lyrics parsing and G2P dictionary lookup.
// Linear-time scanning without regular expression backtracking to prevent ReDoS.

const PUNCT_CHARS: Record<string, true> = {
  '.': true,
  ',': true,
  '?': true,
  '!': true,
  ':': true,
  ';': true,
  '"': true,
  "'": true,
  '(': true,
  ')': true,
  '[': true,
  ']': true,
  '{': true,
  '}': true,
};

/**
 * Trims surrounding punctuation (.,?!:;"'()[]{}) from both ends of a string.
 * Guaranteed linear time O(N) with zero regular expressions.
 */
export function stripPunctuation(str: string): string {
  let start = 0;
  let end = str.length;
  while (start < end && PUNCT_CHARS[str[start]!]) {
    start++;
  }
  while (end > start && PUNCT_CHARS[str[end - 1]!]) {
    end--;
  }
  return start === 0 && end === str.length ? str : str.slice(start, end);
}

/**
 * Normalizes optional whitespace between a word and an inline phone annotation:
 * "foom {f uw m}" -> "foom{f uw m}"
 * Guaranteed linear time O(N) with zero regular expressions.
 */
export function normalizeBracedPhones(line: string): string {
  let result = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line[i] === '{') {
      const close = line.indexOf('}', i);
      if (close === -1) {
        result += line.slice(i);
        break;
      }
      let endWs = result.length;
      while (endWs > 0 && /\s/.test(result[endWs - 1]!)) endWs--;
      if (endWs < result.length && endWs > 0 && result[endWs - 1] !== '{') {
        result = result.slice(0, endWs) + line.slice(i, close + 1);
      } else {
        result += line.slice(i, close + 1);
      }
      i = close + 1;
      continue;
    }
    result += line[i++];
  }
  return result;
}
