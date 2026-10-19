// Guided solver evaluation on the 4 calibrated benchmark songs (breaked, breaked_retro, suika_retro, pdoom).
// Syllable MAE = mean (|d start| + |d end|) / 2 in ms.
// usage: bun research/eval/bench4.ts [--songs-dir <dir>] [--set k=v ...] [--lines] [--json out.json]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { boundaryGuide, GUIDED_DESIGN, solveGuided } from '../../packages/lyricsync/src/engine/guided.ts';
import type { ConsensusLine } from '../../packages/lyricsync/src/types.ts';
import { loadTrainingSongs } from '../../packages/lyricsync/src/train/songs.ts';
import { emptyAnchors } from '../../packages/lyricsync/src/workspace/anchors.ts';

const opt = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};

const songsDirArg = opt('--songs-dir') ?? process.env.SONGS_DIR ?? '../probable-video-editor/projects';
const songsDir = path.resolve(songsDirArg);

const design: Record<string, number> = {};
process.argv.forEach((a, i) => {
  if (a !== '--set') return;
  const [k, v] = process.argv[i + 1]!.split('=');
  if (!(k! in GUIDED_DESIGN)) throw new Error(`unknown design constant ${k}`);
  design[k!] = Number(v);
});
const showLines = process.argv.includes('--lines');
const jsonOut = opt('--json');

interface Acc { sum: number; n: number }
const acc = (): Acc => ({ sum: 0, n: 0 });
const mae = (a: Acc): number => a.sum / Math.max(1, a.n);

function score(lines: ConsensusLine[], truth: Array<ConsensusLine | null>, calOnly: boolean): { all: Acc; perLine: number[] } {
  const all = acc();
  const perLine: number[] = [];
  lines.forEach((line, i) => {
    const t = truth[i];
    const l = acc();
    if (t) {
      line.words.forEach((w, j) => (w.syl ?? []).forEach((s, k) => {
        const tw = t.words[j]!;
        if (calOnly && !(tw.sylCalibrated?.[k] ?? false)) return;
        const z = tw.syl![k]!;
        // calibrated metric: the song's last syllable end is a stylistic fade (pdoom "show"); only its start counts
        const outro = calOnly && i === lines.length - 1 && j === line.words.length - 1 && k === w.syl!.length - 1;
        const e = (outro ? Math.abs(s[0] - z[0]) : (Math.abs(s[0] - z[0]) + Math.abs(s[1] - z[1])) / 2) * 1000;
        all.sum += e; all.n++; l.sum += e; l.n++;
      }));
    }
    perLine.push(l.n ? mae(l) : NaN);
  });
  return { all, perLine };
}

const SONG_DEFS = [
  { id: 'breaked', skipLines: [37] },
  { id: 'breaked_retro', skipLines: [] },
  { id: 'suika_retro', skipLines: [] },
  { id: 'pdoom', skipLines: [] },
];

function resolveSong(id: string): { workspace: string; calibrated: string } {
  // Check local songs/ folder first
  const localWs = path.resolve('songs', id, 'lyricsync');
  const localCal = path.resolve('songs', id, 'user_input/lyrics.calibrated.json');
  if (fs.existsSync(localWs) && fs.existsSync(localCal)) {
    return { workspace: localWs, calibrated: localCal };
  }
  // Check songsDir
  const extWs = path.resolve(songsDir, id, 'lyricsync');
  const extCal = path.resolve(songsDir, id, 'user_input/lyrics.calibrated.json');
  if (fs.existsSync(extWs) && fs.existsSync(extCal)) {
    return { workspace: extWs, calibrated: extCal };
  }
  throw new Error(`Cannot locate song "${id}": checked "songs/${id}" and "${songsDir}/${id}". Set --songs-dir <path> or SONGS_DIR.`);
}

const manifestDir = path.resolve('.cache');
fs.mkdirSync(manifestDir, { recursive: true });
const manifestFile = path.join(manifestDir, 'bench4.manifest.json');
const manifestContent = {
  songs: SONG_DEFS.map((s) => {
    const r = resolveSong(s.id);
    return { id: s.id, workspace: r.workspace, calibrated: r.calibrated, skipLines: s.skipLines };
  }),
};
fs.writeFileSync(manifestFile, `${JSON.stringify(manifestContent, null, 2)}\n`);

const songs = await loadTrainingSongs(manifestFile);
const res: Record<string, number | number[]> = {};
const A: number[] = [];
const F: number[] = [];
for (const song of songs) {
  const guide = () => boundaryGuide(song.evidence.boundary);
  const a = solveGuided({ evidence: song.evidence, anchors: song.anchors, sliced: song.sliced, guide: guide(), design });
  const f = solveGuided({ evidence: song.evidence, anchors: emptyAnchors(), sliced: {}, guide: guide(), design });
  const sa = score(a.lines, song.truth, false);
  const sf = score(f.lines, song.truth, false);
  A.push(mae(sa.all)); F.push(mae(sf.all));
  res[`anchored_${song.id}`] = mae(sa.all); res[`free_${song.id}`] = mae(sf.all);
  res[`lines_free_${song.id}`] = sf.perLine; res[`lines_anchored_${song.id}`] = sa.perLine;
  console.log(`${song.id.padEnd(14)} anchored ${mae(sa.all).toFixed(2).padStart(7)}  free ${mae(sf.all).toFixed(2).padStart(7)}  (n=${sa.all.n})`);
  const calibratedTruth = song.truth.some((t) => t?.words.some((w) => w.sylCalibrated?.some((c) => !c)));
  if (calibratedTruth) {
    const ca = score(a.lines, song.truth, true);
    const cf = score(f.lines, song.truth, true);
    res[`anchored_${song.id}_cal`] = mae(ca.all); res[`free_${song.id}_cal`] = mae(cf.all);
    console.log(`${(song.id + ' cal').padEnd(14)} anchored ${mae(ca.all).toFixed(2).padStart(7)}  free ${mae(cf.all).toFixed(2).padStart(7)}  (n=${ca.all.n} calibrated syllables)`);
    res[`lines_calfree_${song.id}`] = cf.perLine; res[`lines_calanch_${song.id}`] = ca.perLine;
    if (showLines) {
      const rows = cf.perLine.map((e, i) => [i, e, ca.perLine[i]!] as const).filter((x) => !Number.isNaN(x[1])).sort((x, y) => y[1] - x[1]);
      for (const [i, e, ea] of rows) console.log(`   cal L${String(i).padStart(2)} free ${e.toFixed(0).padStart(6)} anchored ${ea.toFixed(0).padStart(5)}  ${song.truth[i]!.text}`);
    }
  }
  if (showLines) {
    const worst = sf.perLine.map((e, i) => [i, e, sa.perLine[i]!] as const).filter((x) => !Number.isNaN(x[1])).sort((x, y) => y[1] - x[1]).slice(0, 8);
    for (const [i, e, ea] of worst) console.log(`   L${String(i).padStart(2)} free ${e.toFixed(0).padStart(6)} anchored ${ea.toFixed(0).padStart(5)}  ${song.truth[i]!.text}`);
  }
}
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
res.anchored_mean = mean(A); res.free_mean = mean(F);
res.anchored_mean3 = mean(A.slice(0, 3)); res.free_mean3 = mean(F.slice(0, 3));
console.log(`MEAN(4)        anchored ${mean(A).toFixed(3)}  free ${mean(F).toFixed(3)}`);
console.log(`MEAN(3 old)    anchored ${mean(A.slice(0, 3)).toFixed(3)}  free ${mean(F.slice(0, 3)).toFixed(3)}`);
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(res, null, 1)}\n`);
