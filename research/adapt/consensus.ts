// usage (repo root): bun research/adapt/consensus.ts [--songs god_ish] [--seeds 1,2,3] [--fracs 0,0.25,0.5] [--tol 80] [--pinw 3]
// Twin consensus. Lines with identical text recur at integer-beat offsets with the same syllable timings in beats. Without any pin the solver's own
// twins already vote: per syllable, the median of the other copies' timings (shifted by the integer beat offset between the copies) replaces a
// copy's time where it is an outlier (more than --tol ms away). Pinned copies count --pinw times.
import { argFlag, beatPos, errors, loadSong, pinAnchors, pooled, rng, solve, timeAt, type Song, type Syl, type Times } from './lib.ts';

const ids = argFlag('--songs', 'god_ish').split(',');
const seeds = argFlag('--seeds', '1,2,3').split(',').map(Number);
const fracs = argFlag('--fracs', '0,0.25,0.5').split(',').map(Number);
const tolMs = Number(argFlag('--tol', '80'));
const pinW = Number(argFlag('--pinw', '3'));

const wmedian = (xs: Array<[number, number]>): number => {
  const s = [...xs].sort((a, b) => a[0] - b[0]);
  const half = s.reduce((a, x) => a + x[1], 0) / 2;
  let c = 0;
  for (const [v, w] of s) { c += w; if (c >= half) return v; }
  return s[s.length - 1]![0];
};

export function repairByTwins(song: Song, out: Times, pinnedLines: Set<number>, tol = tolMs, wPin = pinW): { out: Times; changed: number } {
  const next = out.map((t): [number, number] => [t[0], t[1]]);
  const byLine = new Map<number, Syl[]>();
  song.syls.forEach((s) => (byLine.get(s.line) ?? byLine.set(s.line, []).get(s.line)!).push(s));
  const groups = new Map<string, number[]>();
  for (const l of byLine.keys()) (groups.get(song.lines[l]!.text) ?? groups.set(song.lines[l]!.text, []).get(song.lines[l]!.text)!).push(l);
  let changed = 0;
  for (const lines of groups.values()) {
    if (lines.length < 2) continue;
    for (const line of lines) {
      if (pinnedLines.has(line)) continue;
      const syls = byLine.get(line)!;
      const votes: Array<{ pos: number[]; posEnd: number[]; w: number }> = [];
      for (const twin of lines) {
        if (twin === line) continue;
        const ts = byLine.get(twin)!;
        if (ts.length !== syls.length) continue;
        const d = syls.map((s, j) => beatPos(song.beats, out[s.k]![0]) - beatPos(song.beats, out[ts[j]!.k]![0])).sort((a, b) => a - b);
        const shift = Math.round(d[Math.floor(d.length / 2)]!);
        votes.push({
          pos: ts.map((t) => beatPos(song.beats, out[t.k]![0]) + shift),
          posEnd: ts.map((t) => beatPos(song.beats, out[t.k]![1]) + shift),
          w: pinnedLines.has(twin) ? wPin : 1,
        });
      }
      if (votes.length === 0) continue;
      syls.forEach((s, j) => {
        const c = wmedian(votes.map((v) => [v.pos[j]!, v.w]));
        const cEnd = wmedian(votes.map((v) => [v.posEnd[j]!, v.w]));
        const own = out[s.k]![0];
        if (Math.abs(timeAt(song.beats, c) - own) * 1000 <= tol) return;
        next[s.k] = [timeAt(song.beats, c), timeAt(song.beats, cEnd)];
        changed++;
      });
    }
  }
  return { out: next, changed };
}

if (import.meta.main) {
  for (const id of ids) {
    const song = await loadSong(id);
    for (const frac of fracs) {
      const before: number[] = [];
      const after: number[] = [];
      let changed = 0;
      for (const seed of frac === 0 ? [seeds[0]!] : seeds) {
        const rnd = rng(seed);
        const picked = new Set<number>();
        for (let l = 0; l < song.lines.length; l++) if (rnd() < frac) picked.add(l);
        const out = await solve(song, pinAnchors(song, song.syls.filter((s) => picked.has(s.line))));
        const r = repairByTwins(song, out, picked);
        const held = (s: Syl): boolean => !picked.has(s.line);
        before.push(...errors(song, out, held));
        after.push(...errors(song, r.out, held));
        changed += r.changed;
      }
      console.log(`${id} lines pinned ${(frac * 100).toFixed(0)}%  syllables replaced ${changed}`);
      console.log(`   before ${pooled(before)}`);
      console.log(`   after  ${pooled(after)}`);
    }
  }
}
