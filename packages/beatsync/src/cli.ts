#!/usr/bin/env node
// packages/beatsync/src/cli.ts
// Command-line interface for beatsync: beat and downbeat tracking.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { trackBeats } from './tracker.ts';
import { computeFeatures } from './features.ts';
import type { DrumOnsetKey, FeatureStems, OnsetStems, StemEnvelopeKey } from './types.ts';

function printHelp(): void {
  console.log(`
beatsync - Fast, robust beat and downbeat tracking using Beat This! RoFormer ONNX

Usage:
  beatsync <audio-file> [options]
  beatsync features <mix-file> [--vocal <file>] [--drums <file>] [--bass <file>] [--other <file>]
                    [--kick <file>] [--snare <file>] [--hat <file>] (--out <file.json> | --json)

Options:
  --bpm <n>             Target BPM prior (e.g. 120, 200). Helps regularize beat tracking.
  --first-downbeat <s>  First downbeat timestamp hint in seconds (aligns 4/4 downbeat phase).
  --device gpu|cpu      Where the model runs (default gpu; falls back to the CPU without a GPU provider). Same beats on both.
  --out <file.json>     Write output JSON to specified file path.
  --json                Print pure JSON contract to stdout.
  -h, --help            Show this help documentation.

features command:
  Writes the features.json v1 document: envelopes at 100 fps, each peak-normalized to 0..1.
  rms, low (20-250 Hz), mid (250-4000 Hz), high (4000 Hz and up) come from the mix.
  vocal, drums, bass, other come from the stem files (RMS). Give a stem option more than once to sum files.
  A stem without files is not in the output.
  onsets.kick, onsets.snare, onsets.hat come from isolated drum stem files: [time s, strength 0..1] pairs.
  Give an onset option more than once to add files sample by sample. An onset key without files is not in the output.

Output JSON Contract:
  {
    "v": 1,
    "model": "beat_this",
    "duration": 194.261,
    "bpm": 200.0,
    "beat_period": 0.30000,
    "beats": [0.000, 0.320, 0.620, ...],
    "downbeats": [0.320, 1.500, ...]
  }
`);
}

