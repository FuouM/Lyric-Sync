// packages/beatsync/src/tracker.ts
// End-to-end Beat This! beat and downbeat tracker in JavaScript/TypeScript using ONNX Runtime.

import * as fs from 'node:fs';
import * as ort from 'onnxruntime-node';
import { loadAudioFile, toMono, resample } from './audio.ts';
import { computeLogMelSpectrogram } from './spectrogram.ts';
import { checkTempoChanges, postprocessBeats } from './postprocess.ts';
import { modelPath } from './paths.ts';
import { executionProviders, type InferenceDevice } from './device.ts';
import type { BeatAnalysis, BeatLogits, BeatsFromLogitsOptions, BeatTrackerOptions, TempoChange, TrackBeatsOptions } from './types.ts';

/**
 * Beat This! beat and downbeat tracking engine.
 */
export class BeatTracker {
  private session: ort.InferenceSession | null = null;
  private readonly modelPath: string;
  private readonly chunkSize: number;
  private readonly borderSize: number;
  private readonly fps: number;
  private readonly device: InferenceDevice;
  private readonly targetBpm: number;
  private readonly tempoChanges: readonly TempoChange[];
  private externalRunner?: (spectrogram: Float32Array, chunkSize: number) => Promise<{ beat: Float32Array; downbeat: Float32Array }>;

  constructor(options: BeatTrackerOptions & {
    runner?: (spectrogram: Float32Array, chunkSize: number) => Promise<{ beat: Float32Array; downbeat: Float32Array }>;
  }) {
    checkTempoChanges(options.targetBpm, options.tempoChanges);
    this.chunkSize = options.chunkSize ?? 1500; // 30 seconds at 50 fps
    this.borderSize = options.borderSize ?? 6;   // 120 ms overlap boundary
    this.fps = options.fps ?? 50;
    this.device = options.device ?? 'gpu';
    this.targetBpm = options.targetBpm;
    this.tempoChanges = options.tempoChanges ?? [];
    this.externalRunner = options.runner;
    this.modelPath = modelPath('beat_this.onnx');
  }

