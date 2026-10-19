// Scores a lyricsync (or any lyrics.json-style) result against hand-calibrated timings.
// Usage: bun research/eval/lyricsync_eval.ts <result.json> <calibrated.json> [--skip-lines 37,38] [--anchors <anchors.json>]
import * as fs from 'node:fs';

interface Syl extends Array<number> {
  0: number;
  1: number;
}
interface Word {
  start: number;
  end: number;
  syl?: Syl[];
}
interface Line {
  words: Word[];
}

const args = process.argv.slice(2);
const [resultFile, calFile] = args;
if (!resultFile || !calFile) {
  throw new Error('usage: bun research/eval/lyricsync_eval.ts <result.json> <calibrated.json> [--skip-lines a,b] [--anchors anchors.json]');
}
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const skip = (opt('--skip-lines') ?? '').split(',').filter(Boolean).map(Number);

let anchored: Record<string, unknown> = {};
const anchorsPath = opt('--anchors');
if (anchorsPath) {
  const rawAnchors: unknown = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
  if (rawAnchors && typeof rawAnchors === 'object' && 'lines' in rawAnchors && typeof rawAnchors.lines === 'object' && rawAnchors.lines !== null) {
    anchored = rawAnchors.lines as Record<string, unknown>;
  }
}

function readLines(filePath: string): Line[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (parsed && typeof parsed === 'object' && 'lines' in parsed && Array.isArray(parsed.lines)) {
    return parsed.lines as Line[];
  }
  throw new Error(`Invalid format in ${filePath}: missing lines array`);
}

const result = readLines(resultFile);
const cal = readLines(calFile);
function score(onlyUnanchored: boolean): { mae: number; n: number } {
  let s = 0;
  let e = 0;
  let n = 0;
  let k = 0;
  result.forEach((line, li) => {
    if (skip.includes(li)) return;
    const truth = cal[k++]!;
    if (onlyUnanchored && anchored[String(li)] !== undefined) return;
    for (let wi = 0; wi < Math.min(line.words.length, truth.words.length); wi++) {
      const gw = line.words[wi]!;
      const cw = truth.words[wi]!;
      const gs = gw.syl ?? [[gw.start, gw.end] as unknown as Syl];
      const cs = cw.syl ?? [[cw.start, cw.end] as unknown as Syl];
      for (let si = 0; si < Math.min(gs.length, cs.length); si++) {
        s += Math.abs(gs[si]![0] - cs[si]![0]);
        e += Math.abs(gs[si]![1] - cs[si]![1]);
        n++;
      }
    }
  });
  return { mae: n > 0 ? (s / n + e / n) * 500 : 0, n };
}

const all = score(false);
console.log(`all scored lines : ${all.mae.toFixed(2)} ms over ${all.n} syllables`);
if (Object.keys(anchored).length > 0) {
  const rest = score(true);
  console.log(`lines with no anchor: ${rest.mae.toFixed(2)} ms over ${rest.n} syllables`);
}
