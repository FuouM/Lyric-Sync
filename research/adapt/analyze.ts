// usage (repo root): bun research/adapt/analyze.ts <songId>   (needs baseline.ts output .cache/adapt/free_<id>_snaptrue.json)
// Where the free-solve error is: flagged vs unflagged, signed error, beat-grid structure of the truth, worst lines, repeated lines.
import * as fs from 'node:fs';
import { beatPos, fmt, loadSong, score, type Times } from './lib.ts';

const id = process.argv[2] ?? 'god_ish';
const song = await loadSong(id);
const out: Times = JSON.parse(fs.readFileSync(`.cache/adapt/free_${id}_snaptrue.json`, 'utf8'));
const { syls, beats } = song;

console.log(`== ${id}`);
console.log('all      ', fmt(score(song, out)));
console.log('flagged  ', fmt(score(song, out, (s) => s.flagged)));
console.log('unflagged', fmt(score(song, out, (s) => !s.flagged)));

// signed start error (solver - truth), ms
const signed = syls.map((s) => (out[s.k]![0] - s.ts) * 1000);
const q = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!;
console.log(`signed start err ms: p10 ${q(signed, 0.1).toFixed(0)} p25 ${q(signed, 0.25).toFixed(0)} med ${q(signed, 0.5).toFixed(0)} p75 ${q(signed, 0.75).toFixed(0)} p90 ${q(signed, 0.9).toFixed(0)}`);

// beat grid structure of the truth starts: fraction within 15 ms of k/16 of a beat, and of the solver output
const period = (t: number): number => { const p = beatPos(beats, t); const lo = Math.floor(p); return (beats[Math.min(lo + 1, beats.length - 1)]! - beats[lo]!) * 1000; };
function gridHist(times: number[]): string {
  const bins = new Array<number>(16).fill(0);
  let near = 0;
  for (const t of times) {
    const p = beatPos(beats, t);
    const ph = p - Math.floor(p);
    const b = Math.round(ph * 16);
    bins[b % 16]!++;
    if (Math.abs(ph * 16 - b) * period(t) / 16 < 15) near++;
  }
  return `${bins.map((n) => String(n).padStart(3)).join('')}   within 15ms of a 16th: ${(near / times.length * 100).toFixed(0)}%`;
}
console.log('16th-phase hist (truth)  :', gridHist(syls.map((s) => s.ts)));
console.log('16th-phase hist (solver) :', gridHist(syls.map((s) => out[s.k]![0])));
const sixteenth = (t: number): number => {
  // distance (ms) to the nearest 16th-note gridline
  const p = beatPos(beats, t) * 4;
  return Math.abs(p - Math.round(p)) * period(t) / 4;
};
const dist = syls.map((s) => sixteenth(s.ts));
console.log(`truth start dist to 16th grid ms: med ${q(dist, 0.5).toFixed(1)} p90 ${q(dist, 0.9).toFixed(1)}`);
// grid snap oracle: snap solver start to the nearest 16th when truth is on the grid
const gridSnapErr = syls.map((s) => {
  const p = beatPos(beats, out[s.k]![0]) * 4;
  const snapped = Math.round(p) / 4;
  const pt = beatPos(beats, s.ts);
  return Math.abs(snapped - pt) * period(s.ts);
});
console.log(`solver start snapped to nearest 16th: mean start err ${(gridSnapErr.reduce((a, b) => a + b, 0) / gridSnapErr.length).toFixed(1)} ms (unsnapped ${(syls.reduce((a, s) => a + Math.abs(out[s.k]![0] - s.ts) * 1000, 0) / syls.length).toFixed(1)})`);

// duration structure in beats
const dur = syls.map((s) => (beatPos(beats, s.te) - beatPos(beats, s.ts)));
console.log(`truth syllable duration (beats): p10 ${q(dur, 0.1).toFixed(2)} med ${q(dur, 0.5).toFixed(2)} p90 ${q(dur, 0.9).toFixed(2)}`);

// per-line mean error, worst 12
const perLine = new Map<number, number[]>();
for (const s of syls) {
  const e = ((Math.abs(out[s.k]![0] - s.ts) + Math.abs(out[s.k]![1] - s.te)) / 2) * 1000;
  (perLine.get(s.line) ?? perLine.set(s.line, []).get(s.line)!).push(e);
}
const rows = [...perLine].map(([l, e]) => [l, e.reduce((a, b) => a + b, 0) / e.length, e.length] as const).sort((a, b) => b[1] - a[1]);
const totalErr = rows.reduce((a, r) => a + r[1] * r[2], 0);
let cum = 0;
console.log('worst lines (mean err ms, share of total error):');
for (const [l, e, n] of rows.slice(0, 12)) {
  cum += e * n;
  console.log(`  L${String(l).padStart(2)} ${e.toFixed(0).padStart(4)}ms n=${n} cum ${(cum / totalErr * 100).toFixed(0)}%  ${song.lines[l]!.text.slice(0, 60)}`);
}

// repeated lines: identical text -> do the truth timings in beats agree between copies?
const byText = new Map<string, number[]>();
song.lines.forEach((l, i) => (byText.get(l.text) ?? byText.set(l.text, []).get(l.text)!).push(i));
const reps = [...byText].filter(([, v]) => v.length > 1);
let nCmp = 0;
let sumDev = 0;
const devs: number[] = [];
for (const [, idxs] of reps) {
  const rel = idxs.map((i) => {
    const ls = syls.filter((s) => s.line === i);
    const p0 = beatPos(beats, ls[0]!.ts);
    return ls.map((s) => beatPos(beats, s.ts) - p0);
  });
  for (let a = 1; a < rel.length; a++) {
    if (rel[a]!.length !== rel[0]!.length) continue;
    const pb = idxs[a]!;
    const p0 = beatPos(beats, syls.find((s) => s.line === pb)!.ts);
    const t0 = idxs[0]!;
    void t0;
    rel[a]!.forEach((r, k) => {
      const d = Math.abs(r - rel[0]![k]!) * period(syls.find((s) => s.line === pb)!.ts);
      devs.push(d);
      sumDev += d;
      nCmp++;
    });
    void p0;
  }
}
console.log(`repeated lines: ${reps.length} distinct texts, ${reps.reduce((n, [, v]) => n + v.length, 0)} lines; copy-vs-first relative start dev (ms): mean ${(sumDev / Math.max(1, nCmp)).toFixed(1)} med ${devs.length ? q(devs, 0.5).toFixed(1) : '-'} p90 ${devs.length ? q(devs, 0.9).toFixed(1) : '-'} (n=${nCmp})`);
