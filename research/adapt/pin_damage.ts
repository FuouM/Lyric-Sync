// usage (repo root): bun research/adapt/pin_damage.ts [--song god_ish] [--frac 0.25] [--seed 1]
// Which held-out syllables get worse (or better) once a scatter of syllables is pinned? Splits by where they sit relative to the pins.
import { argFlag, beatPos, loadSong, pinAnchors, rng, solve, type Syl } from './lib.ts';
import { emptyAnchors } from '../../packages/lyricsync/src/workspace/anchors.ts';

const song = await loadSong(argFlag('--song', 'god_ish'));
const frac = Number(argFlag('--frac', '0.25'));
const rnd = rng(Number(argFlag('--seed', '1')));
const pinned = new Set<number>();
song.syls.forEach((s) => { if (rnd() < frac) pinned.add(s.k); });
const free = await solve(song, emptyAnchors());
const out = await solve(song, pinAnchors(song, song.syls.filter((s) => pinned.has(s.k))));
const err = (o: Array<[number, number]>, s: Syl): number => ((Math.abs(o[s.k]![0] - s.ts) + Math.abs(o[s.k]![1] - s.te)) / 2) * 1000;

const pinsPerLine = new Map<number, number>();
song.syls.forEach((s) => { if (pinned.has(s.k)) pinsPerLine.set(s.line, (pinsPerLine.get(s.line) ?? 0) + 1); });
interface Acc { n: number; before: number; after: number; worse100: number; better100: number }
const groups = new Map<string, Acc>();
const add = (g: string, b: number, a: number): void => {
  const x = groups.get(g) ?? groups.set(g, { n: 0, before: 0, after: 0, worse100: 0, better100: 0 }).get(g)!;
  x.n++; x.before += b; x.after += a;
  if (a - b > 100) x.worse100++;
  if (b - a > 100) x.better100++;
};
const worst: Array<[number, Syl]> = [];
for (const s of song.syls) {
  if (pinned.has(s.k)) continue;
  const b = err(free, s);
  const a = err(out, s);
  const np = pinsPerLine.get(s.line) ?? 0;
  const nearest = Math.min(...song.syls.filter((p) => pinned.has(p.k) && p.line === s.line).map((p) => Math.abs(p.j - s.j)), 99);
  const g = np === 0 ? 'line has no pin' : nearest === 1 ? 'adjacent to a pin' : nearest <= 3 ? 'within 3 of a pin' : 'farther than 3 from pins';
  add(g, b, a);
  worst.push([a - b, s]);
}
for (const [g, x] of [...groups].sort()) console.log(`${g.padEnd(26)} n=${String(x.n).padStart(4)} before ${(x.before / x.n).toFixed(1).padStart(6)} after ${(x.after / x.n).toFixed(1).padStart(6)}  worse by >100ms: ${x.worse100}  better by >100ms: ${x.better100}`);
worst.sort((a, b) => b[0] - a[0]);
console.log('largest damage:');
for (const [d, s] of worst.slice(0, 14)) console.log(`  L${s.line} j${s.j} ${s.text.padEnd(4)} +${d.toFixed(0)}ms (line pins ${pinsPerLine.get(s.line) ?? 0})`);
const lineDamage = new Map<number, number>();
for (const [d, s] of worst) lineDamage.set(s.line, (lineDamage.get(s.line) ?? 0) + d);
console.log('lines by total damage:', [...lineDamage].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, d]) => `L${l}:${d.toFixed(0)}`).join(' '));
void beatPos;
