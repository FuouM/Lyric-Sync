#!/usr/bin/env node
// packages/beatsync/src/cli.ts
// Command-line interface for beatsync: beat and downbeat tracking.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { trackBeats } from './tracker.ts';

function printHelp(): void {
  console.log(`
beatsync - Fast, robust beat and downbeat tracking using Beat This! RoFormer ONNX

Usage:
  beatsync <audio-file> [options]

Options:
  --bpm <n>             Target BPM prior (e.g. 120, 200). Helps regularize beat tracking.
  --first-downbeat <s>  First downbeat timestamp hint in seconds (aligns 4/4 downbeat phase).
  --device gpu|cpu      Where the model runs (default gpu; falls back to the CPU without a GPU provider). Same beats on both.
  --out <file.json>     Write output JSON to specified file path.
  --json                Print pure JSON contract to stdout.
  -h, --help            Show this help documentation.

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

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
