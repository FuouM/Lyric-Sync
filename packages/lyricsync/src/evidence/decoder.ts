// packages/lyricsync/src/evidence/decoder.ts
// CTC Viterbi forced alignment decoder with fractional edge boundary interpolation.

export interface DecodedPhoneme {
  text: string;
  start: number;
  end: number;
}

export interface DecodedWord {
  text: string;
  start: number;
  end: number;
  phonemes: DecodedPhoneme[];
}

export interface AlignmentDecoderOptions {
  vocab: Record<string, number>;
  sampleRate?: number;
  hopSize?: number;
}

export class AlignmentDecoder {
  private vocab: Record<string, number>;
  private sampleRate: number;
  private hopSize: number;
  readonly vocabSize: number;
  private frameLength: number;

  constructor(options: AlignmentDecoderOptions) {
    this.vocab = options.vocab;
    this.sampleRate = options.sampleRate ?? 44100;
    this.hopSize = options.hopSize ?? 441;
    this.vocabSize = Math.max(...Object.values(options.vocab)) + 1;
    this.frameLength = this.hopSize / this.sampleRate;
  }

  /**
   * Decodes frame logits and edge logits into word and phoneme intervals.
   */
  public decode(
    phFrameLogits: Float32Array,
    phEdgeLogits: Float32Array,
    wavLength: number,
    phSeq: string[],
    wordSeq: string[],
    phIdxToWordIdx: number[],
    ignoreSp = true
  ): { words: DecodedWord[]; totalConfidence: number } {
    const vocabSize = this.vocabSize;
    const stride = phEdgeLogits.length;
    const numFrames = Math.round((wavLength * this.sampleRate) / this.hopSize);
    const T = Math.min(numFrames, stride);
    const S = phSeq.length;

    const phSeqId = new Int32Array(S);
    for (let i = 0; i < S; i++) {
      phSeqId[i] = this.vocab[phSeq[i]!] ?? 0;
    }

    const phMask = new Float32Array(vocabSize).fill(1e9);
    for (let i = 0; i < S; i++) {
      phMask[phSeqId[i]!] = 0.0;
    }
    phMask[0] = 0.0;

    // Log-softmax of adjusted frame logits: [vocabSize, T]
    const phProbLog = new Float32Array(vocabSize * T);
    for (let t = 0; t < T; t++) {
      let maxVal = -Infinity;
      for (let v = 0; v < vocabSize; v++) {
        const raw = phFrameLogits[v * stride + t] ?? -1e9;
        const adj = raw - (phMask[v] ?? 0);
        if (adj > maxVal) maxVal = adj;
      }

      let sumExp = 0.0;
      for (let v = 0; v < vocabSize; v++) {
        const raw = phFrameLogits[v * stride + t] ?? -1e9;
        const adj = raw - (phMask[v] ?? 0);
        sumExp += Math.exp(adj - maxVal);
      }

      const logSum = maxVal + Math.log(sumExp);
      for (let v = 0; v < vocabSize; v++) {
        const raw = phFrameLogits[v * stride + t] ?? -1e9;
        const adj = raw - (phMask[v] ?? 0);
        phProbLog[v * T + t] = adj - logSum;
      }
    }

    // Edge sigmoid and probability accumulation
    const phEdgePred = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      const e = phEdgeLogits[t] ?? 0;
      phEdgePred[t] = 1.0 / (1.0 + Math.exp(-e));
    }

    const edgeDiff = new Float32Array(T);
    for (let t = 0; t < T - 1; t++) {
      edgeDiff[t] = (phEdgePred[t + 1] ?? 0) - (phEdgePred[t] ?? 0);
    }
    edgeDiff[T - 1] = 0.0;

