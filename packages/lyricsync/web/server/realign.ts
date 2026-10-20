// Auto-time (POST /api/realign): re-times the editor's lines with lyricsync while keeping everything the editor marked calibrated exactly
// where it is. Needs a prepared lyricsync workspace at <songs>/<id>/lyricsync; there is no fallback without one.
//
// Editor line -> pins:
//   - a line flagged `calibrated` is frozen: every syllable boundary is pinned;
//   - otherwise only the syllables flagged calibrated (`sylCalibrated` / word `calibrated`) are pinned;
//   - everything unpinned is re-solved around the pins.
// `snapToBeats` (default true) moves solved boundaries near a beat onto it; false keeps the acoustic times. The response also carries
// `alternate`: the same solve with the other setting, so the editor can switch the setting without solving again. out/ holds the
// requested one.
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyAnchors, importCalibrated, Session } from "../../src/index.ts";
import type { ConsensusLine } from "../../src/index.ts";
import { findSongDir, toRoots, type SongsRoots } from "./song-inputs.ts";
import { inferenceDevice } from "./device.ts";

export interface EditorWord {
  w?: string;
  start: number;
  end: number;
  syl?: Array<[number, number]>;
  calibrated?: boolean;
  sylCalibrated?: boolean[];
}

export interface EditorLine {
  start: number;
  end: number;
  calibrated?: boolean;
  words: EditorWord[];
}

export interface RealignBody {
  project?: string;
  lines?: EditorLine[];
  snapToBeats?: boolean;
}

/** A request the client can fix (or must prepare the workspace for); anything else is a server error. */
class RealignError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface SongSession {
  session: Session;
  /** Mtime of lyricsync.json when the session was opened; `prepare` rewrites it, which makes the cached evidence stale. */
  manifestStamp: number;
  /** Definition lines the editor does not show (sung but never annotated). */
  unannotatedLines: number[];
}

const sessions: Record<string, SongSession> = {};
let queue: Promise<unknown> = Promise.resolve();

function readUnannotatedLines(dir: string): number[] {
  const file = path.join(dir, "user_input", "lyrics.sync.json");
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof raw !== "object" || raw === null || !("unannotatedLines" in raw)) return [];
  const lines = raw.unannotatedLines;
  if (!Array.isArray(lines) || !lines.every((n): n is number => Number.isInteger(n))) throw new Error(`"unannotatedLines" in ${file} must be an array of line indices.`);
  return lines;
}

function songSession(roots: SongsRoots, id: string): SongSession {
  const dir = findSongDir(roots, id);
  if (!dir) {
    const list = toRoots(roots).join(", ");
    throw new RealignError(404, "SONG_NOT_FOUND", `Song "${id}" was not found in any known song directories (${list}).`);
  }
  const workspace = path.join(dir, "lyricsync");
  const manifest = path.join(workspace, "lyricsync.json");
  if (!fs.existsSync(manifest)) {
    throw new RealignError(409, "WORKSPACE_MISSING", `Song "${id}" has no lyricsync workspace (${workspace}). Build it with the New Song wizard, or run: lyricsync init + prepare.`);
  }
  const stamp = fs.statSync(manifest).mtimeMs;
  let song = sessions[dir];
  if (!song || song.manifestStamp !== stamp) {
    song = { session: Session.open(workspace), manifestStamp: stamp, unannotatedLines: readUnannotatedLines(dir) };
    sessions[dir] = song;
  }
  const state = song.session.status();
  if (!state.prepared || !state.evidenceFresh) {
    throw new RealignError(409, "WORKSPACE_NOT_READY", `The lyricsync workspace of "${id}" is not prepared for its current inputs. Run: lyricsync prepare "${workspace}"`);
  }
  return song;
}

/** Editor line index -> definition line index. */
function definitionIndices(editorLines: number, definitionLines: number, unannotated: number[]): number[] {
  const mapped: number[] = [];
  for (let i = 0; i < definitionLines; i++) if (!unannotated.includes(i)) mapped.push(i);
  if (mapped.length !== editorLines) {
    throw new RealignError(422, "LINES_MISMATCH", `The editor has ${editorLines} lines but the lyricsync lyrics have ${mapped.length} (${definitionLines} minus ${unannotated.length} unannotated). Edit user_input/lyrics.sync.json and prepare the workspace again.`);
  }
  return mapped;
}

