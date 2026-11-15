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
import { songNotes, songUstImport } from './ust-song.ts';
import { SUB_FORMATS, type SubFormat } from './formats/subs.ts';
import { retimeSong } from './retime.ts';
import { exportSubs } from './subs-song.ts';
import { songMidiNotes } from './midi-song.ts';
import { writeFixedGrid } from './grid-song.ts';

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
  notes <song>   Write <song>/generated/notes.json: every UST note that a placed clip plays (user_input/placements.json), on the
                 song beat grid (generated/timing.ai.json), with its singer (user_input/singers.json).
  import ust <song>  Write the singers' calibration files from the placed UST notes and user_input/ust.map.json. Every map
                 check runs first; a failure names the lane, the lyric line and the UST note.   [--dry: check, write nothing] [--singer <id,...>]
  train <manifest.json>  (developers) Fit anchored + free DP weights on annotated songs: --out-dir <dir> [--held-out-dir <dir>]
                 [--epochs 3] [--lr 0.1] [--l2 0.2] [--tau-ms 4]. See docs/training.md.
  export subs <song>  Write subtitle files from the calibration files (a line at a time, a syllable lit at a time, as in the pve player).
                 --out <dir> (required; never the song folder by default)   [--format ttml|srt|ass|ytt|all (default ass)] [--lang <code>, TTML]
                 [--singer <id> | --all]  (default: the lead). With --all, ASS and YTT also get <song>.all.<format>: one row per singer.
  retime <song>  Add --by <seconds> (use --by=-0.5 for a negative value) to every time of the calibration files (sections, lines, words,
                 syllables). Pins, text and flags stay. generated/ and the cache stay.   [--singer <id> | --all]  (default: the lead)
  grid <song>    Write generated/timing.ai.json for a song with "grid: fixed" in user_input/prompt.yaml: a constant tempo (nearest_bpm), bar 1 at
                 first_downbeat_s (default 0), every beat to the end of the mix. No models. Other songs get their beats from the editor or the wizard.
  midi <song>    Write the notes of a MIDI file on the song beat grid (generated/timing.ai.json) as JSON: track, channel, program, drum role,
                 pitch, velocity, beat, start, end. --file <mid> --out <file> (required)   [--offset-beats <n>: song beats added to every MIDI beat]
                 [--bpm <n>: time = beat * 60 / n instead of the beat grid]   [--encoding <label>: text encoding of track names, e.g. gbk]
  version

