// Ablation of the guided solver's hand-set components with the boundary model on, from the shipped GUIDED_DESIGN (in-sample: the three annotated songs).
//   knockout: every component switched off alone, at each guide weight.
//   greedy:   backward elimination: each round removes the component whose removal gives the best objective, while that is no worse than
//             the current best + tolerance; the guide weight is re-chosen from the grid each round.
// Objective: mean of the anchored and free syllable MAE over the songs.
// usage: bun scripts/gtsinger/ablate_guided.ts knockout|greedy [--weights 3,6] [--tolerance 0.05] [--guide-dir <dir>]
import { boundaryGuide, GUIDE_SCORING, GUIDED_DESIGN, solveGuided, type BoundaryGuide, type GuidedDesign } from '../../packages/lyricsync/src/engine/guided.ts';
import type { ConsensusLine } from '../../packages/lyricsync/src/engine/consensus.ts';
import { loadTrainingSongs, readTrainingManifest } from '../../packages/lyricsync/src/train/songs.ts';
import { emptyAnchors } from '../../packages/lyricsync/src/workspace/anchors.ts';
import { guideModel } from './guide.ts';

const MANIFEST = 'projects/lyricsync.training.json';
/** Each component and the override that switches it off. */
const OFF: Record<string, Partial<GuidedDesign>> = {
  rmvpe: { rmvpeVote: 0 },
  harmo: { harmoVote: 0 },
  edge: { edgeVote: 0 },
  aligner: { alignerVote: 0 },
  beat: { beatVote: 0 },
  eighth: { eighthVote: 0 },
  audio: { audioVote: 0 },
  prior: { priorWeight: 0 },
  duration: { durationWeight: 0 },
  phase: { phaseWeight: 0 },
  inside: { insideWeight: 0 },
  nucleus: { nucleusWeight: 0 },
  edge1: { edge1Vote: 0 },
  rest: { restMinSec: 0 },
  beatSnap: { beatSnapSec: 0 },
  joinEnds: { joinGapSec: 0 },
  lineEdgeVotes: { lineEdgeVoteScale: 0 },
};

const mode = process.argv[2];
if (mode !== 'knockout' && mode !== 'greedy') throw new Error('usage: ablate_guided.ts knockout|greedy [--weights 3,6] [--tolerance 0.05]');
const opt = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i < 0 ? def : process.argv[i + 1]!;
};
const weights = opt('--weights', '3,6').split(',').map(Number);
const tolerance = Number(opt('--tolerance', '0.05'));

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
// One guide per (song, mode, weight): a guide caches its per-boundary distributions, which depend on the mode's candidate spans.
const guides = new Map<string, BoundaryGuide>();
const guideFor = (id: string, m: 'a' | 'f', w: number): BoundaryGuide => {
  const key = `${id}:${m}:${w}`;
  let g = guides.get(key);
  if (!g) {
    const song = songs.find((s) => s.id === id)!;
    guides.set(key, (g = boundaryGuide(guideModel(workspaces[id]!, song.evidence), { ...GUIDE_SCORING, weight: w })));
  }
  return g;
};

interface Score { anchored: number; free: number; objective: number }
function evaluate(design: Partial<GuidedDesign>, w: number): Score {
  const a: number[] = [];
  const f: number[] = [];
  for (const song of songs) {
    a.push(syllableMae(solveGuided({ evidence: song.evidence, anchors: song.anchors, sliced: song.sliced, guide: guideFor(song.id, 'a', w), design }).lines, song.truth));
    f.push(syllableMae(solveGuided({ evidence: song.evidence, anchors: emptyAnchors(), sliced: {}, guide: guideFor(song.id, 'f', w), design }).lines, song.truth));
  }
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  return { anchored: mean(a), free: mean(f), objective: (mean(a) + mean(f)) / 2 };
}
const fmt = (s: Score): string => `anchored ${s.anchored.toFixed(3)} free ${s.free.toFixed(3)} objective ${s.objective.toFixed(3)}`;
const merge = (names: string[]): Partial<GuidedDesign> => Object.assign({}, ...names.map((n) => OFF[n]));

if (mode === 'knockout') {
  for (const w of weights) {
    const base = evaluate({}, w);
    console.log(`weight ${w}: all components: ${fmt(base)}`);
    for (const name of Object.keys(OFF)) {
      const s = evaluate(OFF[name]!, w);
      console.log(`  -${name.padEnd(14)} ${fmt(s)}  delta anchored ${(s.anchored - base.anchored).toFixed(3).padStart(7)} free ${(s.free - base.free).toFixed(3).padStart(7)}`);
    }
  }
} else {
  const removed: string[] = [];
  let best = { w: weights[0]!, s: evaluate({}, weights[0]!) };
  for (const w of weights.slice(1)) {
    const s = evaluate({}, w);
    if (s.objective < best.s.objective) best = { w, s };
  }
  console.log(`start: weight ${best.w} ${fmt(best.s)}`);
  for (;;) {
    let round: { name: string; w: number; s: Score } | null = null;
    for (const name of Object.keys(OFF).filter((n) => !removed.includes(n))) {
      for (const w of weights) {
        const s = evaluate(merge([...removed, name]), w);
        if (round === null || s.objective < round.s.objective) round = { name, w, s };
      }
    }
    if (round === null || round.s.objective > best.s.objective + tolerance) {
      console.log(`stop: best removal ${round ? `-${round.name} (${fmt(round.s)})` : 'none'} is worse than ${best.s.objective.toFixed(3)} + ${tolerance}`);
      break;
    }
    removed.push(round.name);
    best = { w: round.w, s: round.s };
    console.log(`remove ${round.name.padEnd(14)} -> weight ${round.w} ${fmt(round.s)}  (removed: ${removed.join(', ')})`);
  }
  console.log(`final: removed [${removed.join(', ')}], weight ${best.w}, ${fmt(best.s)}`);
}
