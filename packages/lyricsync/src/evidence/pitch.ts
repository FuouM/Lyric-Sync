// packages/lyricsync/src/evidence/pitch.ts
// Pure TypeScript + ONNX Runtime vocal pitch estimation: Swift-F0, HarmoF0, RMVPE,
// note DP segmentation, and morphological pitch smoothing.

import * as ort from 'onnxruntime-node';
import { executionProviders, type InferenceDevice } from 'beatsync';
import type { ConsensusNote } from '../types.ts';
import { resample } from '../audio/audio.ts';
import {
  computeRmvpeMelSpectrogram,
  loadRmvpeMelFilterbank,
  RMVPE_SAMPLE_RATE,
  RMVPE_HOP_LENGTH,
} from '../audio/spectrogram.ts';
import { openSplitModel } from './split-model.ts';
import { modelFile } from '../paths.ts';

export interface PitchResult {
  timestamps: Float64Array;
  pitchHz: Float64Array;
  confidence: Float32Array;
  loudnessDb: Float32Array;
}

export interface SegmentNotesOptions {
  pitchHoldMs?: number;
  correctOctaves?: boolean;
  vocalCeiling?: number;
}

export interface OctaveCorrectionOptions {
  vocalCeiling?: number;
  minConfidence?: number;
  continuityFold?: boolean;
}

// -------------------------------------------------------------
// Swift-F0 Constants
// -------------------------------------------------------------
const SWIFT_SAMPLE_RATE = 16000;
const SWIFT_HOP = 256;
const SWIFT_FRAME_PERIOD = SWIFT_HOP / SWIFT_SAMPLE_RATE; // 0.016 s (16 ms)
const SWIFT_FMIN = 46.875;
const SWIFT_FMAX = 2093.75;
const SWIFT_LOOKAHEAD_FRAMES = 10;
const SWIFT_LEFT_FRAMES = 11;
const SWIFT_WINDOW_FRAMES = 1875; // 30s
const SWIFT_SILENCE_PEAK = 1e-3;

// -------------------------------------------------------------
// HarmoF0 Constants
// -------------------------------------------------------------
const HARMO_SAMPLE_RATE = 16000;
const HARMO_FRAME_LEN = 1024; // 64 ms
const HARMO_HOP_LENGTH = 160; // 10 ms (100 fps)
const HARMO_FREQ_BINS = 352;
const HARMO_BINS_PER_OCTAVE = 48;
const HARMO_FMIN = 27.5;

// -------------------------------------------------------------
// RMVPE Constants
// -------------------------------------------------------------
const RMVPE_N_CLASS = 360;
const RMVPE_CONST = 1997.3794084376191;
const RMVPE_FRAME_PERIOD = RMVPE_HOP_LENGTH / RMVPE_SAMPLE_RATE; // 0.010 s (100 fps)
const RMVPE_DEFAULT_THRESHOLD = 0.03;

function computeMedian(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2.0;
}

