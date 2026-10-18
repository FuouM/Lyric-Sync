// src/engine/consensus.ts
// Multi-pitch tracker consensus lyric alignment engine.
// Fuses speech/HuBERT phonetic forced alignment with pitch tracking consensus
// (Swift-F0, RMVPE, HarmoF0) and musical tempo/beat grids.

export const VOWEL_SET = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW', 'AX'
]);

export const FRICATIVES = new Set([
  'S', 'Z', 'SH', 'ZH', 'F', 'V', 'TH', 'DH', 'HH'
]);

export const PLOSIVES = new Set([
  'P', 'B', 'T', 'D', 'K', 'G'
]);

export const NASALS = new Set([
  'M', 'N', 'NG'
]);

export const LIQUIDS_GLIDES = new Set([
  'L', 'R', 'W', 'Y', '_R'
]);

export const PROCLITICS = new Set(['the', 'a', 'an', 'to', 'at', 'of', 'in', 'on', 'for', 'with', 'from']);

export const PHONETIC_LEAD_DISTRIBUTIONS: Record<string, number> = {
  FRICATIVE: 0.095,    // Extended turbulent noise onset (S, SH, F, TH)
  AFFRICATE: 0.075,    // Stop closure + friction release (CH, JH)
  PLOSIVE: 0.045,      // Stop closure duration before burst/voicing (P, T, K, B, D, G)
  NASAL: 0.065,        // Nasal murmur before vowel formant transition (M, N, NG)
  LIQUID_GLIDE: 0.055, // Resonant formant gliding into vowel (L, R, W, Y)
  VOWEL: 0.000,        // No consonant lead
  OTHER: 0.035         // Default conservative offset
};

export function getPhoneClass(phoneStr: string): string {
  const p = phoneStr.toUpperCase().replace(/[0-9]+$/, '');
  if (VOWEL_SET.has(p)) return 'VOWEL';
  if (FRICATIVES.has(p)) return 'FRICATIVE';
  if (p === 'CH' || p === 'JH') return 'AFFRICATE';
  if (PLOSIVES.has(p)) return 'PLOSIVE';
  if (NASALS.has(p)) return 'NASAL';
  if (LIQUIDS_GLIDES.has(p)) return 'LIQUID_GLIDE';
  return 'OTHER';
}

export function round3(val: number): number {
  return Math.round(val * 1000) / 1000;
}
export function percentile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (q / 100) * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) {
    return sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!);
  }
  return sorted[base]!;
}

export interface AdaptiveAudioPriors {
  voicedRmsThreshold: number;
  noiseFloor: number;
}

export function computeAdaptiveAudioPriors(
  audioWav?: Float32Array | null,
  audioSr = 44100
): AdaptiveAudioPriors {
  if (!audioWav || audioWav.length === 0) {
    return { voicedRmsThreshold: 0.02, noiseFloor: 0.0001 };
  }
  const frameLen = Math.floor(audioSr * 0.025);
  const hopLen = Math.floor(audioSr * 0.01);
  const maxIdx = audioWav.length - frameLen;
  if (maxIdx <= 0) {
    return { voicedRmsThreshold: 0.02, noiseFloor: 0.0001 };
  }

  const rmsVals: number[] = [];
  for (let i = 0; i <= maxIdx; i += hopLen) {
    let sumSq = 0;
    for (let j = 0; j < frameLen; j++) {
      const s = audioWav[i + j] ?? 0;
      sumSq += s * s;
    }
    rmsVals.push(Math.sqrt(sumSq / frameLen));
  }

  const p15 = percentile(rmsVals, 15);
  const p75 = percentile(rmsVals, 75);
  const voicedThresh = p15 + 0.2 * Math.max(1e-4, p75 - p15);

  return {
    voicedRmsThreshold: Math.round(voicedThresh * 100000) / 100000,
    noiseFloor: Math.round(p15 * 100000) / 100000
  };
}


export interface SyllableDictEntry {
  parts: string[];
  ph_counts?: number[];
}

export interface PhonemeItem {
  text: string;
  start: number;
  end: number;
}

