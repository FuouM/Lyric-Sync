// src/lyrics/g2p.ts
// Grapheme-to-Phoneme (G2P) dictionary lookup for HuBERT forced alignment.

import * as fs from 'node:fs';

export interface G2PResult {
  phSeq: string[];
  wordSeq: string[];
  phIdxToWordIdx: number[];
}

export class HubertG2P {
  private dictionary: Map<string, string[]> = new Map();
  private language: string | null = 'en';
  /** Keep dictionary phone case (e.g. Japanese moraic 'N' vs 'n'); HuBERT-FA vocabularies expect lowercase. */
  private preservePhoneCase: boolean;
  private prefixLanguage: boolean;

  constructor(language: string | null = 'en', dictPath?: string, options: { preservePhoneCase?: boolean; prefixLanguage?: boolean } = {}) {
    this.language = language ?? 'en';
    this.preservePhoneCase = options.preservePhoneCase ?? false;
    this.prefixLanguage = options.prefixLanguage ?? (language !== null && options.prefixLanguage !== false);
    if (dictPath) {
      this.loadDictionary(dictPath);
    }
  }

  public loadDictionary(dictPath: string): void {
    if (!fs.existsSync(dictPath)) {
      throw new Error(`HuBERT G2P dictionary not found at: ${dictPath}`);
    }
    const content = fs.readFileSync(dictPath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      const tabIdx = line.indexOf('\t');
      if (tabIdx === -1) continue;
      const word = line.substring(0, tabIdx).trim().toLowerCase();
      const phStr = line.substring(tabIdx + 1).trim();
      const phones = phStr.split(/\s+/).map(p => (this.preservePhoneCase ? p : p.toLowerCase()));
      if (!this.dictionary.has(word)) {
        this.dictionary.set(word, phones);
      }
    }
  }

  /** Every phone that occurs in the dictionary: the phones a hand-written pronunciation may use. */
  public phoneSet(): Set<string> {
    this.phones ??= new Set([...this.dictionary.values()].flat());
    return this.phones;
  }
  private phones: Set<string> | null = null;

  public hasWord(word: string): boolean {
    const w = word.toLowerCase();
    if (this.dictionary.has(w)) return true;
    if (this.language === 'ja') {
      const decomposed = this.decomposeJapanese(w);
      return decomposed !== null && decomposed.length > 0;
    }
    return false;
  }

  public getPhones(word: string): string[] | undefined {
    const w = word.toLowerCase();
    const direct = this.dictionary.get(w);
    if (direct) return direct;
    if (this.language === 'ja') {
      const decomposed = this.decomposeJapanese(w);
      return decomposed ?? undefined;
    }
    return undefined;
  }

  /**
   * Decomposes compound Japanese romaji words into constituent morae using
   * greedy longest-match lookup against the Japanese dictionary.
   */
  public decomposeJapanese(word: string): string[] | null {
    let rem = word.toLowerCase();
    const phones: string[] = [];

    while (rem.length > 0) {
      // Check for geminate consonant closure ('cl' for double letters like 'tt', 'kk', 'pp', 'ss')
      if (rem.length >= 2 && rem[0] === rem[1] && !'aeiou'.includes(rem[0]!)) {
        phones.push('cl');
        rem = rem.substring(1);
        continue;
      }

      let matched = false;
      for (let len = Math.min(rem.length, 4); len >= 1; len--) {
        const sub = rem.substring(0, len);
        if (this.dictionary.has(sub)) {
          phones.push(...this.dictionary.get(sub)!);
          rem = rem.substring(len);
          matched = true;
          break;
        }
      }
      if (!matched) {
        rem = rem.substring(1);
      }
    }

    return phones.length > 0 ? phones : null;
  }

