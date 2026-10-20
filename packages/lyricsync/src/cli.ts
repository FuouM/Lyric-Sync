#!/usr/bin/env node
// src/cli.ts
// lyricsync command line. Progress and diagnostics go to stderr; stdout carries the result (human text, or one JSON document with --json).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { type ImportLevel, clearAnchors, importCalibrated, pinsOf, setBoundary, setLineBounds, summarizeAnchors, syllableCount } from './workspace/anchors.ts';
import { Session } from './workspace/session.ts';
import { loadTrainingSongs, writeTrainedWeights } from './train/songs.ts';
import { trainMode } from './train/train.ts';
import type { BeatSource } from './workspace/manifest.ts';
import type { Language, LineReview } from './types.ts';

const HELP = `lyricsync - singing-voice lyrics timing (vocal stem + lyrics -> word/syllable lyrics.json)

Usage: lyricsync <command> <workspace> [options]

Commands
  init <ws>      Create a workspace from a vocal stem and lyrics.
                   --vocal <audio>        isolated vocal stem (wav; mp3/flac/m4a/ogg need ffmpeg on PATH)
                   --lyrics <file>        .txt (one line per lyric line, "re|con|cil" for explicit syllables, [Section] headers) or .json
                   --language <en|ja>     lyric language (ja = romaji)
                   beat source, exactly one of:
                   --mix <audio>          full mix: beats are tracked on it   [--bpm <n>] [--first-downbeat <s>]
                   --beats <file.json>    precomputed beats (the JSON that "beatsync" prints)
  prepare <ws>   Extract beats and audio evidence (minutes; cached).        [--force]
  solve <ws>     Write <ws>/out/lyrics.json (+ out/review.json).            [--out <file>] [--method guided|trained|analytic|simple]
                 [--no-snap: guided only; keep acoustic times instead of moving boundaries within 55 ms of a beat onto it]
  review <ws>    List the lines the solver is least sure about.             [--top <n>, default 5]
  anchor <ws>    Pin timings you know, then solve again:
                   --line <n> [--start <s>] [--end <s>]     pin a line's edges (both => accurate "anchored" mode)
                   --boundary <line>:<j>=<s>  (repeatable)  pin the start of the line's j-th syllable (0-based, flat over words)
                   --import <file> --level <line|word|syllable|flagged>  [--lines 0,3] [--skip-lines 37]
                                          pin from a hand-corrected lyrics.json ("flagged" = only syllables the editor marked calibrated)
                   --clear [--line <n>]   remove anchors
                   --list                 show current anchors
  status <ws>    Workspace state.
  run <ws>       init + prepare + solve in one go (init options, plus: --out <file>, --method <...>, --anchors-from <file> --level <...>).
  train <manifest.json>  (developers) Fit anchored + free DP weights on annotated songs: --out-dir <dir> [--held-out-dir <dir>]
                 [--epochs 3] [--lr 0.1] [--l2 0.2] [--tau-ms 4]. See docs/training.md.
  version

Global options: --json (machine-readable stdout), --help
Exit codes: 0 ok, 1 error (message on stderr; with --json also {"error":{"message":..}} on stdout), 2 usage.

Methods: "guided" (default) adds the bundled syllable-boundary model's scores to the vote-count solver (see docs/guided.md); "trained" scores
boundaries with the bundled learned DP weights; "analytic" needs no learned weights (explicit scoring model, see docs/analytic.md); "simple"
counts votes only (docs/simple.md).
Typical loop: init -> prepare -> solve -> review -> (fix a few lines by ear/eye) -> anchor -> solve -> review ...
Docs: README.md, docs/workflow.md, AGENTS.md.
`;

class UsageError extends Error {}

function num(value: string | undefined, name: string): number {
  const n = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isFinite(n)) throw new UsageError(`${name} must be a number, got "${value ?? ''}".`);
  return n;
}

