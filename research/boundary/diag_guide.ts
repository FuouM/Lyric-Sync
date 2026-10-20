// Detector quality of the exported boundary model on the annotated songs (reporting only; nothing is fitted on it).
// For every interior boundary of the anchored skeletons: argmax error of the model's P over the boundary's candidate span, and P's mass within 35 ms of the label.
// usage: bun scripts/gtsinger/diag_guide.ts [--guide-dir <dir>]
import { boundaryGuide, GUIDE_SCORING, solveGuided, type BoundaryGuide } from '../../packages/lyricsync/src/engine/guided.ts';
import type { ConsensusLine } from '../../packages/lyricsync/src/engine/consensus.ts';
import { loadTrainingSongs, readTrainingManifest } from '../../packages/lyricsync/src/train/songs.ts';
import { guideModel } from './guide.ts';

const MANIFEST = 'projects/lyricsync.training.json';
const workspaces: Record<string, string> = {};
for (const s of readTrainingManifest(MANIFEST)) workspaces[s.id] = s.workspace;
const songs = await loadTrainingSongs(MANIFEST);
const bounds = (t: ConsensusLine): number[] => [...t.words.flatMap((w) => w.syl!.map((s) => s[0])), t.words.at(-1)!.syl!.at(-1)![1]];
const pct = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]!;

const all: Array<{ song: string; err: number; mass: number; onBeat: boolean }> = [];
for (const song of songs) {
  const model = boundaryGuide(guideModel(workspaces[song.id]!, song.evidence), { ...GUIDE_SCORING, weight: 1, maxPeaks: 1, minPeak: 1 });
  const probe: BoundaryGuide = {
    candidates: (sk, j) => {
      const t = song.truth[sk.lineIdx];
      if (!t || j === 0 || j === sk.cands.length - 1) return [];
      const truth = bounds(t)[j]!;
      const top = model.candidates(sk, j)[0]!;
      const mass = model.score(sk, j, [truth])[0]!;
      all.push({ song: song.id, err: Math.abs(top - truth) * 1000, mass, onBeat: song.evidence.beats.some((b) => Math.abs(b - truth) <= 0.025) });
      return [];
    },
    score: (_sk, _j, cands) => new Float64Array(cands.length),
    mass: (_sk, _j, cands) => new Float64Array(cands.length),
  };
  solveGuided({ evidence: song.evidence, anchors: song.anchors, sliced: song.sliced, guide: probe });
}
for (const [label, rs] of [
  ['all', all],
  ...songs.map((s) => [s.id, all.filter((r) => r.song === s.id)] as const),
  ['label on beat', all.filter((r) => r.onBeat)],
  ['label off beat', all.filter((r) => !r.onBeat)],
] as const) {
  const e = rs.map((r) => r.err);
  console.log(
    `${String(label).padEnd(14)} n=${String(rs.length).padStart(4)} argmax err median ${pct(e, 0.5).toFixed(0)} ms, mean ${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(1)} ms, <=25 ${((100 * e.filter((x) => x <= 25).length) / e.length).toFixed(0)}%, <=50 ${((100 * e.filter((x) => x <= 50).length) / e.length).toFixed(0)}%; mass@35ms mean ${(rs.reduce((a, r) => a + r.mass, 0) / rs.length).toFixed(2)}`,
  );
}
