// Benchmark of the guided solver (lyricsync's default method: the vote-count solver + the GTSinger-trained boundary model) against the
// calibrated labels of the three annotated songs. The model never saw these songs: it is trained on GTSinger only. Same metric as
// scripts/lyricsync_bench.ts. Defaults = the shipped configuration (GUIDED_DESIGN, GUIDE_SCORING, the model output in the prepared evidence).
// usage: bun scripts/gtsinger/bench_guided.ts [--manifest projects/lyricsync.training.json] [--weight 4.5] [--mass 0.035] [--peaks 3]
//        [--min-peak 0.3] [--margin 0.1] [--no-guide] [--set k=v ...] [--guide-dir <dir>]
//        (--guide-dir: a research export in each workspace, export_guide.py, instead of the shipped model)
import { boundaryGuide, GUIDE_SCORING, GUIDED_DESIGN, solveGuided } from '../../packages/lyricsync/src/engine/guided.ts';
import type { ConsensusLine } from '../../packages/lyricsync/src/engine/consensus.ts';
import { loadTrainingSongs, readTrainingManifest } from '../../packages/lyricsync/src/train/songs.ts';
import { emptyAnchors } from '../../packages/lyricsync/src/workspace/anchors.ts';
import { guideModel } from './guide.ts';

const manifestArg = process.argv.indexOf('--manifest');
const MANIFEST = manifestArg < 0 ? 'projects/lyricsync.training.json' : process.argv[manifestArg + 1]!;
const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i < 0 ? def : Number(process.argv[i + 1]);
};
const scoring = {
  weight: arg('--weight', GUIDE_SCORING.weight),
  massSec: arg('--mass', GUIDE_SCORING.massSec),
  maxPeaks: arg('--peaks', GUIDE_SCORING.maxPeaks),
  minPeak: arg('--min-peak', GUIDE_SCORING.minPeak),
  marginSec: arg('--margin', GUIDE_SCORING.marginSec),
};
const useGuide = !process.argv.includes('--no-guide');
/** --set key=value (repeatable): override a GUIDED_DESIGN constant. */
const design: Record<string, number> = {};
process.argv.forEach((a, i) => {
  if (a !== '--set') return;
  const [k, v] = process.argv[i + 1]!.split('=');
  if (!(k! in GUIDED_DESIGN)) throw new Error(`unknown design constant ${k}`);
  design[k!] = Number(v);
});

const starts = (t: ConsensusLine): number[] => t.words.flatMap((w) => w.syl!.map((s) => s[0]));
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
  return sum / n;
}

const workspaces: Record<string, string> = {};
for (const s of readTrainingManifest(MANIFEST)) workspaces[s.id] = s.workspace;
const songs = await loadTrainingSongs(MANIFEST);
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const anchored: number[] = [];
const free: number[] = [];
const split = { on: [] as number[], off: [] as number[] };
for (const song of songs) {
  const model = guideModel(workspaces[song.id]!, song.evidence);
  // A guide caches its per-boundary distributions, which depend on the mode's candidate spans: one per solve.
  const guide = () => (useGuide ? boundaryGuide(model, scoring) : null);
  const a = solveGuided({ evidence: song.evidence, anchors: song.anchors, sliced: song.sliced, guide: guide(), design });
  const f = solveGuided({ evidence: song.evidence, anchors: emptyAnchors(), sliced: {}, guide: guide(), design });
  anchored.push(syllableMae(a.lines, song.truth));
  free.push(syllableMae(f.lines, song.truth));
  a.lines.forEach((line, li) => {
    const t = song.truth[li];
    if (!t) return;
    const ps = starts(line);
    const ts = starts(t);
    for (let j = 1; j < ts.length; j++) {
      const on = song.evidence.beats.some((b) => Math.abs(b - ts[j]!) <= 0.025);
      (on ? split.on : split.off).push(Math.abs(ps[j]! - ts[j]!) * 1000);
    }
  });
  console.log(`METRIC anchored_${song.id}=${anchored.at(-1)!.toFixed(3)}`);
  console.log(`METRIC free_${song.id}=${free.at(-1)!.toFixed(3)}`);
}
console.log(`interior starts (anchored): on-beat ${mean(split.on).toFixed(1)} ms (n=${split.on.length}), off-beat ${mean(split.off).toFixed(1)} ms (n=${split.off.length})`);
console.log(`METRIC free_mae_ms=${mean(free).toFixed(3)}`);
console.log(`METRIC syllable_mae_ms=${mean(anchored).toFixed(3)}`);
