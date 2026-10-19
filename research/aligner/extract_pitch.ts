// RMVPE pitch evidence for every segment of a boundary dataset (build_dataset.py / build_ritsu_ds.py format: audio.int16 at 16 kHz +
// index.json), computed by lyricsync's own runRmvpe (the code `prepare` runs): the f0 contour at 100 fps and the note spans.
// Output: <out>/<dataset name>/shard<k>of<n>.jsonl, one line per segment: { id, f0: [Hz, 1 decimal], notes: [[start, end] s] }.
// Resumable (segments already in the shard file are skipped). CPU only, so shards can run side by side.
// usage: bun research/aligner/extract_pitch.ts <dataset dir> <k> <n> [--out .cache/line_ev]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runRmvpe } from '../../packages/lyricsync/src/evidence/pitch.ts';

const [ds, kArg, nArg] = process.argv.slice(2);
if (!ds || kArg === undefined || nArg === undefined) throw new Error('usage: bun research/aligner/extract_pitch.ts <dataset dir> <k> <n> [--out dir]');
const k = Number(kArg);
const n = Number(nArg);
const outArg = process.argv.indexOf('--out');
const outRoot = outArg < 0 ? '.cache/line_ev' : process.argv[outArg + 1]!;
const outDir = path.join(outRoot, path.basename(path.resolve(ds)));
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `shard${k}of${n}.jsonl`);
const done = new Set<string>();
if (fs.existsSync(outFile)) {
  for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) if (line.trim()) done.add((JSON.parse(line) as { id: string }).id);
}
const index = JSON.parse(fs.readFileSync(path.join(ds, 'index.json'), 'utf8')) as Array<{ id: string; offset: number; length: number }>;
const mine = index.filter((_, i) => i % n === k);
const fd = fs.openSync(path.join(ds, 'audio.int16'), 'r');
const t0 = Date.now();
let count = 0;
for (const e of mine) {
  if (done.has(e.id)) continue;
  const buf = Buffer.alloc(e.length * 2);
  fs.readSync(fd, buf, 0, buf.length, e.offset * 2);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, e.length);
  const audio = Float32Array.from(pcm, (v) => v / 32768);
  const { f0Hz, rmvpeNotes } = await runRmvpe(audio, 16000);
  const entry = { id: e.id, f0: f0Hz.map((f) => Math.round(f * 10) / 10), notes: rmvpeNotes.map((x) => [Math.round(x.start * 1000) / 1000, Math.round(x.end * 1000) / 1000]) };
  fs.appendFileSync(outFile, `${JSON.stringify(entry)}\n`);
  count++;
  if (count % 100 === 0) console.log(`shard ${k}/${n}: ${done.size + count}/${mine.length}, ${((Date.now() - t0) / count).toFixed(0)} ms per segment`);
}
fs.closeSync(fd);
console.log(`shard ${k}/${n} done: ${done.size + count} segments`);
