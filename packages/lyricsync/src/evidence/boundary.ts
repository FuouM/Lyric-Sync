// packages/lyricsync/src/evidence/boundary.ts
// The trained syllable-boundary model (models/boundary: trained on GTSinger, fine-tuned on the Namine Ritsu database; scripts/gtsinger,
// scripts/ritsu; exported by export_onnx.py).
//   frames.onnx   the vocal (16 kHz, peak-normalised over the song) -> per frame (100 fps) a dim-wide embedding and a context-free boundary logit
//   queries.onnx  one boundary's phone context (last two phones on the left, first three on the right, SIL past a rest; the boundary kind;
//                 the language) -> a dim-wide query.
// Score of boundary j at frame t: embedding_t . query_j / sqrt(dim) + logit_t (the guided solver's guide, engine/guided.ts).

import * as fs from 'node:fs';
import * as ort from 'onnxruntime-node';
import { resampleBandLimited } from '../audio/audio.ts';
import { dictionaryG2P } from '../lyrics/dictionary.ts';
import { modelFile } from '../paths.ts';
import type { BoundaryModelEvidence, Language, LyricsDefinition } from '../types.ts';

interface BoundaryConfig {
  sampleRate: number;
  hop: number;
  fps: number;
  dim: number;
  /** frames.onnx runs on windows of chunkSec + 2 padSec; each window keeps chunkSec of output. */
  chunkSec: number;
  padSec: number;
  phones: string[];
  aliases: Record<string, string>;
  kinds: BoundaryKind[];
  languages: Language[];
  context: number;
}

type BoundaryKind = 'runStart' | 'runEnd' | 'word' | 'inner';

/** A syllable as the model's queries see it: its phones (dictionary names) and whether it starts a word. */
export interface ContextSyllable {
  phones: string[];
  wordStart: boolean;
}

function readConfig(): BoundaryConfig {
  return JSON.parse(fs.readFileSync(modelFile('boundary', 'config.json'), 'utf8')) as BoundaryConfig;
}

const EN_VOWELS = new Set(['aa', 'ae', 'ah', 'ao', 'aw', 'ax', 'ay', 'eh', 'er', 'ey', 'ih', 'iy', 'ow', 'oy', 'uh', 'uw']);
/** Onset consonant phone of a continuation syllable's spelling ("ry" -> r); none when it starts with a vowel letter. */
const LETTER_ONSET: Record<string, string> = {
  b: 'b', c: 'k', d: 'd', f: 'f', g: 'g', h: 'hh', j: 'jh', k: 'k', l: 'l', m: 'm', n: 'n', p: 'p', q: 'k', r: 'r', s: 's', t: 't', v: 'v', w: 'w',
  x: 'k', y: 'y', z: 'z',
};
const DIGRAPH_ONSET: Record<string, string> = { th: 'th', sh: 'sh', ch: 'ch' };

/**
 * Splits an English word's phones over its sung syllables, the rule the GTSinger training labels follow. Same count as its vowels: maximal
 * onset (one consonant between vowels goes right; of two or more, the first stays left). Otherwise the dictionary syllables are spread
 * proportionally: fewer sung syllables join neighbouring ones; more sung syllables are held vowels, and a syllable that continues the previous
 * one's dictionary syllable gets that vowel after the onset its spelling shows ("fa|ace" -> [f ey s] [ey], "in|n|n" -> [ih n] [n ih] [n ih]).
 */
function splitEnglish(phones: string[], texts: string[]): string[][] {
  const vow = phones.flatMap((p, i) => (EN_VOWELS.has(p) ? [i] : []));
  if (vow.length === 0) return texts.map(() => phones);
  const cuts = [0];
  for (let k = 0; k < vow.length - 1; k++) cuts.push(vow[k]! + 1 + (vow[k + 1]! - vow[k]! - 1 >= 2 ? 1 : 0));
  cuts.push(phones.length);
  const groups = vow.map((_, k) => phones.slice(cuts[k], cuts[k + 1]));
  if (groups.length === texts.length) return groups;
  const G = groups.length;
  const K = texts.length;
  let lastGroup = -1;
  return texts.map((text, k) => {
    const g0 = Math.floor((k * G) / K);
    const g1 = Math.max(g0, Math.floor(((k + 1) * G) / K) - 1);
    if (g0 > lastGroup) {
      lastGroup = g1;
      return groups.slice(g0, g1 + 1).flat();
    }
    const letters = text.toLowerCase().replace(/[^a-z]/g, '');
    const onset = DIGRAPH_ONSET[letters.slice(0, 2)] ?? (/^[aeiou]/.test(letters) ? undefined : LETTER_ONSET[letters[0] ?? '']);
    const vowel = phones[vow[g0]!]!;
    return onset === undefined ? [vowel] : [onset, vowel];
  });
}

/** Every line's syllables with their phones, in the order the solver flattens them (words, then syllables). Unknown words throw. */
export function boundaryContexts(definition: LyricsDefinition): Array<{ index: number; syllables: ContextSyllable[] }> {
  const g2p = dictionaryG2P(definition.language);
  const bare = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
  return definition.lines.map((line) => ({
    index: line.index,
    syllables: line.words.flatMap((word) => {
      if (definition.language === 'en') {
        const phones = (word.phones ?? g2p.phonesForWord(word.w))?.map(bare);
        if (!phones) throw new Error(`No pronunciation for "${word.w}": the boundary model needs every word's phones.`);
        return splitEnglish(phones, word.syllables).map((ph, k) => ({ phones: ph, wordStart: k === 0 }));
      }
      return word.syllables.map((text, k) => {
        const ph = g2p.phonesForWord(text.replace(/[()]/g, ''))?.map(bare);
        if (!ph) throw new Error(`No pronunciation for mora "${text}" of "${word.w}".`);
        return { phones: ph, wordStart: k === 0 };
      });
    }),
  }));
}

