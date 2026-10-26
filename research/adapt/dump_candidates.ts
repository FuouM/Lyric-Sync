// Throwaway research: data for a "repair" model on top of the guided solver. Runs the shipped guided solve (research branch exports) per
// song and mode (anchored = line edges pinned, free = nothing pinned) and writes, for every unpinned interior boundary, the solver's final
// time, the truth and one feature row per candidate time; plus every syllable's solved/true edges for MAE.
// usage (repo root): bun research/adapt/dump_candidates.ts <set> <manifest.json> [--exclude <manifest.json>] [--snap]
//   <set>: output name; --snap: production beat snap (annotated songs), else beatSnapSec 0 (Ritsu acoustic labels).
// Output: .cache/adapt/data/<set>.bnd.jsonl, <set>.syl.jsonl
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyPath, buildLineSkeleton, chainMarginals, lowerBound, mbrPath, type LineSkeleton } from '../../packages/lyricsync/src/engine/boundary_dp.ts';
import { audioOnsets, boundaryGuide, clipLineOverlaps, eighthGrid, GUIDE_SCORING, GUIDED_DESIGN, joinLineEnds, lineEvents, pairTables, unaryRows, type GuidedDesign, type LineEvents } from '../../packages/lyricsync/src/engine/guided.ts';
import { fitLineExtents, prepareSolve } from '../../packages/lyricsync/src/engine/solve.ts';
import { isConsensusLine, isRecord } from '../../packages/lyricsync/src/guards.ts';
import type { ConsensusLine, SolveInput } from '../../packages/lyricsync/src/types.ts';
import { readTrainingManifest } from '../../packages/lyricsync/src/train/songs.ts';
import { emptyAnchors, importCalibrated } from '../../packages/lyricsync/src/workspace/anchors.ts';
import { Session } from '../../packages/lyricsync/src/workspace/session.ts';

const [set, manifest] = process.argv.slice(2);
if (!set || !manifest) throw new Error('usage: bun .cache/repair/dump.ts <set> <manifest.json> [--exclude <manifest.json>] [--snap]');
const flag = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const exclude = new Set(flag('--exclude') ? readTrainingManifest(flag('--exclude')!).map((s) => s.id) : []);
const snap = process.argv.includes('--snap');
const design: GuidedDesign = { ...GUIDED_DESIGN, ...(snap ? {} : { beatSnapSec: 0 }) };

const outDir = path.resolve('.cache/adapt/data');
fs.mkdirSync(outDir, { recursive: true });
const bndOut = fs.openSync(path.join(outDir, `${set}.bnd.jsonl`), 'w');
const sylOut = fs.openSync(path.join(outDir, `${set}.syl.jsonl`), 'w');

export const FEATURES = [
  'd', 'absd', 'isCur', 'u', 'uRel', 'uRank', 'm25', 'm1', 'guide', 'guideRel',
  'nRmvpe', 'nHarmo', 'nSwift', 'nEdge', 'nEdge1', 'nBeat', 'nEighth', 'nAudio', 'nRaw',
  'dRmvpe', 'dHarmo', 'dSwift', 'dEdge', 'dEdge1', 'dBeat', 'dEighth', 'dAudio', 'dRaw0', 'dRaw1', 'dRmvpeEnd', 'dHarmoEnd',
  'prior16', 'durPrev', 'durNext', 'durPrev16', 'durNext16', 'logDurRatio',
  'nucPrev', 'silPrev', 'nucNext', 'silNext', 'fadeLast', 'riseFirst', 'fadeNuc', 'riseNuc', 'rms05', 'rms10', 'rms03',
  'beatPhase', 'beatDur', 's16', 'meanDur', 'm', 'pos', 'isWord', 'vowelInit', 'openPrev', 'nCands', 'curM25', 'curU', 'snapMoved',
] as const;

const nearestSigned = (sorted: number[], t: number, cap = 0.25): number => {
  if (sorted.length === 0) return cap;
  const i = lowerBound(sorted, t);
  let best = cap;
  for (const k of [i - 1, i]) if (k >= 0 && k < sorted.length && Math.abs(sorted[k]! - t) < Math.abs(best)) best = sorted[k]! - t;
  return Math.max(-cap, Math.min(cap, best));
};
const within = (sorted: number[], t: number, w: number): number => { const i = lowerBound(sorted, t - w); return i < sorted.length && sorted[i]! <= t + w ? 1 : 0; };

