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
  return normalizeBracedPhonesMapped(line).text;
}

/** normalizeBracedPhones, plus `at[i]`: the index in `line` of the normalized text's character `i`. */
export function normalizeBracedPhonesMapped(line: string): { text: string; at: number[] } {
  let result = '';
  const at: number[] = [];
  let i = 0;
  const n = line.length;
  const append = (from: number, to: number) => {
    result += line.slice(from, to);
    for (let k = from; k < to; k++) at.push(k);
  };
  while (i < n) {
    if (line[i] === '{') {
      const close = line.indexOf('}', i);
      if (close === -1) {
        append(i, n);
        break;
      }
      let endWs = result.length;
      while (endWs > 0 && /\s/.test(result[endWs - 1]!)) endWs--;
      if (endWs < result.length && endWs > 0 && result[endWs - 1] !== '{') {
        result = result.slice(0, endWs);
        at.length = endWs;
      }
      append(i, close + 1);
      i = close + 1;
      continue;
    }
    append(i, i + 1);
    i++;
  }
  return { text: result, at };
}
