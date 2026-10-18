// packages/lyricsync/src/evidence/models.ts
// Directory of a bundled HuBERT forced-aligner model (model.onnx, vocab.json, config.json and its dictionaries live together).

import * as path from 'node:path';
import { modelFile } from '../paths.ts';

export function getHubertDir(flavor: 'base' | 'combined'): string {
  return path.dirname(modelFile(flavor === 'base' ? 'hubert-base' : 'hubert-combined', 'model.onnx'));
}