Global options: --json (machine-readable stdout), --device gpu|cpu (where prepare/solve run the models; default gpu, which uses
                DirectML on Windows and the CPU where no GPU provider exists; results agree up to float rounding), --help
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
      device: { type: 'string' },
      dry: { type: 'boolean' },
      format: { type: 'string' },
      lang: { type: 'string' },
      singer: { type: 'string' },
      all: { type: 'boolean' },
      by: { type: 'string' },
      file: { type: 'string' },
      'offset-beats': { type: 'string' },
      encoding: { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = values.json === true;
  if (values.device !== undefined && values.device !== 'gpu' && values.device !== 'cpu') throw new UsageError('--device must be gpu or cpu.');
  const device = values.device ?? 'gpu';
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
    const result = await session.solve({ onProgress: say, method, snapToBeats: values['no-snap'] !== true, device });
    const out = values.out ? path.resolve(values.out) : undefined;
    if (out) fs.copyFileSync(session.paths.lyricsOut, out);
    const top = session.reviewTop(5);
    emit(
      { out: out ?? session.paths.lyricsOut, anchors: result.anchors, meanExpectedErrorMs: result.meanExpectedErrorMs, review: top },
      `Wrote ${out ?? session.paths.lyricsOut}\nAnchored lines: ${result.anchors.anchoredLines}, partial: ${result.anchors.partialLines}, free: ${result.anchors.freeLines}. Mean expected error over unpinned boundaries: ${result.meanExpectedErrorMs.toFixed(1)} ms.\nLeast certain lines:\n${formatReview(session, top)}`,
    );
  };

  const songFolder = (arg: string | undefined): string => {
    if (arg === undefined) throw new UsageError(`"${command}" needs a song folder.`);
    const song = path.resolve(arg);
    if (!fs.existsSync(path.join(song, 'user_input'))) throw new UsageError(`${song} is not a song folder (no user_input/).`);
    return song;
  };
  const writeJson = (file: string, data: unknown): void => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  const selector = (): { singer?: string; all?: boolean } => ({ ...(values.singer === undefined ? {} : { singer: values.singer }), ...(values.all === true ? { all: true } : {}) });
  switch (command) {
    case 'export': {
      if (dir !== 'subs') throw new UsageError(`Unknown export "${dir}": only "subs" is supported.`);
      const song = songFolder(positionals[1]);
      if (values.out === undefined) throw new UsageError('export subs needs --out <dir>.');
      const raw = values.format ?? 'ass';
      const formats = raw === 'all' ? [...SUB_FORMATS] : raw.split(',').map((f) => f.trim()).filter(Boolean);
      for (const f of formats) if (!(SUB_FORMATS as readonly string[]).includes(f)) throw new UsageError(`--format is ttml, srt, ass, ytt or all, got "${f}".`);
      const files = exportSubs(song, { ...selector(), formats: formats as SubFormat[], out: path.resolve(values.out), lang: values.lang });
      emit(
        { files },
        files.map((f) => `${path.relative(process.cwd(), f.file)}  ${f.cues} cues  ${f.first.toFixed(2)} - ${f.last.toFixed(2)} s  (${f.singers.join(', ')})`).join('\n'),
      );
      return 0;
    }
    case 'grid': {
      const song = songFolder(dir);
      const { file, doc } = await writeFixedGrid(song);
      emit(
        { out: file, bpm: doc.bpm, beats: doc.beats.length, bars: doc.downbeats.length, duration: doc.duration },
        `Wrote ${file}: ${doc.beats.length} beats, ${doc.downbeats.length} downbeats, ${doc.bpm} BPM, ${doc.duration} s.`,
      );
      return 0;
    }
    case 'midi': {
      const song = songFolder(dir);
      if (values.file === undefined) throw new UsageError('midi needs --file <mid>.');
      if (values.out === undefined) throw new UsageError('midi needs --out <file> (never the song folder by default).');
      const doc = songMidiNotes(song, path.resolve(values.file), {
        offsetBeats: values['offset-beats'] === undefined ? undefined : num(values['offset-beats'], '--offset-beats'),
        bpm: values.bpm === undefined ? undefined : num(values.bpm, '--bpm'),
        encoding: values.encoding,
      });
      const out = path.resolve(values.out);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      writeJson(out, doc);
      emit(
        { out, notes: doc.notes.length, dropped: doc.dropped, tracks: doc.tracks },
        `Wrote ${out}: ${doc.notes.length} notes, ${doc.dropped} dropped (before beat 0 or after the song end).\n${doc.tracks.map((t) => `  ${t.track} "${t.name}" ch ${t.channels.join(',') || '-'}: ${t.notes} notes${t.programs.length ? ` (${t.programs.map((p) => p.name).join(', ')})` : ''}`).join('\n')}`,
      );
      return 0;
    }
    case 'retime': {
      const song = songFolder(dir);
      if (values.by === undefined) throw new UsageError('retime needs --by <seconds>.');
      const by = num(values.by, '--by');
      const files = retimeSong(song, by, selector());
      emit({ by, files }, `Shifted by ${by} s:\n${files.map((f) => `  ${path.relative(process.cwd(), f.file)} (${f.singer}): ${f.lines} lines`).join('\n')}`);
      return 0;
    }
    case 'notes': {
      const song = songFolder(dir);
      const doc = songNotes(song);
      const file = path.join(song, 'generated', 'notes.json');
      writeJson(file, doc);
      const lanes = new Map<string, { notes: number; first: number; last: number }>();
      for (const n of doc.notes) {
        const l = lanes.get(n.lane) ?? { notes: 0, first: n.start, last: n.start };
        l.notes++;
        l.first = Math.min(l.first, n.start);
        l.last = Math.max(l.last, n.start);
        lanes.set(n.lane, l);
      }
      const perLane = [...lanes].map(([lane, l]) => ({ lane, ...l }));
      emit(
        { out: file, notes: doc.notes.length, lanes: perLane },
        `Wrote ${file}: ${doc.notes.length} notes.\n${perLane.map((l) => `  ${l.lane}: ${l.notes} notes, ${l.first.toFixed(3)} s to ${l.last.toFixed(3)} s`).join('\n')}`,
      );
      return 0;
    }
    case 'import': {
      if (dir !== 'ust') throw new UsageError(`Unknown import format "${dir}": only "ust" is supported.`);
      const song = songFolder(positionals[1]);
      const dry = values.dry === true;
      const allFiles = songUstImport(song);
      const singers = values.singer ? values.singer.split(',').map((s) => s.trim()) : undefined;
      const files = singers ? allFiles.filter((f) => singers.includes(f.singer)) : allFiles;
      if (singers && files.length === 0) throw new UsageError(`No matching singer for --singer "${values.singer}". Mapped singers: ${allFiles.map((f) => f.singer).join(', ')}.`);
      if (!dry) for (const f of files) writeJson(path.join(song, f.file), f.doc);
      const report = files.map((f) => {
        const flags = f.doc.lines.flatMap((l) => l.words.flatMap((w) => w.sylCalibrated ?? w.syl.map(() => false)));
        const pinned = flags.filter(Boolean).length;
        return {
          singer: f.singer,
          file: f.file,
          lines: f.doc.lines.length,
          syllables: flags.length,
          pinned,
          unpinned: flags.length - pinned,
          sections: f.doc.sections.length,
          first: f.doc.lines[0] ? [f.doc.lines[0].start, f.doc.lines[0].end] : null,
          last: f.doc.lines.at(-1) ? [f.doc.lines.at(-1)!.start, f.doc.lines.at(-1)!.end] : null,
        };
      });
      emit(
        { dry, files: report },
        `${dry ? 'Check passed; would write' : 'Wrote'}:\n${report.map((r) => `  ${r.file} (${r.singer}): ${r.lines} lines, ${r.syllables} syllables (${r.pinned} pinned, ${r.unpinned} unpinned), ${r.sections} sections`).join('\n')}`,
      );
      return 0;
    }
    case 'init':
      initFromOptions(true);
      return 0;
    case 'prepare': {
      const r = await Session.open(dir).prepare({ force: values.force === true, onProgress: say, device });
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
      await session.prepare({ onProgress: say, device });
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
