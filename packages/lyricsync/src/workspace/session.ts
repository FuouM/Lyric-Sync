// src/workspace/session.ts
// The end-to-end workflow over one song:
//   init     parse lyrics, record inputs
//   prepare  beats + audio evidence (slow, cached)
//   solve    free solve, or anchored/mixed solve around the pins in anchors.json
//   review   rank lines by how uncertain the solver is, so a human checks the right places next
// Every step is explicit: nothing is recomputed behind your back and stale evidence is an error, not a silent refresh.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { trackBeats } from 'beatsync';
import { isLineReview, isNumber, isRecord, isSlicedAlignment } from '../guards.ts';
import { loadWeights } from '../engine/weights.ts';
import { solve } from '../engine/solve.ts';
import { solveAnalytic } from '../engine/analytic.ts';
import { solveSimple } from '../engine/simple.ts';
import { boundaryGuide, solveGuided } from '../engine/guided.ts';
import { alignAnchoredLines, computeQueries, extractEvidence, loadEvidence, readBoundaryConfig, saveEvidence } from '../evidence/index.ts';
import { parseStoredDefinition, readLyricsFile, resolveSyllables } from '../lyrics/index.ts';
import type { AutoSplitNote } from '../lyrics/index.ts';
import type { ConsensusLine } from '../engine/consensus.ts';
import type { Anchors, Language, LineReview, LyricsDefinition, LyricsJson, LyricWord, SlicedAlignment, SolveMethod, SongEvidence } from '../types.ts';
import {
  type AnchorSummary,
  emptyAnchors,
  isLineAnchored,
  loadAnchors,
  pinsOf,
  resplitLineAnchor,
  saveAnchors,
  summarizeAnchors,
  syllableCount,
  validateAnchors,
} from './anchors.ts';
import {
  type CalibratedLyricsDocument,
  calibratedToAnchors,
  createInitialCalibratedDocument,
  divideSpan,
  parseCalibratedDocument,
  updateCalibratedFromSolve,
} from './calibration.ts';
import {
  type BeatSource,
  type WorkspaceManifest,
  type WorkspacePaths,
  computeAudioKey,
  computeEvidenceKey,
  readManifest,
  resolveInWorkspace,
  storePath,
  workspacePaths,
  writeManifest,
} from './manifest.ts';

export type Progress = (message: string) => void;

export interface InitOptions {
  dir: string;
  vocalPath: string;
  lyricsPath: string;
  language: Language;
  beats: BeatSource;
}

/** New syllables for word `word` of definition line `line`. */
export interface SyllableChange {
  line: number;
  word: number;
  syllables: string[];
}

/** On-disk beat document; the same schema `beatsync` prints. */
export interface BeatsDocument {
  v: 1;
  model: string;
  duration: number;
  bpm: number;
  beat_period: number;
  beats: number[];
  downbeats: number[];
}

export interface SolveResult {
  lyrics: LyricsJson;
  review: LineReview[];
  anchors: AnchorSummary;
  /** Mean posterior-expected error over all unpinned boundaries, in ms. */
  meanExpectedErrorMs: number;
}

export interface WorkspaceStatus {
  dir: string;
  language: Language;
  lines: number;
  syllables: number;
  prepared: boolean;
  evidenceFresh: boolean;
  anchors: AnchorSummary;
  solved: boolean;
}

function readBeatsDocument(file: string): BeatsDocument {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(raw) || !Array.isArray(raw.beats)) throw new Error(`Beat file must be a beatsync JSON document with a "beats" array: ${file}`);
  const beats = raw.beats.map((b: unknown) => {
    if (!isNumber(b)) throw new Error(`Beat file contains a non-numeric beat time: ${file}`);
    return b;
  });
  if (beats.length < 4) throw new Error(`Beat file has only ${beats.length} beats; a song needs a real beat track: ${file}`);
  for (let i = 1; i < beats.length; i++) if (beats[i]! <= beats[i - 1]!) throw new Error(`Beat times must be strictly increasing (beat ${i} in ${file}).`);
  const downbeats = Array.isArray(raw.downbeats) ? raw.downbeats.filter(isNumber) : [];
  return {
    v: 1,
    model: typeof raw.model === 'string' ? raw.model : 'external',
    duration: isNumber(raw.duration) ? raw.duration : beats[beats.length - 1]!,
    bpm: isNumber(raw.bpm) ? raw.bpm : 0,
    beat_period: isNumber(raw.beat_period) ? raw.beat_period : 0,
    beats,
    downbeats,
  };
}