  /**
   * Converts input text into phoneme sequence, word sequence, and mapping.
   * Matches Reference/HubertFA/tools/g2p.py DictionaryG2P.
   */
  public g2p(inputText: string): G2PResult {
    const rawWords = inputText.trim().split(/\s+/).filter((w) => w.length > 0);
    const wordSeq: string[] = [];
    let wordSeqIdx = 0;
    const phSeq: string[] = ['SP'];
    const phIdxToWordIdx: number[] = [-1];

    for (let wi = 0; wi < rawWords.length; wi++) {
      let word = rawWords[wi]!.toLowerCase();
      // Basic punctuation trimming if direct lookup fails
      if (!this.dictionary.has(word)) {
        const cleaned = word.replace(/^[.,?!:;"'()[\]{}]+/, '').replace(/[.,?!:;"'()[\]{}]+$/, '');
        if (this.dictionary.has(cleaned)) {
          word = cleaned;
        }
      }

      let phones = this.dictionary.get(word);

      // Japanese compound word mora decomposition
      if (!phones && this.language === 'ja') {
        const decomposed = this.decomposeJapanese(word);
        if (decomposed && decomposed.length > 0) {
          phones = decomposed;
        }
      }

      if (!phones || phones.length === 0) {
        continue;
      }

      wordSeq.push(rawWords[wi]!);
      for (let i = 0; i < phones.length; i++) {
        const ph = phones[i]!;
        if ((i === 0 || i === phones.length - 1) && (ph === 'sp' || ph === 'SP')) {
          continue;
        }
        phSeq.push(ph);
        phIdxToWordIdx.push(wordSeqIdx);
      }

      if (phSeq[phSeq.length - 1] !== 'SP') {
        phSeq.push('SP');
        phIdxToWordIdx.push(-1);
      }
      wordSeqIdx++;
    }

    // Apply language prefix if enabled (e.g. 'en/ax', 'ja/k', 'ja/a')
    // Special phonemes like 'SP', 'AP', 'cl' are preserved without prefix
    const finalPhSeq = phSeq.map((ph) => {
      if (this.language !== null && ph !== 'SP' && ph !== 'cl' && ph !== 'CL' && ph !== 'AP' && !ph.includes('/')) {
        return `${this.language}/${ph}`;
      }
      return ph;
    });

    return {
      phSeq: finalPhSeq,
      wordSeq,
      phIdxToWordIdx,
    };
  }

  /**
   * Strict greedy longest-match split of a romaji word into morae with their phones.
   * Returns null when any character is not covered by the dictionary (the research `decomposeJapanese` silently skips such characters).
   * A doubled consonant yields a 'cl' (closure) mora whose text is the consonant, as in the research decomposition.
   */
  public splitMoraeStrict(word: string): Array<{ text: string; phones: string[] }> | null {
    let rem = word.toLowerCase();
    const out: Array<{ text: string; phones: string[] }> = [];
    while (rem.length > 0) {
      if (rem.length >= 2 && rem[0] === rem[1] && !'aeiou'.includes(rem[0]!)) {
        out.push({ text: rem[0]!, phones: ['cl'] });
        rem = rem.substring(1);
        continue;
      }
      let matched = false;
      for (let len = Math.min(rem.length, 4); len >= 1; len--) {
        const sub = rem.substring(0, len);
        const phones = this.dictionary.get(sub);
        if (phones) {
          out.push({ text: sub, phones });
          rem = rem.substring(len);
          matched = true;
          break;
        }
      }
      if (!matched) return null;
    }
    return out.length > 0 ? out : null;
  }

  /**
   * Structural decomposition for English words:
   * 1. Smart quotes / curly apostrophes normalization.
   * 2. Hyphenated compound words ("super-dense", "pre-training").
   * 3. Possessive 's ("word's" -> word + s).
   * 4. All-caps initialisms ("AGI", "GPU", "NVDA", "MLP").
   * 5. Inflection suffixes (-ing, -ed, -s) when root is in dictionary.
   * 6. Compound words (e.g. paper + clips, kill + switch) when both halves are in dictionary.
   */
  public approximateEnglish(cleaned: string, raw: string): string[] | null {
    if (cleaned.includes("(") && cleaned.includes(")")) {
      const parts = cleaned.split(/[()]/).filter((p) => p.length > 0);
      const sub = parts.map((p) => this.phonesForWord(p));
      if (sub.every((s): s is string[] => s !== null)) return sub.flat();
    }

    if (cleaned.includes("-")) {
      const parts = cleaned.split("-").filter((p) => p.length > 0);
      const sub = parts.map((p) => this.phonesForWord(p));
      if (sub.every((s): s is string[] => s !== null)) return sub.flat();
    }

    if (cleaned.endsWith("'s")) {
      const base = cleaned.slice(0, -2);
      const basePhones = this.phonesForWord(base);
      if (basePhones) {
        const last = basePhones[basePhones.length - 1];
        const sPh = last && ["p", "t", "k", "f", "th"].includes(last) ? "s" : "z";
        return [...basePhones, sPh];
      }
    }

    const isUpper = /^[A-Z0-9]+$/.test(raw.replace(/^[.,?!:;"'()[\]{}]+/, '').replace(/[.,?!:;"'()[\]{}]+$/, ''));
    if (isUpper && cleaned.length >= 2 && cleaned.length <= 6) {
      const letters = cleaned.split("");
      const letterPhones: string[] = [];
      let allOk = true;
      for (const ch of letters) {
        const lp = this.dictionary.get(ch);
        if (lp) letterPhones.push(...lp);
        else { allOk = false; break; }
      }
      if (allOk && letterPhones.length > 0) return letterPhones;
    }

    if (cleaned.endsWith("ing") && cleaned.length > 4) {
      const base = cleaned.slice(0, -3);
      const withE = `${base}e`;
      const rootPhones = this.dictionary.get(base) ?? this.dictionary.get(withE);
      if (rootPhones) return [...rootPhones, "ih", "ng"];
    }

    if (cleaned.endsWith("ed") && cleaned.length > 4) {
      const base = cleaned.slice(0, -2);
      const withE = cleaned.slice(0, -1);
      const rootPhones = this.dictionary.get(base) ?? this.dictionary.get(withE);
      if (rootPhones) return [...rootPhones, "d"];
    }

    if (cleaned.endsWith("ity") && cleaned.length > 5) {
      const base = cleaned.slice(0, -3);
      const rootPhones = this.dictionary.get(base);
      if (rootPhones) return [...rootPhones, "ih", "t", "iy"];
    }

    if (cleaned.endsWith("s") && cleaned.length > 3) {
      const base = cleaned.slice(0, -1);
      const rootPhones = this.dictionary.get(base);
      if (rootPhones) return [...rootPhones, "z"];
    }

    for (let i = 3; i <= cleaned.length - 3; i++) {
      const left = cleaned.slice(0, i);
      const right = cleaned.slice(i);
      const lp = this.dictionary.get(left);
      const rp = this.dictionary.get(right);
      if (lp && rp) {
        return [...lp, ...rp];
      }
    }

    return null;
  }

  /** Phones of a lyric word: dictionary entry, strict Japanese mora decomposition, or smart English phonetic approximation; null when unknown. */
  public phonesForWord(raw: string): string[] | null {
    const lower = raw.toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"');
    const cleaned = lower.replace(/^[.,?!:;"'()[\]{}]+/, '').replace(/[.,?!:;"'()[\]{}]+$/, '');
    const direct = this.dictionary.get(lower) ?? this.dictionary.get(cleaned);
    if (direct && direct.length > 0) return direct;
    if (this.language === "ja") {
      const morae = this.splitMoraeStrict(cleaned);
      return morae ? morae.flatMap((m) => m.phones) : null;
    }
    return this.approximateEnglish(cleaned, raw);
  }

  /**
   * Strict word-list variant of `g2p`: every word must resolve (explicit `phones` win over the dictionary), otherwise it throws
   * instead of silently dropping the word, which would shift every following word of the alignment.
   */
  public g2pWords(words: Array<{ w: string; phones?: string[] }>): G2PResult {
    const wordSeq: string[] = [];
    const phSeq: string[] = ['SP'];
    const phIdxToWordIdx: number[] = [-1];
    words.forEach((word, wi) => {
      const phones = word.phones ? word.phones.map((p) => p.toLowerCase()) : this.phonesForWord(word.w);
      if (!phones || phones.length === 0) {
        throw new Error(`No pronunciation for "${word.w}" (language ${this.language ?? 'n/a'}): it is not in the dictionary. Give the word explicit phones, or respell it as a dictionary word.`);
      }
      wordSeq.push(word.w);
      for (const ph of phones) {
        phSeq.push(ph);
        phIdxToWordIdx.push(wi);
      }
      phSeq.push('SP');
      phIdxToWordIdx.push(-1);
    });
    const finalPhSeq = phSeq.map((ph) => {
      if (this.prefixLanguage && this.language !== null && ph !== 'SP' && ph !== 'cl' && ph !== 'CL' && ph !== 'AP' && !ph.includes('/')) {
        return `${this.language}/${ph}`;
      }
      return ph;
    });
    return { phSeq: finalPhSeq, wordSeq, phIdxToWordIdx };
  }
}
