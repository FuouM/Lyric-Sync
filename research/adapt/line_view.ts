// usage (repo root): bun research/adapt/line_view.ts --line 20 [--song god_ish] [--frac 0.25] [--seed 1]
// One line under a scatter pin set: truth, free solve and pinned solve, per syllable (seconds from the line's truth start; * = pinned).
import { argFlag, loadSong, pinAnchors, rng, solve, type Syl } from './lib.ts';
import { emptyAnchors } from '../../packages/lyricsync/src/workspace/anchors.ts';

const song = await loadSong(argFlag('--song', 'god_ish'));
const rnd = rng(Number(argFlag('--seed', '1')));
const frac = Number(argFlag('--frac', '0.25'));
const pinned = new Set<number>();
song.syls.forEach((s) => { if (rnd() < frac) pinned.add(s.k); });
const free = await solve(song, emptyAnchors());
const out = await solve(song, pinAnchors(song, song.syls.filter((s) => pinned.has(s.k))));
const L = Number(argFlag('--line', '20'));
const ls: Syl[] = song.syls.filter((s) => s.line === L);
const t0 = ls[0]!.ts;
console.log(`L${L} "${song.lines[L]!.text}" truth start ${t0}`);
const f = (x: number): string => (x - t0).toFixed(2).padStart(6);
for (const s of ls) console.log(`${String(s.j).padStart(2)} ${s.text.padEnd(4)}${pinned.has(s.k) ? '*' : ' '} truth ${f(s.ts)}-${f(s.te)}  free ${f(free[s.k]![0])}-${f(free[s.k]![1])}  pinned ${f(out[s.k]![0])}-${f(out[s.k]![1])}`);
const prev = song.syls.filter((s) => s.line === L - 1);
console.log(`prev line L${L - 1}: truth end ${f(prev.at(-1)!.te)}  free last start ${f(free[prev.at(-1)!.k]![0])}  pinned last start ${f(out[prev.at(-1)!.k]![0])}`);
