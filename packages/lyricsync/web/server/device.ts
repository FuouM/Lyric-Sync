// packages/lyricsync/web/server/device.ts
// Where this editor server runs the models (prepare, solve, beat tracking): one setting for the server, because the models run on
// the server's machine. Starts at `bun run dev --device gpu|cpu` (default gpu); the editor changes it through POST /api/config.
// Results are the same on both devices up to float rounding.
import { gpuExecutionProvider, type InferenceDevice } from "../../../beatsync/src/index.ts";

let device: InferenceDevice = "gpu";

export function inferenceDevice(): InferenceDevice {
  return device;
}

export function setInferenceDevice(next: InferenceDevice): void {
  device = next;
}

export const isInferenceDevice = (v: unknown): v is InferenceDevice => v === "gpu" || v === "cpu";

/** What /api/config reports: the current device and the GPU provider of this machine's onnxruntime build (null: none, gpu runs on the CPU). */
export function deviceConfig(): { device: InferenceDevice; gpuProvider: string | null } {
  return { device, gpuProvider: gpuExecutionProvider() };
}
