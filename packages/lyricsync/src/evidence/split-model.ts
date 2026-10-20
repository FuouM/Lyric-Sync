// packages/lyricsync/src/evidence/split-model.ts
// Models whose GRU runs on the CPU while the rest runs on the GPU. scripts/split_gru.py cuts such a model into
// <stem>.encoder.onnx (every node before the GRUs) and <stem>.recurrent.onnx (the GRUs and what follows them). DirectML's GRU
// kernel is slow to set up (about 2.7 ms per time step on the first run) and fails on long sequences, while the CPU runs a GRU fast;
// the convolutions and transformer layers before it are what the GPU speeds up. On the CPU the two parts give exactly the output of
// the whole model.

import * as ort from 'onnxruntime-node';
import { executionProviders, type InferenceDevice } from 'beatsync';
import { modelFile } from '../paths.ts';

export interface SplitModel {
  /** Runs the encoder on `feeds`, then the recurrent part on the encoder's outputs; returns the recurrent part's outputs. */
  run(feeds: Record<string, ort.Tensor>): Promise<ort.InferenceSession.ReturnType>;
  release(): Promise<void>;
}

export async function openSplitModel(dir: string, stem: string, device: InferenceDevice): Promise<SplitModel> {
  const encoder = await ort.InferenceSession.create(modelFile(dir, `${stem}.encoder.onnx`), {
    executionProviders: executionProviders(device),
    graphOptimizationLevel: 'all',
  });
  const recurrent = await ort.InferenceSession.create(modelFile(dir, `${stem}.recurrent.onnx`), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  return {
    async run(feeds) {
      return recurrent.run(await encoder.run(feeds));
    },
    async release() {
      await encoder.release();
      await recurrent.release();
    },
  };
}