// -------------------------------------------------------------
// Octave Error Correction
// -------------------------------------------------------------
export function correctOctaveErrors(
  result: PitchResult,
  options: OctaveCorrectionOptions = {}
): PitchResult {
  const vocalCeiling = options.vocalCeiling ?? 750.0;
  const minConfidence = options.minConfidence ?? 0.4;
  const continuityFold = options.continuityFold ?? true;

  const { timestamps, pitchHz, confidence, loudnessDb } = result;
  const n = timestamps.length;
  const correctedPitch = new Float64Array(pitchHz);
  const correctedConf = new Float32Array(confidence);

  // 1. Ceiling octave fold
  for (let i = 0; i < n; i++) {
    const c = confidence[i] ?? 0;
    let p = correctedPitch[i] ?? 0;
    if (c >= minConfidence && p > vocalCeiling) {
      while (p > vocalCeiling) {
        p /= 2.0;
      }
      correctedPitch[i] = p;
    }
  }

  // 2. Continuity fold
  if (continuityFold) {
    for (let i = 2; i < n - 2; i++) {
      const c = correctedConf[i] ?? 0;
      if (c < minConfidence) continue;
      const curP = correctedPitch[i] ?? 0;

      let prevP = 0;
      for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
        if ((correctedConf[j] ?? 0) >= minConfidence) {
          prevP = correctedPitch[j] ?? 0;
          break;
        }
      }

      let nextP = 0;
      for (let j = i + 1; j <= Math.min(n - 1, i + 12); j++) {
        if ((correctedConf[j] ?? 0) >= minConfidence) {
          nextP = correctedPitch[j] ?? 0;
          break;
        }
      }

      if (prevP > 0 && nextP > 0) {
        const neighborAvg = (prevP + nextP) / 2.0;
        const ratio = curP / neighborAvg;
        if (ratio > 1.85 && ratio < 2.15) {
          correctedPitch[i] = curP / 2.0;
        } else if (ratio > 0.45 && ratio < 0.55 && curP * 2.0 <= vocalCeiling) {
          correctedPitch[i] = curP * 2.0;
        }
      }
    }
  }

  return { timestamps, pitchHz: correctedPitch, confidence: correctedConf, loudnessDb };
}

// -------------------------------------------------------------
// Note DP Segmentation
// -------------------------------------------------------------
export function segmentNotes(
  result: PitchResult,
  options: SegmentNotesOptions = {}
): ConsensusNote[] {
  const input = options.correctOctaves
    ? correctOctaveErrors(result, { vocalCeiling: options.vocalCeiling })
    : result;

  const pitchHoldMs = options.pitchHoldMs ?? 80.0;
  const framePeriod = 0.016; // 16 ms normalization basis used in research CLI
  const { timestamps, pitchHz, confidence, loudnessDb } = input;
  const n = timestamps.length;
  if (n === 0) return [];

  const valid = new Uint8Array(n);
  let hasValid = false;

  for (let i = 0; i < n; i++) {
    const p = pitchHz[i] ?? 0;
    if (Number.isFinite(p) && p > 0) {
      valid[i] = 1;
      hasValid = true;
    }
  }

  if (!hasValid) return [];

  const m = new Float64Array(n);
  const w = new Float64Array(n);
  const cc = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    if (valid[i]) {
      const p = pitchHz[i] ?? 0;
      m[i] = 69.0 + 12.0 * Math.log2(p / 440.0);
      w[i] = confidence[i] ?? 0;
    } else {
      m[i] = 0.0;
      w[i] = 0.0;
    }
    cc[i] = Math.max(0.01, Math.min(0.99, w[i] ?? 0));
  }

  // Symmetric pad loudnessDb by 4
  const padded = new Float64Array(n + 8);
  for (let i = 0; i < 4; i++) {
    const symLeftIdx = 3 - i < n ? 3 - i : 0;
    padded[i] = loudnessDb[symLeftIdx] ?? 0;
  }
  for (let i = 0; i < n; i++) {
    padded[4 + i] = loudnessDb[i] ?? 0;
  }
  for (let i = 0; i < 4; i++) {
    const symRightIdx = n - 1 - i >= 0 ? n - 1 - i : 0;
    padded[4 + n + i] = loudnessDb[symRightIdx] ?? 0;
  }

  const left = new Float64Array(n);
  const right = new Float64Array(n);

  for (let t = 0; t < n; t++) {
    let maxL = -Infinity;
    for (let j = 0; j < 5; j++) {
      const val = padded[t + j] ?? 0;
      if (val > maxL) maxL = val;
    }
    left[t] = maxL;

    let maxR = -Infinity;
    for (let j = 0; j < 5; j++) {
      const val = padded[4 + t + j] ?? 0;
      if (val > maxR) maxR = val;
    }
    right[t] = maxR;
  }

  const q = new Float64Array(n);
  const log10_2 = Math.log10(2.0);

  for (let t = 0; t < n; t++) {
    const cVal = cc[t] ?? 0.01;
    const logit = -Math.log(cVal / (1.0 - cVal));
    const minLR = Math.min(left[t] ?? 0, right[t] ?? 0);
    const dip = Math.max(0.0, minLR - (loudnessDb[t] ?? 0) - 10.0 * log10_2);
    q[t] = logit + dip;
  }

  const muSet = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (valid[i]) {
      const rounded = Math.floor((m[i] ?? 0) * 100 + 0.5) / 100;
      muSet.add(rounded);
    }
  }

  const mu = Array.from(muSet).sort((a, b) => a - b);
  const numMu = mu.length;
  const beta = pitchHoldMs / 1000.0 / framePeriod;

  const vn = new Float64Array(numMu).fill(Infinity);
  const noteStart = new Int32Array(numMu);
  const back = new Int32Array(n + 1);
  const kind = new Int32Array(n + 1).fill(-1);
  let best = 0.0;

  for (let t = 0; t < n; t++) {
    const startCost = best + beta;
    const mt = m[t] ?? 0;
    const wt = w[t] ?? 0;
    const qt = q[t] ?? 0;

    let minVn = Infinity;
    let minIdx = 0;

    for (let k = 0; k < numMu; k++) {
      if (startCost < (vn[k] ?? Infinity)) {
        noteStart[k] = t;
        vn[k] = startCost;
      }
      const targetMu = mu[k] ?? 0;
      const diff = Math.min(Math.abs(targetMu - mt), 2.0);
      const updatedVn = (vn[k] ?? 0) + diff * wt + qt;
      vn[k] = updatedVn;

      if (updatedVn < minVn) {
        minVn = updatedVn;
        minIdx = k;
      }
    }

    if (minVn < best) {
      best = minVn;
      back[t + 1] = noteStart[minIdx] ?? 0;
      kind[t + 1] = minIdx;
    } else {
      back[t + 1] = t;
    }
  }

  const notes: ConsensusNote[] = [];
  let b = n;

  while (b > 0) {
    const a = back[b] ?? 0;
    const k = kind[b] ?? -1;
    if (k >= 0) {
      const noteMu = mu[k] ?? 0;
      const notePitchHz = 440.0 * Math.pow(2.0, (noteMu - 69.0) / 12.0);
      const midi = Math.round(69 + 12 * Math.log2(notePitchHz / 440));
      const startTime = timestamps[a] ?? 0;
      const endTime = (timestamps[b - 1] ?? 0) + framePeriod;

      notes.push({
        start: startTime,
        end: endTime,
        pitchHz: notePitchHz,
        pitch: midi,
      });
    }
    b = a;
  }

  notes.reverse();
  return notes;
}

