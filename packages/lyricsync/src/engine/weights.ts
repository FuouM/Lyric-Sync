// src/engine/weights.ts
// Trained boundary-DP weights bundled in <package root>/weights/:
//   index.json                        provenance + how many DP stages each mode uses (written by the trainer)
//   {anchored,free}.stage1.json       feature name -> weight
//   {anchored,free}.stage2.json       only for a mode whose index says stages = 2
// A missing file is an error, never replaced by another mode's weights. See docs/training.md.

import * as fs from 'node:fs';
import { isNumber, isRecord } from '../guards.ts';
import { weightsFile } from '../paths.ts';
import type { ModeWeights, WeightBundle, Weights } from '../types.ts';

export interface WeightsIndexMode {
  /** 1 or 2: DP stages used for lines solved in this mode. */
  stages: 1 | 2;
  /** Held-out (leave-one-song-out) syllable MAE in ms with the stages actually shipped. */
  heldOutMaeMs: number;
}

export interface WeightsIndex {
  version: 1;
  trainedOn: string[];
  anchored: WeightsIndexMode;
  free: WeightsIndexMode;
}

export function readWeightsFile(file: string): Weights {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(raw)) throw new Error(`Malformed weights file (expected an object of feature name -> weight): ${file}`);
  const weights: Weights = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isNumber(value)) throw new Error(`Malformed weights file: feature "${name}" is not a number: ${file}`);
    weights[name] = value;
  }
  return weights;
}

function parseMode(raw: unknown, name: string): WeightsIndexMode {
  if (!isRecord(raw) || (raw.stages !== 1 && raw.stages !== 2) || !isNumber(raw.heldOutMaeMs)) throw new Error(`weights/index.json: "${name}" needs stages (1 or 2) and heldOutMaeMs.`);
  return { stages: raw.stages, heldOutMaeMs: raw.heldOutMaeMs };
}

export function readWeightsIndex(): WeightsIndex {
  const raw: unknown = JSON.parse(fs.readFileSync(weightsFile('index.json'), 'utf8'));
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.trainedOn) || !raw.trainedOn.every((s: unknown) => typeof s === 'string')) {
    throw new Error('weights/index.json is malformed (expected version 1 and a trainedOn list).');
  }
  return { version: 1, trainedOn: raw.trainedOn, anchored: parseMode(raw.anchored, 'anchored'), free: parseMode(raw.free, 'free') };
}

export function loadWeights(): WeightBundle {
  const index = readWeightsIndex();
  const mode = (name: 'anchored' | 'free'): ModeWeights => ({
    stage1: readWeightsFile(weightsFile(`${name}.stage1.json`)),
    stage2: index[name].stages === 2 ? readWeightsFile(weightsFile(`${name}.stage2.json`)) : null,
  });
  return { anchored: mode('anchored'), free: mode('free') };
}