export function mapPhonemesToSyllablesPhonetic(
  wordText: string,
  wStart: number,
  wEnd: number,
  phonemes: PhonemeItem[],
  syllablesDict: Record<string, SyllableDictEntry>
): { sylTimes: Array<[number, number]>; parts: string[] } {
  const cleanW = wordText.toLowerCase().replace(/['\-]/g, '');
  const info = syllablesDict[cleanW];

  const cleanPhs: PhonemeItem[] = [];
  for (const p of phonemes) {
    let pName = p.text;
    if (pName.includes('/')) {
      pName = pName.split('/', 2)[1] ?? pName;
    }
    pName = pName.replace(/[0-9]+$/, '').toUpperCase();
    cleanPhs.push({ start: p.start, end: p.end, text: pName });
  }

  if (!info || cleanPhs.length === 0) {
    return { sylTimes: [[wStart, wEnd]], parts: [wordText] };
  }

  const parts = info.parts;
  const phCounts = info.ph_counts ?? parts.map(() => 1);
  const numSyl = parts.length;
  const sumCounts = phCounts.reduce((a, b) => a + b, 0);

  const sylTimes: Array<[number, number]> = [];

  if (cleanPhs.length >= sumCounts) {
    let curPh = 0;
    for (let i = 0; i < phCounts.length; i++) {
      const count = phCounts[i]!;
      const chunk = cleanPhs.slice(curPh, curPh + count);
      curPh += count;

      let s0 = chunk.length > 0 ? round3(chunk[0]!.start) : wStart;
      let s1 = chunk.length > 0 ? round3(chunk[chunk.length - 1]!.end) : s0 + 0.15;

      // P-center adjustment based on leading consonant acoustics
      if (chunk.length > 0) {
        const firstPClass = getPhoneClass(chunk[0]!.text);
        const maxLead = PHONETIC_LEAD_DISTRIBUTIONS[firstPClass] ?? 0.0;
        if (maxLead > 0) {
          for (const p of chunk) {
            if (VOWEL_SET.has(p.text)) {
              s0 = round3(Math.min(p.start, s0 + maxLead));
              break;
            }
          }
        }
      }

      if (i === 0) s0 = wStart;
      if (i === numSyl - 1) s1 = wEnd;

      s0 = Math.max(wStart, Math.min(wEnd, s0));
      s1 = Math.max(s0, Math.min(wEnd, s1));
      sylTimes.push([s0, s1]);
    }
  } else {
    const step = (wEnd - wStart) / numSyl;
    let cur = wStart;
    for (let i = 0; i < numSyl; i++) {
      const nxt = i === numSyl - 1 ? wEnd : round3(cur + step);
      sylTimes.push([cur, nxt]);
      cur = nxt;
    }
  }

  for (let k = 0; k < sylTimes.length - 1; k++) {
    const mid = round3((sylTimes[k]![1] + sylTimes[k + 1]![0]) / 2);
    sylTimes[k]![1] = mid;
    sylTimes[k + 1]![0] = mid;
  }
  if (sylTimes.length > 0) {
    sylTimes[sylTimes.length - 1]![1] = wEnd;
  }

  return { sylTimes, parts };
}

export interface ConsensusNote {
  start: number;
  end: number;
  pitch?: number;
  pitchHz?: number;
  confidence?: number;
  [key: string]: unknown;
}

export interface ConsensusWord {
  text?: string;
  w?: string;
  word?: string;
  start: number;
  end: number;
  syl?: Array<[number, number]>;
  sylText?: string[];
  sylCalibrated?: boolean[];
  calibrated?: boolean;
  parts?: string[];
  [key: string]: unknown;
}

export interface ConsensusLine {
  text?: string;
  start: number;
  end: number;
  words: ConsensusWord[];
  [key: string]: unknown;
}

export interface RefineAlignmentOptions {
  swiftNotes?: ConsensusNote[];
  harmoNotes?: ConsensusNote[];
  rmvpeNotes?: ConsensusNote[];
  beats?: number[];
  audio?: Float32Array;
  sampleRate?: number;
  legatoGap?: number;
  breaths?: Array<{ start: number; end: number }>;
  edges?: Array<{ t: number; prob: number }>;
}

function searchSorted(arr: number[], val: number): number {
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (arr[mid]! < val) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function findClosest(arr: number[], val: number): number {
  if (arr.length === 0) return val;
  let best = arr[0]!;
  let minDiff = Math.abs(best - val);
  for (let i = 1; i < arr.length; i++) {
    const diff = Math.abs(arr[i]! - val);
    if (diff < minDiff) {
      minDiff = diff;
      best = arr[i]!;
    }
  }
  return best;
}


/**
 * Refines phonetic syllable alignments using pitch tracker consensus
 * (Swift-F0, RMVPE, HarmoF0) and musical timing.
 */
export function refineAlignment(
  hubertLines: ConsensusLine[],
  options: RefineAlignmentOptions = {}
): ConsensusLine[] {
  const {
    swiftNotes = [],
    harmoNotes: rawHarmoNotes = [],
    rmvpeNotes = [],
    beats: beatsList = [],
    audio: audioWav,
    sampleRate: audioSr = 44100,
    legatoGap = 0.12,
    breaths = [],
    edges = []
  } = options;

  // Filter out sub-bass instrumental bleed (< 100 Hz) from HarmoF0
  const harmoNotes = rawHarmoNotes.filter(hn => !hn.pitchHz || hn.pitchHz >= 100);

  const qArr = beatsList.length > 0 ? [...beatsList] : [];
  const eArr: number[] = [];
  if (qArr.length > 1) {
    for (let i = 0; i < qArr.length - 1; i++) {
      eArr.push((qArr[i]! + qArr[i + 1]!) / 2.0);
    }
  }

  // Combine and sort unique qArr + eArr
  const allGridSet = new Set<number>();
  for (const b of qArr) allGridSet.add(round3(b));
  for (const b of eArr) allGridSet.add(round3(b));
  const allGrid = Array.from(allGridSet).sort((a, b) => a - b);

  // Build dynamic AI 16th-note sub-beat grid directly from timing beats (no hardcoded BPM)
  const dynamicGridList: number[] = [];
  if (qArr.length > 1) {
    for (let i = 0; i < qArr.length - 1; i++) {
      const b0 = qArr[i]!;
      const b1 = qArr[i + 1]!;
      const step = (b1 - b0) / 4.0;
      dynamicGridList.push(b0, b0 + step, b0 + 2 * step, b0 + 3 * step);
    }
    dynamicGridList.push(qArr[qArr.length - 1]!);
  }
  const dynamicGridSet = new Set<number>();
  for (const v of dynamicGridList) dynamicGridSet.add(round3(v));
  const dynamicGrid = Array.from(dynamicGridSet).sort((a, b) => a - b);

  const getLocalBeatDur = (t: number): number => {
    if (qArr.length < 2) return 0.3;
    const idx = searchSorted(qArr, t);
    if (idx <= 0) {
      return qArr[1]! - qArr[0]!;
    } else if (idx >= qArr.length) {
      return qArr[qArr.length - 1]! - qArr[qArr.length - 2]!;
    } else {
      return qArr[idx]! - qArr[idx - 1]!;
    }
  };

  // Deep clone input lines
  const refinedLines: ConsensusLine[] = JSON.parse(JSON.stringify(hubertLines));
  const consumedSwiftOnsets = new Set<number>();
  const consumedRmvpeOnsets = new Set<number>();
  const consumedHarmoOnsets = new Set<number>();


  const rmvpeStarts = rmvpeNotes.map(n => n.start);
  const harmoStarts = harmoNotes.map(n => n.start);
  const hasVocalPitchNear = (t: number, tol = 0.070): boolean => {
    if (rmvpeStarts.length === 0 && harmoStarts.length === 0) return true;
    if (rmvpeStarts.length > 0) {
      const idx = searchSorted(rmvpeStarts, t);
      if (idx < rmvpeStarts.length && Math.abs(rmvpeStarts[idx]! - t) <= tol) return true;
      if (idx > 0 && Math.abs(rmvpeStarts[idx - 1]! - t) <= tol) return true;
    }
    if (harmoStarts.length > 0) {
      const idx = searchSorted(harmoStarts, t);
      if (idx < harmoStarts.length && Math.abs(harmoStarts[idx]! - t) <= tol) return true;
      if (idx > 0 && Math.abs(harmoStarts[idx - 1]! - t) <= tol) return true;
    }
    return false;
  };
  for (let li = 0; li < refinedLines.length; li++) {
    const line = refinedLines[li]!;
    const words = line.words;
    if (!words || words.length === 0) continue;
    if (line.calibrated === true) continue;

    const prevLineEnd = li > 0 ? refinedLines[li - 1]!.end : 0.0;

    // --- STAGE 0: ACOUSTIC DE-SQUASH FOR COLLAPSED WORDS (< 0.050s) ---
    for (let wi = 0; wi < words.length - 1; wi++) {
      const wCur = words[wi]!;
      const wNxt = words[wi + 1]!;
      const curDur = wCur.end - wCur.start;
      const pitchPool = rmvpeNotes.length > 0 ? rmvpeNotes : harmoNotes;
      if (curDur < 0.05 && pitchPool.length > 0) {
        const prevBound = wi > 0 ? words[wi - 1]!.end : Math.max(prevLineEnd + 0.05, line.start - 0.6);
        const cands = pitchPool.filter(pn => prevBound - 0.05 <= pn.start && pn.start < wNxt.start - 0.1);
        if (cands.length > 0) {
          let nSt = cands[0]!.start;
          for (let k = 0; k < cands.length - 1; k++) {
            if (cands[k + 1]!.start - cands[k]!.end > 0.12) {
              nSt = cands[k + 1]!.start;
            }
          }
          wCur.start = round3(nSt);
          wCur.end = round3(Math.min(cands[cands.length - 1]!.end + 0.05, wNxt.start));
          if (wCur.syl && wCur.syl.length > 0) {
            wCur.syl[0]![0] = wCur.start;
            wCur.syl[wCur.syl.length - 1]![1] = wCur.end;
          }
        }
      }
    }


    // Stage 0g: De-truncate abnormally compressed lines into subsequent pitch notes
    if (words.length >= 2) {
      const lineSyls: Array<[number, number]> = [];
      for (const w of words) {
        if (w.syl) {
          for (const s of w.syl) lineSyls.push(s);
        } else {
          lineSyls.push([w.start, w.end]);
        }
      }
      const lineSylCount = lineSyls.length;
      const curLineSpan = words[words.length - 1]!.end - words[0]!.start;
      const avgSylDur = curLineSpan / lineSylCount;
      const nxtLineStart = li + 1 < refinedLines.length ? refinedLines[li + 1]!.start : Infinity;
      const gapToNxt = nxtLineStart - words[words.length - 1]!.end;
      const hasSquashedMultiSyl = words.some(w => {
        const d = w.end - w.start;
        const n = w.syl?.length ?? 1;
        return n >= 2 && (d / n) <= 0.08;
      });
      const endLimit = (line.end && line.end > words[0]!.start + 0.30) ? line.end : nxtLineStart;
      const shouldDecompress = (avgSylDur <= 0.18 && gapToNxt >= 0.60 && lineSylCount >= 3) ||
                               (hasSquashedMultiSyl && (endLimit - words[0]!.start >= lineSylCount * 0.22));
      if (shouldDecompress) {
        const pool = rmvpeNotes.concat(harmoNotes);
        const lineNotes = pool.filter(pn => words[0]!.start - 0.05 <= pn.start && pn.start <= endLimit - 0.10);
        const distinct: ConsensusNote[] = [];
        for (const pn of lineNotes.sort((a, b) => a.start - b.start)) {
          if (distinct.length === 0 || pn.start - distinct[distinct.length - 1]!.start >= 0.20) {
            distinct.push(pn);
          }
        }
        if (distinct.length === lineSylCount) {
          let sIdx = 0;
          for (const w of words) {
            const wSyls = w.syl ?? [[w.start, w.end]];
            for (let si = 0; si < wSyls.length; si++) {
              const curNote = distinct[sIdx]!;
              const nxtNote = sIdx + 1 < lineSylCount ? distinct[sIdx + 1]! : null;
              wSyls[si]![0] = round3(curNote.start);
              wSyls[si]![1] = nxtNote ? round3(nxtNote.start) : (line.end ? round3(line.end) : round3(curNote.end));
              sIdx++;
            }
            w.start = wSyls[0]![0];
            w.end = wSyls[wSyls.length - 1]![1];
          }
        }
      }
    }
    // Stage 0j: Acoustic edge realignment for squashed multi-syllable word pairs
    if (edges && edges.length > 0) {
      for (let wi = 0; wi < words.length - 1; wi++) {
        const wCur = words[wi]!;
        const wNxt = words[wi + 1]!;
        const nCur = wCur.syl?.length ?? 1;
        const nNxt = wNxt.syl?.length ?? 1;
        const durCur = wCur.end - wCur.start;
        const durNxt = wNxt.end - wNxt.start;
        const pairEnd = wNxt.end;
        const pairSylCount = nCur + nNxt;
        const curScore = ('score' in wCur && typeof wCur.score === 'number') ? wCur.score : (('conf' in wCur && typeof wCur.conf === 'number') ? wCur.conf : 1.0);
        const nxtScore = ('score' in wNxt && typeof wNxt.score === 'number') ? wNxt.score : (('conf' in wNxt && typeof wNxt.conf === 'number') ? wNxt.conf : 1.0);
        const wCurText = (wCur.w ?? wCur.text ?? '').toLowerCase().trim();
        const isSquashedPair = (nCur >= 2 && durCur <= 0.22 && (durCur / nCur) <= 0.11 && durNxt >= 0.70 && durNxt / durCur >= 3.0 && (curScore < 0.60 || nxtScore < 0.60)) ||
          (PROCLITICS.has(wCurText) && nCur === 1 && nNxt === 1 && durCur <= 0.16 && durNxt >= 0.45 && (curScore < 0.70 || nxtScore < 0.60));
        if (isSquashedPair) {
          const highEdges = edges.filter(e => wCur.start - 0.05 <= e.t && e.t <= pairEnd - 0.10 && e.prob >= 0.70);
          const onsets: number[] = [];
          const minSep = (nCur === 1 && nNxt === 1) ? 0.20 : 0.12;
          for (const e of highEdges.sort((a, b) => a.t - b.t)) {
            if (onsets.length === 0 || e.t - onsets[onsets.length - 1]! >= minSep) {
              onsets.push(round3(e.t));
            } else if (e.prob > 0.80) {
              onsets[onsets.length - 1] = round3(e.t);
            }
          }
          if (onsets.length === pairSylCount) {
            const cuts = [...onsets, round3(pairEnd)];
            if (wCur.syl) {
              for (let si = 0; si < nCur; si++) {
                wCur.syl[si]![0] = cuts[si]!;
                wCur.syl[si]![1] = cuts[si + 1]!;
              }
              wCur.start = wCur.syl[0]![0];
              wCur.end = wCur.syl[nCur - 1]![1];
            }
            if (wNxt.syl) {
              for (let si = 0; si < nNxt; si++) {
                wNxt.syl[si]![0] = cuts[nCur + si]!;
                wNxt.syl[si]![1] = cuts[nCur + si + 1]!;
              }
              wNxt.start = wNxt.syl[0]![0];
              wNxt.end = wNxt.syl[nNxt - 1]![1];
            }
          }
        }
      }
    }
    // Stage 0k: Low-confidence tail word realignment via acoustic edges
    if (edges && edges.length > 0 && words.length >= 3) {
      const wLast = words[words.length - 1]!;
      const lastScore = ('score' in wLast && typeof wLast.score === 'number') ? wLast.score : (('conf' in wLast && typeof wLast.conf === 'number') ? wLast.conf : 1.0);
      if (lastScore <= 0.30) {
        let lowStartIdx = words.length - 1;
        while (lowStartIdx > 0) {
          const w = words[lowStartIdx - 1]!;
          const sc = ('score' in w && typeof w.score === 'number') ? w.score : (('conf' in w && typeof w.conf === 'number') ? w.conf : 1.0);
          if (sc <= 0.30) {
            lowStartIdx--;
          } else {
            break;
          }
        }
        const lowWords = words.slice(lowStartIdx);
        if (lowWords.length >= 2) {
          const tailSylCount = lowWords.reduce((s, w) => s + (w.syl?.length ?? 1), 0);
          const tailStart = lowStartIdx > 0 ? words[lowStartIdx - 1]!.end : words[0]!.start;
          const tailEnd = (line.end && line.end > tailStart + 0.30) ? line.end : wLast.end;
          const tailEdges = edges.filter(e => tailStart - 0.05 <= e.t && e.t <= tailEnd - 0.05 && e.prob >= 0.55);
          const distinctTail: number[] = [];
          for (const e of tailEdges.sort((a, b) => a.t - b.t)) {
            if (distinctTail.length === 0 || e.t - distinctTail[distinctTail.length - 1]! >= 0.22) {
              distinctTail.push(round3(e.t));
            }
          }
          if (distinctTail.length >= tailSylCount) {
            const cuts = [...distinctTail.slice(0, tailSylCount), round3(tailEnd)];
            let cutIdx = 0;
            for (const w of lowWords) {
              const nS = w.syl?.length ?? 1;
              if (w.syl) {
                for (let si = 0; si < nS; si++) {
                  w.syl[si]![0] = cuts[cutIdx]!;
                  w.syl[si]![1] = cuts[cutIdx + 1]!;
                  cutIdx++;
                }
                w.start = w.syl[0]![0];
                w.end = w.syl[nS - 1]![1];
              } else {
                w.start = cuts[cutIdx]!;
                w.end = cuts[cutIdx + nS]!;
                cutIdx += nS;
              }
            }
          }
        }
      }
    }


    // Stage 0e: De-squash collapsed proclitic before multi-syllable content word
    for (let wi = 0; wi < words.length - 1; wi++) {
      const wCur = words[wi]!;
      const wNxt = words[wi + 1]!;
      const wText = (wCur.w ?? wCur.text ?? '').toLowerCase().trim();
      if (PROCLITICS.has(wText) && (wCur.end - wCur.start < 0.08) && (wNxt.syl?.length ?? 1) >= 2) {
        const pool = rmvpeNotes.concat(harmoNotes);
        const sStart = line.start ?? words[0]!.start;
        const prevEnd = wi > 0 ? words[wi - 1]!.end : (sStart - 0.05);
        const minCandStart = wi > 0 ? prevEnd + 0.04 : sStart - 0.05;
        const candNotes = pool.filter(pn => minCandStart <= pn.start && pn.start <= wNxt.end - 0.20);
        const distinctNotes: number[] = [];
        for (const pn of candNotes.sort((a, b) => a.start - b.start)) {
          if (distinctNotes.length === 0 || pn.start - distinctNotes[distinctNotes.length - 1]! >= 0.22) {
            distinctNotes.push(round3(pn.start));
          }
        }
        if (distinctNotes.length >= 2) {
          const t0 = distinctNotes[0]!;
          const t1 = distinctNotes[1]!;
          if (t0 >= minCandStart && t1 > t0 + 0.15) {
            wCur.start = t0;
            wCur.end = t1;
            if (wCur.syl && wCur.syl.length > 0) {
              wCur.syl[0]![0] = t0;
              wCur.syl[0]![1] = t1;
            }
            wNxt.start = t1;
            if (wNxt.syl && wNxt.syl.length > 0) {
              wNxt.syl[0]![0] = t1;
            }
          }
        }
      }
    }

    // Stage 0a2: Check if word 0 was squashed (< 0.060s) absorbed into word 1
    if (words.length >= 2) {
      const w0 = words[0]!;
      const w1 = words[1]!;
      if (w0.end - w0.start < 0.060) {
        const pitchPool = rmvpeNotes.concat(swiftNotes);
        const transitionNotes = pitchPool.filter(pn => w0.start + 0.10 <= pn.start && pn.start <= w1.end);
        if (transitionNotes.length > 0) {
          const splitNote = transitionNotes[0]!;
          let splitT = round3(splitNote.start);
          const nearB = qArr.filter(b => Math.abs(b - splitT) <= 0.06);
          if (nearB.length > 0) splitT = round3(nearB[0]!);
          w0.end = splitT;
          if (w0.syl && w0.syl.length > 0) {
            w0.syl[w0.syl.length - 1]![1] = splitT;
          }
          w1.start = splitT;
          if (w1.syl && w1.syl.length > 0) {
            w1.syl[0]![0] = splitT;
          }
          // If w1 duration became very short (< 0.15s) while w1+w2 span >= 0.45s to next beat
          if (words.length >= 3) {
            const w2 = words[2]!;
            const totalSpan = w2.end - w1.start;
            const w1Dur = w1.end - w1.start;
            if (w1Dur < 0.15 && totalSpan >= 0.45) {
              const midNotes = pitchPool.filter(pn => w1.start + 0.20 <= pn.start && pn.start <= w2.end - 0.10);
              if (midNotes.length > 0) {
                let midT = round3(midNotes[0]!.start);
                const nearMidB = qArr.filter(b => Math.abs(b - midT) <= 0.06);
                if (nearMidB.length > 0) midT = round3(nearMidB[0]!);
                w1.end = midT;
                if (w1.syl && w1.syl.length > 0) {
                  w1.syl[w1.syl.length - 1]![1] = midT;
                }
                w2.start = midT;
                if (w2.syl && w2.syl.length > 0) {
                  w2.syl[0]![0] = midT;
                }
              }
            }
          }
        }
      } else if (w1.end - w1.start < 0.060 && w0.end - w0.start >= 0.40) {
        const pitchPool = rmvpeNotes.concat(swiftNotes);
        const transitionNotes = pitchPool.filter(pn => w0.start + 0.15 <= pn.start && pn.start <= w1.end - 0.04);
        if (transitionNotes.length > 0) {
          let splitT = round3(transitionNotes[transitionNotes.length - 1]!.start);
          const allBeats = qArr.concat(eArr);
          const nearB = allBeats.filter(b => Math.abs(b - splitT) <= 0.06);
          if (nearB.length > 0) splitT = round3(nearB[0]!);
          w0.end = splitT;
          if (w0.syl && w0.syl.length > 0) {
            w0.syl[w0.syl.length - 1]![1] = splitT;
          }
          w1.start = splitT;
          if (w1.syl && w1.syl.length > 0) {
            w1.syl[0]![0] = splitT;
          }
        }
      }
    }

    // Stage 0b: Check if the final word of the line was squashed (< 0.100s or first syllable <= 0.080s) by an elongated predecessor
    if (words.length >= 2) {
      const wLast = words[words.length - 1]!;
      const wPrev = words[words.length - 2]!;
      const wLastFirstSylDur = wLast.syl && wLast.syl.length >= 2 ? wLast.syl[0]![1] - wLast.syl[0]![0] : 1.0;
      const isSquashedOpener = wLast.syl && wLast.syl.length >= 2 && wLastFirstSylDur <= 0.080;
      if ((wLast.end - wLast.start < 0.100 || isSquashedOpener) && wPrev.end - wPrev.start > 0.35) {
        const pitchPool = rmvpeNotes.concat(swiftNotes);
        if (pitchPool.length > 0) {
          const cands = pitchPool
            .filter(pn => wPrev.start + 0.15 <= pn.start && pn.start <= wLast.end - 0.20)
            .sort((a, b) => a.start - b.start);
          if (cands.length > 0) {
            const chosenNote = isSquashedOpener ? cands[0]! : cands[cands.length - 1]!;
            let splitT = round3(chosenNote.start);
            const allBeats = qArr.concat(allGrid);
            const nearB = allBeats.filter(b => Math.abs(b - splitT) <= 0.06);
            if (nearB.length > 0) splitT = round3(nearB[0]!);
            wPrev.end = splitT;
            if (wPrev.syl && wPrev.syl.length > 0) {
              wPrev.syl[wPrev.syl.length - 1]![1] = splitT;
            }
            wLast.start = splitT;
            if (wLast.syl && wLast.syl.length > 0) {
              wLast.syl[0]![0] = splitT;
              if (isSquashedOpener) {
                const noteRelease = round3(chosenNote.end);
                const nearReleaseB = allBeats.filter(b => Math.abs(b - noteRelease) <= 0.06);
                const sylEnd = nearReleaseB.length > 0 ? round3(nearReleaseB[0]!) : noteRelease;
                if (sylEnd > splitT + 0.12 && sylEnd < wLast.end - 0.10) {
                  wLast.syl[0]![1] = sylEnd;
                  wLast.syl[1]![0] = sylEnd;
                }
              }
            }
          }
        }
      }
    }

    // Stage 0c: Proclitic Pickup Re-anchoring
    // If an unstressed monosyllabic proclitic (e.g. 'the', 'a', 'to') is detached from its head word
    // by a long gap (> 0.35s) while vocal pitch is actively sung in that gap, the aligner confused
    // an earlier elongated vowel with the proclitic. The true proclitic is the pickup note directly preceding the head word.
    for (let wi = 0; wi < words.length - 1; wi++) {
      const w = words[wi]!;
      const wNxt = words[wi + 1]!;
      const prevL = li > 0 ? refinedLines[li - 1]! : null;
      const wPrev = wi > 0 ? words[wi - 1]! : (prevL && prevL.words ? prevL.words[prevL.words.length - 1]! : null);
      const wText = (w.w ?? w.text ?? '').toLowerCase();
      if (PROCLITICS.has(wText) && (w.syl?.length ?? 1) === 1) {
        const gap = wNxt.start - w.end;
        let curDur = w.end - w.start;
        const allowShift = wi === 0 ? gap > 0.35 : (gap > 0.35 && curDur >= 0.28);
        if (allowShift) {
          const pitchPool = rmvpeNotes.concat(swiftNotes);
          const notesInGap = pitchPool.filter(pn => w.end - 0.05 <= pn.start && pn.start <= wNxt.start + 0.05);
          if (notesInGap.length > 0) {
            const cands = notesInGap.filter(pn => Math.abs(pn.start - wNxt.start) <= 0.25 || (wNxt.start - 0.35 <= pn.start && pn.start <= wNxt.start));
            if (cands.length > 0) {
              const pickup = cands[cands.length - 1]!;
              const pickupStart = round3(pickup.start);
              const newStart = pickupStart;
              let newEnd = round3(Math.max(newStart + 0.15, wNxt.start));
              if (wNxt.start <= newStart + 0.05) {
                const nxtNotes = pitchPool.filter(pn => newStart + 0.08 <= pn.start && pn.start <= newStart + 0.22);
                const nxtShift = nxtNotes.length > 0 ? round3(nxtNotes[0]!.start - newStart) : 0.14;
                wNxt.start = round3(newStart + nxtShift);
                if (wNxt.syl && wNxt.syl.length > 0) {
                  wNxt.syl[0]![0] = wNxt.start;
                  if (wNxt.syl[0]![1] < wNxt.start) {
                    wNxt.syl[0]![1] = wNxt.start;
                  }
                }
                newEnd = wNxt.start;
              }
              w.start = newStart;
              w.end = newEnd;
              if (w.syl && w.syl.length > 0) {
                w.syl[0]![0] = newStart;
                w.syl[0]![1] = newEnd;
              }
              if (wPrev) {
                wPrev.end = newStart;
                // Detect if wPrev actually starts at a vocal pitch note attack after a breath pause
              const pBound = wi >= 2 ? words[wi - 2]!.end : (words[0] === wPrev ? words[0]!.start : line.start);
              const pNotes = pitchPool
                .filter(pn => pBound - 0.05 <= pn.start && pn.start <= newStart - 0.20)
                .sort((a, b) => a.start - b.start);
              if (pNotes.length > 0) {
                for (let k = 0; k < pNotes.length - 1; k++) {
                  if (pNotes[k + 1]!.start - pNotes[k]!.end >= 0.10 && pNotes[k + 1]!.start > wPrev.start + 0.15) {
                    let adjStart = round3(pNotes[k + 1]!.start);
                    const nearBeat = qArr.filter(b => Math.abs(b - adjStart) <= 0.14);
                    if (nearBeat.length > 0) adjStart = round3(nearBeat[0]!);
                    wPrev.start = adjStart;
                    break;
                  }
                }
              }
              if (wPrev.syl && wPrev.syl.length > 0) {
                wPrev.syl[0]![0] = wPrev.start;
                wPrev.syl[wPrev.syl.length - 1]![1] = newStart;
                const nPrev = wPrev.syl.length;
                if (nPrev === 3 && (newStart - wPrev.start) >= 1.20) {
                  const bDur = getLocalBeatDur(wPrev.start);
                  // 1 beat prefix (0.30s), 2 beats stressed root (0.60s), remainder suffix
                  const b1 = round3(wPrev.start + bDur);
                  const b2 = round3(wPrev.start + 3 * bDur);
                  wPrev.syl[0]![0] = wPrev.start;
                  wPrev.syl[0]![1] = b1;
                  wPrev.syl[1]![0] = b1;
                  wPrev.syl[1]![1] = b2;
                  wPrev.syl[2]![0] = b2;
                  wPrev.syl[2]![1] = newStart;
                } else if (nPrev > 1) {
                  // Find distinct pitch note attacks in [wPrev.start + 0.18, newStart - 0.15]
                  const candAttacks = pNotes
                    .filter(pn => wPrev.start + 0.18 <= pn.start && pn.start <= newStart - 0.15)
                    .map(pn => {
                      let t = round3(pn.start);
                      const nearB = qArr.filter(b => Math.abs(b - t) <= 0.08);
                      return nearB.length > 0 ? round3(nearB[0]!) : t;
                    });
                  const dedupSplits: number[] = [];
                  for (const t of candAttacks) {
                    if (dedupSplits.length === 0 || t - dedupSplits[dedupSplits.length - 1]! >= 0.22) {
                      dedupSplits.push(t);
                    }
                  }
                  if (dedupSplits.length >= nPrev - 1) {
                    let cur = wPrev.start;
                    for (let si = 0; si < nPrev; si++) {
                      const nxt = si === nPrev - 1 ? newStart : dedupSplits[si]!;
                      wPrev.syl[si]![0] = cur;
                      wPrev.syl[si]![1] = nxt;
                      cur = nxt;
                    }
                  } else {
                    const step = (newStart - wPrev.start) / nPrev;
                    let cur = wPrev.start;
                    for (let si = 0; si < nPrev; si++) {
                      const nxt = si === nPrev - 1 ? newStart : round3(cur + step);
                      wPrev.syl[si]![0] = cur;
                      wPrev.syl[si]![1] = nxt;
                      cur = nxt;
                    }
                  }
                }
              }
              }
            }
          }
        }
        curDur = w.end - w.start;
        const prevDur = wPrev ? wPrev.end - wPrev.start : 0.30;
        if (wPrev && gap <= 0.35 && curDur >= 0.30 && prevDur <= 0.10) {
          const pitchPool = rmvpeNotes.concat(swiftNotes);
          const spanNotes = pitchPool
            .filter(pn => wPrev.start - 0.05 <= pn.start && pn.start <= w.end + 0.05)
            .sort((a, b) => a.start - b.start);
          const dedup: ConsensusNote[] = [];
          for (const pn of spanNotes) {
            if (dedup.length === 0 || pn.start - dedup[dedup.length - 1]!.start >= 0.15) {
              dedup.push(pn);
            }
          }
          if (dedup.length >= 2) {
            const pickupNote = dedup[dedup.length - 1]!;
            const prevNote = dedup[dedup.length - 2]!;
            const newStart = round3(pickupNote.start);
            w.start = newStart;
            if (w.syl && w.syl.length > 0) {
              w.syl[0]![0] = newStart;
            }
            wPrev.start = round3(prevNote.start);
            wPrev.end = newStart;
            if (wPrev.syl && wPrev.syl.length > 0) {
              wPrev.syl[0]![0] = wPrev.start;
              wPrev.syl[wPrev.syl.length - 1]![1] = wPrev.end;
            }
            if (wi >= 2 && words[wi - 2]!.end > wPrev.start) {
              words[wi - 2]!.end = wPrev.start;
              const prev2Syl = words[wi - 2]!.syl;
              if (prev2Syl && prev2Syl.length > 0) {
                prev2Syl[prev2Syl.length - 1]![1] = wPrev.start;
              }
            }
          }
        }
      }
    }



    // --- STAGE 1: SENTENCE-LEVEL TIMING ANCHORING ---
    const rawSentenceStart = words[0]!.start;
    const rawVowelStart = (words[0]!.syl && words[0]!.syl.length > 0) ? words[0]!.syl[0]![0] : rawSentenceStart;
    const interSentenceGap = rawSentenceStart - prevLineEnd;
    let sentenceStart = rawSentenceStart;

    // Check for Speech Aligner Backward Bleed on Multi-Syllable Phrase Openers
    if (
      li > 0 &&
      words[0]!.syl &&
      words[0]!.syl.length > 1 &&
      words[0]!.syl[0]![1] - words[0]!.syl[0]![0] >= 0.5 &&
      prevLineEnd - words[0]!.syl[0]![0] >= 0.15
    ) {
      const s0End = words[0]!.syl[0]![1];
      const boundaryT = round3((prevLineEnd + s0End) / 2.0);
      sentenceStart = boundaryT;

      refinedLines[li - 1]!.end = sentenceStart;
      const prevWords = refinedLines[li - 1]!.words;
      if (prevWords && prevWords.length > 0) {
        const prevLastW = prevWords[prevWords.length - 1]!;
        prevLastW.end = sentenceStart;
        if (prevLastW.syl && prevLastW.syl.length > 0) {
          prevLastW.syl[prevLastW.syl.length - 1]![1] = sentenceStart;
        }
      }

      words[0]!.syl[0]![0] = sentenceStart;
      if (words[0]!.syl[0]![1] <= sentenceStart) {
        words[0]!.syl[0]![1] = round3(sentenceStart + 0.15);
      }
    } else if (interSentenceGap >= 0.2) {
      let prolongedNoteStart: number | null = null;
      const w0Text = (words[0]!.w ?? words[0]!.text ?? '').toLowerCase().trim();
      const isVowelOpener = /^[aeiou]/.test(w0Text);
      if (interSentenceGap >= 0.50 && isVowelOpener && (words[0]!.syl?.length ?? 1) === 1) {
        const pool = harmoNotes.concat(rmvpeNotes);
        const heldNotes = pool.filter(pn => 
          prevLineEnd + 0.04 <= pn.start && pn.start <= rawSentenceStart - 0.30 &&
          pn.end >= rawSentenceStart - 0.05 && (pn.end - pn.start >= 0.40)
        );
        if (heldNotes.length > 0) {
          prolongedNoteStart = round3(heldNotes.sort((a, b) => a.start - b.start)[0]!.start);
        }
      }

      const swCands = swiftNotes
        .map(sn => sn.start)
        .filter(st => sentenceStart - 0.08 <= st && st <= rawVowelStart + 0.02 && st > prevLineEnd + 0.04 && !consumedSwiftOnsets.has(st));

      if (prolongedNoteStart !== null) {
        sentenceStart = prolongedNoteStart;
      } else if (swCands.length > 0) {
        sentenceStart = Math.min(...swCands);
        consumedSwiftOnsets.add(sentenceStart);
      } else if (rmvpeNotes.length > 0) {
        const rCands = rmvpeNotes
          .map(rn => rn.start)
          .filter(st => sentenceStart - 0.08 <= st && st <= rawVowelStart + 0.02 && st > prevLineEnd + 0.04 && !consumedRmvpeOnsets.has(st));
        if (rCands.length > 0) {
          sentenceStart = Math.min(...rCands);
          consumedRmvpeOnsets.add(sentenceStart);
        }
      } else if (harmoNotes.length > 0) {
        const hCands = harmoNotes
          .map(hn => hn.start)
          .filter(st => sentenceStart - 0.08 <= st && st <= rawVowelStart + 0.02 && st > prevLineEnd + 0.04 && !consumedHarmoOnsets.has(st));
        if (hCands.length > 0) {
          sentenceStart = Math.min(...hCands);
          consumedHarmoOnsets.add(sentenceStart);
        }
      }
    } else {
      const pPool = swiftNotes.length > 0 ? swiftNotes : (rmvpeNotes.length > 0 ? rmvpeNotes : harmoNotes);
      const consumed = swiftNotes.length > 0 ? consumedSwiftOnsets : (rmvpeNotes.length > 0 ? consumedRmvpeOnsets : consumedHarmoOnsets);
      const cands = pPool.map(pn => pn.start).filter(st => Math.abs(st - sentenceStart) <= 0.04 && !consumed.has(st));
      if (cands.length > 0) {
        const best = cands.reduce((prev, curr) => Math.abs(curr - sentenceStart) < Math.abs(prev - sentenceStart) ? curr : prev);
        sentenceStart = best;
        consumed.add(best);
      }
    }

    sentenceStart = round3(sentenceStart);

    // --- STAGE 2: INTERNAL SYLLABLE TIMING REFINEMENT ---
    let lastSylEnd = sentenceStart;

    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi]!;
      const syls = w.syl ?? [];
      const nSyls = syls.length;

      for (let si = 0; si < nSyls; si++) {
        const s = syls[si]!;
        const sRawDur = s[1] - s[0];
        let curSt = s[0];
        let minAllowedStart = lastSylEnd;

        const lineShift = sentenceStart - rawSentenceStart;
        const shiftVal = lineShift >= 0.080 ? lineShift : 0;
        if (wi === 0 && si === 0) {
          curSt = sentenceStart;
        } else {
          curSt = s[0] + shiftVal;
          const pWord = wi > 0 ? words[wi - 1]! : null;
          const pSyl = si > 0
            ? syls[si - 1]!
            : (pWord && pWord.syl && pWord.syl.length > 0 ? pWord.syl[pWord.syl.length - 1]! : null);
          const prevSylStart = pSyl ? pSyl[0] : (pWord ? pWord.start : 0);
          const prevSylEnd = pSyl ? pSyl[1] : (pWord ? pWord.end : 0);
          const prevSylDur = (si > 0 || wi > 0) ? prevSylEnd - prevSylStart : 0;
          const minPrevHold = si > 0 ? 0.12 : 0.18;

          minAllowedStart = (prevSylDur > minPrevHold + 0.10)
            ? prevSylStart + minPrevHold
            : lastSylEnd;
          const pPoolBack = rmvpeNotes.concat(harmoNotes);
          const pnAtPrevEnd = (curSt - prevSylEnd >= 0.20)
            ? (rmvpeNotes.find(pn => (Math.abs(pn.start - prevSylEnd) <= 0.12 || (pn.start >= prevSylEnd - 0.05 && pn.end >= curSt - 0.05)) && pn.end >= prevSylEnd + 0.15 && pn.start <= curSt - 0.12) ||
               harmoNotes.find(pn => (Math.abs(pn.start - prevSylEnd) <= 0.12 || (pn.start >= prevSylEnd - 0.05 && pn.end >= curSt - 0.05)) && pn.end >= prevSylEnd + 0.15 && pn.start <= curSt - 0.12))
            : undefined;
          if (pnAtPrevEnd && prevSylDur < 0.70) {
            curSt = pnAtPrevEnd.start;
          }
          const winPast = pnAtPrevEnd
            ? Math.min(0.60, curSt - prevSylEnd + 0.04)
            : ((prevSylDur > minPrevHold + 0.10)
              ? Math.min(0.22, prevSylDur - minPrevHold)
              : 0.045);
          const wText = (w.w ?? w.text ?? '').toLowerCase();
          const hasUnvoicedOnset = si === 0 && /^(s|st|sp|sk|str|sh|f|th|p|t|k|ch|ts|hi|fu)/.test(wText);
          const hasFutureBeatNote = sRawDur >= 0.50 && qArr.some(b => curSt + 0.12 <= b && b <= curSt + 0.28 && hasVocalPitchNear(b, 0.05));
          const maxFuture = (nSyls > 1 && sRawDur >= 0.50)
            ? 0.40
            : (hasFutureBeatNote ? 0.26 : (hasUnvoicedOnset ? 0.17 : (nSyls > 1 ? 0.16 : 0.14)));
          const winFuture = hasFutureBeatNote
            ? 0.26
            : (hasUnvoicedOnset
              ? Math.max(0.14, Math.min(maxFuture, sRawDur * 0.8))
              : Math.max(0.06, Math.min(maxFuture, sRawDur * 0.45)));
          let found = false;
          if (swiftNotes.length > 0) {
            const sCand = swiftNotes
              .map(sn => sn.start)
              .filter(st => -winPast <= st - curSt && st - curSt <= winFuture && !consumedSwiftOnsets.has(st) && st >= minAllowedStart - 0.045 && hasVocalPitchNear(st, 0.070));
            const rCandEarly = (rmvpeNotes || [])
              .map(rn => rn.start)
              .filter(st => -winPast <= st - curSt && st - curSt <= winFuture && !consumedRmvpeOnsets.has(st) && st >= minAllowedStart - 0.045);

            let preferRmvpe = false;
            let bestR = 0;
            if (rCandEarly.length > 0 && sCand.length > 0) {
              const getRDiff = (r: number) => {
                const d = Math.abs(r - curSt);
                const onBeat = qArr.some(b => Math.abs(b - r) <= 0.035);
                return (r < curSt - 0.05 && !onBeat) ? d * 1.5 : (onBeat ? d * 0.7 : d);
              };
              bestR = rCandEarly[0]!;
              let minRDiff = getRDiff(bestR);
              for (const r of rCandEarly) {
                const diff = getRDiff(r);
                if (diff < minRDiff) { minRDiff = diff; bestR = r; }
              }
              let minSDiff = Math.abs(sCand[0]! - curSt);
              for (const s of sCand) {
                if (Math.abs(s - curSt) < minSDiff) { minSDiff = Math.abs(s - curSt); }
              }
              const rOnBeat = qArr.some(b => Math.abs(b - bestR) <= 0.035);
              const swInPast = sCand.every(s => s < curSt - 0.05);
              if ((minRDiff <= 0.045 && minSDiff >= minRDiff + 0.040 && sCand.some(s => s > curSt + 0.035)) ||
                  (minSDiff >= 0.15 && minRDiff <= minSDiff - 0.10) ||
                  (rOnBeat && swInPast && minRDiff <= minSDiff + 0.04)) {
                preferRmvpe = true;
              }
            }

            if (preferRmvpe) {
              curSt = bestR;
              consumedRmvpeOnsets.add(bestR);
              found = true;
            } else if (sCand.length > 0) {
              let bestSw = sCand[0]!;
              const getDiff = (c: number, tgt: number) => c < tgt - 0.03 ? (tgt - c) * 1.35 : (c - tgt);
              let minDiff = getDiff(bestSw, curSt);
              for (const cand of sCand) {
                const diff = getDiff(cand, curSt);
                if (diff < minDiff) {
                  minDiff = diff;
                  bestSw = cand;
                }
              }
              curSt = bestSw;
              consumedSwiftOnsets.add(bestSw);
              found = true;
            }
          }

          if (!found && rmvpeNotes.length > 0) {
            const rCand = rmvpeNotes
              .map(rn => rn.start)
              .filter(st => -winPast <= st - curSt && st - curSt <= winFuture && !consumedRmvpeOnsets.has(st) && st >= minAllowedStart - 0.045);
            if (rCand.length > 0) {
              let bestR = rCand[0]!;
              const getDiff = (c: number, tgt: number) => c < tgt - 0.03 ? (tgt - c) * 1.35 : (c - tgt);
              let minDiff = getDiff(bestR, curSt);
              for (const cand of rCand) {
                const diff = getDiff(cand, curSt);
                if (diff < minDiff) {
                  minDiff = diff;
                  bestR = cand;
                }
              }
              const hNoteAtPrev = harmoNotes.find(hn => Math.abs(hn.start - prevSylEnd) <= 0.05 && hn.end >= prevSylEnd + 0.15);
              const rNoteObj = rmvpeNotes.find(rn => Math.abs(rn.start - bestR) <= 0.01);
              const isShortR = rNoteObj && (rNoteObj.end - rNoteObj.start < 0.10);
              const hSustained = isShortR ? harmoNotes.find(hn => -winPast <= hn.start - curSt && hn.start - curSt <= winFuture && (hn.end - hn.start >= 0.25) && !consumedHarmoOnsets.has(hn.start) && hn.start >= minAllowedStart - 0.045) : null;
              if (bestR - prevSylEnd >= 0.25 && hNoteAtPrev) {
                curSt = round3(hNoteAtPrev.start);
                consumedHarmoOnsets.add(hNoteAtPrev.start);
              } else if (hSustained) {
                curSt = round3(hSustained.start);
                consumedHarmoOnsets.add(hSustained.start);
              } else {
                curSt = bestR;
                consumedRmvpeOnsets.add(bestR);
              }
              found = true;
            }
          }

          if (!found && harmoNotes.length > 0) {
            const hCand = harmoNotes
              .map(hn => hn.start)
              .filter(st => -winPast <= st - curSt && st - curSt <= winFuture && !consumedHarmoOnsets.has(st) && st >= minAllowedStart - 0.045);
            if (hCand.length > 0) {
              let bestH = hCand[0]!;
              const getDiff = (c: number, tgt: number) => c < tgt - 0.03 ? (tgt - c) * 1.35 : (c - tgt);
              let minDiff = getDiff(bestH, curSt);
              for (const cand of hCand) {
                const diff = getDiff(cand, curSt);
                if (diff < minDiff) {
                  minDiff = diff;
                  bestH = cand;
                }
              }
              curSt = bestH;
              consumedHarmoOnsets.add(bestH);
              found = true;
            }
          }
        }

        if (curSt < lastSylEnd && curSt >= minAllowedStart) {
          if (si > 0) {
            syls[si - 1]![1] = curSt;
          } else if (wi > 0 && words[wi - 1]) {
            const pW = words[wi - 1]!;
            pW.end = curSt;
            if (pW.syl && pW.syl.length > 0) {
              pW.syl[pW.syl.length - 1]![1] = curSt;
            }
          }
          lastSylEnd = curSt;
        }
        curSt = Math.max(curSt, (wi > 0 || si > 0) ? lastSylEnd : curSt);
        let curEn = Math.max(s[1], curSt + Math.max(0.06, sRawDur * 0.5));

        // Harmo sustain release extension: extend vowels that speech HuBERT closed early
        if (harmoNotes.length > 0) {
          for (const hn of harmoNotes) {
            if (hn.start <= curEn && curEn <= hn.end + 0.05 && hn.end > curEn + 0.08) {
              // Large extension (> 0.20s) requires RMVPE vocal pitch confirmation
              const extLen = hn.end - curEn;
              const hasRmvpeConfirm = extLen <= 0.20 || !rmvpeNotes || rmvpeNotes.length === 0 ||
                rmvpeNotes.some(rn => Math.max(curEn, rn.start) <= Math.min(hn.end, rn.end) + 0.04);
              if (hasRmvpeConfirm && si === nSyls - 1) {
                if (wi === words.length - 1) {
                  const nxtLineRawStart = li + 1 < refinedLines.length ? refinedLines[li + 1]!.start : Infinity;
                  const maxLineEn = (line.end && line.end > curSt + 0.10)
                    ? Math.min(round3(line.end + 0.08), nxtLineRawStart)
                    : nxtLineRawStart;
                  curEn = round3(Math.min(hn.end, maxLineEn));
                } else if (wi + 1 < words.length && words[wi + 1]!.start > hn.end - 0.05) {
                  curEn = round3(hn.end);
                }
              }
              break;
            }
          }
        }


        // Acoustic breath clamp: clamp word release at onset of detected breath pause
        if (breaths.length > 0 && si === nSyls - 1) {
          const b = breaths.find(br => br.start >= curSt + 0.10 && br.start < curEn && curEn <= br.end + 0.15);
          if (b && curEn - b.start >= 0.08) {
            curEn = round3(b.start);
          }
        }

        // Musical beat grid offset snap: clamp trailing vocal release if within 40ms
        if (allGrid.length > 0) {
          const closestG = findClosest(allGrid, curEn);
          if (Math.abs(closestG - curEn) <= 0.030 && closestG > curSt + 0.08) {
            curEn = closestG;
          }
        }
        curEn = Math.max(curEn, curSt + 0.06);
        s[0] = round3(curSt);
        s[1] = round3(curEn);
        lastSylEnd = s[1];
      }

      // Ensure contiguous syllables inside word
      for (let k = 0; k < syls.length - 1; k++) {
        if (syls[k]![1] !== syls[k + 1]![0]) {
          const midT = round3((syls[k]![1] + syls[k + 1]![0]) / 2.0);
          syls[k]![1] = midT;
          syls[k + 1]![0] = midT;
        }
      }

      if (syls.length > 0) {
        if (wi === 0) {
          w.start = sentenceStart;
        } else {
          w.start = syls[0]![0];
        }
        w.end = syls[syls.length - 1]![1];
      }
    }

    // Stage 2b: Dynamic AI Sub-Beat & Note Duration Quantization
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi]!;
      const syls = w.syl ?? [];
      for (let si = 0; si < syls.length; si++) {
        let st = syls[si]![0];
        let en = syls[si]![1];
        const localQuarter = getLocalBeatDur(st);
        const local16th = localQuarter / 4.0;
        const snapTolSt = Math.max(0.025, Math.min(0.035, local16th * 0.22));
        const snapTolDur = 0.02;

        // Snap start to nearest point on dynamic AI grid
        if (dynamicGrid.length > 0) {
          const candSt = findClosest(dynamicGrid, st);
          const prevBound = si > 0
            ? syls[si - 1]![1]
            : (wi > 0 ? words[wi - 1]!.end : (li > 0 ? refinedLines[li - 1]!.end : 0.0));
          if (Math.abs(candSt - st) <= snapTolSt && candSt >= prevBound - 0.005 && (en - candSt >= 0.06)) {
            st = candSt;
            syls[si]![0] = st;
          }
        }

        // Snap duration to local musical multiples (16th, 8th, dotted 8th, 1/4, dotted 1/4, 1/2)
        const dur = en - st;
        const multipliers = [1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18];
        const localNoteDurs = multipliers.map(m => m * local16th);
        const closestD = findClosest(localNoteDurs, dur);
        if (Math.abs(closestD - dur) <= snapTolDur) {
          const nxtBound = (si < syls.length - 1)
            ? syls[si + 1]![0]
            : ((wi < words.length - 1)
              ? words[wi + 1]!.start
              : ((li < refinedLines.length - 1) ? refinedLines[li + 1]!.start : en + 1.0));
          const targetEn = round3(st + closestD);
          if (targetEn <= nxtBound + 0.005 && (targetEn - st >= 0.06)) {
            syls[si]![1] = targetEn;
          }
        }
      }
      if (syls.length > 0) {
        w.start = wi === 0 ? sentenceStart : syls[0]![0];
        w.end = syls[syls.length - 1]![1];
      }
    }

    // Stage 2c: Isomorphic Consecutive Syllable Duration Equalization
    interface SylInfo {
      s: [number, number];
      word: string;
      isProclitic: boolean;
    }
    const lineSylInfos: SylInfo[] = [];
    for (const w of words) {
      const wText = (w.w ?? w.text ?? '').toLowerCase().trim();
      const isProc = /^(the|a|an|to|at|in|of|from|for|on|with)$/i.test(wText);
      if (w.syl) {
        for (const s of w.syl) {
          lineSylInfos.push({ s, word: wText, isProclitic: isProc });
        }
      }
    }

    const pPool2c = swiftNotes.concat(rmvpeNotes);

    for (let si = 0; si < lineSylInfos.length - 1; si++) {
      const info0 = lineSylInfos[si]!;
      const info1 = lineSylInfos[si + 1]!;
      const s0 = info0.s;
      const s1 = info1.s;
      const d0 = s0[1] - s0[0];
      const d1 = s1[1] - s1[0];
      const localQ = getLocalBeatDur(s0[0]);
      const localE = localQ / 2.0;

      // Local 2-beat pair: if total span is ~2 beats, split at the musical beat
      const totalSpan = s1[1] - s0[0];
      if (localQ * 1.8 <= totalSpan && totalSpan <= localQ * 2.2) {
        const targetMid = s0[0] + localQ;
        const candBeats = qArr.filter(b => Math.abs(b - targetMid) <= Math.max(0.045, localE * 0.50));
        const mid = candBeats.length > 0 ? round3(candBeats[0]!) : round3(targetMid);

        // Guard: If s0 is an unstressed proclitic and s1 already has a melodic pitch onset inside the beat, do not push s1 forward to the beat
        const hasPriorAttack = info0.isProclitic && pPool2c.some(pn => s0[0] + 0.08 <= pn.start && pn.start <= mid - 0.04);
        const s1AlreadyOnBeat = (info0.word !== info1.word) && qArr.some(b => Math.abs(b - s1[0]) <= 0.035);

        // Sub-beat 1-eighth or 3-eighth dotted/asymmetric rhythm check
        const t1E = s0[0] + localE;
        const t3E = s0[0] + localE * 3.0;
        const sub1E = allGrid.filter(b => Math.abs(b - t1E) <= 0.045);
        const sub3E = allGrid.filter(b => Math.abs(b - t3E) <= 0.045);
        const cand1E = sub1E.length > 0 ? round3(sub1E[0]!) : round3(t1E);
        const cand3E = sub3E.length > 0 ? round3(sub3E[0]!) : round3(t3E);

        const has1E = (edges && edges.some(e => e.prob >= 0.65 && Math.abs(e.t - cand1E) <= 0.055)) ||
          pPool2c.some(pn => Math.abs(pn.start - cand1E) <= 0.045);
        const has3E = (edges && edges.some(e => e.prob >= 0.65 && Math.abs(e.t - cand3E) <= 0.055)) ||
          pPool2c.some(pn => Math.abs(pn.start - cand3E) <= 0.045);
        const hasMidPitch = pPool2c.some(pn => Math.abs(pn.start - mid) <= 0.045);
        const maxTol = Math.min(0.14, localE * 0.45);

        if (!hasPriorAttack && !s1AlreadyOnBeat) {
          if (!hasMidPitch && has1E && d1 > 1.8 * d0 && Math.abs(s1[0] - cand1E) <= maxTol) {
            s0[1] = cand1E;
            s1[0] = cand1E;
          } else if (!hasMidPitch && has3E && d0 > 1.8 * d1 && Math.abs(s1[0] - cand3E) <= maxTol) {
            s0[1] = cand3E;
            s1[0] = cand3E;
          } else if ((d0 > 1.8 * d1 || d1 > 1.8 * d0) || (localQ * 0.8 <= d0 && d0 <= localQ * 1.2 && localQ * 0.8 <= d1 && d1 <= localQ * 1.2)) {
            if (mid - s0[0] >= 0.10 && s1[1] - mid >= 0.10) {
              s0[1] = mid;
              s1[0] = mid;
            }
          }
        }
      } else if (localQ * 1.3 <= totalSpan && totalSpan <= localQ * 1.65 && d0 < localQ * 0.7 && d1 >= localE * 1.3) {
        const targetMid = s0[0] + localQ;
        const candBeats = qArr.filter(b => Math.abs(b - targetMid) <= Math.max(0.065, localE * 0.65));
        if (candBeats.length > 0) {
          const mid = round3(candBeats[0]!);
          const hasPitchNearBeat = pPool2c.some(pn => Math.abs(pn.start - mid) <= 0.08) ||
            (edges && edges.some(e => e.prob >= 0.55 && Math.abs(e.t - mid) <= 0.06));
          if (hasPitchNearBeat && mid - s0[0] >= 0.20 && s1[1] - mid >= 0.08) {
            s0[1] = mid;
            s1[0] = mid;
          }
        }
      } else if (localE * 0.8 <= d0 && d0 <= localE * 1.2 && localE * 0.8 <= d1 && d1 <= localE * 1.2) {
        // Local Eighth note pair
        const totalSpanE = s1[1] - s0[0];
        if (localE * 1.8 <= totalSpanE && totalSpanE <= localE * 2.2) {
          const mid = round3(s0[0] + localE);
          if (Math.abs(mid - s0[1]) <= 0.025 && mid - s0[0] >= 0.06 && s1[1] - mid >= 0.06) {
            s0[1] = mid;
            s1[0] = mid;
          }
        }
      }
    }
    // Isochronous beat-locked multi-syllable word balancing (e.g. N-syllable words spanning ~N beats like 'des-ti-na-tion')
    for (const w of words) {
      const syls = w.syl ?? [];
      const n = syls.length;
      if (n >= 3) {
        const totalDur = syls[n - 1]![1] - syls[0]![0];
        const localQ = getLocalBeatDur(syls[0]![0]);
        const localBeat = (totalDur <= localQ * (n * 0.65)) ? localQ / 2.0 : localQ;
        const gridPool = (localBeat < localQ * 0.75) ? allGrid : qArr;
        if (localBeat * (n - 0.35) <= totalDur && totalDur <= localBeat * (n + 0.35)) {
          let allBeatsFound = true;
          const targetBeats: number[] = [syls[0]![0]];
          for (let k = 1; k < n; k++) {
            const expectedT = syls[0]![0] + k * (totalDur / n);
            const nearBeats = gridPool.filter(b => Math.abs(b - expectedT) <= 0.045);
            if (nearBeats.length > 0) {
              targetBeats.push(round3(nearBeats[0]!));
            } else {
              allBeatsFound = false;
              break;
            }
          }
          if (allBeatsFound) {
            targetBeats.push(syls[n - 1]![1]);
            for (let k = 0; k < n; k++) {
              syls[k]![0] = targetBeats[k]!;
              syls[k]![1] = targetBeats[k + 1]!;
            }
          }
        }
      }
    }
    // Sync word boundaries after syllable equalization
    for (const w of words) {
      if (w.syl && w.syl.length > 0) {
        w.start = w.syl[0]![0];
        w.end = w.syl[w.syl.length - 1]![1];
      }
    }


    // Multi-syllable internal balancing: ensure every syllable has >= 100ms or >= 30% of word, and 0ms intra-word gap
    for (const w of words) {
      const syls = w.syl ?? [];
      if (syls.length > 1) {
        const totalDur = syls[syls.length - 1]![1] - syls[0]![0];
        const minSylDur = Math.min(0.12, totalDur / syls.length);
        for (let si = 0; si < syls.length; si++) {
          const curDur = syls[si]![1] - syls[si]![0];
          if (curDur < minSylDur) {
            const needed = minSylDur - curDur;
            if (si === 0 && syls.length > 1) {
              const nxtDur = syls[1]![1] - syls[1]![0];
              const shift = Math.min(needed, nxtDur - minSylDur);
              if (shift > 0) {
                syls[0]![1] = round3(syls[0]![1] + shift);
                syls[1]![0] = syls[0]![1];
              }
            } else if (si === syls.length - 1 && syls.length > 1) {
              const prevDur = syls[syls.length - 2]![1] - syls[syls.length - 2]![0];
              const shift = Math.min(needed, prevDur - minSylDur);
              if (shift > 0) {
                syls[syls.length - 2]![1] = round3(syls[syls.length - 2]![1] - shift);
                syls[syls.length - 1]![0] = syls[syls.length - 2]![1];
              }
            } else if (si > 0 && si < syls.length - 1) {
              const prevDur = syls[si - 1]![1] - syls[si - 1]![0];
              const nxtDur = syls[si + 1]![1] - syls[si + 1]![0];
              if (prevDur >= nxtDur && prevDur > minSylDur) {
                let shift = Math.min(needed, prevDur - minSylDur);
                if (prevDur > minSylDur * 2.0) {
                  shift = Math.max(shift, (prevDur - minSylDur) * 0.5);
                }
                let newSplit = round3(syls[si - 1]![1] - shift);
                const candPool: Array<{ start: number }> = swiftNotes.concat(rmvpeNotes);
                if (edges && edges.length > 0) {
                  for (const e of edges) {
                    if (e.prob >= 0.60) candPool.push({ start: e.t });
                  }
                }
                const cands = candPool.filter(pn => syls[si - 1]![0] + 0.12 <= pn.start && pn.start <= syls[si]![1] - 0.05);
                if (cands.length > 0) {
                  let bestC = cands[0]!;
                  let minD = Math.abs(bestC.start - newSplit);
                  for (const c of cands) {
                    const diff = Math.abs(c.start - newSplit);
                    if (diff < minD) {
                      minD = diff;
                      bestC = c;
                    }
                  }
                  newSplit = round3(bestC.start);
                }
                syls[si - 1]![1] = newSplit;
                syls[si]![0] = newSplit;
              } else if (nxtDur > minSylDur) {
                const shift = Math.min(needed, nxtDur - minSylDur);
                syls[si]![1] = round3(syls[si]![1] + shift);
                syls[si + 1]![0] = syls[si]![1];
              }
            }
          }
        }
        // Restore stressed penult vowel absorbed by unstressed antepenult glide (e.g. -i-a-tion)
        const wGlideMatch = /(tion|sion|tian|cian)$/i.test(w.w ?? w.text ?? '');
        if (syls.length >= 4 && wGlideMatch) {
          const penultIdx = syls.length - 2;
          const glideIdx = syls.length - 3;
          const penultDur = syls[penultIdx]![1] - syls[penultIdx]![0];
          const glideDur = syls[glideIdx]![1] - syls[glideIdx]![0];
          if (penultDur < 0.16 && glideDur > 0.25) {
            const penultStart = syls[glideIdx]![0];
            const glideStart = round3(penultStart - 0.17);
            syls[glideIdx]![0] = glideStart;
            syls[glideIdx]![1] = penultStart;
            syls[penultIdx]![0] = penultStart;
            if (glideIdx > 0 && syls[glideIdx - 1]![1] > glideStart) {
              syls[glideIdx - 1]![1] = glideStart;
            }
          }
        }
        for (let si = 0; si < syls.length - 1; si++) {
          if (syls[si]![1] !== syls[si + 1]![0]) {
            const mid = round3((syls[si]![1] + syls[si + 1]![0]) / 2.0);
            syls[si]![1] = mid;
            syls[si + 1]![0] = mid;
          }
        }
        w.start = syls[0]![0];
        w.end = syls[syls.length - 1]![1];
      }
    }

    // Stage 2d: Rebalance unbalanced 2-beat monosyllabic word pairs at musical beats
    const pitchPool = swiftNotes.concat(rmvpeNotes);
    for (let wi = 0; wi < words.length - 1; wi++) {
      const curW = words[wi]!;
      const nxtW = words[wi + 1]!;
      const curDur = curW.end - curW.start;
      const nxtDur = nxtW.end - nxtW.start;
      const localQ = getLocalBeatDur(curW.start);
      const nxtNextDur = wi < words.length - 2 ? words[wi + 2]!.end - words[wi + 2]!.start : localQ * 3.0;
      const isSquashedFollower = nxtDur <= localQ * 0.75 || (nxtDur + nxtNextDur <= localQ * 1.15);

      if ((curW.syl?.length ?? 1) === 1 && (nxtW.syl?.length ?? 1) === 1) {
        if (curDur >= localQ * 1.60 && curDur <= localQ * 2.20 && isSquashedFollower) {
          const candNotes = pitchPool.filter(pn => 
            curW.start + localQ * 0.80 <= pn.start && pn.start <= curW.start + localQ * 1.25 &&
            curW.end - pn.start >= localQ * 0.55
          );
          if (candNotes.length > 0) {
            for (const pn of candNotes) {
              const nearBeats = qArr.filter(b => Math.abs(b - pn.start) <= 0.08);
              if (nearBeats.length > 0) {
                const splitT = round3(nearBeats[0]!);
                curW.end = splitT;
                if (curW.syl && curW.syl.length > 0) {
                  curW.syl[0]![1] = splitT;
                }
                nxtW.start = splitT;
                if (nxtW.syl && nxtW.syl.length > 0) {
                  nxtW.syl[0]![0] = splitT;
                }
                break;
              }
            }
          }
        } else if (curDur <= localQ * 1.25 && nxtDur >= localQ * 2.20) {
          const candNotes = pitchPool.filter(pn =>
            curW.end + localQ * 0.40 <= pn.start && pn.start <= curW.end + localQ * 1.20 &&
            nxtW.end - pn.start >= localQ * 0.90
          );
          if (candNotes.length > 0) {
            for (const pn of candNotes) {
              const nearBeats = qArr.filter(b => Math.abs(b - pn.start) <= 0.08);
              if (nearBeats.length > 0) {
                const splitT = round3(nearBeats[0]!);
                curW.end = splitT;
                if (curW.syl && curW.syl.length > 0) {
                  curW.syl[0]![1] = splitT;
                }
                nxtW.start = splitT;
                if (nxtW.syl && nxtW.syl.length > 0) {
                  nxtW.syl[0]![0] = splitT;
                }
                break;
              }
            }
          }
        }
      }
    }


    // Inter-word de-squash: borrow from elongated predecessor if follower is squashed
    for (let wi = 1; wi < words.length; wi++) {
      const w = words[wi]!;
      const wPrev = words[wi - 1]!;
      const dur = w.end - w.start;
      const durPrev = wPrev.end - wPrev.start;
      const local16th = getLocalBeatDur(w.start) / 4.0;
      const minWordDur = Math.max(0.10, Math.min(0.16, local16th * 1.25));
      const squashedThresh = Math.max(0.08, local16th * 0.95);
      if (dur < squashedThresh) {
        const needed = minWordDur - dur;
        const gap = Math.max(0, w.start - wPrev.end);
        if (gap >= needed) {
          w.start = round3(w.start - needed);
          if (w.syl && w.syl.length > 0) w.syl[0]![0] = w.start;
        } else if (durPrev > minWordDur * 1.8) {
          const remNeeded = needed - gap;
          const shift = Math.min(remNeeded, durPrev - minWordDur * 1.2);
          if (shift > 0) {
            const newSplit = round3(wPrev.end - shift);
            wPrev.end = newSplit;
            if (wPrev.syl && wPrev.syl.length > 0) wPrev.syl[wPrev.syl.length - 1]![1] = newSplit;
            w.start = newSplit;
            if (w.syl && w.syl.length > 0) w.syl[0]![0] = newSplit;
          }
        }
      }
    }
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi]!;
      if (w.syl && w.syl.length > 0) {
        w.start = wi === 0 ? sentenceStart : w.syl[0]![0];
        w.end = w.syl[w.syl.length - 1]![1];
      }
    }

    // Ensure continuous intra-sentence legato flow between adjacent words (bridge natural gaps <= 0.200s or pitch-held gaps <= 0.35s)
    const pPoolIntra = swiftNotes.concat(rmvpeNotes);
    for (let k = 0; k < words.length - 1; k++) {
      const gap = words[k + 1]!.start - words[k]!.end;
      const isPitchHeld = gap > 0.20 && gap <= 0.35 && pPoolIntra.some(pn => pn.start <= words[k]!.end + 0.05 && pn.end >= words[k + 1]!.start - 0.10);
      if (gap > 0.0 && (gap <= 0.20 || isPitchHeld)) {
        let isSilentGap = false;
        if (breaths.length > 0 && breaths.some(br => br.start < words[k + 1]!.start && br.end > words[k]!.end)) {
          isSilentGap = true;
        }
        if (!isSilentGap) {
          words[k]!.end = words[k + 1]!.start;
          const syl = words[k]!.syl;
          if (syl && syl.length > 0) {
            syl[syl.length - 1]![1] = words[k + 1]!.start;
          }
        }
      }
    }

    line.start = sentenceStart;
    line.end = words[words.length - 1]!.end;
  }

  // --- STAGE 3: INTER-SENTENCE LEGATO BRIDGING FOR CONTINUOUS VOCAL PHRASES ---

  for (let li = 0; li < refinedLines.length - 1; li++) {
    const curL = refinedLines[li]!;
    const nxtL = refinedLines[li + 1]!;
    const interGap = nxtL.start - curL.end;

    if (interGap > 0.0 && interGap <= legatoGap && curL.calibrated !== true) {
      curL.end = nxtL.start;
      if (curL.words && curL.words.length > 0) {
        const lastW = curL.words[curL.words.length - 1]!;
        lastW.end = nxtL.start;
        if (lastW.syl && lastW.syl.length > 0) {
          lastW.syl[lastW.syl.length - 1]![1] = nxtL.start;
        }
      }
    }
  }

  // --- STAGE 4: STRICT NON-OVERLAPPING SENTENCE INVARIANT (RUNS LAST!) ---
  for (let li = 0; li < refinedLines.length - 1; li++) {
    const curL = refinedLines[li]!;
    const nxtL = refinedLines[li + 1]!;
    const nxtSt = nxtL.start;
    if (curL.end > nxtSt) {
      curL.end = round3(nxtSt);
      if (curL.words && curL.words.length > 0) {
        const lastW = curL.words[curL.words.length - 1]!;
        if (lastW.end > nxtSt) {
          lastW.end = round3(nxtSt);
          if (lastW.syl && lastW.syl.length > 0) {
            const lastS = lastW.syl[lastW.syl.length - 1]!;
            if (lastS[1] > nxtSt) {
              lastS[1] = round3(nxtSt);
              if (lastS[0] >= lastS[1]) {
                lastS[0] = round3(lastS[1] - 0.05);
              }
            }
          }
          if (lastW.start >= lastW.end) {
            lastW.start = round3(lastW.end - 0.05);
          }
        }
      }
    }
  }

  // --- STAGE 5: STRICT NON-OVERLAPPING WORD & SYLLABLE INVARIANT ---
  for (const line of refinedLines) {
    if (!line.words || line.words.length === 0) continue;
    for (let wi = 0; wi < line.words.length; wi++) {
      const w = line.words[wi]!;
      if (wi > 0) {
        const prevW = line.words[wi - 1]!;
        if (prevW.end > w.start) {
          prevW.end = w.start;
          if (prevW.syl && prevW.syl.length > 0) {
            prevW.syl[prevW.syl.length - 1]![1] = w.start;
          }
        }
      }
      if (w.syl && w.syl.length > 0) {
        w.syl[0]![0] = w.start;
        w.syl[w.syl.length - 1]![1] = w.end;
        for (let si = 1; si < w.syl.length; si++) {
          const prevS = w.syl[si - 1]!;
          const curS = w.syl[si]!;
          if (curS[0] < prevS[0]) {
            curS[0] = prevS[0];
          }
          if (prevS[1] > curS[0]) {
            prevS[1] = curS[0];
          }
        }
        for (let si = 0; si < w.syl.length; si++) {
          if (w.syl[si]![0] > w.syl[si]![1]) {
            const span = w.end - w.start;
            let cur = w.start;
            for (let k = 0; k < w.syl.length; k++) {
              const nxt = k === w.syl.length - 1 ? w.end : round3(cur + span / w.syl.length);
              w.syl[k]![0] = cur;
              w.syl[k]![1] = nxt;
              cur = nxt;
            }
            break;
          }
        }
      }
    }
  }

  return refinedLines;
}