function resliceWords(words: unknown[], defWords: LyricWord[]): void {
  for (let wi = 0; wi < defWords.length; wi++) {
    const defW = defWords[wi]!;
    const w = words[wi] as { start: number; end: number; syl: Array<[number, number]>; sylText: string[] };
    const dur = w.end - w.start;
    const syls = defW.syllables;
    const syl: Array<[number, number]> = [];
    let curS = w.start;
    for (let si = 0; si < syls.length; si++) {
      const nxtS = si === syls.length - 1 ? w.end : Math.round((curS + dur / syls.length) * 1000) / 1000;
      syl.push([curS, nxtS]);
      curS = nxtS;
    }
    w.syl = syl;
    w.sylText = [...syls];
  }
}

function resliceAlignments(alignments: { fullBase: ConsensusLine[]; fullCombined: ConsensusLine[] | null }, def: LyricsDefinition): void {
  for (let li = 0; li < def.lines.length; li++) {
    const defLine = def.lines[li]!;
    resliceWords(alignments.fullBase[li]!.words, defLine.words);
    if (alignments.fullCombined && alignments.fullCombined[li]) {
      resliceWords(alignments.fullCombined[li]!.words, defLine.words);
    }
  }
}

function canResliceAlignments(alignments: unknown, def: LyricsDefinition): alignments is { fullBase: ConsensusLine[]; fullCombined: ConsensusLine[] | null } {
  if (!isRecord(alignments) || !Array.isArray(alignments.fullBase)) return false;
  const base = alignments.fullBase;
  if (base.length !== def.lines.length) return false;
  for (let li = 0; li < def.lines.length; li++) {
    const lDef = def.lines[li]!;
    const lBase = base[li];
    if (!isRecord(lBase) || !Array.isArray(lBase.words) || lBase.words.length !== lDef.words.length) return false;
    for (let wi = 0; wi < lDef.words.length; wi++) {
      const wDef = lDef.words[wi]!;
      const wBase = lBase.words[wi];
      if (!isRecord(wBase) || wBase.w !== wDef.w) return false;
      if (!isNumber(wBase.start) || !isNumber(wBase.end)) return false;
    }
  }
  return true;
}

export class Session {
  readonly paths: WorkspacePaths;
  readonly manifest: WorkspaceManifest;
  #definition: LyricsDefinition;
  /** Evidence is decoded from disk once per session; `prepare` replaces it. */
  private evidence: SongEvidence | null = null;

  private constructor(paths: WorkspacePaths, manifest: WorkspaceManifest, definition: LyricsDefinition) {
    this.paths = paths;
    this.manifest = manifest;
    this.#definition = definition;
  }

  get definition(): LyricsDefinition {
    return this.#definition;
  }