/** The model's phone ids around one boundary: the last two phones on the left, the first three on the right; SIL past a rest. */
function contextIds(cfg: BoundaryConfig, language: Language, left: string[] | null, right: string[] | null): number[] {
  const id = (name: string): number => {
    const i = cfg.phones.indexOf(name);
    if (i < 0) throw new Error(`Boundary model has no phone "${name}".`);
    return i;
  };
  const pad = id('<pad>');
  const sil = id('SIL');
  const pid = (p: string): number => {
    const key = `${language}/${p}`;
    const i = cfg.phones.indexOf(cfg.aliases[key] ?? key);
    // Phones outside the model's inventory read as padding, as in training (boundary_model.py context_ids).
    return i < 0 ? pad : i;
  };
  const L = left === null ? [sil, sil] : [pad, pad, ...left.map(pid)].slice(-2);
  const R = right === null ? [sil, sil, sil] : [...right.map(pid), pad, pad, pad].slice(0, 3);
  return [...L, ...R];
}

/** Queries of every boundary of every line: boundary 0 starts the line after a rest, the last one ends it before a rest. */
export async function computeQueries(cfg: BoundaryConfig, definition: LyricsDefinition): Promise<Record<number, number[][]>> {
  const lines = boundaryContexts(definition);
  const ctx: number[] = [];
  const kind: number[] = [];
  const owner: Array<{ line: number; j: number }> = [];
  for (const line of lines) {
    const syl = line.syllables;
    for (let j = 0; j <= syl.length; j++) {
      const k: BoundaryKind = j === 0 ? 'runStart' : j === syl.length ? 'runEnd' : syl[j]!.wordStart ? 'word' : 'inner';
      ctx.push(...contextIds(cfg, definition.language, j > 0 ? syl[j - 1]!.phones : null, j < syl.length ? syl[j]!.phones : null));
      kind.push(cfg.kinds.indexOf(k));
      owner.push({ line: line.index, j });
    }
  }
  const n = owner.length;
  const lang = cfg.languages.indexOf(definition.language);
  if (lang < 0) throw new Error(`Boundary model has no language "${definition.language}".`);
  const session = await ort.InferenceSession.create(modelFile('boundary', 'queries.onnx'), { executionProviders: ['cpu'] });
  const out = await session.run({
    ctx: new ort.Tensor('int64', BigInt64Array.from(ctx, BigInt), [n, cfg.context]),
    kind: new ort.Tensor('int64', BigInt64Array.from(kind, BigInt), [n]),
    lang: new ort.Tensor('int64', new BigInt64Array(n).fill(BigInt(lang)), [n]),
  });
  await session.release();
  const q = out.q!.data as Float32Array;
  const queryMap = new Map<number, number[][]>();
  owner.forEach((o, i) => {
    let arr = queryMap.get(o.line);
    if (!arr) {
      arr = [];
      queryMap.set(o.line, arr);
    }
    arr[o.j] = Array.from(q.subarray(i * cfg.dim, (i + 1) * cfg.dim));
  });
  return Object.fromEntries(queryMap);
}

/**
 * Frame embeddings of the whole vocal. frames.onnx runs on fixed windows (chunkSec + 2 padSec, the last one shifted back inside the song) so
 * the accelerator sees one input shape; each window contributes the chunkSec of frames at its centre (all of it for a song shorter than a window).
 */
async function computeFrames(cfg: BoundaryConfig, audio: Float32Array, sampleRate: number): Promise<Float32Array> {
  // The model was trained on scipy-resampled (band-limited) audio; linear interpolation's aliasing costs accuracy (measured on the annotated songs).
  const signal = Float32Array.from(resampleBandLimited(audio, sampleRate, cfg.sampleRate));
  let peak = 0;
  for (const v of signal) peak = Math.max(peak, Math.abs(v));
  const gain = 0.9 / (peak + 1e-6);
  for (let i = 0; i < signal.length; i++) signal[i]! *= gain;
  const T = Math.floor(signal.length / cfg.hop);
  const stride = cfg.dim + 1;
  const out = new Float32Array(T * stride);
  const step = Math.round(cfg.chunkSec * cfg.fps);
  const pad = Math.round(cfg.padSec * cfg.fps);
  const W = Math.min(T, step + 2 * pad);
  // DirectML first: windows are fixed-size and short (a few thousand GRU steps); the CPU provider takes what DirectML cannot run.
  const session = await ort.InferenceSession.create(modelFile('boundary', 'frames.onnx'), { executionProviders: ['dml', 'cpu'], graphOptimizationLevel: 'all' });
  for (let f0 = 0; f0 < T; f0 += step) {
    const a = Math.max(0, Math.min(f0 - pad, T - W));
    const res = await session.run({ waveform: new ort.Tensor('float32', signal.slice(a * cfg.hop, (a + W) * cfg.hop), [1, W * cfg.hop]) });
    const fr = res.frames!.data as Float32Array;
    const n = Math.min(step, T - f0);
    out.set(fr.subarray((f0 - a) * stride, (f0 - a + n) * stride), f0 * stride);
  }
  await session.release();
  return out;
}

export function readBoundaryConfig(): BoundaryConfig {
  return readConfig();
}

/** Runs the boundary model on a vocal (mono, any rate) for the lines of `definition`. */
export async function extractBoundaryEvidence(audio: Float32Array, sampleRate: number, definition: LyricsDefinition): Promise<BoundaryModelEvidence> {
  const cfg = readConfig();
  return { fps: cfg.fps, dim: cfg.dim, frames: await computeFrames(cfg, audio, sampleRate), queries: await computeQueries(cfg, definition) };
}