// -------------------------------------------------------------
// Despiking & Gap Closing
// -------------------------------------------------------------
export function despikeF0(
  hzArr: number[],
  tsArr: number[],
  windowLen = 5
): { cleanedHz: number[]; midiArr: number[]; vMask: boolean[] } {
  const n = hzArr.length;
  const cleanedHz = [...hzArr];
  const vMask: boolean[] = hzArr.map((h) => h > 65.0);
  const midiArr: number[] = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (vMask[i]) {
      midiArr[i] = 12.0 * Math.log2(cleanedHz[i]! / 440.0) + 69.0;
    }
  }

  // 1. Running median filter on voiced frames
  const halfW = Math.floor(windowLen / 2);
  for (let i = halfW; i < n - halfW; i++) {
    if (!vMask[i]) continue;
    const localV: number[] = [];
    for (let k = i - halfW; k <= i + halfW; k++) {
      if (vMask[k]) localV.push(midiArr[k]!);
    }
    if (localV.length >= 3) {
      const localMed = computeMedian(localV);
      const diff = midiArr[i]! - localMed;
      if (Math.abs(diff) >= 10.5 && Math.abs(diff) <= 13.5) {
        const shift = diff > 0 ? -12.0 : 12.0;
        midiArr[i]! += shift;
        cleanedHz[i] = 440.0 * Math.pow(2.0, (midiArr[i]! - 69.0) / 12.0);
      } else if (Math.abs(diff) >= 22.5 && Math.abs(diff) <= 25.5) {
        const shift = diff > 0 ? -24.0 : 24.0;
        midiArr[i]! += shift;
        cleanedHz[i] = 440.0 * Math.pow(2.0, (midiArr[i]! - 69.0) / 12.0);
      } else if (Math.abs(diff) > 4.5 && Math.abs(localV[0]! - localV[localV.length - 1]!) < 2.0) {
        midiArr[i] = localMed;
        cleanedHz[i] = 440.0 * Math.pow(2.0, (localMed - 69.0) / 12.0);
      }
    }
  }

  // 2. Morphological gap-closing: fill short unvoiced dropouts (1-4 frames <= 50ms)
  const maxGapFrames = 5;
  let i = 0;
  while (i < n) {
    if (!vMask[i]) {
      const gapStart = i;
      while (i < n && !vMask[i]) {
        i++;
      }
      const gapLen = i - gapStart;
      if (gapLen <= maxGapFrames && gapStart > 0 && i < n) {
        const pBefore = midiArr[gapStart - 1]!;
        const pAfter = midiArr[i]!;
        if (Math.abs(pBefore - pAfter) <= 2.5) {
          for (let k = gapStart; k < i; k++) {
            const frac = (k - gapStart + 1) / (gapLen + 1);
            const interpMidi = pBefore + frac * (pAfter - pBefore);
            midiArr[k] = interpMidi;
            cleanedHz[k] = 440.0 * Math.pow(2.0, (interpMidi - 69.0) / 12.0);
            vMask[k] = true;
          }
        }
      }
    } else {
      i++;
    }
  }

  return { cleanedHz, midiArr, vMask };
}