async function realign(roots: SongsRoots, id: string, lines: EditorLine[], snapToBeats: boolean): Promise<{ lines: EditorLine[]; alternate: EditorLine[] }> {
  const { session, unannotatedLines } = songSession(roots, id);
  const def = session.definition;
  const indices = definitionIndices(lines.length, def.lines.length, unannotatedLines);

  const anchors = emptyAnchors();
  const frozen = indices.filter((_, k) => lines[k]!.calibrated === true);
  const partial = indices.filter((_, k) => lines[k]!.calibrated !== true);
  // importCalibrated pairs the editor's lines with the definition lines in order, apart from the unannotated ones.
  try {
    if (frozen.length > 0) importCalibrated(anchors, def, { lines }, { level: "syllable", lines: frozen, skipDefinitionLines: unannotatedLines });
    if (partial.length > 0) importCalibrated(anchors, def, { lines }, { level: "flagged", lines: partial, skipDefinitionLines: unannotatedLines });
  } catch (err: unknown) {
    throw new RealignError(422, "LINES_MISMATCH", `The editor's lines do not match the lyricsync lyrics: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The other setting first, so out/lyrics.json and out/review.json end up as the requested one. The second solve reuses the cached
  // anchored-line alignments, so it costs only the decode.
  const alternate = (await session.solve({ anchors, snapToBeats: !snapToBeats, device: inferenceDevice() })).lyrics.lines;
  const solved = (await session.solve({ anchors, snapToBeats, device: inferenceDevice() })).lyrics.lines;
  return {
    lines: lines.map((line, k) => merge(line, solved[indices[k]!]!)),
    alternate: lines.map((line, k) => merge(line, alternate[indices[k]!]!)),
  };
}

/**
 * The editor line with the solved timings. What the editor marked calibrated stays exactly as the editor has it: a calibrated line and
 * calibrated words are returned untouched, calibrated syllables keep their times. Every other editor field is kept.
 */
function merge(line: EditorLine, solved: ConsensusLine): EditorLine {
  if (line.calibrated === true) return line;
  const words = line.words.map((word, wi) => {
    if (word.calibrated === true) return word;
    const solvedWord = solved.words[wi]!;
    if (!solvedWord.syl) throw new Error(`lyricsync returned no syllable timings for "${solvedWord.w}" in "${solved.text}".`);
    const syl = solvedWord.syl.map((s, si) => (word.sylCalibrated?.[si] === true && word.syl?.[si] ? word.syl[si]! : s));
    return { ...word, start: solvedWord.start, end: solvedWord.end, syl };
  });
  return { ...line, start: solved.start, end: solved.end, words };
}

/** The route: HTTP status and JSON body. */
export async function handleRealign(roots: SongsRoots, body: RealignBody): Promise<{ status: number; body: unknown }> {
  const error = (status: number, code: string, message: string) => ({ status, body: { ok: false, error: code, message } });
  const id = body.project;
  if (!id) return error(400, "BAD_REQUEST", "Missing project");
  if (!Array.isArray(body.lines) || body.lines.length === 0) return error(400, "BAD_REQUEST", "Missing or empty lines array");
  if (body.snapToBeats !== undefined && typeof body.snapToBeats !== "boolean") return error(400, "BAD_REQUEST", "snapToBeats must be a boolean");
  const lines = body.lines;
  const snapToBeats = body.snapToBeats ?? true;

  const run = queue.then(() => realign(roots, id, lines, snapToBeats));
  queue = run.catch(() => undefined);
  try {
    const { lines: refined, alternate } = await run;
    const calibratedLines = refined.filter((l) => l.calibrated === true).length;
    const totalLines = refined.length;
    const pct = Math.round((calibratedLines / totalLines) * 1000) / 10;
    return { status: 200, body: { ok: true, project: id, snapToBeats, lines: refined, alternate, coverage: { calibratedLines, totalLines, pct } } };
  } catch (err: unknown) {
    if (err instanceof RealignError) return error(err.status, err.code, err.message);
    throw err;
  }
}