function solveAndDump(id: string, mode: 'anchored' | 'free', s: Omit<SolveInput, 'weights'> & { truth: Array<ConsensusLine | null> }): void {
  const input: Omit<SolveInput, 'weights'> = { evidence: s.evidence, anchors: s.anchors, sliced: s.sliced };
  const guide = boundaryGuide(s.evidence.boundary!, GUIDE_SCORING);
  const D = design;
  const { consensus, linePins, ev } = prepareSolve(input);
  const eighths = eighthGrid(ev.events, D);
  const audio = audioOnsets(input.evidence.audio, input.evidence.sampleRate, D);
  const lines: ConsensusLine[] = structuredClone(consensus);
  const order = linePins.map((_, i) => i).sort((a, b) => linePins[a]!.lineIndex - linePins[b]!.lineIndex);
  const pinnedEnd = new Map(linePins.flatMap((lp) => (lp.pins[lp.syllableCount] === undefined ? [] : [[lp.lineIndex, lp.pins[lp.syllableCount]!] as const])));
  const pending: Array<{ sk: LineSkeleton; pins: Array<number | undefined>; u: Float64Array[]; m25: Float64Array[]; m1: Float64Array[]; path: number[]; raw: number[]; le: LineEvents }> = [];
  for (const i of order) {
    const lp = linePins[i]!;
    const line = lines[lp.lineIndex]!;
    const sk = buildLineSkeleton(line, lp.lineIndex, ev, lp.pins);
    // addGuideCandidates (not exported): same rule.
    sk.cands.forEach((cands, j) => {
      if (lp.pins[j] !== undefined || cands.length === 0) return;
      const lo = cands[0]!;
      const hi = cands[cands.length - 1]!;
      const extra = guide.candidates(sk, j).filter((t) => t >= lo && t <= hi && !cands.some((c) => Math.abs(c - t) < 0.002));
      if (extra.length > 0) sk.cands[j] = [...cands, ...extra].sort((a, b) => a - b);
    });
    const prev = lines[lp.lineIndex - 1];
    if (prev !== undefined) {
      const prevSyl = prev.words[prev.words.length - 1]!.syl!;
      const bound = Math.max(prevSyl[prevSyl.length - 1]![0] + D.minSylSec, pinnedEnd.get(lp.lineIndex - 1) ?? -Infinity);
      sk.cands.forEach((cands, j) => {
        if (lp.pins[j] !== undefined) return;
        const lo = bound + j * D.minSylSec;
        const kept = cands.filter((t) => t >= lo);
        sk.cands[j] = kept.length > 0 ? kept : [lo];
      });
    }
    const le = lineEvents(sk, eighths, audio, D);
    const u = unaryRows(sk, le, lp.pins, guide, D);
    const pair = pairTables(sk, le, D);
    const m25 = chainMarginals(sk.cands, { u: u.map((r) => r.map((x) => x / D.mbrTemp)), pair: pair.map((r) => r.map((x) => x / D.mbrTemp)) });
    const raw = mbrPath(sk.cands, m25);
    const path = snapPath(sk, raw, D);
    applyPath(line, sk, path);
    const m1 = chainMarginals(sk.cands, { u, pair });
    pending.push({ sk, pins: lp.pins, u, m25, m1, path, raw, le });
  }
  joinLineEnds(lines, linePins, [...input.evidence.rmvpeNotes, ...input.evidence.harmoNotes], D);
  clipLineOverlaps(lines, new Set(pinnedEnd.keys()));
  fitLineExtents(lines);

  const e = ev.events;
  const beats = e.beats;
  for (const p of pending) {
    const { sk, pins, u, m25, m1, path, raw, le } = p;
    const li = sk.lineIdx;
    const truth = s.truth[li];
    const line = lines[li]!;
    const solvedB: number[] = line.words.flatMap((w) => w.syl!.map((x) => x[0]));
    solvedB.push(line.words.at(-1)!.syl!.at(-1)![1]);
    const m = sk.cands.length - 1;
    const trueB: number[] | null = truth ? [...truth.words.flatMap((w) => w.syl!.map((x) => x[0])), truth.words.at(-1)!.syl!.at(-1)![1]] : null;
    const cal: boolean[] | null = truth ? truth.words.flatMap((w) => w.syl!.map((_, k) => w.sylCalibrated?.[k] ?? false)) : null;
    const solvedSyl = line.words.flatMap((w) => w.syl!);
    const trueSyl = truth ? truth.words.flatMap((w) => w.syl!) : [];
    if (trueB && trueB.length !== m + 1) throw new Error(`${id} line ${li}: syllable count mismatch`);
    // Syllable rows (MAE uses the final, post-processed lines).
    if (trueB) for (let k = 0; k < m; k++) fs.writeSync(sylOut, JSON.stringify({ song: id, mode, line: li, k, m, s: solvedSyl[k], t: trueSyl[k], cal: cal![k] }) + '\n');
    const raws = le.raws;
    for (let j = 1; j < m; j++) {
      if (pins[j] !== undefined || !trueB) continue;
      const cands = sk.cands[j]!;
      const cur = cands[path[j]!]!;
      if (Math.abs(cur - solvedB[j]!) > 1e-6) throw new Error(`${id} line ${li} b${j}: path ${cur} vs final ${solvedB[j]}`);
      const tPrev = solvedB[j - 1]!;
      const tNext = solvedB[j + 1]!;
      const urow = u[j]!;
      const umax = Math.max(...urow);
      const order = [...urow.keys()].sort((a, b) => urow[b]! - urow[a]!);
      const rank = new Array<number>(cands.length);
      order.forEach((k, r) => (rank[k] = r));
      const gs = guide.score(sk, j, cands);
      const gmax = Math.max(...gs);
      const refPrev = sk.sylRefs[j - 1]!;
      const refNext = sk.sylRefs[j]!;
      const s16 = sk.s16[j]!;
      const meanDur = Math.max(sk.meanDur, 1e-3);
      const bd = ev.beatDur(cur);
      const rows: number[][] = cands.map((c, k) => {
        const segP = ev.segmentPhones(refPrev.nucleus, tPrev, c);
        const segN = ev.segmentPhones(refNext.nucleus, c, tNext);
        const r0 = raws[0]?.[j];
        const r1 = raws[1]?.[j];
        const bk = lowerBound(beats, c) - 1;
        const phase = bk >= 0 && bk + 1 < beats.length ? (c - beats[bk]!) / (beats[bk + 1]! - beats[bk]!) : 0;
        const f: Record<(typeof FEATURES)[number], number> = {
          d: c - cur, absd: Math.abs(c - cur), isCur: k === path[j] ? 1 : 0,
          u: urow[k]!, uRel: urow[k]! - umax, uRank: rank[k]!, m25: m25[j]![k]!, m1: m1[j]![k]!, guide: gs[k]! / GUIDE_SCORING.weight, guideRel: (gs[k]! - gmax) / GUIDE_SCORING.weight,
          nRmvpe: within(le.rmvpe, c, D.voteWindowSec), nHarmo: within(le.harmo, c, D.voteWindowSec), nSwift: within(e.swiftStarts, c, D.voteWindowSec),
          nEdge: within(le.edges, c, D.voteWindowSec), nEdge1: within(le.edges1, c, D.voteWindowSec), nBeat: within(beats, c, D.voteWindowSec),
          nEighth: within(eighths, c, D.eighthWindowSec), nAudio: within(audio, c, D.voteWindowSec),
          nRaw: raws.reduce((a, rb) => a + (rb !== null && Math.abs(rb[j]! - c) <= D.voteWindowSec ? 1 : 0), 0),
          dRmvpe: nearestSigned(le.rmvpe, c), dHarmo: nearestSigned(le.harmo, c), dSwift: nearestSigned(e.swiftStarts, c), dEdge: nearestSigned(le.edges, c),
          dEdge1: nearestSigned(le.edges1, c), dBeat: nearestSigned(beats, c), dEighth: nearestSigned(eighths, c), dAudio: nearestSigned(audio, c),
          dRaw0: r0 === undefined ? 0.25 : Math.max(-0.25, Math.min(0.25, r0 - c)), dRaw1: r1 === undefined ? 0.25 : Math.max(-0.25, Math.min(0.25, r1 - c)),
          dRmvpeEnd: nearestSigned(e.rmvpeEnds, c), dHarmoEnd: nearestSigned(e.harmoEnds, c),
          prior16: (c - sk.prior[j]!) / s16,
          durPrev: c - tPrev, durNext: tNext - c, durPrev16: (c - tPrev) / s16, durNext16: (tNext - c) / s16,
          logDurRatio: Math.log(Math.max(c - tPrev, 1e-3) / Math.max(tNext - c, 1e-3)),
          nucPrev: segP.nucleus, silPrev: segP.silence, nucNext: segN.nucleus, silNext: segN.silence,
          fadeLast: ev.phoneFade(refPrev.lastPhone, c, 0.04), riseFirst: ev.phoneRise(refNext.firstPhone, c, 0.04),
          fadeNuc: ev.phoneFade(refPrev.nucleus, c, 0.05), riseNuc: ev.phoneRise(refNext.nucleus, c, 0.05),
          rms05: ev.rmsRise(c, 0.05), rms10: ev.rmsRise(c, 0.1), rms03: ev.rmsRise(c, 0.03),
          beatPhase: phase, beatDur: bd, s16, meanDur, m, pos: j / m, isWord: sk.kinds[j] === 'in' ? 0 : 1,
          vowelInit: refNext.firstPhone >= 0 && refNext.firstPhone === refNext.nucleus ? 1 : 0,
          openPrev: refPrev.lastPhone >= 0 && refPrev.lastPhone === refPrev.nucleus ? 1 : 0,
          nCands: cands.length, curM25: m25[j]![path[j]!]!, curU: urow[path[j]!]!, snapMoved: path[j] !== raw[j] ? 1 : 0,
        };
        return FEATURES.map((n) => Math.round(f[n] * 1e5) / 1e5);
      });
      fs.writeSync(bndOut, JSON.stringify({ song: id, mode, line: li, j, m, cur, prev: tPrev, next: tNext, truth: trueB[j], calL: cal![j - 1], calR: cal![j], cands, cur_k: path[j], x: rows }) + '\n');
    }
  }
}

