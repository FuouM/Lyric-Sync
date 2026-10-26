// packages/lyricsync/src/evidence/hubert.ts
// HuBERT-FA CTC Viterbi forced alignment, posteriors, and acoustic prior extraction.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ort from 'onnxruntime-node';
import { executionProviders, type InferenceDevice } from 'beatsync';
import type {
  AcousticBreath,
  AcousticEdge,
  ConsensusLine,
  ConsensusWord,
  Language,
  LyricsDefinition,
  LyricWord,
  Posteriorgram,
} from '../types.ts';
import { HubertG2P } from '../lyrics/g2p.ts';
import { AlignmentDecoder, type DecodedWord } from './decoder.ts';
import {
  fillGaps,
  removeShort,
  detectEventPeaks,
  sigmoid,
  extractApProbabilities,
} from './events.ts';
import { getHubertDir } from './models.ts';

export interface AlignedLineWord {
  w: string;
  start: number;
  end: number;
  conf: number;
  syl: [number, number][];
  sylText: string[];
  phonemes?: Array<{ text: string; start: number; end: number }>;
}

/**
 * Closes silences of up to 100 ms between consecutive decoded words by extending the earlier word.
 */
export function fillSmallWordGaps(words: DecodedWord[]): void {
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!;
    const cur = words[i]!;
    const gap = cur.start - prev.end;
    if (gap > 0 && gap <= 0.1) {
      prev.end = cur.start;
      const phs = prev.phonemes;
      if (phs.length > 0) {
        phs[phs.length - 1]!.end = cur.start;
      }
    }
  }
}

/**
 * Maps decoded word/phoneme intervals onto the lyric definition's syllables.
 */
export function mapDecodedWordsToSyllables(
  decodedWords: DecodedWord[],
  words: LyricWord[],
  offset: number,
  targetLang: Language,
  phonesInMora: (mora: string) => number
): AlignedLineWord[] {
  const result: AlignedLineWord[] = [];

  for (let wi = 0; wi < words.length; wi++) {
    const defW = words[wi]!;
    const dw = decodedWords[wi];
    const wStart = dw ? Math.round((offset + dw.start) * 1000) / 1000 : offset;
    const wEnd = dw ? Math.round((offset + dw.end) * 1000) / 1000 : Math.round((offset + 0.3) * 1000) / 1000;
    const syllables = defW.syllables.length > 0 ? defW.syllables : [defW.w];

    const syl: [number, number][] = [];
    if (dw && dw.phonemes.length > 0 && syllables.length > 1) {
      if (targetLang === 'ja') {
        let phIdx = 0;
        for (let si = 0; si < syllables.length; si++) {
          const sStart = Math.round((offset + (dw.phonemes[phIdx]?.start ?? dw.start)) * 1000) / 1000;
          phIdx = Math.min(dw.phonemes.length, phIdx + Math.max(1, phonesInMora(syllables[si]!)));
          const sEnd = Math.round((offset + (dw.phonemes[phIdx - 1]?.end ?? dw.end)) * 1000) / 1000;
          syl.push([sStart, Math.max(sStart + 0.04, sEnd)]);
        }
      } else {
        const dur = wEnd - wStart;
        let curS = wStart;
        for (let si = 0; si < syllables.length; si++) {
          const nxtS = si === syllables.length - 1 ? wEnd : Math.round((curS + dur / syllables.length) * 1000) / 1000;
          syl.push([curS, nxtS]);
          curS = nxtS;
        }
      }
    } else {
      syl.push([wStart, wEnd]);
    }

    result.push({
      w: defW.w,
      start: wStart,
      end: wEnd,
      conf: 0.95,
      syl,
      sylText: syllables,
      ...(dw?.phonemes && dw.phonemes.length > 0
        ? {
            phonemes: dw.phonemes.map((p) => ({
              text: p.text,
              start: Math.round((offset + p.start) * 1000) / 1000,
              end: Math.round((offset + p.end) * 1000) / 1000,
            })),
          }
        : {}),
    });
  }

  return result;
}