export function smoothAndSegmentNotes(
  cleanedHz: number[],
  midiArr: number[],
  vMask: boolean[],
  tsArr: number[],
  confArr?: number[],
  minNoteDur = 0.055,
  minConfidence = 0.35
): ConsensusNote[] {
  const n = cleanedHz.length;
  const dt = n > 1 ? tsArr[1]! - tsArr[0]! : 0.01;
  const notes: ConsensusNote[] = [];
  let currFrames: number[] = [];

  const emitNote = (frames: number[]): void => {
    if (frames.length === 0) return;
    const st = tsArr[frames[0]!]!;
    const en = tsArr[frames[frames.length - 1]!]! + dt;
    const dur = en - st;
    if (dur >= minNoteDur) {
      const midis = frames.map((k) => midiArr[k]!);
      const hzs = frames.map((k) => cleanedHz[k]!);
      let avgC = 1.0;
      if (confArr && confArr.length === n) {
        const sum = frames.reduce((acc, k) => acc + (confArr[k] ?? 0), 0);
        avgC = sum / frames.length;
      }
      if (avgC >= minConfidence) {
        const medP = Math.round(computeMedian(hzs) * 100) / 100;
        const medMidi = Math.round(computeMedian(midis) * 100) / 100;
        notes.push({
          start: Math.round(st * 1000) / 1000,
          end: Math.round(en * 1000) / 1000,
          pitchHz: medP,
          pitch: Math.round(medMidi),
          confidence: Math.round(avgC * 100) / 100,
        });
      }
    }
  };

  for (let i = 0; i < n; i++) {
    if (!vMask[i]) {
      if (currFrames.length > 0) {
        emitNote(currFrames);
        currFrames = [];
      }
    } else {
      if (currFrames.length === 0) {
        currFrames.push(i);
      } else {
        const currMed = computeMedian(currFrames.map((k) => midiArr[k]!));
        const diff = Math.abs(midiArr[i]! - currMed);
        if (diff >= 1.4) {
          emitNote(currFrames);
          currFrames = [i];
        } else {
          currFrames.push(i);
        }
      }
    }
  }

  if (currFrames.length > 0) {
    emitNote(currFrames);
  }

  return notes;
}