// Beat snap as guided.ts snapToBeats (not exported).
function snapPath(sk: LineSkeleton, path: number[], D: GuidedDesign): number[] {
  const beats = sk.ev.events.beats;
  const snapped = [...path];
  for (let j = 0; j < path.length; j++) {
    const c = sk.cands[j]![path[j]!]!;
    const i = lowerBound(beats, c);
    const beat = i > 0 && (i >= beats.length || c - beats[i - 1]! < beats[i]! - c) ? beats[i - 1]! : beats[i];
    if (beat === undefined || Math.abs(beat - c) > D.beatSnapSec) continue;
    let best = -1;
    sk.cands[j]!.forEach((t, k) => {
      if (Math.abs(t - beat) <= D.onBeatSec && (best < 0 || Math.abs(t - beat) < Math.abs(sk.cands[j]![best]! - beat))) best = k;
    });
    if (best < 0) continue;
    const t = sk.cands[j]![best]!;
    const before = j === 0 ? -Infinity : sk.cands[j - 1]![snapped[j - 1]!]!;
    const after = j === path.length - 1 ? Infinity : sk.cands[j + 1]![snapped[j + 1]!]!;
    if (t - before < D.minSylSec || after - t < D.minSylSec) continue;
    snapped[j] = best;
  }
  return snapped;
}