  /**
   * Re-splits words into other syllables (validated like lyrics input) and writes lyrics.def.json. The evidence depends on the
   * syllables, so the workspace needs `prepare` again. Pins move with the split: anchors.json keeps every pin outside the changed
   * words (re-indexed) and drops those inside them; in lyrics.calibrated.json a changed word is unpinned and its span divided evenly.
   */
  setSyllables(changes: SyllableChange[]): void {
    const next = structuredClone(this.#definition);
    for (const c of changes) {
      const word = next.lines[c.line]?.words[c.word];
      if (!word) throw new Error(`Lyrics line ${c.line} has no word ${c.word}.`);
      if (c.syllables.length === 0 || c.syllables.some((s) => s.length === 0 || /[\s|]/.test(s))) {
        throw new Error(`Syllables ${JSON.stringify(c.syllables)} of "${word.w}" must be non-empty and contain no spaces or "|".`);
      }
      word.syllables = resolveSyllables(word, c.syllables, next.language);
    }

    const anchors = this.loadAnchors();
    // Right to left within a line, so the boundary offset of every later change is still the one of the old split.
    for (const c of [...changes].sort((a, b) => a.line - b.line || b.word - a.word)) {
      const anchor = anchors.lines[String(c.line)];
      const old = this.#definition.lines[c.line]!;
      if (!anchor) continue;
      const from = old.words.slice(0, c.word).reduce((n, w) => n + w.syllables.length, 0);
      resplitLineAnchor(anchor, from, old.words[c.word]!.syllables.length, c.syllables.length);
    }
    validateAnchors(anchors, next);

    const calibrated = fs.existsSync(this.calibratedPath()) ? this.loadCalibrated() : null;
    if (calibrated) {
      for (const c of changes) {
        const line = calibrated.lines[c.line];
        const word = line?.words[c.word];
        if (!line || !word) throw new Error(`${this.calibratedPath()} has no word ${c.word} in line ${c.line}.`);
        word.syl = divideSpan(word.start, word.end, c.syllables.length);
        word.sylText = [...c.syllables];
        word.sylCalibrated = c.syllables.map(() => false);
        word.calibrated = false;
        line.calibrated = false;
      }
    }

    fs.writeFileSync(this.paths.definition, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    saveAnchors(this.paths.anchors, anchors);
    if (calibrated) fs.writeFileSync(this.calibratedPath(), `${JSON.stringify(calibrated, null, 2)}\n`, 'utf8');
    this.#definition = next;
    this.evidence = null;
  }

  /** Creates a workspace: validates and resolves the lyrics, records the inputs. Fails if the directory is already a workspace. */
  static init(options: InitOptions): { session: Session; autoSplit: AutoSplitNote[] } {
    const paths = workspacePaths(options.dir);
    if (fs.existsSync(paths.manifest)) throw new Error(`Workspace already exists: ${paths.dir}. Open it, or choose another directory.`);
    for (const [what, file] of [['Vocal stem', options.vocalPath], ['Beat source', options.beats.path]] as const) {
      if (!fs.existsSync(file)) throw new Error(`${what} not found: ${file}`);
    }
    const { definition, autoSplit } = readLyricsFile(options.lyricsPath, options.language);
    // `definition` was just built by the parser, which resolved every pronunciation and syllable.
    fs.mkdirSync(paths.dir, { recursive: true });
    const beats: BeatSource = { ...options.beats, path: storePath(paths.dir, options.beats.path) };
    const manifest: WorkspaceManifest = {
      version: 1,
      language: options.language,
      vocal: storePath(paths.dir, options.vocalPath),
      beats,
      evidenceKey: null,
    };
    fs.writeFileSync(paths.definition, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
    saveAnchors(paths.anchors, emptyAnchors());
    writeManifest(paths.manifest, manifest);
    return { session: new Session(paths, manifest, definition), autoSplit };
  }

  static open(dir: string): Session {
    const paths = workspacePaths(dir);
    const manifest = readManifest(paths.manifest);
    if (!fs.existsSync(paths.definition)) throw new Error(`Workspace is missing ${paths.definition}.`);
    const definition = parseStoredDefinition(JSON.parse(fs.readFileSync(paths.definition, 'utf8')));
    if (definition.language !== manifest.language) throw new Error(`Workspace language mismatch between lyricsync.json and lyrics.def.json.`);
    return new Session(paths, manifest, definition);
  }

  calibratedPath(): string {
    return path.join(this.paths.dir, 'lyrics.calibrated.json');
  }

  loadCalibrated(): CalibratedLyricsDocument {
    const file = this.calibratedPath();
    if (fs.existsSync(file)) {
      return parseCalibratedDocument(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    return createInitialCalibratedDocument(this.definition);
  }

  saveCalibrated(doc: CalibratedLyricsDocument): void {
    fs.writeFileSync(this.calibratedPath(), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    // Mirror pins into anchors.json for CLI/agent backward compatibility
    this.saveAnchors(calibratedToAnchors(doc));
  }

  private vocalPath(): string {
    return resolveInWorkspace(this.paths.dir, this.manifest.vocal);
  }

  loadAnchors(): Anchors {
    const anchors = loadAnchors(this.paths.anchors);
    validateAnchors(anchors, this.definition);
    return anchors;
  }

  saveAnchors(anchors: Anchors): void {
    validateAnchors(anchors, this.definition);
    saveAnchors(this.paths.anchors, anchors);
  }

  private evidenceFresh(): boolean {
    if (this.manifest.evidenceKey === null) return false;
    return computeEvidenceKey(this.paths.dir, this.manifest, this.definition) === this.manifest.evidenceKey;
  }

  /** Beats + audio evidence. Skips work when the workspace is already prepared for the current inputs, unless `force`. */
  async prepare(options: { force?: boolean; onProgress?: Progress } = {}): Promise<{ skipped: boolean; incremental?: boolean }> {
    const say = options.onProgress ?? (() => {});
    if (!options.force && this.evidenceFresh()) return { skipped: true, incremental: false };
    fs.mkdirSync(this.paths.evidence, { recursive: true });

    const source = this.manifest.beats;
    const sourcePath = resolveInWorkspace(this.paths.dir, source.path);
    let beats: BeatsDocument;
    if (source.kind === 'mix') {
      say(`Tracking beats on ${path.basename(sourcePath)}...`);
      const analysis = await trackBeats(sourcePath, { targetBpm: source.targetBpm, firstDownbeat: source.firstDownbeat });
      beats = {
        v: 1,
        model: 'beat_this',
        duration: Number(analysis.durationSec.toFixed(3)),
        bpm: analysis.bpm,
        beat_period: analysis.beatPeriod,
        beats: analysis.beats.map((b) => Number(b.toFixed(3))),
        downbeats: analysis.downbeats.map((d) => Number(d.toFixed(3))),
      };
    } else {
      say(`Reading beats from ${path.basename(sourcePath)}...`);
      beats = readBeatsDocument(sourcePath);
    }
    fs.writeFileSync(this.paths.beats, `${JSON.stringify(beats)}\n`, 'utf8');

    // Check whether the acoustic evidence is current; if so, update boundary queries and alignments incrementally.
    const audioKey = computeAudioKey(this.paths.dir, this.manifest);
    const metaPath = path.join(this.paths.evidence, 'meta.json');
    const notesPath = path.join(this.paths.evidence, 'notes.json');
    const posteriorsPath = path.join(this.paths.evidence, 'posteriors.bin');
    const boundaryFramesPath = path.join(this.paths.evidence, 'boundary.bin');
    const alignPath = path.join(this.paths.evidence, 'alignments.json');

    const canIncremental =
      !options.force &&
      fs.existsSync(metaPath) &&
      fs.existsSync(notesPath) &&
      fs.existsSync(posteriorsPath) &&
      fs.existsSync(boundaryFramesPath) &&
      fs.existsSync(alignPath);

    if (canIncremental) {
      try {
        const meta: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const alignments: unknown = JSON.parse(fs.readFileSync(alignPath, 'utf8'));
        // Evidence without an audio key predates it: its inputs are unknown, so it is extracted again.
        const audioFresh = isRecord(meta) && meta.audioKey === audioKey;
        if (audioFresh && canResliceAlignments(alignments, this.definition)) {
          say('Audio evidence is current; updating boundary queries and alignments...');
          const t0 = Date.now();
          resliceAlignments(alignments, this.definition);
          fs.writeFileSync(alignPath, `${JSON.stringify(alignments, null, 2)}\n`, 'utf8');

          const cfg = readBoundaryConfig();
          const queries = await computeQueries(cfg, this.definition);
          fs.writeFileSync(path.join(this.paths.evidence, 'boundary.json'), `${JSON.stringify(queries, null, 2)}\n`, 'utf8');

          if (fs.existsSync(this.paths.sliced)) {
            for (const f of fs.readdirSync(this.paths.sliced)) if (f.endsWith('.json')) fs.unlinkSync(path.join(this.paths.sliced, f));
          }

          this.evidence = null;
          const key = computeEvidenceKey(this.paths.dir, this.manifest, this.definition);
          this.manifest.evidenceKey = key;
          writeManifest(this.paths.manifest, this.manifest);
          say(`Evidence updated incrementally in ${Date.now() - t0} ms.`);
          return { skipped: false, incremental: true };
        }
      } catch {
        // Fall back to full extraction
      }
    }

    const evidence = await extractEvidence({ vocalPath: this.vocalPath(), definition: this.definition, beats: beats.beats, onProgress: say });
    saveEvidence(this.paths.evidence, evidence, { audioKey });
    this.evidence = null;
    // Cached per-line alignments belong to the previous evidence; they are recomputed on demand.
    if (fs.existsSync(this.paths.sliced)) {
      for (const f of fs.readdirSync(this.paths.sliced)) if (f.endsWith('.json')) fs.unlinkSync(path.join(this.paths.sliced, f));
    }
    const key = computeEvidenceKey(this.paths.dir, this.manifest, this.definition);
    this.manifest.evidenceKey = key;
    writeManifest(this.paths.manifest, this.manifest);
    return { skipped: false, incremental: false };
  }

  status(): WorkspaceStatus {
    const prepared = this.manifest.evidenceKey !== null && fs.existsSync(path.join(this.paths.evidence, 'meta.json'));
    return {
      dir: this.paths.dir,
      language: this.manifest.language,
      lines: this.definition.lines.length,
      syllables: this.definition.lines.reduce((n, l) => n + syllableCount(l), 0),
      prepared,
      evidenceFresh: prepared && this.evidenceFresh(),
      anchors: summarizeAnchors(this.loadAnchors(), this.definition),
      solved: fs.existsSync(this.paths.lyricsOut),
    };
  }

  /** Loads the prepared evidence. Throws when the workspace is not prepared, or its lyrics, vocal stem or beat source changed since `prepare`. */
  async loadEvidence(): Promise<SongEvidence> {
    if (this.manifest.evidenceKey === null) throw new Error('Workspace is not prepared. Run "lyricsync prepare <workspace>" first.');
    if (this.evidence === null) {
      if (!this.evidenceFresh()) throw new Error('The lyrics, vocal stem or beat source changed since "prepare". Run "lyricsync prepare <workspace>" again.');
      this.evidence = await loadEvidence(this.paths.evidence, this.vocalPath());
    }
    return this.evidence;
  }

  /** Forced alignments of anchored lines, cached per line and reused while that line's anchors do not change. */
  async alignAnchored(anchors: Anchors, evidence: SongEvidence, say: Progress): Promise<Record<number, SlicedAlignment>> {
    const sliced: Record<number, SlicedAlignment> = {};
    const missing: Record<number, { start: number; end: number }> = {};
    fs.mkdirSync(this.paths.sliced, { recursive: true });
    for (const line of this.definition.lines) {
      const anchor = anchors.lines[String(line.index)];
      if (!isLineAnchored(anchor)) continue;
      const bounds = { start: anchor!.start!, end: anchor!.end! };
      const cacheFile = path.join(this.paths.sliced, `${line.index}.json`);
      if (fs.existsSync(cacheFile)) {
        const cached: unknown = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (isRecord(cached) && cached.start === bounds.start && cached.end === bounds.end && isSlicedAlignment(cached.alignment)) {
          sliced[line.index] = cached.alignment;
          continue;
        }
      }
      missing[line.index] = bounds;
    }
    const todo = Object.keys(missing).length;
    if (todo > 0) {
      say(`Aligning ${todo} anchored line${todo === 1 ? '' : 's'}...`);
      const fresh = await alignAnchoredLines(evidence, this.definition, missing, say);
      for (const [key, alignment] of Object.entries(fresh)) {
        const index = Number(key);
        sliced[index] = alignment;
        const bounds = missing[index]!;
        fs.writeFileSync(path.join(this.paths.sliced, `${index}.json`), JSON.stringify({ start: bounds.start, end: bounds.end, alignment }), 'utf8');
      }
    }
    return sliced;
  }

  /**
   * Solves the song: free where nothing is known, anchored where both line edges are pinned, pinned boundaries exact everywhere.
   * `anchors` replaces anchors.json for this solve (nothing is written back to anchors.json); results are still written to out/.
   * `method` picks the boundary scorer: "guided" (the bundled boundary model, the default), "trained" (bundled learned DP weights),
   * "analytic" (explicit model, no learned weights) or "simple" (vote counts).
   * `snapToBeats` (guided only, default true) moves a solved boundary within 55 ms of a beat onto the beat, as hand-calibrated lyrics are;
   * false keeps the acoustic times (natural timing).
   */
  async solve(options: { onProgress?: Progress; anchors?: Anchors; method?: SolveMethod; snapToBeats?: boolean } = {}): Promise<SolveResult> {
    const method = options.method ?? 'guided';
    const snapToBeats = options.snapToBeats ?? true;
    if (!snapToBeats && method !== 'guided') throw new Error(`Natural timing (no beat snap) is only available with the guided method, not "${method}".`);
    const say = options.onProgress ?? (() => {});
    say('Loading evidence...');
    const evidence = await this.loadEvidence();
    let anchors = options.anchors;
    if (anchors === undefined) {
      // If lyrics.calibrated.json exists, derive anchors from confirmed calibration flags
      if (fs.existsSync(this.calibratedPath())) {
        anchors = calibratedToAnchors(this.loadCalibrated());
      } else {
        anchors = this.loadAnchors();
      }
    } else {
      validateAnchors(anchors, this.definition);
    }
    const sliced = await this.alignAnchored(anchors, evidence, say);
    say('Solving...');
    const input = { evidence, anchors, sliced };
    const output =
      method === 'guided'
        ? solveGuided({ ...input, guide: boundaryGuide(evidence.boundary), design: snapToBeats ? {} : { beatSnapSec: 0 } })
        : method === 'analytic'
          ? solveAnalytic(input)
          : method === 'simple'
            ? solveSimple(input)
            : solve({ ...input, weights: loadWeights() });
    if (output.lines.length !== this.definition.lines.length) {
      throw new Error(`Solver returned ${output.lines.length} lines for ${this.definition.lines.length} lyric lines.`);
    }
    this.markPinnedSyllablesCalibrated(output.lines, anchors);
    const lyrics: LyricsJson = { format: 'words', fps: 60, method: 'lyricsync', lines: output.lines };
    fs.mkdirSync(this.paths.out, { recursive: true });
    fs.writeFileSync(this.paths.lyricsOut, `${JSON.stringify(lyrics, null, 2)}\n`, 'utf8');
    fs.writeFileSync(this.paths.reviewOut, `${JSON.stringify({ lines: output.review }, null, 2)}\n`, 'utf8');
    const unpinned = output.review.filter((r) => r.uncertain.length > 0);
    const meanExpectedErrorMs = unpinned.length === 0 ? 0 : unpinned.reduce((s, r) => s + r.meanExpectedErrorMs, 0) / unpinned.length;
    // Update unconfirmed times in lyrics.calibrated.json while preserving human/agent flags
    const calDoc = this.loadCalibrated();
    updateCalibratedFromSolve(calDoc, output.lines);
    fs.writeFileSync(this.calibratedPath(), `${JSON.stringify(calDoc, null, 2)}\n`, 'utf8');

    return { lyrics, review: output.review, anchors: summarizeAnchors(anchors, this.definition), meanExpectedErrorMs };
  }

  /** Syllables whose both edges the user pinned are flagged calibrated, the convention of the lyrics editor (sylCalibrated / calibrated). */
  private markPinnedSyllablesCalibrated(lines: LyricsJson['lines'], anchors: Anchors): void {
    this.definition.lines.forEach((lyric) => {
      const anchor = anchors.lines[String(lyric.index)];
      if (!anchor) return;
      const pinned = new Set(pinsOf(anchor, syllableCount(lyric)).map(([j]) => j));
      const line = lines[lyric.index];
      if (!line) return;
      let flat = 0;
      lyric.words.forEach((w, wi) => {
        const calibrated = w.syllables.map((_, s) => pinned.has(flat + s) && pinned.has(flat + s + 1));
        flat += w.syllables.length;
        const word = line.words[wi];
        if (!word || !calibrated.some(Boolean)) return;
        word.sylCalibrated = calibrated;
        word.calibrated = true;
      });
    });
  }

  /** Lines worth a human look, most uncertain first. Reads the review written by the last solve. */
  reviewTop(top: number): LineReview[] {
    if (!fs.existsSync(this.paths.reviewOut)) throw new Error('No review yet. Run "lyricsync solve <workspace>" first.');
    const raw: unknown = JSON.parse(fs.readFileSync(this.paths.reviewOut, 'utf8'));
    if (!isRecord(raw) || !Array.isArray(raw.lines) || !raw.lines.every(isLineReview)) throw new Error(`Malformed review file: ${this.paths.reviewOut}`);
    return raw.lines.filter((l) => l.uncertain.length > 0).sort((a, b) => b.meanExpectedErrorMs - a.meanExpectedErrorMs).slice(0, top);
  }
}
