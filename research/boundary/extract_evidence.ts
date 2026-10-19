// Extracts lyricsync's lyrics-free evidence (the same models and code the workspaces use) for every GTSinger segment of the dataset index,
// so a boundary model can learn from the evidence the solver votes with.
// Output (.cache/gtsinger_ev, resumable: segments already in index.jsonl are skipped):
//   posteriors.u8  every segment's base-model phone posteriors (frames x vocab, uint8, 10 ms frames), concatenated
//   index.jsonl    one line per segment: { id, frames, vocab, postOffset (bytes), f0Hz, edgeSets, rmvpe, swift, harmo } with notes as [start, end]
// usage: bun scripts/gtsinger/extract_evidence.ts [dataset dir, default .cache/gtsinger_ds_full] [--subset 0.25]
//   --subset: the training segments train_boundary.py --subset keeps (md5 of the id) plus every validation segment (md5 of the song title).
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadAudioFile } from '../../packages/lyricsync/src/audio/audio.ts';
import { HubertAligner } from '../../packages/lyricsync/src/evidence/hubert.ts';
import { runHarmoF0, runRmvpe, runSwiftF0 } from '../../packages/lyricsync/src/evidence/pitch.ts';

const DS = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.cache/gtsinger_ds_full';
const subsetArg = process.argv.indexOf('--subset');
const SUBSET = subsetArg < 0 ? 1 : Number(process.argv[subsetArg + 1]);
if (!(SUBSET > 0 && SUBSET <= 1)) throw new Error(`--subset must be in (0, 1], got ${process.argv[subsetArg + 1]}`);
const SRC = '.cache/gtsinger';
const OUT = '.cache/gtsinger_ev';
fs.mkdirSync(OUT, { recursive: true });
const indexFile = path.join(OUT, 'index.jsonl');
const postFile = path.join(OUT, 'posteriors.u8');
/** The fields of an index.jsonl line this script reads back when resuming. */
function readEntry(line: string): { id: string; end: number } {
  const e: unknown = JSON.parse(line);
  if (typeof e !== 'object' || e === null || !('id' in e) || !('postOffset' in e) || !('frames' in e) || !('vocab' in e)) throw new Error(`malformed index line: ${line.slice(0, 80)}`);
  const { id, postOffset, frames, vocab } = e;
  if (typeof id !== 'string' || typeof postOffset !== 'number' || typeof frames !== 'number' || typeof vocab !== 'number') throw new Error(`malformed index line: ${line.slice(0, 80)}`);
  return { id, end: postOffset + frames * vocab };
}
const done = new Set<string>();
let postOffset = 0;
if (fs.existsSync(indexFile)) {
  for (const line of fs.readFileSync(indexFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = readEntry(line);
    done.add(e.id);
    postOffset = Math.max(postOffset, e.end);
  }
}
// Truncate a posteriors file left longer than the index says (an interrupted append).
if (fs.existsSync(postFile) && fs.statSync(postFile).size !== postOffset) fs.truncateSync(postFile, postOffset);

const datasetIndex: unknown = JSON.parse(fs.readFileSync(path.join(DS, 'index.json'), 'utf8'));
if (!Array.isArray(datasetIndex)) throw new Error(`${DS}/index.json is not an array`);
const md5mod = (s: string, m: bigint): number => Number(BigInt(`0x${createHash('md5').update(s, 'utf8').digest('hex')}`) % m);
const segments = datasetIndex.flatMap((e: unknown) => {
  if (typeof e !== 'object' || e === null || !('id' in e) || typeof e.id !== 'string' || !('song' in e) || typeof e.song !== 'string') {
    throw new Error('dataset entry without an id or song');
  }
  // Same split and subset rules as train_boundary.py (is_val, Data keep).
  const isVal = md5mod(e.song.trim().toLowerCase(), 10n) === 0;
  return isVal || md5mod(e.id, 1000n) < SUBSET * 1000 ? [e.id] : [];
});
console.log(`${segments.length} segments (subset ${SUBSET}), ${done.size} already extracted`);
const base = new HubertAligner('base');
const combined = new HubertAligner('combined');
const spans = (notes: Array<{ start: number; end: number }>): number[][] => notes.map((n) => [Math.round(n.start * 1000) / 1000, Math.round(n.end * 1000) / 1000]);
const t0 = Date.now();
let n = 0;
for (const id of segments) {
  if (done.has(id)) continue;
  const audio = await loadAudioFile(path.join(SRC, `${id}.wav`), 44100);
  const { f0Hz, rmvpeNotes } = await runRmvpe(audio, 44100);
  const swift = await runSwiftF0(audio, 44100);
  const harmo = await runHarmoF0(audio, 44100);
  const post = await base.extractPosteriorgram(audio);
  const basePriors = await base.extractAcousticPriors(audio);
  const combPriors = await combined.extractAcousticPriors(audio);
  fs.appendFileSync(postFile, post.data);
  const entry = {
    id,
    frames: post.frames,
    vocab: post.vocabSize,
    postOffset,
    f0Hz: f0Hz.map((f) => Math.round(f * 10) / 10),
    edgeSets: [basePriors.edges, combPriors.edges],
    rmvpe: spans(rmvpeNotes),
    swift: spans(swift),
    harmo: spans(harmo),
  };
  postOffset += post.frames * post.vocabSize;
  fs.appendFileSync(indexFile, `${JSON.stringify(entry)}\n`);
  n++;
  if (n % 50 === 0) console.log(`${done.size + n}/${segments.length} segments, ${((Date.now() - t0) / n).toFixed(0)} ms per segment`);
}
console.log(`done: ${done.size + n} segments`);
