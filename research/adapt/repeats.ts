// usage (repo root): bun research/adapt/repeats.ts [--songs god_ish] [--seeds 1,2,3] [--fracs 0.1,0.25,0.5] [--agree 0.4] [--tol 60]
// Repeated-line transfer. A line whose lyric text equals a pinned line's recurs at an integer number of beats later (god_ish truth: 0.0-0.1 beat
// off an integer), with the same syllable timings in beats. Pin whole random lines, solve, then for every unpinned line with a pinned twin: find the
// integer beat shift of the twin's timing that agrees best with the solver's own boundaries; if enough of them agree, take the twin's timing.
import { argFlag, beatPos, errors, loadSong, pinAnchors, pooled, rng, solve, timeAt, type Song, type Syl, type Times } from './lib.ts';

const ids = argFlag('--songs', 'god_ish').split(',');
const seeds = argFlag('--seeds', '1,2,3').split(',').map(Number);
const fracs = argFlag('--fracs', '0.1,0.25,0.5').split(',').map(Number);
const agreeMin = Number(argFlag('--agree', '0.4'));
const tolSec = Number(argFlag('--tol', '60')) / 1000;

interface Transfer { line: number; twin: number; shift: number; agree: number }

/** Transfer onto `out` (copy) for every line not in `pinnedLines`; returns the new times and what was done. */
export function transferRepeats(song: Song, out: Times, pinnedLines: Set<number>, truthTimes: Times = song.syls.map((s) => [s.ts, s.te])): { out: Times; done: Transfer[] } {
  const next = out.map((t): [number, number] => [t[0], t[1]]);
  const done: Transfer[] = [];
  const byLine = new Map<number, Syl[]>();
  song.syls.forEach((s) => (byLine.get(s.line) ?? byLine.set(s.line, []).get(s.line)!).push(s));
  const text = (l: number): string => song.lines[l]!.text;
  for (const [line, syls] of byLine) {
    if (pinnedLines.has(line)) continue;
    let best: Transfer | null = null;
    for (const [twin, tsyls] of byLine) {
      if (!pinnedLines.has(twin) || text(twin) !== text(line) || tsyls.length !== syls.length) continue;
      const rel = tsyls.map((s) => beatPos(song.beats, truthTimes[s.k]![0]));
      const relEnd = tsyls.map((s) => beatPos(song.beats, truthTimes[s.k]![1]));
      // integer beat shifts: every shift that puts the first syllable inside the song
      const center = Math.round(beatPos(song.beats, out[syls[0]!.k]![0]) - rel[0]!);
      let top: Transfer | null = null;
      for (let shift = center - 400; shift <= center + 400; shift++) {
        let agree = 0;
        for (let j = 1; j < syls.length; j++) if (Math.abs(timeAt(song.beats, rel[j]! + shift) - out[syls[j]!.k]![0]) < tolSec) agree++;
        const a = agree / Math.max(1, syls.length - 1);
        if (!top || a > top.agree) top = { line, twin, shift, agree: a };
      }
      void relEnd;
      if (top && (!best || top.agree > best.agree)) best = top;
    }
    if (!best || best.agree < agreeMin) continue;
    const tsyls = byLine.get(best.twin)!;
    syls.forEach((s, j) => {
      const t = tsyls[j]!;
      next[s.k] = [timeAt(song.beats, beatPos(song.beats, truthTimes[t.k]![0]) + best.shift), timeAt(song.beats, beatPos(song.beats, truthTimes[t.k]![1]) + best.shift)];
    });
    done.push(best);
  }
  return { out: next, done };
}

if (import.meta.main) {
  for (const id of ids) {
    const song = await loadSong(id);
    for (const frac of fracs) {
      const base: number[] = [];
      const moved: number[] = [];
      const wrongBefore: number[] = [];
      const wrongAfter: number[] = [];
      let nMoved = 0;
      let nHeld = 0;
      for (const seed of seeds) {
        const rnd = rng(seed);
        const picked = new Set<number>();
        for (let l = 0; l < song.lines.length; l++) if (rnd() < frac) picked.add(l);
        const pins = song.syls.filter((s) => picked.has(s.line));
        const out = await solve(song, pinAnchors(song, pins));
        const { out: after, done } = transferRepeats(song, out, picked);
        const held = (s: Syl): boolean => !picked.has(s.line);
        base.push(...errors(song, out, held));
        moved.push(...errors(song, after, held));
        const touched = new Set(done.map((d) => d.line));
        wrongBefore.push(...errors(song, out, (s) => touched.has(s.line)));
        wrongAfter.push(...errors(song, after, (s) => touched.has(s.line)));
        nMoved += done.length;
        nHeld += song.lines.length - picked.size;
      }
      console.log(`${id} lines pinned ${(frac * 100).toFixed(0)}%  lines transferred ${nMoved}/${nHeld}`);
      console.log(`   held-out before ${pooled(base)}`);
      console.log(`   held-out after  ${pooled(moved)}`);
      console.log(`   transferred lines only: before ${pooled(wrongBefore)}`);
      console.log(`                           after  ${pooled(wrongAfter)}`);
    }
  }
}