// -------------------------------------------------------------
// Swift-F0 Tracker Execution
// -------------------------------------------------------------
export async function runSwiftF0(
  audio44k: Float32Array,
  sampleRate = 44100,
  device: InferenceDevice = 'gpu'
): Promise<ConsensusNote[]> {
  const signal = sampleRate === SWIFT_SAMPLE_RATE ? audio44k : resample(audio44k, sampleRate, SWIFT_SAMPLE_RATE);
  const modelPath = modelFile('swift-f0', 'swift_f0.onnx');
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: executionProviders(device),
    graphOptimizationLevel: 'all',
  });

  const n = Math.floor(signal.length / SWIFT_HOP);
  const timestamps = new Float64Array(n);
  const pitch = new Float64Array(n);
  const confidence = new Float32Array(n);
  const loudnessDb = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    timestamps[i] = i * SWIFT_FRAME_PERIOD;
  }

  for (let start = 0; start < n; start += SWIFT_WINDOW_FRAMES) {
    const end = Math.min(start + SWIFT_WINDOW_FRAMES, n);
    const audioStart = Math.max(0, (start - SWIFT_LEFT_FRAMES) * SWIFT_HOP);
    const audioEnd = Math.min(signal.length, (end + SWIFT_LOOKAHEAD_FRAMES) * SWIFT_HOP);
    const windowAudio = signal.subarray(audioStart, audioEnd);

    const audioTensor = new ort.Tensor('float32', windowAudio, [1, windowAudio.length]);
    const fminTensor = new ort.Tensor('float32', new Float32Array([SWIFT_FMIN]), []);
    const fmaxTensor = new ort.Tensor('float32', new Float32Array([SWIFT_FMAX]), []);

    const outputs = await session.run({ audio: audioTensor, fmin: fminTensor, fmax: fmaxTensor });
    const rawPitch = outputs.pitch;
    const rawConf = outputs.confidence;
    if (!rawPitch || !rawConf) throw new Error('Swift-F0 model output missing pitch/confidence');

    const numFrames = rawPitch.dims[1] ?? 0;
    const pitchData = rawPitch.data as Float64Array;
    const confData = new Float32Array(rawConf.data as Float32Array);
    const chunkLen = Math.min(numFrames, end - start);

    const power = new Float64Array(chunkLen);
    for (let i = 0; i < chunkLen; i++) {
      const hopStart = i * SWIFT_HOP;
      let maxAbs = 0;
      let hopPower = 0;
      for (let s = 0; s < SWIFT_HOP; s++) {
        const val = windowAudio[hopStart + s] ?? 0;
        const absVal = Math.abs(val);
        if (absVal > maxAbs) maxAbs = absVal;
        hopPower += val * val;
      }
      if (maxAbs < SWIFT_SILENCE_PEAK) {
        confData[i] = 0.0;
      }
      power[i] = hopPower;
    }

    const chunkLoudness = new Float32Array(chunkLen);
    for (let i = 0; i < chunkLen; i++) {
      const prevPower = i > 0 ? (power[i - 1] ?? 0.0) : 0.0;
      const curPower = power[i] ?? 0.0;
      const rms = Math.sqrt((prevPower + curPower) / 512.0);
      chunkLoudness[i] = 20.0 * Math.log10(Math.max(rms, 1e-7));
    }

    pitch.set(pitchData.subarray(0, chunkLen), start);
    confidence.set(confData.subarray(0, chunkLen), start);
    loudnessDb.set(chunkLoudness, start);
  }

  const rawResult: PitchResult = { timestamps, pitchHz: pitch, confidence, loudnessDb };
  const folded = correctOctaveErrors(rawResult, { vocalCeiling: 750.0 });
  return segmentNotes(folded, { pitchHoldMs: 80.0 });
}

