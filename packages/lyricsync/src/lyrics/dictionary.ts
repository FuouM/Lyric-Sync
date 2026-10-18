// src/lyrics/dictionary.ts
// Pronunciation dictionaries bundled with the base forced-aligner model (CMUdict-derived for English, romaji morae for Japanese).

import { modelFile } from '../paths.ts';
import type { Language } from '../types.ts';
import { HubertG2P } from './g2p.ts';

const DICTIONARY_FILE: Record<Language, string> = {
  en: 'ds_cmudict-07b.txt',
  ja: 'japanese_dict_full.txt',
};

const cache: Partial<Record<Language, HubertG2P>> = {};

/** G2P over the base model's dictionary for `language` (loaded once per process). */
export function dictionaryG2P(language: Language): HubertG2P {
  let g2p = cache[language];
  if (!g2p) {
    g2p = new HubertG2P(language, modelFile('hubert-base', DICTIONARY_FILE[language]));
    cache[language] = g2p;
  }
  return g2p;
}

/**
 * Phones for a hand-added pronunciation. `input` is either dictionary words that sound like it ("fay ding" -> f ey d ih ng)
 * or the phones themselves ("f ey d ih ng"). Throws, naming the tokens it cannot use, when it is neither.
 */
export function pronounceAs(input: string, language: Language): string[] {
  const g2p = dictionaryG2P(language);
  const tokens = input.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) throw new Error('Type dictionary words that sound like it, or its phones.');
  const asWords = tokens.map((t) => g2p.phonesForWord(t));
  if (asWords.every((p) => p !== null)) return asWords.flatMap((p) => p ?? []);
  const inventory = g2p.phoneSet();
  const phones = tokens.map((t) => t.toLowerCase());
  if (phones.every((p) => inventory.has(p))) return phones;
  const bad = tokens.filter((t, i) => asWords[i] === null && !inventory.has(t.toLowerCase()));
  throw new Error(`Neither dictionary words nor phones: ${bad.map((b) => `"${b}"`).join(', ')}.`);
}

/** English vowel phones; one per sung syllable nucleus. */
export const EN_VOWEL_PHONES: Record<string, true> = {
  aa: true, ae: true, ah: true, ao: true, aw: true, ax: true, ay: true, eh: true,
  er: true, ey: true, ih: true, iy: true, ow: true, oy: true, uh: true, uw: true,
};
