// packages/beatsync/src/tracker.ts
// End-to-end Beat This! beat and downbeat tracker in JavaScript/TypeScript using ONNX Runtime.

import * as fs from 'node:fs';
import * as ort from 'onnxruntime-node';
import { loadAudioFile, toMono, resample } from './audio.ts';
import { computeLogMelSpectrogram } from './spectrogram.ts';
import { postprocessBeats } from './postprocess.ts';
import { modelPath } from './paths.ts';
import type { BeatAnalysis, BeatTrackerOptions, TrackBeatsOptions } from './types.ts';

/**
 * Beat This! beat and downbeat tracking engine.
 */
export class BeatTracker {
  private session: ort.InferenceSession | null = null;
  private readonly modelPath: string;
  private readonly chunkSize: number;
  private readonly borderSize: number;
  private readonly fps: number;
  private readonly executionProvider: string;
  private readonly targetBpm: number;
  private externalRunner?: (spectrogram: Float32Array, chunkSize: number) => Promise<{ beat: Float32Array; downbeat: Float32Array }>;

  constructor(options: BeatTrackerOptions & {
    runner?: (spectrogram: Float32Array, chunkSize: number) => Promise<{ beat: Float32Array; downbeat: Float32Array }>;
  }) {
    if (!Number.isFinite(options.targetBpm) || options.targetBpm <= 0) {
      throw new Error(`targetBpm must be a positive number (the song's approximate tempo in BPM), got ${String(options.targetBpm)}.`);
    }
    this.chunkSize = options.chunkSize ?? 1500; // 30 seconds at 50 fps
    this.borderSize = options.borderSize ?? 6;   // 120 ms overlap boundary
    this.fps = options.fps ?? 50;
    this.executionProvider = options.executionProvider ?? 'cpu';
    this.targetBpm = options.targetBpm;
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
      executionProviders: [this.executionProvider === 'cpu' ? 'cpu' : this.executionProvider],
      graphOptimizationLevel: 'all',
    };

    this.session = await ort.InferenceSession.create(this.modelPath, sessionOptions);
  }

  /**
   * Analyzes a 1D Float32Array PCM audio buffer (at 22,050 Hz mono).
   */
  async trackAudio(signal: Float32Array, firstDownbeatHint?: number): Promise<BeatAnalysis> {
    if (!this.externalRunner) {
      await this.init();
      if (!this.session) throw new Error('Failed to initialize ONNX session');
    }
    const startTime = performance.now();

    // 1. Compute Log-Mel Spectrogram (T, 128)
    const { data: spect, numFrames } = computeLogMelSpectrogram(signal);
    const durationSec = signal.length / 22050.0;

    if (numFrames === 0) {
      return {
        beats: [],
        downbeats: [],
        bpm: 0,
        beatPeriod: 0,
        durationSec: 0,
        inferenceTimeMs: 0,
      };
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

    // 4. Post-processing: peak picking & timestamp generation
    const { beats, downbeats } = postprocessBeats(beatLogits, downbeatLogits, {
      fps: this.fps,
      targetBpm: this.targetBpm,
      useDP: true,
      firstDownbeatHint,
    });

    // 5. Estimate overall BPM and average beat period
    let estimatedBpm = 0;
    if (beats.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < beats.length; i++) {
        const diff = beats[i]! - beats[i - 1]!;
        if (diff > 0.2 && diff < 1.5) {
          intervals.push(60.0 / diff);
        }
      }
      if (intervals.length > 0) {
        intervals.sort((a, b) => a - b);
        estimatedBpm = intervals[Math.floor(intervals.length / 2)]!;
      }
    }

    const intervals: number[] = [];
    for (let i = 1; i < beats.length; i++) {
      intervals.push(beats[i]! - beats[i - 1]!);
    }
    const avgInterval =
      intervals.length > 0
        ? intervals.reduce((a, b) => a + b, 0) / intervals.length
        : 0.5;

    const elapsed = performance.now() - startTime;

    return {
      beats,
      downbeats,
      bpm: Math.round(estimatedBpm * 10) / 10,
      beatPeriod: parseFloat(avgInterval.toFixed(5)),
      durationSec: Math.round(durationSec * 1000) / 1000,
      inferenceTimeMs: Math.round(elapsed),
    };
  }

  /**
   * Analyzes an audio file on disk (WAV or format supported by ffmpeg).
   */
  async trackFile(filePath: string, firstDownbeatHint?: number): Promise<BeatAnalysis> {
    const audio = await loadAudioFile(filePath, 22050);
    return this.trackAudio(audio, firstDownbeatHint);
  }
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
