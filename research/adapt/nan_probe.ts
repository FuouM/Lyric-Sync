// Counts syllables with non-finite solved times for random pin patterns (feasibility of the solver under user pins).
// usage: bun research/adapt/dbg.ts [--songs a,b] [--seeds 1,2,3,4]
import { argFlag, loadSong, pinAnchors, rng, solve, type Syl } from './lib.ts';
const ids = argFlag('--songs', 'god_ish').split(',');
const seeds = argFlag('--seeds', '1,2,3,4').split(',').map(Number);
for (const id of ids) {
  const song = await loadSong(id);
  for (const pattern of ['scatter', 'lines'] as const) {
    for (const frac of [0.1, 0.25, 0.5, 0.75]) {
      for (const seed of seeds) {
        const rnd = rng(seed);
        const pinned = new Set<number>();
        const picked = new Set<number>();
        if (pattern === 'lines') for (let l = 0; l < song.lines.length; l++) if (rnd() < frac) picked.add(l);
        song.syls.forEach((s) => { if (pattern === 'scatter' ? rnd() < frac : picked.has(s.line)) pinned.add(s.k); });
        const pins: Syl[] = song.syls.filter((s) => pinned.has(s.k));
        const out = await solve(song, pinAnchors(song, pins), true);
        const bad = song.syls.filter((s) => !Number.isFinite(out[s.k]![0]) || !Number.isFinite(out[s.k]![1]));
        if (bad.length > 0) console.log(`${id} ${pattern} ${frac} seed ${seed}: pins ${pins.length} nonfinite ${bad.length} first line ${bad[0]!.line}`);
      }
    }
  }
}
console.log('done');
