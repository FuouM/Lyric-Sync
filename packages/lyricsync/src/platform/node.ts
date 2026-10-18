// packages/lyricsync/src/platform/node.ts
// Node/Bun implementation of PlatformRuntime.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as ort from 'onnxruntime-node';
import type { FileStat, FileStore, ModelStore, OnnxBackend, OnnxSession, PlatformRuntime, TensorDescriptor } from './types.ts';
import { loadAudioFile, parseWav, toMono, resample } from '../audio/audio.ts';

function sanitizePath(root: string, relPath: string): string {
  const normalized = path.normalize(relPath).replace(/^[\\\/]+/, '');
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error(`Path traversal denied: ${relPath}`);
  }
  return resolved;
}

export class NodeFileStore implements FileStore {
  readonly root: string;

  constructor(rootDirectory: string) {
    this.root = path.resolve(rootDirectory);
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
  }

  async readText(relativePath: string): Promise<string> {
    const p = sanitizePath(this.root, relativePath);
    return fs.promises.readFile(p, 'utf8');
  }

  async readBytes(relativePath: string): Promise<Uint8Array> {
    const p = sanitizePath(this.root, relativePath);
    const buf = await fs.promises.readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    const p = sanitizePath(this.root, relativePath);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, content, 'utf8');
  }

  async writeBytes(relativePath: string, data: Uint8Array): Promise<void> {
    const p = sanitizePath(this.root, relativePath);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  async exists(relativePath: string): Promise<boolean> {
    const p = sanitizePath(this.root, relativePath);
    return fs.existsSync(p);
  }

  async stat(relativePath: string): Promise<FileStat> {
    const p = sanitizePath(this.root, relativePath);
    const st = await fs.promises.stat(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  }

  async list(relativeDirPath: string): Promise<string[]> {
    const p = sanitizePath(this.root, relativeDirPath);
    if (!fs.existsSync(p)) return [];
    return fs.promises.readdir(p);
  }

  async remove(relativePath: string): Promise<void> {
    const p = sanitizePath(this.root, relativePath);
    if (fs.existsSync(p)) {
      await fs.promises.unlink(p);
    }
  }

  async mkdir(relativeDirPath: string): Promise<void> {
    const p = sanitizePath(this.root, relativeDirPath);
    await fs.promises.mkdir(p, { recursive: true });
  }
}

export class NodeModelStore implements ModelStore {
  readonly modelsDir: string;

  constructor(modelsDir: string) {
    this.modelsDir = path.resolve(modelsDir);
  }

  async getFilePath(modelRelativePath: string): Promise<string> {
    const p = path.resolve(this.modelsDir, modelRelativePath);
    if (!fs.existsSync(p)) {
      throw new Error(`Model file not found: ${p}`);
    }
    return p;
  }

  async getBytes(modelRelativePath: string): Promise<Uint8Array> {
    const p = await this.getFilePath(modelRelativePath);
    const buf = await fs.promises.readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}

export class NodeOnnxSession implements OnnxSession {
  private session: ort.InferenceSession;

  constructor(session: ort.InferenceSession) {
    this.session = session;
  }

  async run(feeds: Record<string, TensorDescriptor>): Promise<Record<string, TensorDescriptor>> {
    const ortFeeds: Record<string, ort.Tensor> = {};
    for (const [k, desc] of Object.entries(feeds)) {
      // ort.Tensor accepts TypedArray buffer
      ortFeeds[k] = new ort.Tensor(desc.type, desc.data, desc.dims);
    }
    const results = await this.session.run(ortFeeds);
    const out: Record<string, TensorDescriptor> = {};
    for (const [k, tensor] of Object.entries(results)) {
      out[k] = {
        type: tensor.type as 'float32' | 'int64' | 'int32',
        data: tensor.data as Float32Array | BigInt64Array | Int32Array,
        dims: tensor.dims as number[],
      };
    }
    return out;
  }

  async release(): Promise<void> {
    if ('release' in this.session && typeof this.session.release === 'function') {
      await (this.session.release as () => Promise<void>)();
    }
  }
}

export class NodeOnnxBackend implements OnnxBackend {
  async createSession(
    modelPathOrBytes: string | Uint8Array,
    options: { preferredDevice?: 'gpu' | 'cpu'; intraThreads?: number } = {}
  ): Promise<OnnxSession> {
    const eps = options.preferredDevice === 'cpu' ? ['cpu'] : ['dml', 'cpu'];
    const sessOpts: ort.InferenceSession.SessionOptions = {
      executionProviders: eps,
      graphOptimizationLevel: 'all',
    };
    if (options.intraThreads) {
      sessOpts.intraOpNumThreads = options.intraThreads;
    }
    const session = typeof modelPathOrBytes === 'string'
      ? await ort.InferenceSession.create(modelPathOrBytes, sessOpts)
      : await ort.InferenceSession.create(Buffer.from(modelPathOrBytes.buffer, modelPathOrBytes.byteOffset, modelPathOrBytes.byteLength), sessOpts);
    return new NodeOnnxSession(session);
  }
}

export function createNodeRuntime(workspaceRoot: string, modelsRoot: string): PlatformRuntime {
  return {
    files: new NodeFileStore(workspaceRoot),
    models: new NodeModelStore(modelsRoot),
    onnx: new NodeOnnxBackend(),
    async decodeAudio(audioData: Uint8Array, targetSampleRate = 44100): Promise<Float32Array> {
      // Decode WAV in-memory if WAV header, else fallback
      const dec = parseWav(audioData);
      const mono = toMono(dec.samples, dec.channels);
      return dec.sampleRate === targetSampleRate ? mono : resample(mono, dec.sampleRate, targetSampleRate);
    },
    async sha256(data: Uint8Array | string): Promise<string> {
      const h = crypto.createHash('sha256');
      if (typeof data === 'string') h.update(data, 'utf8');
      else h.update(data);
      return h.digest('hex');
    },
  };
}
