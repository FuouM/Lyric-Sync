// packages/lyricsync/src/platform/types.ts
// Platform abstraction layer: contracts for filesystem, model cache, ONNX sessions, audio decoding and cryptography.
// Both Node (CLI, daemon, tests) and Browser (Web Worker) implement this interface.

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/**
 * Sandboxed, POSIX-style hierarchical storage interface.
 * Paths are always relative to the store root (e.g., "song/evidence/meta.json").
 * Path traversal attempts ('..') throw an error.
 */
export interface FileStore {
  readText(relativePath: string): Promise<string>;
  readBytes(relativePath: string): Promise<Uint8Array>;
  writeText(relativePath: string, content: string): Promise<void>;
  writeBytes(relativePath: string, data: Uint8Array): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  stat(relativePath: string): Promise<FileStat>;
  list(relativeDirPath: string): Promise<string[]>;
  remove(relativePath: string): Promise<void>;
  mkdir(relativeDirPath: string): Promise<void>;
}

export type ProgressCallback = (message: string, progress?: { loaded: number; total: number }) => void;

/**
 * Model distribution asset cache.
 * Resolves models and binary resources by logical name (e.g., 'boundary/frames.onnx', 'hubert-base/model.onnx').
 */
export interface ModelStore {
  /** Returns the local filesystem path (in Node) or memory/URL pointer to the model binary */
  getFilePath(modelRelativePath: string): Promise<string>;
  /** Returns the raw bytes of a model or binary asset */
  getBytes(modelRelativePath: string, onProgress?: ProgressCallback): Promise<Uint8Array>;
}

export interface TensorDescriptor {
  type: 'float32' | 'int64' | 'int32';
  data: Float32Array | BigInt64Array | Int32Array;
  dims: number[];
}

export interface OnnxSession {
  run(feeds: Record<string, TensorDescriptor>): Promise<Record<string, TensorDescriptor>>;
  release(): Promise<void>;
}

export interface OnnxBackend {
  createSession(
    modelPathOrBytes: string | Uint8Array,
    options?: { preferredDevice?: 'gpu' | 'cpu'; intraThreads?: number }
  ): Promise<OnnxSession>;
}

export interface PlatformRuntime {
  files: FileStore;
  models: ModelStore;
  onnx: OnnxBackend;
  decodeAudio(audioData: Uint8Array, targetSampleRate?: number): Promise<Float32Array>;
  sha256(data: Uint8Array | string): Promise<string>;
}