function intList(value: string | undefined, name: string): number[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a comma-separated list of line indices, got "${value}".`);
    return n;
  });
}

function beatSource(values: { mix?: string; beats?: string; bpm?: string; 'first-downbeat'?: string }): BeatSource {
  if ((values.mix === undefined) === (values.beats === undefined)) throw new UsageError('Give exactly one beat source: --mix <audio> or --beats <beats.json>.');
  if (values.beats !== undefined) {
    if (values.bpm !== undefined || values['first-downbeat'] !== undefined) throw new UsageError('--bpm and --first-downbeat only apply with --mix.');
    return { kind: 'file', path: path.resolve(values.beats) };
  }
  if (values.bpm === undefined) throw new UsageError("--mix needs --bpm <n>: the song's approximate tempo (a tight prior: beats are tracked within about +/-12% of it).");
  const firstDownbeat = values['first-downbeat'] === undefined ? undefined : num(values['first-downbeat'], '--first-downbeat');
  return { kind: 'mix', path: path.resolve(values.mix!), targetBpm: num(values.bpm, '--bpm'), firstDownbeat };
}

function language(value: string | undefined): Language {
  if (value !== 'en' && value !== 'ja') throw new UsageError('--language must be "en" or "ja".');
  return value;
}

function formatReview(session: Session, review: LineReview[]): string {
  if (review.length === 0) return 'Nothing uncertain: every boundary is pinned.';
  return review
    .map((r) => {
      const line = session.definition.lines[r.line]!;
      const head = `line ${r.line} [${r.mode}] mean ±${r.meanExpectedErrorMs.toFixed(0)} ms  "${line.text}"`;
      const detail = r.uncertain.map((b) => `    boundary ${b.boundary} "${b.syllable || '(line end)'}" at ${b.time.toFixed(3)} s  ±${b.expectedErrorMs.toFixed(0)} ms`).join('\n');
      return `${head}\n${detail}`;
    })
    .join('\n');
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return command === undefined ? 2 : 0;
  }
  if (command === 'version') {
    const pkg: unknown = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown'}\n`);
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      vocal: { type: 'string' },
      lyrics: { type: 'string' },
      language: { type: 'string' },
      mix: { type: 'string' },
      beats: { type: 'string' },
      bpm: { type: 'string' },
      'first-downbeat': { type: 'string' },
      force: { type: 'boolean' },
      out: { type: 'string' },
      top: { type: 'string' },
      line: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      boundary: { type: 'string', multiple: true },
      import: { type: 'string' },
      'anchors-from': { type: 'string' },
      level: { type: 'string' },
      lines: { type: 'string' },
      'skip-lines': { type: 'string' },
      clear: { type: 'boolean' },
      list: { type: 'boolean' },
      'out-dir': { type: 'string' },
      'held-out-dir': { type: 'string' },
      epochs: { type: 'string' },
      lr: { type: 'string' },
      l2: { type: 'string' },
      'tau-ms': { type: 'string' },
      method: { type: 'string' },
      'no-snap': { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = values.json === true;
  const dir = positionals[0];
  if (dir === undefined) throw new UsageError(`"${command}" needs a workspace directory.`);
  const say = (m: string): void => void process.stderr.write(`${m}\n`);
  const emit = (data: unknown, text: string): void => void process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);

  const importLevel = (): ImportLevel => {
    const level = values.level;
    if (level !== 'line' && level !== 'word' && level !== 'syllable' && level !== 'flagged') throw new UsageError('--level must be line, word, syllable or flagged.');
    return level;
  };
  const initFromOptions = (announce: boolean): { session: Session } => {
    if (values.vocal === undefined || values.lyrics === undefined) throw new UsageError('init needs --vocal and --lyrics.');
    const { session, autoSplit } = Session.init({
      dir,
      vocalPath: path.resolve(values.vocal),
      lyricsPath: path.resolve(values.lyrics),
      language: language(values.language),
      beats: beatSource(values),
    });
    const st = session.status();
    const notes = autoSplit.map((a) => `line ${a.line}: ${a.word} -> ${a.syllables.join('|')}`);
    const autoText = notes.length ? `Auto-split ${notes.length} words (write "a|b" in the lyrics to override):\n  ${notes.join('\n  ')}` : '';
    if (announce) {
      emit({ workspace: st.dir, language: st.language, lines: st.lines, syllables: st.syllables, autoSplit }, `Workspace ${st.dir}: ${st.lines} lines, ${st.syllables} syllables.${autoText ? `\n${autoText}` : ''}`);
    } else if (autoText) {
      say(autoText);
    }
    return { session };
  };
  const solveAndReport = async (session: Session): Promise<void> => {
    const method = values.method ?? 'guided';
    if (method !== 'guided' && method !== 'trained' && method !== 'analytic' && method !== 'simple') {
      throw new UsageError(`--method must be guided, trained, analytic or simple, got "${method}".`);
    }
    const result = await session.solve({ onProgress: say, method, snapToBeats: values['no-snap'] !== true });
    const out = values.out ? path.resolve(values.out) : undefined;
    if (out) fs.copyFileSync(session.paths.lyricsOut, out);
    const top = session.reviewTop(5);
    emit(
      { out: out ?? session.paths.lyricsOut, anchors: result.anchors, meanExpectedErrorMs: result.meanExpectedErrorMs, review: top },
      `Wrote ${out ?? session.paths.lyricsOut}\nAnchored lines: ${result.anchors.anchoredLines}, partial: ${result.anchors.partialLines}, free: ${result.anchors.freeLines}. Mean expected error over unpinned boundaries: ${result.meanExpectedErrorMs.toFixed(1)} ms.\nLeast certain lines:\n${formatReview(session, top)}`,
    );
  };

  switch (command) {
    case 'init':
      initFromOptions(true);
      return 0;
    case 'prepare': {
      const r = await Session.open(dir).prepare({ force: values.force === true, onProgress: say });
      emit({ skipped: r.skipped }, r.skipped ? 'Already prepared for these inputs (use --force to redo).' : 'Prepared.');
      return 0;
    }
    case 'solve':
      await solveAndReport(Session.open(dir));
      return 0;
    case 'run': {
      const { session } = initFromOptions(false);
      if (values['anchors-from'] !== undefined) {
        const anchors = session.loadAnchors();
        const summary = importCalibrated(anchors, session.definition, JSON.parse(fs.readFileSync(path.resolve(values['anchors-from']), 'utf8')) as unknown, {
          level: importLevel(),
          lines: intList(values.lines, '--lines'),
          skipDefinitionLines: intList(values['skip-lines'], '--skip-lines'),
        });
        session.saveAnchors(anchors);
        say(`Imported ${summary.boundariesPinned} pinned boundaries on ${summary.linesTouched} lines.`);
      }
      await session.prepare({ onProgress: say });
      await solveAndReport(session);
      return 0;
    }
    case 'review': {
      const session = Session.open(dir);
      const top = values.top === undefined ? 5 : num(values.top, '--top');
      const review = session.reviewTop(top);
      emit({ lines: review }, formatReview(session, review));
      return 0;
    }
    case 'status': {
      const st = Session.open(dir).status();
      emit(st, `Workspace ${st.dir}\n  language ${st.language}, ${st.lines} lines, ${st.syllables} syllables\n  prepared: ${st.prepared} (fresh: ${st.evidenceFresh}), solved: ${st.solved}\n  anchors: ${st.anchors.anchoredLines} anchored lines, ${st.anchors.partialLines} partial, ${st.anchors.pinnedBoundaries} pinned boundaries`);
      return 0;
    }
    case 'anchor': {
      const session = Session.open(dir);
      const anchors = session.loadAnchors();
      const def = session.definition;
      if (values.list) {
        const lines = def.lines
          .filter((l) => anchors.lines[String(l.index)] !== undefined)
          .map((l) => ({ line: l.index, text: l.text, pins: pinsOf(anchors.lines[String(l.index)]!, syllableCount(l)) }));
        emit({ anchors: summarizeAnchors(anchors, def), lines }, lines.length === 0 ? 'No anchors.' : lines.map((l) => `line ${l.line} "${l.text}": ${l.pins.map(([j, t]) => `${j}@${t}`).join(' ')}`).join('\n'));
        return 0;
      }
      let changed = 0;
      if (values.clear) {
        changed += clearAnchors(anchors, values.line === undefined ? undefined : num(values.line, '--line'));
      } else if (values.import !== undefined) {
        const summary = importCalibrated(anchors, def, JSON.parse(fs.readFileSync(path.resolve(values.import), 'utf8')) as unknown, {
          level: importLevel(),
          lines: intList(values.lines, '--lines'),
          skipDefinitionLines: intList(values['skip-lines'], '--skip-lines'),
        });
        changed += summary.boundariesPinned;
      } else if (values.line !== undefined) {
        const line = num(values.line, '--line');
        const lyric = def.lines[line];
        if (!lyric) throw new UsageError(`No line ${line}: the lyrics have ${def.lines.length} lines.`);
        if (values.start === undefined && values.end === undefined) throw new UsageError('--line needs --start and/or --end.');
        if (values.start !== undefined && values.end !== undefined) setLineBounds(anchors, def, line, num(values.start, '--start'), num(values.end, '--end'));
        else if (values.start !== undefined) setBoundary(anchors, def, line, 0, num(values.start, '--start'));
        else setBoundary(anchors, def, line, syllableCount(lyric), num(values.end, '--end'));
        changed++;
      }
      for (const spec of values.boundary ?? []) {
        const m = /^(\d+):(\d+)=(\d+(?:\.\d+)?)$/.exec(spec);
        if (!m) throw new UsageError(`--boundary must look like <line>:<j>=<seconds>, got "${spec}".`);
        setBoundary(anchors, def, Number(m[1]), Number(m[2]), Number(m[3]));
        changed++;
      }
      if (changed === 0 && !values.clear) throw new UsageError('Nothing to do: give --line/--start/--end, --boundary, --import, --clear or --list.');
      session.saveAnchors(anchors);
      const s = summarizeAnchors(anchors, def);
      emit({ changed, anchors: s }, `Anchors saved: ${s.anchoredLines} anchored lines, ${s.partialLines} partial, ${s.pinnedBoundaries} pinned boundaries. Run "lyricsync solve" to apply.`);
      return 0;
    }
    case 'train': {
      const outDir = values['out-dir'];
      if (outDir === undefined) throw new UsageError('train needs --out-dir <dir> (e.g. the package weights/ directory).');
      const songs = await loadTrainingSongs(path.resolve(dir), say);
      const hyper = {
        epochs: values.epochs === undefined ? undefined : num(values.epochs, '--epochs'),
        lr: values.lr === undefined ? undefined : num(values.lr, '--lr'),
        l2: values.l2 === undefined ? undefined : num(values.l2, '--l2'),
        tauMs: values['tau-ms'] === undefined ? undefined : num(values['tau-ms'], '--tau-ms'),
        onProgress: say,
      };
      const results = [trainMode(songs, 'anchored', hyper), trainMode(songs, 'free', hyper)];
      writeTrainedWeights(results, path.resolve(outDir), values['held-out-dir'] === undefined ? undefined : path.resolve(values['held-out-dir']));
      emit(
        results.map((r) => ({ mode: r.mode, stages: r.stages, overall: r.overall, songs: r.songs })),
        results.map((r) => `${r.mode}: ${r.stages} stage${r.stages === 1 ? '' : 's'}, held-out syllable MAE ${r.overall.shipped.toFixed(3)} ms (consensus ${r.overall.consensus.toFixed(2)}, stage 1 ${r.overall.stage1.toFixed(2)}, stage 2 ${r.overall.stage2.toFixed(2)})`).join('\n'),
      );
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}". Run "lyricsync --help".`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { message } })}\n`);
    process.stderr.write(`lyricsync: ${message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
