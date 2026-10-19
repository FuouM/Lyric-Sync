// Benchmark of a training-free lyricsync solver against the calibrated labels of the annotated songs.
// Prints METRIC lines: syllable_mae_ms (anchored mode), free_mae_ms (no anchors), per-song values.
// usage: bun research/eval/lyricsync_bench.ts [--method simple|analytic] [--manifest <file>]
import { solveAnalytic } from '../../packages/lyricsync/src/engine/analytic.ts';
import type { ConsensusLine } from '../../packages/lyricsync/src/engine/consensus.ts';
import { solveSimple } from '../../packages/lyricsync/src/engine/simple.ts';
import { loadTrainingSongs } from '../../packages/lyricsync/src/train/songs.ts';
import { emptyAnchors } from '../../packages/lyricsync/src/workspace/anchors.ts';

const methodArg = process.argv.indexOf('--method');
const method = methodArg < 0 ? 'simple' : process.argv[methodArg + 1];
if (method !== 'simple' && method !== 'analytic') throw new Error(`--method must be simple or analytic, got "${method}".`);
const solver = method === 'simple' ? solveSimple : solveAnalytic;

const manifestArg = process.argv.indexOf('--manifest');
const manifestFile = manifestArg < 0 ? '.cache/bench4.manifest.json' : process.argv[manifestArg + 1]!;

/** Mean over syllables of (|start error| + |end error|) / 2, in ms, over the lines that have a label. */
function syllableMae(lines: ConsensusLine[], truth: Array<ConsensusLine | null>): number {
  let sum = 0;
  let n = 0;
  lines.forEach((line, i) => {
    const t = truth[i];
    if (!t) return;
    line.words.forEach((w, j) => (w.syl ?? []).forEach((s, k) => {
      const z = t.words[j]!.syl![k]!;
      sum += ((Math.abs(s[0] - z[0]) + Math.abs(s[1] - z[1])) / 2) * 1000;
      n++;
    }));
  });
  return n > 0 ? sum / n : 0;
}

const songs = await loadTrainingSongs(manifestFile);
const anchored: number[] = [];
const free: number[] = [];
for (const song of songs) {
  const a = syllableMae(solver({ evidence: song.evidence, anchors: song.anchors, sliced: song.sliced }).lines, song.truth);
  const f = syllableMae(solver({ evidence: song.evidence, anchors: emptyAnchors(), sliced: {} }).lines, song.truth);
  anchored.push(a);
  free.push(f);
  console.log(`METRIC anchored_${song.id}=${a.toFixed(3)}`);
  console.log(`METRIC free_${song.id}=${f.toFixed(3)}`);
}
const mean = (xs: number[]): number => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
console.log(`METRIC free_mae_ms=${mean(free).toFixed(3)}`);
console.log(`METRIC syllable_mae_ms=${mean(anchored).toFixed(3)}`);