    const edgeProb = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      const prev = t > 0 ? (phEdgePred[t - 1] ?? 0.0) : 0.0;
      edgeProb[t] = Math.min(1.0, Math.max(0.0, (phEdgePred[t] ?? 0) + prev));
    }

    // Forward pass
    const probLog = new Float32Array(S * T);
    for (let s = 0; s < S; s++) {
      const v = phSeqId[s]!;
      for (let t = 0; t < T; t++) {
        probLog[s * T + t] = phProbLog[v * T + t]!;
      }
    }

    const dp = new Float32Array(S * T).fill(-Infinity);
    const backtrackS = new Int16Array(S * T).fill(-1);
    const currPhMaxProbLog = new Float32Array(S).fill(-Infinity);

    dp[0] = probLog[0]!;
    currPhMaxProbLog[0] = probLog[0]!;
    if (phSeqId[0] === 0 && S > 1) {
      dp[1 * T + 0] = probLog[1 * T + 0]!;
      currPhMaxProbLog[1] = probLog[1 * T + 0]!;
    }

    const prob3PadLen = S >= 2 ? 2 : 1;
    const edgeProbLog = new Float32Array(T);
    const notEdgeProbLog = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      edgeProbLog[t] = Math.log((edgeProb[t] ?? 0) + 1e-6);
      notEdgeProbLog[t] = Math.log(1.0 - (edgeProb[t] ?? 0) + 1e-6);
    }

    const maxIndices = new Int8Array(S);

    for (let t = 1; t < T; t++) {
      const edgeLogT = edgeProbLog[t]!;
      const notEdgeLogT = notEdgeProbLog[t]!;
      const tFactor = T / S;
      const tPrevOffset = t - 1;
      const tCurOffset = t;

      for (let s = 0; s < S; s++) {
        const p1 = dp[s * T + tPrevOffset]! + probLog[s * T + tCurOffset]! + notEdgeLogT;

        const p2 =
          s > 0
            ? dp[(s - 1) * T + tPrevOffset]! +
              probLog[(s - 1) * T + tCurOffset]! +
              edgeLogT +
              currPhMaxProbLog[s - 1]! * tFactor
            : -Infinity;

        let p3 = -Infinity;
        if (s >= prob3PadLen) {
          const idx = Math.min(S - 1, Math.max(0, s - prob3PadLen + 1));
          if (idx >= S - 1 || phSeqId[idx] === 0) {
            p3 =
              dp[(s - prob3PadLen) * T + tPrevOffset]! +
              probLog[(s - prob3PadLen) * T + tCurOffset]! +
              edgeLogT +
              currPhMaxProbLog[s - prob3PadLen]! * tFactor;
          }
        }

        let bestVal = p1;
        let bestIdx = 0;
        if (p2 > bestVal) {
          bestVal = p2;
          bestIdx = 1;
        }
        if (p3 > bestVal) {
          bestVal = p3;
          bestIdx = 2;
        }

        dp[s * T + tCurOffset] = bestVal;
        backtrackS[s * T + tCurOffset] = bestIdx;
        maxIndices[s] = bestIdx;
      }

      for (let s = 0; s < S; s++) {
        if (maxIndices[s] === 0) {
          currPhMaxProbLog[s] = Math.max(currPhMaxProbLog[s]!, probLog[s * T + tCurOffset]!);
        } else {
          currPhMaxProbLog[s] = probLog[s * T + tCurOffset]!;
        }
        if (phSeqId[s] === 0) {
          currPhMaxProbLog[s] = 0.0;
        }
      }
    }

    // Backward pass
    let s =
      S > 1 && dp[(S - 2) * T + (T - 1)]! > dp[(S - 1) * T + (T - 1)]! && phSeqId[S - 1] === 0
        ? S - 2
        : S - 1;
    const phIdxSeq: number[] = [];
    const phTimeInt: number[] = [];
    const frameConfList: number[] = [];

    for (let t = T - 1; t >= 0; t--) {
      frameConfList.push(dp[s * T + t]!);
      const type = backtrackS[s * T + t]!;
      if (type !== 0) {
        phIdxSeq.push(s);
        phTimeInt.push(t);
        if (type === 1) {
          s -= 1;
        } else if (type === 2) {
          s -= prob3PadLen;
        }
      }
    }

    phIdxSeq.reverse();
    phTimeInt.reverse();
    frameConfList.reverse();

    // Fractional boundary interpolation
    const phTimePred: number[] = [];
    for (let i = 0; i < phTimeInt.length; i++) {
      const tVal = phTimeInt[i]!;
      const frac = Math.max(-0.5, Math.min(0.5, (edgeDiff[tVal] ?? 0) / 2.0));
      phTimePred.push(this.frameLength * Math.max(0, tVal + frac));
    }
    phTimePred.push(this.frameLength * T);

    // Group phonemes into words
    const words: DecodedWord[] = [];
    let currentWord: DecodedWord | null = null;
    let lastWordIdx = -1;

    for (let i = 0; i < phIdxSeq.length; i++) {
      const phIdx = phIdxSeq[i]!;
      const phName = phSeq[phIdx]!;
      if (phName === 'SP' && ignoreSp) continue;

      const pStart = phTimePred[i]!;
      const pEnd = phTimePred[i + 1]!;
      const phoneme: DecodedPhoneme = { text: phName, start: pStart, end: pEnd };

      const wordIdx = phIdxToWordIdx[phIdx]!;
      if (wordIdx === lastWordIdx && currentWord) {
        currentWord.phonemes.push(phoneme);
        currentWord.end = pEnd;
      } else {
        currentWord = {
          text: wordSeq[wordIdx]!,
          start: pStart,
          end: pEnd,
          phonemes: [phoneme],
        };
        words.push(currentWord);
        lastWordIdx = wordIdx;
      }
    }

    // Confidence geometric mean approximation
    let totalConfidence = 1.0;
    if (frameConfList.length > 1) {
      let logDiffSum = 0.0;
      for (let i = 1; i < frameConfList.length; i++) {
        logDiffSum += (frameConfList[i] ?? 0) - (frameConfList[i - 1] ?? 0);
      }
      totalConfidence = Math.exp(logDiffSum / (3.0 * frameConfList.length));
    }

    return { words, totalConfidence };
  }
}
