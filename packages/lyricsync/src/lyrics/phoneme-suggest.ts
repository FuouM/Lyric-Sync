// packages/lyricsync/src/lyrics/phoneme-suggest.ts
// Automatic phoneme approximation and suggestion formatting for out-of-dictionary singing words.
import { dictionaryG2P, EN_VOWEL_PHONES } from "./dictionary.ts";
import { syllabifyEnglish } from "./syllabify.ts";

const RULES: Array<[RegExp, string]> = [
  [/^sh/, "sh"],
  [/^ch/, "ch"],
  [/^th/, "th"],
  [/^ph/, "f"],
  [/^wh/, "w"],
  [/^ck/, "k"],
  [/^ng/, "ng"],
  [/^oo/, "uw"],
  [/^ee/, "iy"],
  [/^ea/, "iy"],
  [/^ai/, "ey"],
  [/^ay/, "ey"],
  [/^oa/, "ow"],
  [/^ou/, "aw"],
  [/^ow/, "aw"],
  [/^oi/, "oy"],
  [/^oy/, "oy"],
  [/^ar/, "aa r"],
  [/^or/, "ao r"],
  [/^er/, "er"],
  [/^ir/, "er"],
  [/^ur/, "er"],
  [/^b/, "b"],
  [/^c(?=[eiy])/, "s"],
  [/^c/, "k"],
  [/^d/, "d"],
  [/^f/, "f"],
  [/^g(?=[eiy])/, "jh"],
  [/^g/, "g"],
  [/^h/, "hh"],
  [/^j/, "jh"],
  [/^k/, "k"],
  [/^l/, "l"],
  [/^m/, "m"],
  [/^n/, "n"],
  [/^p/, "p"],
  [/^qu/, "k w"],
  [/^r/, "r"],
  [/^s/, "s"],
  [/^t/, "t"],
  [/^v/, "v"],
  [/^w/, "w"],
  [/^x/, "k s"],
  [/^y(?=[aeiou])/, "y"],
  [/^y/, "iy"],
  [/^z/, "z"],
  [/^a(?=.*e$)/, "ey"],
  [/^a/, "ae"],
  [/^e(?=.*e$)/, "iy"],
  [/^e$/, ""],
  [/^e/, "eh"],
  [/^i(?=.*e$)/, "ay"],
  [/^i/, "ih"],
  [/^o(?=.*e$)/, "ow"],
  [/^o/, "aa"],
  [/^u(?=.*e$)/, "uw"],
  [/^u/, "ah"],
];

/** Approximates English phonemes using dictionary lookup, sub-word decomposition, and letter-to-sound rules. */
export function approximateEnglishPhonemes(rawWord: string): string[] | null {
  const g2p = dictionaryG2P("en");
  const dict = (g2p as unknown as { dictionary: Map<string, string[]> }).dictionary;
  const w = rawWord.toLowerCase().replace(/^[.,?!:;"'()[\]{}]+/, '').replace(/[.,?!:;"'()[\]{}]+$/, '');
  if (!w || !dict) return null;

  // 1. Direct dictionary match
  if (dict.has(w)) return dict.get(w)!;

  // 2. Parenthesized e.g. "p(doom)" -> "p" + "doom"
  if (w.includes("(") && w.includes(")")) {
    const parts = w.split(/[()]/).filter((p) => p.length > 0);
    const sub = parts.map(approximateEnglishPhonemes);
    if (sub.every((s): s is string[] => s !== null)) return sub.flat();
  }

  // 3. Hyphenated e.g. "post-chinchilla"
  if (w.includes("-")) {
    const parts = w.split("-").filter((p) => p.length > 0);
    const sub = parts.map(approximateEnglishPhonemes);
    if (sub.every((s): s is string[] => s !== null)) return sub.flat();
  }

  // 4. Possessive 's
  if (w.endsWith("'s")) {
    const root = approximateEnglishPhonemes(w.slice(0, -2));
    if (root) {
      const last = root[root.length - 1];
      const sPh = last && ["p", "t", "k", "f", "th"].includes(last) ? "s" : "z";
      return [...root, sPh];
    }
  }

  // 5. Suffix -ing
  if (w.endsWith("ing") && w.length > 4) {
    const base = w.slice(0, -3);
    const root = dict.get(base) ?? dict.get(`${base}e`);
    if (root) return [...root, "ih", "ng"];
  }

  // 6. Suffix -s
  if (w.endsWith("s") && w.length > 3) {
    const root = dict.get(w.slice(0, -1));
    if (root) {
      const last = root[root.length - 1];
      const sPh = last && ["p", "t", "k", "f", "th"].includes(last) ? "s" : "z";
      return [...root, sPh];
    }
  }

  // 7. Sub-word compound decomposition (e.g. paper + clips, kill + switch)
  for (let i = w.length - 3; i >= 3; i--) {
    const left = w.slice(0, i);
    const right = w.slice(i);
    const lp = dict.get(left);
    const rp = approximateEnglishPhonemes(right);
    if (lp && rp) return [...lp, ...rp];
  }

  // 8. Letter-to-sound rules fallback
  let rem = w;
  const phones: string[] = [];
  while (rem.length > 0) {
    let matched = false;
    for (const [re, ph] of RULES) {
      const m = re.exec(rem);
      if (m) {
        if (ph) phones.push(...ph.split(" "));
        rem = rem.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) rem = rem.slice(1);
  }

  return phones.length > 0 ? phones : null;
}

/** Formats a word with phonemes. Only adds syllable pipes in the phonemes part if the word itself has pipes. */
export function formatPhonemeSuggestion(word: string, phones: string[]): string {
  const hasPipes = word.includes("|");
  const cleanWord = word.replace(/\|/g, "");
  const vowels = phones.filter((p) => EN_VOWEL_PHONES[p]);

  // If the word has no pipes, do not put pipes in the phonemes part
  if (!hasPipes || vowels.length <= 1) {
    return `${cleanWord}{${phones.join(" ")}}`;
  }

  // Word has pipes: partition phonemes to match the syllables
  const syls = word.split("|");
  if (syls.length !== vowels.length) {
    return `${word}{${phones.join(" ")}}`;
  }
  // Partition phonemes across the syllables based on vowel nuclei
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let vowelCount = 0;

  for (let i = 0; i < phones.length; i++) {
    const p = phones[i]!;
    currentChunk.push(p);
    if (EN_VOWEL_PHONES[p]) {
      vowelCount++;
      if (vowelCount < vowels.length) {
        let j = i + 1;
        while (j < phones.length && !EN_VOWEL_PHONES[phones[j]!]) j++;
        const consonantCount = j - (i + 1);
        const advance = consonantCount > 1 ? Math.floor(consonantCount / 2) : 0;
        for (let k = 0; k < advance; k++) {
          i++;
          currentChunk.push(phones[i]!);
        }
        chunks.push(currentChunk.join(" "));
        currentChunk = [];
      }
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk.join(" "));

  if (chunks.length === syls.length) {
    return `${syls.join("|")}{${chunks.join(" | ")}}`;
  }
  return `${syls.join("|")}{${phones.join(" ")}}`;
}
