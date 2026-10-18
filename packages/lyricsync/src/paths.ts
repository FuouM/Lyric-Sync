// src/paths.ts
// Every bundled file (models, weights) is resolved relative to the package root. The root is one level above this file
// both when running from `src/` (Bun, tests) and from `dist/` (Node), so no environment variable or cwd lookup is involved.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Absolute path of a file under `<package root>/models/`; throws naming the file when it is missing. */
export function modelFile(...segments: string[]): string {
  const file = path.join(packageRoot(), 'models', ...segments);
  if (!fs.existsSync(file)) {
    throw new Error(`Model file is missing: ${file}. A published package ships its models/; in a source checkout run "bun run fetch-models" at the repository root.`);
  }
  return file;
}

/** Absolute path of a file under `<package root>/weights/`; throws naming the file when it is missing. */
export function weightsFile(name: string): string {
  const file = path.join(packageRoot(), 'weights', name);
  if (!fs.existsSync(file)) {
    throw new Error(`Bundled DP weights file is missing: ${file}. Weights are produced by the trainer (see docs/training.md).`);
  }
  return file;
}