// -------------------------------------------------------------
// HarmoF0 Tracker Execution
// -------------------------------------------------------------
export async function runHarmoF0(
  audio44k: Float32Array,
  sampleRate = 44100,
  device: InferenceDevice = 'gpu'
): Promise<ConsensusNote[]> {
  const signal = sampleRate === HARMO_SAMPLE_RATE ? audio44k : resample(audio44k, sampleRate, HARMO_SAMPLE_RATE);
  const modelPath = modelFile('harmof0', 'harmof0_e2e.onnx');
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: executionProviders(device),
    graphOptimizationLevel: 'all',
  });

  const wavLen = signal.length;
  if (wavLen < HARMO_FRAME_LEN) return [];
  const numFrames = Math.floor((wavLen - HARMO_FRAME_LEN) / HARMO_HOP_LENGTH) + 1;

  const frames = new Float32Array(numFrames * HARMO_FRAME_LEN);
  for (let i = 0; i < numFrames; i++) {
    const begin = i * HARMO_HOP_LENGTH;
    frames.set(signal.subarray(begin, begin + HARMO_FRAME_LEN), i * HARMO_FRAME_LEN);
  }

  const totalActivationMap = new Float32Array(numFrames * HARMO_FREQ_BINS);
  const framesPerStep = 1000;
  const steps = Math.ceil(numFrames / framesPerStep);

  for (let s = 0; s < steps; s++) {
    const begin = s * framesPerStep;
    const end = Math.min(numFrames, begin + framesPerStep);
    const stepFrames = end - begin;
    const stepSlice = frames.subarray(begin * HARMO_FRAME_LEN, end * HARMO_FRAME_LEN);

    const inputTensor = new ort.Tensor('float32', stepSlice, [1, stepFrames, HARMO_FRAME_LEN]);
    const results = await session.run({ waveform: inputTensor });
    const actOut = results.activation;
    if (!actOut) throw new Error('HarmoF0 output missing activation');
    totalActivationMap.set(actOut.data as Float32Array, begin * HARMO_FREQ_BINS);
  }

  const frequencies = new Float32Array(numFrames);
  const activations = new Float32Array(numFrames);
  for (let t = 0; t < numFrames; t++) {
    const offset = t * HARMO_FREQ_BINS;
    let maxVal = -Infinity;
    let maxBin = 0;
    for (let b = 0; b < HARMO_FREQ_BINS; b++) {
      const val = totalActivationMap[offset + b] ?? 0;
      if (val > maxVal) {
        maxVal = val;
        maxBin = b;
      }
    }
    activations[t] = maxVal;
    frequencies[t] = maxVal > 0.0 ? HARMO_FMIN * Math.pow(2.0, maxBin / HARMO_BINS_PER_OCTAVE) : 0.0;
  }

  const timestamps = new Float64Array(numFrames);
  const timeStep = HARMO_HOP_LENGTH / HARMO_SAMPLE_RATE;
  const pitchHz = new Float64Array(numFrames);
  const confidence = new Float32Array(numFrames);
  const loudnessDb = new Float32Array(numFrames).fill(-12.0);

  for (let i = 0; i < numFrames; i++) {
    timestamps[i] = i * timeStep;
    pitchHz[i] = frequencies[i] ?? 0;
    confidence[i] = activations[i] ?? 0;

    const hopStart = i * HARMO_HOP_LENGTH;
    let power = 0;
    const count = Math.min(HARMO_FRAME_LEN, signal.length - hopStart);
    for (let s = 0; s < count; s++) {
      const smp = signal[hopStart + s] ?? 0;
      power += smp * smp;
    }
    const rms = Math.sqrt(power / Math.max(1, count));
    loudnessDb[i] = 20.0 * Math.log10(Math.max(rms, 1e-7));
  }

  const result: PitchResult = { timestamps, pitchHz, confidence, loudnessDb };
  return segmentNotes(result, { pitchHoldMs: 80.0 });
}

