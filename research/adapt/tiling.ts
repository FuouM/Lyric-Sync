// usage (repo root): bun research/adapt/tiling.ts [--songs god_ish,pdoom,...] [--fracs 0.1,0.25,0.5] [--seeds 1,2,3,4,5]
// Line-end convention. The shipped solver joins a line's end to the next line's start when they are < joinGapSec apart (labels that tile through
// breaths). god_ish's labels do not tile (30% of line ends meet the next start, median gap 189 ms); pdoom / jazzpop / neuro do (76-92%).
// Estimate the song's tiling rate from the lines the user pinned (pinned line end vs the next line's start in the solve, tiled when < --tile ms),
// and switch the join off when it is below --min. Scores the lines that were not pinned: default vs adaptive.
import { argFlag, errors, loadSong, pinAnchors, pooled, rng, SONG_IDS, solve, type Syl } from './lib.ts';

const ids = argFlag('--songs', SONG_IDS.join(',')).split(',');
const fracs = argFlag('--fracs', '0.1,0.25,0.5').split(',').map(Number);
const seeds = argFlag('--seeds', '1,2,3,4,5').split(',').map(Number);
const tile = Number(argFlag('--tile', '30')) / 1000;
const minRate = Number(argFlag('--min', '0.5'));

for (const id of ids) {
  const song = await loadSong(id);
  const first = new Map<number, Syl>();
  const last = new Map<number, Syl>();
  for (const s of song.syls) {
    if (!first.has(s.line)) first.set(s.line, s);
    last.set(s.line, s);
  }
  for (const frac of fracs) {
    const base: number[] = [];
    const adapt: number[] = [];
    const baseF: number[] = [];
    const adaptF: number[] = [];
    const rates: number[] = [];
    let switched = 0;
    for (const seed of seeds) {
      const rnd = rng(seed);
      const picked = new Set<number>();
      for (let l = 0; l < song.lines.length; l++) if (rnd() < frac) picked.add(l);
      if (picked.size === 0) continue;
      const pins = song.syls.filter((s) => picked.has(s.line));
      const anchors = pinAnchors(song, pins);
      const out = await solve(song, anchors);
      // tiling rate from the pinned lines that have a following line: pinned end vs that line's start in the solve
      let tiled = 0;
      let n = 0;
      for (const l of picked) {
        const nx = first.get(l + 1);
        if (!nx) continue;
        n++;
        if (Math.abs(out[nx.k]![0] - last.get(l)!.te) < tile) tiled++;
      }
      const rate = n > 0 ? tiled / n : 1;
      rates.push(rate);
      const join = n > 0 && rate < minRate ? 0 : undefined;
      const out2 = join === 0 ? await solve(song, anchors, true, { joinGapSec: 0 }) : out;
      if (join === 0) switched++;
      const held = (s: Syl): boolean => !picked.has(s.line);
      base.push(...errors(song, out, held));
      adapt.push(...errors(song, out2, held));
      baseF.push(...errors(song, out, (s) => held(s) && s.flagged));
      adaptF.push(...errors(song, out2, (s) => held(s) && s.flagged));
    }
    const mean = rates.reduce((a, b) => a + b, 0) / Math.max(1, rates.length);
    console.log(`${id.padEnd(15)} pinned ${(frac * 100).toFixed(0).padStart(2)}% tiling rate est ${mean.toFixed(2)} (min ${Math.min(...rates).toFixed(2)} max ${Math.max(...rates).toFixed(2)}), join switched off in ${switched}/${seeds.length} runs`);
    console.log(`   default  ${pooled(base)}  | flagged ${pooled(baseF)}`);
    console.log(`   adaptive ${pooled(adapt)}  | flagged ${pooled(adaptF)}`);
  }
}
