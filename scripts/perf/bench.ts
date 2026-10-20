// Times every stage of evidence extraction on one workspace and saves the evidence for comparison.
// usage: bun scripts/perf/bench.ts <workspace dir> <out dir> [--mix <audio> --bpm <n>] [--device gpu|cpu] [--ep "<rule>;<rule>"]
// --ep overrides the execution providers per model (research switch): "rmvpe=cpu;*=dml,cpu", first rule whose key is part of the model
// path wins. Compare two outputs with compare.ts (evidence) and solve_dir.ts (solved times).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Session } from '../../packages/lyricsync/src/workspace/session.ts';
import { extractEvidence, saveEvidence } from '../../packages/lyricsync/src/evidence/index.ts';
import { trackBeats } from '../../packages/beatsync/src/index.ts';
import * as ort from '../../packages/lyricsync/node_modules/onnxruntime-node';

const [ws, out] = process.argv.slice(2);
if (!ws || !out) throw new Error('usage: bench.ts <workspace> <out> [--mix <audio> --bpm <n>] [--device gpu|cpu] [--ep rules]');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const mix = arg('--mix');
fs.mkdirSync(out, { recursive: true });
const session = Session.open(ws);
const manifest = JSON.parse(fs.readFileSync(path.join(ws, 'lyricsync.json'), 'utf8'));
const beats: number[] = JSON.parse(fs.readFileSync(path.join(ws, 'evidence', 'meta.json'), 'utf8')).beats;

const forceEp = arg('--ep');
const models: Record<string, { create: number; run: number; runs: number; eps: string }> = {};
const create = ort.InferenceSession.create.bind(ort.InferenceSession);
Object.assign(ort.InferenceSession, { create: async (p: string, o: ort.InferenceSession.SessionOptions = {}) => {
  const name = path.basename(path.dirname(p)) + '/' + path.basename(p);
  // --ep "rmvpe=cpu;beat_this=dml,cpu;*=dml,cpu": first rule whose key is a substring of the model path wins.
  const rule = forceEp?.split(';').map((r) => r.split('=')).find(([k]) => k === '*' || p.includes(k!));
  const opts = rule ? { ...o, executionProviders: rule[1]!.split(',') } : o;
  const t = performance.now();
  const s = await create(p, opts);
  const m = (models[name] ??= { create: 0, run: 0, runs: 0, eps: String(opts.executionProviders) });
  m.create += performance.now() - t;
  const run = s.run.bind(s);
  Object.assign(s, { run: async (...args: Parameters<typeof s.run>) => {
    const t1 = performance.now();
    const r = await run(...args);
    m.run += performance.now() - t1;
    m.runs++;
    return r;
  } });
  return s;
} });

const stages: Array<{ stage: string; ms: number }> = [];
let current = '';
let last = performance.now();
const mark = (next: string) => {
  const now = performance.now();
  if (current) stages.push({ stage: current, ms: Math.round(now - last) });
  current = next;
  last = now;
};

const device = arg('--device') === 'cpu' ? 'cpu' : 'gpu';
const t0 = performance.now();
if (mix) {
  mark('beats');
  const r = await trackBeats(mix, { targetBpm: Number(arg('--bpm')), device });
  fs.writeFileSync(path.join(out, 'beats.out.json'), JSON.stringify({ beats: r.beats, downbeats: r.downbeats, bpm: r.bpm }));
}
const ev = await extractEvidence({
  vocalPath: path.resolve(ws, manifest.vocal),
  definition: session.definition,
  beats,
  onProgress: (m) => mark(m),
  device,
});
mark('');
saveEvidence(out, ev);
const round = (o: typeof models) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, create: Math.round(v.create), run: Math.round(v.run) }]));
const timings = { total: Math.round(performance.now() - t0), stages, models: round(models), rssMB: Math.round(process.memoryUsage().rss / 1e6) };
fs.writeFileSync(path.join(out, 'timings.json'), JSON.stringify(timings, null, 2));
console.log(JSON.stringify(timings, null, 2));
