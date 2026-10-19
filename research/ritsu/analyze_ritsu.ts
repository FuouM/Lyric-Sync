// Benchmark and error breakdown of the guided (default) and simple solvers on the Ritsu benchmark (.cache/ritsu, prepared by
// prepare_ritsu.ts). Metric as bench_guided.ts: syllable MAE = mean over syllables of (|d start| + |d end|) / 2, in ms.
// Breakdown of syllable-start errors by kind: line start, run start (after a rest inside the line), V (vowel-only mora after a
// sung mora: legato vowel change), N, cl, CV; plus line ends. Songs: all, or --split dev|test (md5-free: alternate by index).
// usage: bun research/ritsu/analyze_ritsu.ts [--manifest m.json] [--split dev|test] [--only guided|simple] [--set k=v ...] [--guide-dir <dir>]
//        [--json out.json]   (--guide-dir: a research boundary-model export in each workspace, export_guide.py)
import * as fs from 'node:fs';
import type { ConsensusLine } from '../../packages/lyricsync/src/engine/consensus.ts';
import { boundaryGuide, GUIDE_SCORING, GUIDED_DESIGN, solveGuided } from '../../packages/lyricsync/src/engine/guided.ts';
import { solveSimple } from '../../packages/lyricsync/src/engine/simple.ts';
import { loadTrainingSongs, readTrainingManifest } from '../../packages/lyricsync/src/train/songs.ts';
import { guideModel } from '../boundary/guide.ts';
import { emptyAnchors } from '../../packages/lyricsync/src/workspace/anchors.ts';

const opt = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const MANIFEST = opt('--manifest') ?? '.cache/ritsu/ritsu.training.json';
const split = opt('--split');
const only = opt('--only');

// Vsame: the vowel of the previous mora again (a held vowel re-attacked on a new note, "ka a"); Vdiff: another vowel ("ko i")
type Kind = 'lineStart' | 'runStart' | 'Vsame' | 'Vdiff' | 'N' | 'cl' | 'CV' | 'lineEnd';
const KINDS: Kind[] = ['lineStart', 'runStart', 'CV', 'Vsame', 'Vdiff', 'N', 'cl', 'lineEnd'];
/** Signed errors (prediction - truth) in ms. */
/** joined: line ends the solver ran up to (within 10 ms of) the next line's predicted start, of `ends` line ends with a next line. */
interface Acc { mae: number[]; err: Record<Kind, number[]>; joined: number; ends: number }
const newAcc = (): Acc => ({ mae: [], err: Object.fromEntries(KINDS.map((k) => [k, []])) as unknown as Record<Kind, number[]>, joined: 0, ends: 0 });

function kindOf(text: string, prevText: string | null, k: number, prevEnd: number | null, start: number): Kind {
  if (k === 0) return 'lineStart';
  if (prevEnd !== null && start - prevEnd > 0.0005) return 'runStart';
  if (text === 'n') return 'N';
  if (text === 'cl') return 'cl';
  if (!/^[aiueo]$/.test(text)) return 'CV';
  return prevText !== null && prevText.endsWith(text) ? 'Vsame' : 'Vdiff';
}