async function featuresMain(args: string[]): Promise<void> {
  let mixPath: string | null = null;
  let outPath: string | null = null;
  let isJson = false;
  const stems: FeatureStems = {};
  const stemFlags: Record<string, StemEnvelopeKey> = { '--vocal': 'vocal', '--drums': 'drums', '--bass': 'bass', '--other': 'other' };
  const onsetStems: OnsetStems = {};
  const onsetFlags: Record<string, DrumOnsetKey> = { '--kick': 'kick', '--snare': 'snare', '--hat': 'hat' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const stemKey = stemFlags[arg];
    const onsetKey = onsetFlags[arg];
    if (stemKey || onsetKey) {
      const val = args[++i];
      if (!val) {
        console.error(`Error: ${arg} requires a file path argument`);
        process.exit(2);
      }
      if (stemKey) (stems[stemKey] ??= []).push(path.resolve(val));
      else (onsetStems[onsetKey!] ??= []).push(path.resolve(val));
    } else if (arg === '--out') {
      const val = args[++i];
      if (!val) {
        console.error('Error: --out requires a file path argument');
        process.exit(2);
      }
      outPath = val;
    } else if (arg === '--json') {
      isJson = true;
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(2);
    } else if (!mixPath) {
      mixPath = arg;
    }
  }
  if (!mixPath) {
    console.error('Error: No mix file provided.');
    printHelp();
    process.exit(2);
  }
  if (!outPath && !isJson) {
    console.error('Error: give --out <file.json>, --json, or both.');
    process.exit(2);
  }

  try {
    const t0 = Date.now();
    const doc = await computeFeatures(path.resolve(mixPath), stems, onsetStems);
    const text = JSON.stringify(doc);
    if (outPath) {
      const resolvedOut = path.resolve(outPath);
      fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
      fs.writeFileSync(resolvedOut, text, 'utf8');
    }
    if (isJson) {
      console.log(text);
    } else {
      const keys = Object.keys(doc.envelopes);
      console.log(`Envelopes: ${keys.join(', ')} (${doc.envelopes.rms.length} frames at ${doc.fps} fps) in ${Date.now() - t0} ms`);
      const onsetCounts = Object.entries(doc.onsets).map(([key, list]) => `${key} ${list.length}`);
      if (onsetCounts.length > 0) console.log(`Onsets: ${onsetCounts.join(', ')}`);
      console.log(`Saved output to:  ${outPath}`);
    }
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'features' && !args.includes('-h') && !args.includes('--help')) {
    await featuresMain(args.slice(1));
    return;
  }

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  let audioPath: string | null = null;
  let targetBpm: number | undefined = undefined;
  let firstDownbeat: number | undefined = undefined;
  let outPath: string | null = null;
  let isJson = false;
  let device: 'gpu' | 'cpu' = 'gpu';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--bpm' || arg === '--target-bpm') {
      const val = args[++i];
      if (!val || isNaN(parseFloat(val))) {
        console.error('Error: --bpm requires a numeric argument');
        process.exit(1);
      }
      targetBpm = parseFloat(val);
    } else if (arg === '--first-downbeat') {
      const val = args[++i];
      if (!val || isNaN(parseFloat(val))) {
        console.error('Error: --first-downbeat requires a numeric argument in seconds');
        process.exit(1);
      }
      firstDownbeat = parseFloat(val);
    } else if (arg === '--device') {
      const val = args[++i];
      if (val !== 'gpu' && val !== 'cpu') {
        console.error('Error: --device must be gpu or cpu');
        process.exit(1);
      }
      device = val;
    } else if (arg === '--out') {
      const val = args[++i];
      if (!val) {
        console.error('Error: --out requires a file path argument');
        process.exit(1);
      }
      outPath = val;
    } else if (arg === '--json') {
      isJson = true;
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    } else if (!audioPath) {
      audioPath = arg;
    }
  }

  if (targetBpm === undefined) {
    console.error('Error: --bpm <n> is required: the song\'s approximate tempo (beats are tracked within about +/-12% of it).');
    printHelp();
    process.exit(1);
  }

  if (!audioPath) {
    console.error('Error: No audio input file provided.');
    printHelp();
    process.exit(1);
  }

  const resolvedAudio = path.resolve(audioPath);
  if (!fs.existsSync(resolvedAudio)) {
    console.error(`Error: Audio file not found: ${resolvedAudio}`);
    process.exit(1);
  }

  try {
    const analysis = await trackBeats(resolvedAudio, {
      targetBpm,
      firstDownbeat,
      device,
    });

    const outputPayload = {
      v: 1,
      model: 'beat_this',
      duration: parseFloat(analysis.durationSec.toFixed(3)),
      bpm: analysis.bpm,
      beat_period: analysis.beatPeriod,
      beats: analysis.beats.map((b) => parseFloat(b.toFixed(3))),
      downbeats: analysis.downbeats.map((d) => parseFloat(d.toFixed(3))),
    };

    if (outPath) {
      const resolvedOut = path.resolve(outPath);
      const parentDir = path.dirname(resolvedOut);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(resolvedOut, JSON.stringify(outputPayload, null, 2), 'utf8');
    }

    if (isJson) {
      console.log(JSON.stringify(outputPayload, null, 2));
    } else {
      console.log(`----------------------------------------`);
      console.log(`beatsync Analysis`);
      console.log(`----------------------------------------`);
      console.log(`File:             ${path.basename(resolvedAudio)}`);
      console.log(`Duration:         ${outputPayload.duration}s`);
      console.log(`BPM:              ${outputPayload.bpm}`);
      console.log(`Beat Period:      ${outputPayload.beat_period}s`);
      console.log(`Total Beats:      ${outputPayload.beats.length}`);
      console.log(`Total Downbeats:  ${outputPayload.downbeats.length}`);
      console.log(`Inference Time:   ${analysis.inferenceTimeMs}ms`);
      console.log(`----------------------------------------`);
      console.log(
        `First 8 Beats:     [${outputPayload.beats.slice(0, 8).map((b) => b.toFixed(3)).join(', ')}]`
      );
      console.log(
        `First 8 Downbeats: [${outputPayload.downbeats.slice(0, 8).map((d) => d.toFixed(3)).join(', ')}]`
      );
      if (outPath) {
        console.log(`Saved output to:  ${outPath}`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
