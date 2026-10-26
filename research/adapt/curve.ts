// usage (repo root): bun research/adapt/curve.ts [--songs god_ish,pdoom] [--seeds 1,2,3] [--snap true|false] [--fracs 0,0.1,0.25,0.5]
// Pins a fraction of a song's syllables, solves, scores the syllables that were NOT pinned. Errors are pooled over seeds.
//   scatter: random syllables      lines: random whole lines (both edges -> anchored); the user edits anywhere, in any order
// "flagged" = held-out syllables the human touched (hard truth); the others of the three older songs are the solver's own earlier output.
import { argFlag, errors, loadSong, pinAnchors, pooled, rng, solve, type Syl } from './lib.ts';

const ids = argFlag('--songs', 'god_ish').split(',');
const seeds = argFlag('--seeds', '1,2,3').split(',').map(Number);
const snap = argFlag('--snap', 'true') === 'true';
const fracs = argFlag('--fracs', '0,0.1,0.25,0.5,0.75').split(',').map(Number);

for (const id of ids) {
  const song = await loadSong(id);
  const nLines = song.lines.length;
  for (const pattern of ['scatter', 'lines']) {
    for (const frac of fracs) {
      const all: number[] = [];
      const flagged: number[] = [];
      for (const seed of frac === 0 ? [seeds[0]!] : seeds) {
        const rnd = rng(seed);
        const picked = new Set<number>();
        if (pattern === 'lines') for (let l = 0; l < nLines; l++) if (rnd() < frac) picked.add(l);
        const pinned = new Set<number>();
        song.syls.forEach((s) => { if (pattern === 'scatter' ? rnd() < frac : picked.has(s.line)) pinned.add(s.k); });
        const pins: Syl[] = song.syls.filter((s) => pinned.has(s.k));
        const out = await solve(song, pinAnchors(song, pins), snap);
        all.push(...errors(song, out, (s) => !pinned.has(s.k)));
        flagged.push(...errors(song, out, (s) => !pinned.has(s.k) && s.flagged));
      }
      console.log(`${id.padEnd(15)} ${pattern.padEnd(7)} pin ${String(Math.round(frac * 100)).padStart(3)}%  all ${pooled(all)}  | flagged ${pooled(flagged)}`);
    }
  }
}