function score(lines: ConsensusLine[], truth: Array<ConsensusLine | null>, acc: Acc): void {
  let sum = 0;
  let n = 0;
  lines.forEach((line, li) => {
    const t = truth[li];
    if (!t) return;
    const ps = line.words.flatMap((w) => w.syl ?? []);
    const ts = t.words.flatMap((w) => w.syl ?? []);
    const texts = t.words.flatMap((w) => w.sylText ?? []);
    ts.forEach((z, k) => {
      const s = ps[k]!;
      sum += ((Math.abs(s[0] - z[0]) + Math.abs(s[1] - z[1])) / 2) * 1000;
      n++;
      acc.err[kindOf(texts[k]!, k > 0 ? texts[k - 1]! : null, k, k > 0 ? ts[k - 1]![1] : null, z[0])].push((s[0] - z[0]) * 1000);
    });
    acc.err.lineEnd.push((ps.at(-1)![1] - ts.at(-1)![1]) * 1000);
    const next = lines[li + 1]?.words[0]?.syl?.[0];
    if (next) {
      acc.ends++;
      if (next[0] - ps.at(-1)![1] < 0.01) acc.joined++;
    }
  });
  acc.mae.push(sum / n);
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const absMean = (xs: number[]): number => mean(xs.map(Math.abs));
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? 0;
const within = (xs: number[], ms: number): number => (100 * xs.filter((x) => Math.abs(x) <= ms).length) / Math.max(1, xs.length);

const all = await loadTrainingSongs(MANIFEST, (m) => process.stderr.write(`${m}\n`));
const workspaces = new Map(readTrainingManifest(MANIFEST).map((s) => [s.id, s.workspace]));
const songs = split === undefined ? all : all.filter((_, i) => (i % 2 === 0) === (split === 'dev'));
const solvers = (['guided', 'simple'] as const).filter((s) => only === undefined || s === only);
/** --set key=value (repeatable): override a GUIDED_DESIGN constant. */
const design: Record<string, number> = {};
process.argv.forEach((a, i) => {
  if (a !== '--set') return;
  const [k, v] = process.argv[i + 1]!.split('=');
  if (!(k! in GUIDED_DESIGN)) throw new Error(`unknown design constant ${k}`);
  design[k!] = Number(v);
});
const results: Record<string, Acc> = {};
for (const solver of solvers) for (const mode of ['anchored', 'free']) results[`${solver}/${mode}`] = newAcc();
const perSong: Record<string, Record<string, number>> = {};
for (const song of songs) {
  perSong[song.id] = {};
  for (const solver of solvers) {
    for (const mode of ['anchored', 'free'] as const) {
      const anchors = mode === 'anchored' ? song.anchors : emptyAnchors();
      const sliced = mode === 'anchored' ? song.sliced : {};
      const out = solver === 'guided'
        ? solveGuided({ evidence: song.evidence, anchors, sliced, guide: boundaryGuide(guideModel(workspaces.get(song.id)!, song.evidence), GUIDE_SCORING), design })
        : solveSimple({ evidence: song.evidence, anchors, sliced });
      const acc = results[`${solver}/${mode}`]!;
      score(out.lines, song.truth, acc);
      perSong[song.id]![`${solver}/${mode}`] = acc.mae.at(-1)!;
    }
  }
  console.log(`${song.id}: ${Object.entries(perSong[song.id]!).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  ')}`);
}

console.log(`\n${songs.length} songs${split ? ` (${split})` : ''}`);
console.log(`| solver/mode | syllable MAE ms | starts <=20 ms | starts <=50 ms |`);
console.log(`|---|---|---|---|`);
for (const [k, acc] of Object.entries(results)) {
  const starts = KINDS.filter((x) => x !== 'lineEnd').flatMap((x) => acc.err[x]);
  console.log(`| ${k} | ${mean(acc.mae).toFixed(2)} | ${within(starts, 20).toFixed(1)}% | ${within(starts, 50).toFixed(1)}% |`);
}
console.log(`\nstart error by kind (|mean| ms / signed mean ms / median signed ms / <=20 ms / n):`);
console.log(`| solver/mode | ${KINDS.join(' | ')} |`);
console.log(`|---|${KINDS.map(() => '---').join('|')}|`);
for (const [k, acc] of Object.entries(results)) {
  const cell = (x: Kind): string => `${absMean(acc.err[x]).toFixed(1)} / ${mean(acc.err[x]).toFixed(1)} / ${median(acc.err[x]).toFixed(1)} / ${within(acc.err[x], 20).toFixed(0)}% / ${acc.err[x].length}`;
  console.log(`| ${k} | ${KINDS.map(cell).join(' | ')} |`);
  console.log(`  line ends joined to the next line's start: ${((100 * acc.joined) / Math.max(1, acc.ends)).toFixed(0)}% (truth: every line is followed by a rest >= 0.25 s)`);
}
const jsonOut = opt('--json');
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify({ perSong, results }, null, 1)}\n`);