// -------------------------------------------------------------
// RMVPE Tracker Execution
// -------------------------------------------------------------
export async function runRmvpe(
  audio44k: Float32Array,
  sampleRate = 44100,
  device: InferenceDevice = 'gpu'
): Promise<{ f0Hz: number[]; rmvpeNotes: ConsensusNote[] }> {
  const signal = sampleRate === RMVPE_SAMPLE_RATE ? audio44k : resample(audio44k, sampleRate, RMVPE_SAMPLE_RATE);
  const melFb = loadRmvpeMelFilterbank(modelFile('rmvpe', 'rmvpe_mel_fb.bin'));

  const { data: melData, numFrames } = computeRmvpeMelSpectrogram(signal, melFb);
  if (numFrames === 0) {
    return { f0Hz: [], rmvpeNotes: [] };
  }

  // The whole song is one input sequence; its GRU runs on the CPU (split-model.ts), the convolutions on `device`.
  const model = await openSplitModel('rmvpe', 'rmvpe', device);
  const outputs = await model.run({ mel: new ort.Tensor('float32', melData, [1, 128, numFrames]) });
  await model.release();
  const hiddenOut = outputs.hidden;
  if (!hiddenOut) throw new Error('RMVPE model output missing hidden');
  const hiddenData = hiddenOut.data as Float32Array;

  // Local-weighted cents averaging
  const rawF0 = new Float64Array(numFrames);
  const confidence = new Float32Array(numFrames);

  for (let t = 0; t < numFrames; t++) {
    const frameOffset = t * RMVPE_N_CLASS;
    let maxVal = -Infinity;
    let center = 0;
    for (let b = 0; b < RMVPE_N_CLASS; b++) {
      const val = hiddenData[frameOffset + b] ?? 0;
      if (val > maxVal) {
        maxVal = val;
        center = b;
      }
    }
    confidence[t] = Math.max(0.0, maxVal);
    if (maxVal < RMVPE_DEFAULT_THRESHOLD) {
      rawF0[t] = 0.0;
      continue;
    }
    const start = Math.max(0, center - 4);
    const end = Math.min(RMVPE_N_CLASS, center + 5);
    let productSum = 0;
    let weightSum = 0;
    for (let b = start; b < end; b++) {
      const w = hiddenData[frameOffset + b] ?? 0;
      const cents = b * 20 + RMVPE_CONST;
      productSum += w * cents;
      weightSum += w;
    }
    const cents = weightSum > 0 ? productSum / weightSum : 0;
    rawF0[t] = 10.0 * Math.pow(2.0, cents / 1200.0);
  }

  // Post-process glitch elimination
  const minGap = 2;
  const fmin = 50.0;
  const fmax = 1000.0;
  const cleanedF0 = new Float64Array(rawF0);
  for (let i = 0; i < numFrames; i++) {
    const p = cleanedF0[i] ?? 0;
    if (p < fmin || p > fmax) cleanedF0[i] = 0.0;
  }
  for (let i = 0; i < numFrames - minGap - 1; i++) {
    if (cleanedF0[i] === 0.0 && cleanedF0[i + minGap + 1] === 0.0) {
      let hasVoiced = false;
      for (let g = 1; g <= minGap; g++) {
        if ((cleanedF0[i + g] ?? 0) > 0.0) {
          hasVoiced = true;
          break;
        }
      }
      if (hasVoiced) {
        for (let g = 1; g <= minGap; g++) {
          cleanedF0[i + g] = 0.0;
        }
      }
    }
  }

  // Timestamps and RMS loudness
  const timestamps = new Float64Array(numFrames);
  const loudnessDb = new Float32Array(numFrames);
  const frameLen = 1024;
  for (let i = 0; i < numFrames; i++) {
    timestamps[i] = i * RMVPE_FRAME_PERIOD;
    const hopStart = i * RMVPE_HOP_LENGTH;
    let power = 0;
    const count = Math.min(frameLen, signal.length - hopStart);
    for (let s = 0; s < count; s++) {
      const smp = signal[hopStart + s] ?? 0;
      power += smp * smp;
    }
    const rms = Math.sqrt(power / Math.max(1, count));
    loudnessDb[i] = 20.0 * Math.log10(Math.max(rms, 1e-7));
  }

  const pitchResult: PitchResult = { timestamps, pitchHz: cleanedF0, confidence, loudnessDb };
  const rmvpeNotes = segmentNotes(pitchResult, { pitchHoldMs: 80.0 });
  const f0Hz = Array.from(cleanedF0);

  return { f0Hz, rmvpeNotes };
}