  /**
   * Initializes the ONNX Runtime session if not already loaded.
   */
  async init(): Promise<void> {
    if (this.session) return;

    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Beat This ONNX model not found at: ${this.modelPath}`);
    }

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: executionProviders(this.device),
      graphOptimizationLevel: 'all',
    };

    this.session = await ort.InferenceSession.create(this.modelPath, sessionOptions);
  }

  /**
   * Runs the model over a 1D Float32Array PCM audio buffer (22,050 Hz mono) and returns its per-frame beat and downbeat logits.
   * The expensive step of tracking: keep the logits to try other tempo priors with `beatsFromLogits`.
   */
  async trackLogits(signal: Float32Array): Promise<BeatLogits> {
    if (!this.externalRunner) {
      await this.init();
      if (!this.session) throw new Error('Failed to initialize ONNX session');
    }
    const startTime = performance.now();

    // 1. Compute Log-Mel Spectrogram (T, 128)
    const { data: spect, numFrames } = computeLogMelSpectrogram(signal);
    const durationSec = signal.length / 22050.0;

    if (numFrames === 0) {
      return { fps: this.fps, beat: new Float32Array(0), downbeat: new Float32Array(0), durationSec: 0, inferenceTimeMs: 0 };
    }

    // 2. Chunking & Overlapping Window Generation
    const step = this.chunkSize - 2 * this.borderSize; // 1488
    const starts: number[] = [];

    for (let s = -this.borderSize; s < numFrames - this.borderSize; s += step) {
      starts.push(s);
    }
    // Shift last chunk left to prevent truncated tail if audio is longer than 1 chunk
    if (numFrames > step && starts.length > 0) {
      starts[starts.length - 1] = numFrames - (this.chunkSize - this.borderSize);
    }

    const beatLogits = new Float32Array(numFrames).fill(-1000.0);
    const downbeatLogits = new Float32Array(numFrames).fill(-1000.0);

    const chunkBuffer = new Float32Array(this.chunkSize * 128);

    // 3. Inference on each 1500-frame chunk
    for (const start of starts) {
      chunkBuffer.fill(0);

      for (let i = 0; i < this.chunkSize; i++) {
        const frameIdx = start + i;
        if (frameIdx >= 0 && frameIdx < numFrames) {
          const srcOffset = frameIdx * 128;
          const dstOffset = i * 128;
          for (let m = 0; m < 128; m++) {
            chunkBuffer[dstOffset + m] = spect[srcOffset + m]!;
          }
        }
      }

      let bChunk: Float32Array;
      let dbChunk: Float32Array;
      if (this.externalRunner) {
        const out = await this.externalRunner(chunkBuffer, this.chunkSize);
        bChunk = out.beat;
        dbChunk = out.downbeat;
      } else {
        const inputTensor = new ort.Tensor('float32', chunkBuffer, [1, this.chunkSize, 128]);
        const outputs = await this.session!.run({ spectrogram: inputTensor });
        bChunk = outputs.beat!.data as Float32Array;
        dbChunk = outputs.downbeat!.data as Float32Array;
      }
      // Splicing: keep inner predictions, discard border
      const validStart = start + this.borderSize;
      const validEnd = Math.min(numFrames, start + this.chunkSize - this.borderSize);

      for (let f = validStart; f < validEnd; f++) {
        const chunkOffset = f - start;
        beatLogits[f] = bChunk[chunkOffset]!;
        downbeatLogits[f] = dbChunk[chunkOffset]!;
      }
    }

    return { fps: this.fps, beat: beatLogits, downbeat: downbeatLogits, durationSec: Math.round(durationSec * 1000) / 1000, inferenceTimeMs: Math.round(performance.now() - startTime) };
  }

  /**
   * Analyzes a 1D Float32Array PCM audio buffer (at 22,050 Hz mono).
   */
  async trackAudio(signal: Float32Array, firstDownbeatHint?: number): Promise<BeatAnalysis> {
    const logits = await this.trackLogits(signal);
    return beatsFromLogits(logits, { targetBpm: this.targetBpm, tempoChanges: this.tempoChanges, firstDownbeat: firstDownbeatHint });
  }

  /**
   * Analyzes an audio file on disk (WAV or format supported by ffmpeg).
   */
  async trackFile(filePath: string, firstDownbeatHint?: number): Promise<BeatAnalysis> {
    const audio = await loadAudioFile(filePath, 22050);
    return this.trackAudio(audio, firstDownbeatHint);
  }

  /** The model's logits of an audio file on disk; see `trackLogits`. */
  async trackLogitsFile(filePath: string): Promise<BeatLogits> {
    const audio = await loadAudioFile(filePath, 22050);
    return this.trackLogits(audio);
  }
}

/**
 * Beats and downbeats of a song from its model logits: the tempo prior (a tempo and its changes) and the first downbeat decide what
 * the beat tracker's DP picks. Cheap (no model run), so a tempo map can be tried again and again on the same logits.
 */
export function beatsFromLogits(logits: BeatLogits, options: BeatsFromLogitsOptions): BeatAnalysis {
  const { beats, downbeats } = postprocessBeats(logits.beat, logits.downbeat, {
    fps: logits.fps,
    targetBpm: options.targetBpm,
    ...(options.tempoChanges ? { tempoChanges: options.tempoChanges } : {}),
    ...(options.beatPins ? { beatPins: options.beatPins } : {}),
    useDP: true,
    firstDownbeatHint: options.firstDownbeat,
  });

  // Overall BPM (median beat tempo) and average beat period
  let estimatedBpm = 0;
  if (beats.length >= 2) {
    const tempos: number[] = [];
    for (let i = 1; i < beats.length; i++) {
      const diff = beats[i]! - beats[i - 1]!;
      if (diff > 0.2 && diff < 1.5) {
        tempos.push(60.0 / diff);
      }
    }
    if (tempos.length > 0) {
      tempos.sort((a, b) => a - b);
      estimatedBpm = tempos[Math.floor(tempos.length / 2)]!;
    }
  }

  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    intervals.push(beats[i]! - beats[i - 1]!);
  }
  const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0.5;

  return {
    beats,
    downbeats,
    bpm: Math.round(estimatedBpm * 10) / 10,
    beatPeriod: parseFloat(avgInterval.toFixed(5)),
    durationSec: logits.durationSec,
    inferenceTimeMs: logits.inferenceTimeMs,
  };
}

/**
 * Top-level convenience function to analyze beats from file path or in-memory PCM audio.
 */
export async function trackBeats(
  input: string | { samples: Float32Array; sampleRate: number; channels?: number },
  options: TrackBeatsOptions
): Promise<BeatAnalysis> {
  const tracker = new BeatTracker({
    targetBpm: options.targetBpm,
    ...(options.tempoChanges ? { tempoChanges: options.tempoChanges } : {}),
    ...(options.device ? { device: options.device } : {}),
  });

  if (typeof input === 'string') {
    return tracker.trackFile(input, options.firstDownbeat);
  }

  let mono = input.channels && input.channels > 1 ? toMono(input.samples, input.channels) : input.samples;
  if (input.sampleRate !== 22050) {
    mono = resample(mono, input.sampleRate, 22050);
  }
  return tracker.trackAudio(mono, options.firstDownbeat);
}