/** Whole songs run through the model in 30 s chunks overlapping by 2 s (multiples of the 10 ms frame). */
const SONG_CHUNK_SEC = 30.0;
const SONG_OVERLAP_SEC = 2.0;

/** Model outputs of one song chunk starting at sample `pos`. `frame` is vocab-major ([vocab, frames]). */
interface ChunkOutput {
  pos: number;
  end: number;
  frame: Float32Array;
  edge: Float32Array;
  cvnt: Float32Array | null;
}

export class HubertAligner {
  private session: ort.InferenceSession | null = null;
  /** Chunk outputs of the last song analysed: posteriors, acoustic priors and full-song alignment of one song share one model pass. */
  private song: { audio: Float32Array; chunks: ChunkOutput[] } | null = null;
  private decoder: AlignmentDecoder | null = null;
  private g2p: HubertG2P | null = null;
  private readonly modelDir: string;
  private readonly sampleRate = 44100;
  private readonly hopSize = 441;
  private language: Language = 'en';

  constructor(
    flavor: 'base' | 'combined',
    private readonly device: InferenceDevice = 'gpu'
  ) {
    this.modelDir = getHubertDir(flavor);
  }

  public async init(lang: Language = 'en'): Promise<void> {
    if (this.session && this.decoder && this.g2p && this.language === lang) return;

    this.language = lang;
    const modelPath = path.join(this.modelDir, 'model.onnx');
    if (!fs.existsSync(modelPath)) {
      throw new Error(`HuBERT ONNX model not found: ${modelPath}`);
    }

    const vocabPath = path.join(this.modelDir, 'vocab.json');
    if (!fs.existsSync(vocabPath)) {
      throw new Error(`HuBERT vocabulary not found: ${vocabPath}`);
    }
    const vocabData = JSON.parse(fs.readFileSync(vocabPath, 'utf8')) as {
      vocab: Record<string, number>;
      language_prefix?: boolean;
    };

    const dictFileName = lang === 'ja' ? 'japanese_dict_full.txt' : 'ds_cmudict-07b.txt';
    const dictPath = path.join(this.modelDir, dictFileName);
    if (!fs.existsSync(dictPath)) {
      throw new Error(`HuBERT G2P dictionary not found: ${dictPath}`);
    }

    this.g2p = new HubertG2P(lang, dictPath, { prefixLanguage: vocabData.language_prefix !== false });

    if (!this.decoder) {
      this.decoder = new AlignmentDecoder({
        vocab: vocabData.vocab,
        sampleRate: this.sampleRate,
        hopSize: this.hopSize,
      });
    }

    if (!this.session) {
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: executionProviders(this.device),
        graphOptimizationLevel: 'all',
      });
    }
  }

  /** Runs the model over `audioSamples` chunk by chunk; calls with the same array reuse the outputs of the first call. */
  private async songChunks(audioSamples: Float32Array): Promise<ChunkOutput[]> {
    if (this.song?.audio === audioSamples) return this.song.chunks;
    if (!this.session) throw new Error('HuBERT aligner not initialized');
    const chunkSamples = Math.round(SONG_CHUNK_SEC * this.sampleRate);
    const hopSamples = Math.round((SONG_CHUNK_SEC - SONG_OVERLAP_SEC) * this.sampleRate);
    const chunks: ChunkOutput[] = [];
    for (let pos = 0; pos < audioSamples.length; pos += hopSamples) {
      const end = Math.min(pos + chunkSamples, audioSamples.length);
      const chunk = audioSamples.subarray(pos, end);
      const outputs = await this.session.run({ waveform: new ort.Tensor('float32', chunk, [1, chunk.length]) });
      const frameT = outputs.ph_frame_logits;
      const edgeT = outputs.ph_edge_logits;
      if (!frameT || !edgeT) throw new Error('Missing expected logits in HuBERT model outputs');
      const cvnt = outputs.cvnt_logits?.data;
      chunks.push({ pos, end, frame: frameT.data as Float32Array, edge: edgeT.data as Float32Array, cvnt: cvnt ? (cvnt as Float32Array) : null });
    }
    this.song = { audio: audioSamples, chunks };
    return chunks;
  }

  /** Song-length logits: each chunk contributes its frames up to the middle of the overlaps with its neighbours. */
  private async stitchChunkedLogits(
    audioSamples: Float32Array
  ): Promise<{ frameLogits: Float32Array; edgeLogits: Float32Array; totalFrames: number; vocabSize: number }> {
    if (!this.decoder) throw new Error('HuBERT aligner not initialized');
    const chunks = await this.songChunks(audioSamples);
    const chunkSamples = Math.round(SONG_CHUNK_SEC * this.sampleRate);
    const hopSamples = Math.round((SONG_CHUNK_SEC - SONG_OVERLAP_SEC) * this.sampleRate);
    if (chunkSamples % this.hopSize !== 0 || hopSamples % this.hopSize !== 0) {
      throw new Error('chunk/overlap seconds must be multiples of 10 ms model frame');
    }

    const overlapFrames = (chunkSamples - hopSamples) / this.hopSize;
    const vocabSize = this.decoder.vocabSize;
    const totalFrames = Math.round(audioSamples.length / this.hopSize);
    const frameLogits = new Float32Array(vocabSize * totalFrames);
    const edgeLogits = new Float32Array(totalFrames);

    for (const { pos, end, frame: frameData, edge: edgeData } of chunks) {
      const n = edgeData.length;
      const f0 = pos / this.hopSize;
      const isFirst = pos === 0;
      const isLast = end >= audioSamples.length;
      const keepFrom = isFirst ? 0 : Math.floor(overlapFrames / 2);
      const keepTo = isLast ? n : n - Math.floor(overlapFrames / 2);

      for (let f = keepFrom; f < keepTo; f++) {
        const gf = f0 + f;
        if (gf >= totalFrames) break;
        edgeLogits[gf] = edgeData[f]!;
        for (let v = 0; v < vocabSize; v++) {
          frameLogits[v * totalFrames + gf] = frameData[v * n + f]!;
        }
      }

      if (isLast) break;
    }

    return { frameLogits, edgeLogits, totalFrames, vocabSize };
  }

  public async extractPosteriorgram(audioSamples: Float32Array): Promise<Posteriorgram> {
    await this.init();
    const { frameLogits, totalFrames, vocabSize } = await this.stitchChunkedLogits(audioSamples);
    const data = new Uint8Array(totalFrames * vocabSize);

    for (let t = 0; t < totalFrames; t++) {
      let max = -Infinity;
      for (let v = 0; v < vocabSize; v++) {
        const val = frameLogits[v * totalFrames + t]!;
        if (val > max) max = val;
      }

      let sum = 0;
      for (let v = 0; v < vocabSize; v++) {
        sum += Math.exp(frameLogits[v * totalFrames + t]! - max);
      }

      for (let v = 0; v < vocabSize; v++) {
        const prob = Math.exp(frameLogits[v * totalFrames + t]! - max) / sum;
        data[t * vocabSize + v] = Math.round(prob * 255);
      }
    }

    return { frames: totalFrames, vocabSize, data, silenceId: 0 };
  }

  public async extractAcousticPriors(
    audioSamples: Float32Array,
    options: { edgeThres?: number; breathThres?: number } = {}
  ): Promise<{ breaths: AcousticBreath[]; edges: AcousticEdge[] }> {
    await this.init();
    const edgeThres = options.edgeThres ?? 0.35;
    const breathThres = options.breathThres ?? 0.45;

    const breathsRaw: AcousticBreath[] = [];
    const edgesRaw: AcousticEdge[] = [];

    for (const { pos, end, edge, cvnt } of await this.songChunks(audioSamples)) {
      const chunkLength = end - pos;
      const chunkT0 = pos / this.sampleRate;

      if (cvnt) {
        const cvntData = cvnt;
        const numFrames = Math.round((chunkLength * this.sampleRate) / this.hopSize);
        const actualFrames = Math.min(numFrames, Math.floor(cvntData.length / 3));
        const apProb = extractApProbabilities(cvntData, actualFrames);

        const labels = new Uint8Array(actualFrames);
        for (let f = 0; f < actualFrames; f++) {
          if (apProb[f]! >= breathThres) labels[f] = 1;
        }

        fillGaps(labels, 5);
        removeShort(labels, 7);

        let inBreath = false;
        let bStart = 0;
        for (let f = 0; f < actualFrames; f++) {
          if (labels[f] === 1) {
            if (!inBreath) {
              inBreath = true;
              bStart = f;
            }
          } else {
            if (inBreath) {
              inBreath = false;
              let maxP = 0;
              for (let k = bStart; k < f; k++) {
                if (apProb[k]! > maxP) maxP = apProb[k]!;
              }
              breathsRaw.push({
                start: Math.round((chunkT0 + bStart * 0.01) * 1000) / 1000,
                end: Math.round((chunkT0 + f * 0.01) * 1000) / 1000,
                prob: Math.round(maxP * 1000) / 1000,
              });
            }
          }
        }

        if (inBreath) {
          let maxP = 0;
          for (let k = bStart; k < actualFrames; k++) {
            if (apProb[k]! > maxP) maxP = apProb[k]!;
          }
          breathsRaw.push({
            start: Math.round((chunkT0 + bStart * 0.01) * 1000) / 1000,
            end: Math.round((chunkT0 + actualFrames * 0.01) * 1000) / 1000,
            prob: Math.round(maxP * 1000) / 1000,
          });
        }
      }

      const numFrames = Math.min(Math.round((chunkLength * this.sampleRate) / this.hopSize), edge.length);
      const edgeProb = new Float32Array(numFrames);
      for (let f = 0; f < numFrames; f++) {
        edgeProb[f] = sigmoid(edge[f]!);
      }
      for (const pk of detectEventPeaks(edgeProb, edgeThres, 4)) {
        edgesRaw.push({
          t: Math.round((chunkT0 + pk.index * 0.01) * 1000) / 1000,
          prob: Math.round(pk.prob * 1000) / 1000,
        });
      }
    }

    // Deduplicate edges within 35ms (keep peak with max prob)
    edgesRaw.sort((a, b) => a.t - b.t);
    const edgesDedup: AcousticEdge[] = [];
    for (const e of edgesRaw) {
      if (edgesDedup.length === 0) {
        edgesDedup.push(e);
      } else {
        const prev = edgesDedup[edgesDedup.length - 1]!;
        if (Math.abs(e.t - prev.t) <= 0.035) {
          if (e.prob > prev.prob) {
            edgesDedup[edgesDedup.length - 1] = e;
          }
        } else {
          edgesDedup.push(e);
        }
      }
    }

    // Merge overlapping breath intervals (within 50ms)
    breathsRaw.sort((a, b) => a.start - b.start);
    const breathsMerged: AcousticBreath[] = [];
    for (const b of breathsRaw) {
      if (breathsMerged.length === 0) {
        breathsMerged.push(b);
      } else {
        const prev = breathsMerged[breathsMerged.length - 1]!;
        if (b.start <= prev.end + 0.05) {
          prev.end = Math.max(prev.end, b.end);
          if (b.prob !== undefined && prev.prob !== undefined) {
            prev.prob = Math.max(prev.prob, b.prob);
          }
        } else {
          breathsMerged.push(b);
        }
      }
    }

    return { breaths: breathsMerged, edges: edgesDedup };
  }

  public async alignFullSong(
    audioSamples: Float32Array,
    definition: LyricsDefinition
  ): Promise<ConsensusLine[]> {
    await this.init(definition.language);
    if (!this.session || !this.decoder || !this.g2p) {
      throw new Error('HuBERT aligner not initialized');
    }

    const flatWords = definition.lines.flatMap((line, li) =>
      line.words.map((w) => ({ lineIndex: line.index, li, word: w }))
    );
    if (flatWords.length === 0) return [];

    const { phSeq, wordSeq, phIdxToWordIdx } = this.g2p.g2pWords(flatWords.map((x) => x.word));
    const { frameLogits, edgeLogits } = await this.stitchChunkedLogits(audioSamples);
    const wavLength = audioSamples.length / this.sampleRate;
    const { words: decodedWords } = this.decoder.decode(
      frameLogits,
      edgeLogits,
      wavLength,
      phSeq,
      wordSeq,
      phIdxToWordIdx,
      true
    );

    for (const w of decodedWords) {
      for (const p of w.phonemes) {
        const slashIdx = p.text.lastIndexOf('/');
        if (slashIdx !== -1) p.text = p.text.substring(slashIdx + 1);
      }
    }
    fillSmallWordGaps(decodedWords);

    const aligned = mapDecodedWordsToSyllables(
      decodedWords,
      flatWords.map((x) => x.word),
      0,
      definition.language,
      (mora) => this.g2p?.getPhones(mora)?.length ?? 1
    );

    return definition.lines.map((lineDef, li) => {
      const ws = aligned.filter((_, i) => flatWords[i]!.li === li);
      if (ws.length === 0) {
        return {
          i: lineDef.index,
          text: lineDef.text,
          start: 0,
          end: 0,
          words: [],
        };
      }
      return {
        i: lineDef.index,
        text: lineDef.text,
        start: ws[0]!.start,
        end: ws[ws.length - 1]!.end,
        words: ws.map((w) => ({
          w: w.w,
          start: w.start,
          end: w.end,
          conf: 0.95,
          syl: w.syl,
          sylText: w.sylText,
        })),
      };
    });
  }

  public async alignLineSlice(
    audioSlice: Float32Array,
    words: LyricWord[],
    lineStartOffset: number,
    lang: Language
  ): Promise<ConsensusWord[]> {
    await this.init(lang);
    if (!this.session || !this.decoder || !this.g2p) {
      throw new Error('HuBERT aligner not initialized');
    }

    if (words.length === 0) return [];

    const { phSeq, wordSeq, phIdxToWordIdx } = this.g2p.g2pWords(words);
    const wavLength = audioSlice.length / this.sampleRate;
    const waveformTensor = new ort.Tensor('float32', audioSlice, [1, audioSlice.length]);
    const outputs = await this.session.run({ waveform: waveformTensor });

    const phFrameTensor = outputs.ph_frame_logits;
    const phEdgeTensor = outputs.ph_edge_logits;
    if (!phFrameTensor || !phEdgeTensor) {
      throw new Error('Missing expected logits in HuBERT model outputs');
    }

    const phFrameData = phFrameTensor.data as Float32Array;
    const phEdgeData = new Float32Array(phEdgeTensor.data as Float32Array);

    const { words: decodedWords } = this.decoder.decode(
      phFrameData,
      phEdgeData,
      wavLength,
      phSeq,
      wordSeq,
      phIdxToWordIdx,
      true
    );

    for (const w of decodedWords) {
      for (const p of w.phonemes) {
        const slashIdx = p.text.lastIndexOf('/');
        if (slashIdx !== -1) p.text = p.text.substring(slashIdx + 1);
      }
    }
    fillSmallWordGaps(decodedWords);

    const aligned = mapDecodedWordsToSyllables(
      decodedWords,
      words,
      lineStartOffset,
      lang,
      (mora) => this.g2p?.getPhones(mora)?.length ?? 1
    );

    return aligned.map((w) => ({
      w: w.w,
      start: w.start,
      end: w.end,
      conf: 0.95,
      syl: w.syl,
      sylText: w.sylText,
    }));
  }
}
