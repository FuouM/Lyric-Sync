// packages/beatsync/src/device.ts
// Where ONNX models run: the GPU provider this platform's onnxruntime-node build bundles, or the CPU.

import * as ort from 'onnxruntime-node';

/** `gpu`: the platform's GPU provider (DirectML on Windows, CUDA where the build has it), CPU for the ops it cannot run. `cpu`: CPU only. */
export type InferenceDevice = 'gpu' | 'cpu';

/** GPU providers in order of preference. WebGPU is left out: its GRU kernel is slower than the CPU's. */
const GPU_PROVIDERS = ['dml', 'cuda'];

let gpuProvider: string | null | undefined;

/** The GPU execution provider of this onnxruntime-node build, or null when it has none. */
export function gpuExecutionProvider(): string | null {
  if (gpuProvider === undefined) {
    const bundled = new Set(ort.listSupportedBackends().map((b) => b.name));
    gpuProvider = GPU_PROVIDERS.find((p) => bundled.has(p)) ?? null;
  }
  return gpuProvider;
}

/** Execution providers for a session: the GPU provider first when `device` is gpu and one exists, CPU always last. */
export function executionProviders(device: InferenceDevice): string[] {
  const gpu = device === 'gpu' ? gpuExecutionProvider() : null;
  return gpu ? [gpu, 'cpu'] : ['cpu'];
}