for (const entry of readTrainingManifest(manifest)) {
  if (exclude.has(entry.id)) continue;
  const t0 = performance.now();
  const session = Session.open(entry.workspace);
  const evidence = await session.loadEvidence();
  const calibrated: unknown = JSON.parse(fs.readFileSync(entry.calibrated, 'utf8'));
  if (!isRecord(calibrated) || !Array.isArray(calibrated.lines) || !calibrated.lines.every(isConsensusLine)) throw new Error(`bad calibrated ${entry.calibrated}`);
  const anchors = emptyAnchors();
  importCalibrated(anchors, session.definition, calibrated, { level: 'line', skipDefinitionLines: entry.skipLines });
  const truth: Array<ConsensusLine | null> = [];
  let k = 0;
  for (const line of session.definition.lines) truth.push(entry.skipLines.includes(line.index) ? null : calibrated.lines[k++]!);
  const sliced = await session.alignAnchored(anchors, evidence, () => {});
  solveAndDump(entry.id, 'anchored', { evidence, anchors, sliced, truth });
  solveAndDump(entry.id, 'free', { evidence, anchors: emptyAnchors(), sliced: {}, truth });
  console.log(`${set} ${entry.id} ${Math.round(performance.now() - t0)} ms`);
}
fs.closeSync(bndOut);
fs.closeSync(sylOut);
