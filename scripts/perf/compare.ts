// Compares two evidence dumps written by bench.ts (or a workspace's evidence/ folder) component by component.
// usage: bun scripts/perf/compare.ts <reference dir> <candidate dir>
import * as fs from 'node:fs';
import * as path from 'node:path';

const [a, b] = process.argv.slice(2);
if (!a || !b) throw new Error('usage: compare.ts <ref> <cand>');
const json = (dir: string, f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const report: Record<string, unknown> = {};

function arr(name: string, x: ArrayLike<number>, y: ArrayLike<number>, tol = 0): void {
  if (x.length !== y.length) {
    report[name] = { lengthA: x.length, lengthB: y.length };
    return;
  }
  let max = 0;
  let sum = 0;
  let over = 0;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(x[i]! - y[i]!);
    if (d > max) max = d;
    sum += d;
    if (d > tol) over++;
  }
  report[name] = { n: x.length, maxAbs: +max.toPrecision(4), meanAbs: +(sum / Math.max(1, x.length)).toPrecision(4), [`over${tol}`]: over };
}

/** Event lists (notes, edges, breaths): same count and time differences of paired items. */
function events(name: string, x: Array<Record<string, number>>, y: Array<Record<string, number>>, keys: string[]): void {
  const r: Record<string, unknown> = { countA: x.length, countB: y.length };
  if (x.length === y.length) {
    for (const k of keys) {
      let max = 0;
      for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs((x[i]![k] ?? 0) - (y[i]![k] ?? 0)));
      r[`max_${k}`] = +max.toPrecision(4);
    }
  }
  report[name] = r;
}

function syllableTimes(lines: Array<{ words: Array<{ syl: [number, number][] }> }> | null): number[] {
  return (lines ?? []).flatMap((l) => l.words.flatMap((w) => w.syl.flat()));
}

const ma = json(a, 'meta.json');
const mb = json(b, 'meta.json');
const fa = ma.f0Hz as number[];
const fb = mb.f0Hz as number[];
arr('f0Hz', fa, fb, 1);
if (fa.length === fb.length) report.f0VoicingFlips = fa.filter((v, i) => (v > 0) !== (fb[i]! > 0)).length;
events('edges.base', ma.edgeSets[0], mb.edgeSets[0], ['t', 'prob']);
events('edges.combined', ma.edgeSets[1], mb.edgeSets[1], ['t', 'prob']);
events('breaths', ma.breaths, mb.breaths, ['start', 'end', 'prob']);
const na = json(a, 'notes.json');
const nb = json(b, 'notes.json');
for (const k of ['rmvpeNotes', 'swiftNotes', 'harmoNotes']) events(k, na[k], nb[k], ['start', 'end', 'midi']);
const al = json(a, 'alignments.json');
const bl = json(b, 'alignments.json');
arr('align.fullBase', syllableTimes(al.fullBase), syllableTimes(bl.fullBase));
arr('align.fullCombined', syllableTimes(al.fullCombined), syllableTimes(bl.fullCombined));
arr('posteriors', fs.readFileSync(path.join(a, 'posteriors.bin')), fs.readFileSync(path.join(b, 'posteriors.bin')), 1);
const f32 = (dir: string, f: string) => {
  const buf = fs.readFileSync(path.join(dir, f));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
arr('boundary.frames', f32(a, 'boundary.bin'), f32(b, 'boundary.bin'), 1e-3);
const qa = json(a, 'boundary.json');
const qb = json(b, 'boundary.json');
const flatQ = (q: Record<string, number[][]>) => Object.keys(q).sort((x, y) => +x - +y).flatMap((k) => q[k]!.flat());
arr('boundary.queries', flatQ(qa), flatQ(qb), 1e-4);
if (fs.existsSync(path.join(a, 'beats.out.json')) && fs.existsSync(path.join(b, 'beats.out.json'))) {
  const ba = json(a, 'beats.out.json');
  const bb = json(b, 'beats.out.json');
  arr('beats', ba.beats, bb.beats);
  arr('downbeats', ba.downbeats, bb.downbeats);
}
console.log(JSON.stringify(report, null, 1));
