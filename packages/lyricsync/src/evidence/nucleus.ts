// packages/lyricsync/src/evidence/nucleus.ts
// Resolves a syllable to its vowel nucleus and edge phone IDs in the HuBERT base vocabulary.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Language, NucleusResolver } from '../types.ts';
import { HubertG2P } from '../lyrics/g2p.ts';
import { getHubertDir } from './models.ts';

const EN_VOWELS: Record<string, true> = {
  aa: true,
  ae: true,
  ah: true,
  ao: true,
  aw: true,
  ax: true,
  ay: true,
  eh: true,
  er: true,
  ey: true,
  ih: true,
  iy: true,
  ow: true,
  oy: true,
  uh: true,
  uw: true,
};

export function createNucleusResolver(lang: Language): { resolver: NucleusResolver; silenceId: number } {
  const modelDir = getHubertDir('base');
  const vocabPath = path.join(modelDir, 'vocab.json');
  if (!fs.existsSync(vocabPath)) {
    throw new Error(`HuBERT base vocabulary not found at: ${vocabPath}`);
  }

  const vocabRaw = JSON.parse(fs.readFileSync(vocabPath, 'utf8')) as { vocab: Record<string, number> };
  const vocab = vocabRaw.vocab;
  const dictFile = lang === 'ja' ? 'japanese_dict_full.txt' : 'ds_cmudict-07b.txt';
  const dictPath = path.join(modelDir, dictFile);
  if (!fs.existsSync(dictPath)) {
    throw new Error(`G2P dictionary file not found at: ${dictPath}`);
  }

  const g2p = new HubertG2P(lang, dictPath);

  const phonesOf = (text: string): string[] => {
    const clean = text.replace(/[()]/g, '');
    const g2pRes = g2p.g2p(clean);
    return g2pRes.phSeq
      .filter((p) => p !== 'SP')
      .map((p) => {
        const lastSlash = p.lastIndexOf('/');
        return lastSlash !== -1 ? p.substring(lastSlash + 1) : p;
      });
  };

  const id = (langPrefix: string, phone: string | undefined): number => {
    if (!phone) return -1;
    return vocab[`${langPrefix}/${phone}`] ?? -1;
  };

  const resolver: NucleusResolver = (word, sylIdx, sylText, sylCount) => {
    if (lang === 'ja') {
      const phones = phonesOf(sylText);
      const lastPhone = phones[phones.length - 1];
      const firstPhone = phones[0];
      return {
        nucleus: id('ja', lastPhone),
        first: id('ja', firstPhone),
        last: id('ja', lastPhone),
      };
    }

    const phones = phonesOf(word);
    const vowels = phones.filter((p) => EN_VOWELS[p]);
    const vowelPhone = vowels.length ? vowels[Math.min(sylIdx, vowels.length - 1)] : undefined;

    return {
      nucleus: id('en', vowelPhone),
      first: sylIdx === 0 ? id('en', phones[0]) : -1,
      last: sylIdx === sylCount - 1 ? id('en', phones[phones.length - 1]) : -1,
    };
  };

  return { resolver, silenceId: 0 };
}
