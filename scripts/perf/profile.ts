// Profiles one model on one execution-provider list with a synthetic input of the real shape and prints time per op type and provider.
// usage: bun scripts/perf/profile.ts <model.onnx> <eps comma list> <input spec> [runs] [intra-op threads] [extra session options JSON]
// input spec: name:type:d0xd1x...[,name:type:dims] with type float32|int64; float inputs are filled with low-level noise.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ort from '../../packages/lyricsync/node_modules/onnxruntime-node';
const [model, eps, spec, runsArg, threadsArg, extraArg] = process.argv.slice(2);
if (!model || !eps || !spec) throw new Error('usage: profile.ts <model> <eps> <name:type:dims,...> [runs]');
const runs = Number(runsArg ?? 3);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortprof-'));
const session = await ort.InferenceSession.create(model, {
  executionProviders: eps.split(','),
  graphOptimizationLevel: 'all',
  enableProfiling: true,
  ...(threadsArg ? { intraOpNumThreads: Number(threadsArg) } : {}),
  profileFilePrefix: path.join(dir, 'p'),
  ...(extraArg ? JSON.parse(extraArg) : {}),
});
const feeds: Record<string, ort.Tensor> = {};
for (const part of spec.split(',')) {
  const [name, type, dims] = part.split(':');
  const shape = dims!.split('x').map(Number);
  const n = shape.reduce((a, b) => a * b, 1);
  if (type === 'int64') feeds[name!] = new ort.Tensor('int64', new BigInt64Array(n), shape);
  else {
    const data = new Float32Array(n);
    let seed = 1;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x7fffffff - 0.5) * 0.2;
    }
    feeds[name!] = new ort.Tensor('float32', data, shape);
  }
}
const times: number[] = [];
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  await session.run(feeds);
  times.push(Math.round(performance.now() - t));
}
session.endProfiling();
const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))!);
const events: Array<{ cat: string; name: string; dur: number; args?: { op_name?: string; provider?: string } }> = JSON.parse(fs.readFileSync(file, 'utf8'));
const byOp = new Map<string, { us: number; n: number }>();
for (const e of events) {
  if (e.cat !== 'Node' || !e.name.endsWith('_kernel_time')) continue;
  const key = `${e.args?.op_name}@${e.args?.provider}`;
  const v = byOp.get(key) ?? { us: 0, n: 0 };
  v.us += e.dur;
  v.n++;
  byOp.set(key, v);
}
const top = [...byOp.entries()].sort((a, b) => b[1].us - a[1].us).slice(0, 15);
console.log(JSON.stringify({ model: path.basename(model), eps, runMs: times, opsPerRunMs: Object.fromEntries(top.map(([k, v]) => [k, +(v.us / 1000 / runs).toFixed(1)])) }, null, 1));
fs.rmSync(dir, { recursive: true, force: true });
