// packages/lyricsync/src/platform/browser.ts
// Browser implementation of PlatformRuntime using FileSystemDirectoryHandle and onnxruntime-web.
import type { FileStat, FileStore, ModelStore, OnnxBackend, OnnxSession, PlatformRuntime, TensorDescriptor, ProgressCallback } from './types.ts';

interface OrtTensor {
  type: string;
  data: Float32Array | BigInt64Array | Int32Array;
  dims: number[];
}

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

declare const ort: {
  InferenceSession: {
    create(modelOrBytes: string | Uint8Array, options?: { executionProviders?: string[]; graphOptimizationLevel?: string }): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array | BigInt64Array | Int32Array, dims: number[]) => unknown;
};

async function getHandle(root: FileSystemDirectoryHandle, relPath: string, create = false): Promise<FileSystemFileHandle> {
  const parts = relPath.replace(/^[\\\/]+/, '').split(/[\\\/]+/);
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]!, { create });
  }
  return dir.getFileHandle(parts[parts.length - 1]!, { create });
}

export class BrowserFileStore implements FileStore {
  readonly root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  async readText(relativePath: string): Promise<string> {
    const handle = await getHandle(this.root, relativePath, false);
    const file = await handle.getFile();
    return file.text();
  }

  async readBytes(relativePath: string): Promise<Uint8Array> {
    const handle = await getHandle(this.root, relativePath, false);
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    const handle = await getHandle(this.root, relativePath, true);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async writeBytes(relativePath: string, data: Uint8Array): Promise<void> {
    const handle = await getHandle(this.root, relativePath, true);
    const writable = await handle.createWritable();
    // Ensure buffer is typed as standard ArrayBuffer
    await writable.write(new Uint8Array(data) as unknown as BufferSource);
    await writable.close();
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await getHandle(this.root, relativePath, false);
      return true;
    } catch {
      return false;
    }
  }

  async stat(relativePath: string): Promise<FileStat> {
    const handle = await getHandle(this.root, relativePath, false);
    const file = await handle.getFile();
    return { size: file.size, mtimeMs: file.lastModified };
  }

  async list(relativeDirPath: string): Promise<string[]> {
    const parts = relativeDirPath.replace(/^[\\\/]+/, '').split(/[\\\/]+/).filter(Boolean);
    let dir = this.root;
    for (const p of parts) {
      try {
        dir = await dir.getDirectoryHandle(p, { create: false });
      } catch {
        return [];
      }
    }
    const names: string[] = [];
    const dirWithEntries = dir as unknown as { entries(): AsyncIterable<[string, unknown]> };
    for await (const [name] of dirWithEntries.entries()) {
      names.push(name);
    }
    return names;
  }

  async remove(relativePath: string): Promise<void> {
    const parts = splitRelativePath(relativePath);
    let dir = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]!, { create: false });
    }
    await dir.removeEntry(parts[parts.length - 1]!);
  }

  async mkdir(dirPath: string): Promise<void> {
    const parts = splitRelativePath(dirPath);
    let dir = this.root;
    for (const p of parts) {
      dir = await dir.getDirectoryHandle(p, { create: true });
    }
  }
}

function splitRelativePath(p: string): string[] {
  return p.replace(/^[\\\/]+/, '').split(/[\\\/]+/).filter(Boolean);
}

export class BrowserModelStore implements ModelStore {
  readonly modelsDir: FileSystemDirectoryHandle;
  readonly remoteBaseUrl: string;

  constructor(modelsDir: FileSystemDirectoryHandle, remoteBaseUrl = './models') {
    this.modelsDir = modelsDir;
    this.remoteBaseUrl = remoteBaseUrl.replace(/\/+$/, '');
  }

  async getFilePath(modelRelativePath: string): Promise<string> {
    return `${this.remoteBaseUrl}/${modelRelativePath}`;
  }

  async getBytes(modelRelativePath: string, onProgress?: ProgressCallback): Promise<Uint8Array> {
    try {
      const handle = await getHandle(this.modelsDir, modelRelativePath, false);
      const file = await handle.getFile();
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      onProgress?.(`Downloading ${modelRelativePath}...`);
      const url = `${this.remoteBaseUrl}/${modelRelativePath}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download model ${modelRelativePath}: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      try {
        const handle = await getHandle(this.modelsDir, modelRelativePath, true);
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array(bytes) as unknown as BufferSource);
        await writable.close();
      } catch {
        // non-fatal quota ignore
      }
      return bytes;
    }
  }
}

export class BrowserOnnxSession implements OnnxSession {
  private session: OrtSession;

  constructor(session: OrtSession) {
    this.session = session;
  }

  async run(feeds: Record<string, TensorDescriptor>): Promise<Record<string, TensorDescriptor>> {
    const ortFeeds: Record<string, unknown> = {};
    for (const [k, desc] of Object.entries(feeds)) {
      ortFeeds[k] = new ort.Tensor(desc.type, desc.data, desc.dims);
    }
    const results = await this.session.run(ortFeeds);
    const out: Record<string, TensorDescriptor> = {};
    for (const [k, tensor] of Object.entries(results)) {
      out[k] = {
        type: tensor.type as 'float32' | 'int64' | 'int32',
        data: tensor.data,
        dims: tensor.dims,
      };
    }
    return out;
  }

  async release(): Promise<void> {
    await this.session.release?.();
  }
}

export class BrowserOnnxBackend implements OnnxBackend {
  async createSession(
    modelPathOrBytes: string | Uint8Array,
    options: { preferredDevice?: 'gpu' | 'cpu'; intraThreads?: number } = {}
  ): Promise<OnnxSession> {
    const eps = options.preferredDevice === 'cpu' ? ['wasm'] : ['webgpu', 'wasm'];
    const sessOpts = {
      executionProviders: eps,
      graphOptimizationLevel: 'all',
    };
    const session = await ort.InferenceSession.create(modelPathOrBytes, sessOpts);
    return new BrowserOnnxSession(session);
  }
}

export function createBrowserRuntime(
  libraryRoot: FileSystemDirectoryHandle,
  modelsDir: FileSystemDirectoryHandle,
  remoteBaseUrl?: string
): PlatformRuntime {
  return {
    files: new BrowserFileStore(libraryRoot),
    models: new BrowserModelStore(modelsDir, remoteBaseUrl),
    onnx: new BrowserOnnxBackend(),
    async decodeAudio(audioData: Uint8Array, targetSampleRate = 44100): Promise<Float32Array> {
      const ctx = new OfflineAudioContext(1, 44100, targetSampleRate);
      const copy = new Uint8Array(audioData.byteLength);
      copy.set(audioData);
      const audioBuffer = await ctx.decodeAudioData(copy.buffer as ArrayBuffer);
      return audioBuffer.getChannelData(0);
    },
    async sha256(data: Uint8Array | string): Promise<string> {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const hashBuf = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
      return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    },
  };
}
