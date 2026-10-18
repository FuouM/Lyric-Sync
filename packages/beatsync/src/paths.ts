// packages/beatsync/src/paths.ts
// Resolves package root and model paths relative to import.meta.url.
// Works cleanly in both src/ (TS source) and dist/ (compiled output) across Node and Bun.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Returns the absolute path to the beatsync package root.
 * Both `src/` and `dist/` are exactly one directory level below root.
 */
export function packageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  return path.resolve(currentDir, '..');
}

/**
 * Returns the absolute path to a model file located inside `<root>/models/<name>`.
 * Throws a descriptive error if the model file does not exist.
 */
export function modelPath(name: string): string {
  const root = packageRoot();
  const resolved = path.join(root, 'models', name);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Model file '${name}' not found at: ${resolved}. A published package ships its models/; in a source checkout run "bun run fetch-models" at the repository root.`
    );
  }
  return resolved;
}
