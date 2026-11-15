// packages/lyricsync/web/server/syllables.ts
// Syllable splits of a song project (local dev server). The editor's lines are the project's lyrics lines minus the
// "unannotatedLines" of user_input/lyrics.sync.json; the workspace (<songs>/<id>/lyricsync) holds the analysed split.
//   analysedSplits   the workspace's syllables per editor line and word, and whether its evidence is up to date
//   reanalyze        writes the editor's splits to lyrics.sync.json and the workspace (Session.setSyllables), then runs
//                    `prepare` as a background job: the evidence depends on the syllables
import * as fs from "node:fs";
import * as path from "node:path";
import {
  emptyAnchors,
  lyricsSectionOutline,
  parseLyricsText,
  Session,
  syllableCount,
  setBoundary,
  validateAnchors,
  type Pronunciations,
  type SyllableChange,
} from "../../src/index.ts";
import { isRecord, isStringArray } from "../../src/guards.ts";
import { findSongDir, songInputs, type SongsRoots } from "../../src/song-folder.ts";
import { backupSongFiles } from "../../src/song-backups.ts";
import { calibrationFromSolve, checkLyrics, syncLines } from "./wizard.ts";
import { inferenceDevice } from "./device.ts";

export interface ReanalyzeJob {
  project: string;
  state: "running" | "done" | "error";
  log: string[];
  error?: string;
}

/** Editor words as the client sends them. */
export interface EditorSplitLine {
  words: Array<{ w: string; sylText: string[] }>;
}

let job: ReanalyzeJob | null = null;

export function currentReanalyzeJob(): ReanalyzeJob | null {
  return job;
}

/**
 * The longest in-order matching of `a` to `b` (longest common subsequence under `same`): for each item of `a`, the index of
 * its partner in `b`, or null. Partners keep their order, so the k-th copy of a repeated line pairs with the k-th copy.
 */
export function matchInOrder<A, B>(a: readonly A[], b: readonly B[], same: (x: A, y: B) => boolean): Array<number | null> {
  const n = a.length;
  const m = b.length;
  // len[i][j]: LCS length of a[i..] and b[j..]
  const len = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i]![j] = same(a[i]!, b[j]!) ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
    }
  }
  const out: Array<number | null> = new Array(n).fill(null);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i]!, b[j]!) && len[i]![j] === len[i + 1]![j + 1]! + 1) out[i++] = j++;
    else if (len[i + 1]![j]! >= len[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/**
 * The lines an edit changed in place: `matched` is matchInOrder's answer for the new lines (null = changed). A run of changed new
 * lines between two matched ones pairs in order with the old lines between their partners, when both runs have the same length
 * (lines edited, none added or removed there). For each new line, its old line's index, or null (matched lines stay null).
 */
export function pairEditedLines(matched: ReadonlyArray<number | null>, oldCount: number): Array<number | null> {
  const out: Array<number | null> = new Array(matched.length).fill(null);
  for (let i = 0; i < matched.length; ) {
    if (matched[i] !== null) {
      i++;
      continue;
    }
    let end = i;
    while (end < matched.length && matched[end] === null) end++;
    const oldFrom = i === 0 ? 0 : matched[i - 1]! + 1;
    const oldTo = end === matched.length ? oldCount : matched[end]!;
    if (oldTo - oldFrom === end - i) for (let k = i; k < end; k++) out[k] = oldFrom + (k - i);
    i = end;
  }
  return out;
}

/**
 * The words of an edited line that keep the old line's pins: the common prefix and suffix of the two word lists (`newKeys`,
 * `oldKeys`: word text and syllable count). When they overlap (a repeated word was added or removed) the old words are split
 * between them, so both line edges stay: "ah-ah ah-ah" -> "ah-ah ah-ah ah-ah" pairs the first and the last word and leaves the
 * middle one new. For each new word, its old word's index or null; `prefix`/`suffix` are the paired counts at each end.
 */
export function carriedWords(newKeys: readonly string[], oldKeys: readonly string[]): { words: Array<number | null>; prefix: number; suffix: number } {
  const n = Math.min(newKeys.length, oldKeys.length);
  let p = 0;
  while (p < n && newKeys[p] === oldKeys[p]) p++;
  let s = 0;
  while (s < n && newKeys[newKeys.length - 1 - s] === oldKeys[oldKeys.length - 1 - s]) s++;
  if (p + s > n) {
    s = Math.min(s, Math.floor(n / 2));
    p = Math.min(p, n - s);
    s = Math.min(s, n - p);
  }
  const words: Array<number | null> = new Array(newKeys.length).fill(null);
  for (let k = 0; k < p; k++) words[k] = k;
  for (let k = 1; k <= s; k++) words[newKeys.length - k] = oldKeys.length - k;
  return { words, prefix: p, suffix: s };
}

export function parseSplitLines(raw: unknown): EditorSplitLine[] {
  if (!Array.isArray(raw)) throw new Error("lines must be an array.");
  return raw.map((l: unknown, i: number) => {
    if (!isRecord(l) || !Array.isArray(l.words)) throw new Error(`Line ${i} needs a words array.`);
    return {
      words: l.words.map((w: unknown, wi: number) => {
        if (!isRecord(w) || typeof w.w !== "string" || !isStringArray(w.sylText)) throw new Error(`Line ${i} word ${wi} needs w and sylText.`);
        return { w: w.w, sylText: w.sylText };
      }),
    };
  });
}

interface ProjectLyrics {
  syncFile: string;
  sync: Record<string, unknown> & { lines: unknown[] };
  /** Editor line index -> lyrics line index. */
  indices: number[];
  session: Session;
}

function openProject(roots: SongsRoots, id: string): ProjectLyrics {
  const dir = findSongDir(roots, id);
  if (!dir) throw new Error(`Song "${id}" not found.`);
  const syncFile = path.join(dir, "user_input", "lyrics.sync.json");
  if (!fs.existsSync(syncFile)) throw new Error(`Song ${id} has no user_input/lyrics.sync.json.`);
  const sync: unknown = JSON.parse(fs.readFileSync(syncFile, "utf8"));
  if (!isRecord(sync) || !Array.isArray(sync.lines)) throw new Error(`${syncFile} needs a "lines" array.`);
  const skip = sync.unannotatedLines ?? [];
  if (!Array.isArray(skip) || !skip.every((n): n is number => Number.isInteger(n))) throw new Error(`"unannotatedLines" in ${syncFile} must be line indices.`);
  const workspace = path.join(dir, "lyricsync");
  if (!fs.existsSync(path.join(workspace, "lyricsync.json"))) throw new Error(`Song ${id} has no lyricsync workspace (${workspace}).`);
  const session = Session.open(workspace);
  if (session.definition.lines.length !== sync.lines.length) {
    throw new Error(`${syncFile} has ${sync.lines.length} lines but the workspace lyrics have ${session.definition.lines.length}.`);
  }
  const indices = session.definition.lines.map((l) => l.index).filter((i) => !skip.includes(i));
  return { syncFile, sync: { ...sync, lines: sync.lines }, indices, session };
}

/** The analysed syllables per editor line and word, and whether the evidence matches the current workspace inputs. */
export function analysedSplits(roots: SongsRoots, id: string): { lines: string[][][]; fresh: boolean } {
  try {
    const { indices, session } = openProject(roots, id);
    return {
      lines: indices.map((i) => session.definition.lines[i]!.words.map((w) => w.syllables)),
      fresh: session.status().evidenceFresh,
    };
  } catch {
    return { lines: [], fresh: false };
  }
}

/** Validates and writes the editor's splits, then starts `prepare` in the background. Throws before writing anything when a split is invalid. */
export function reanalyze(roots: SongsRoots, id: string, lines: EditorSplitLine[], busy: string | null): ReanalyzeJob {
  if (job?.state === "running") throw new Error(`Re-analysis of ${job.project} is already running.`);
  if (busy) throw new Error(busy);
  const project = openProject(roots, id);
  const { indices, session, sync } = project;
  if (lines.length !== indices.length) throw new Error(`The editor has ${lines.length} lines but the project lyrics have ${indices.length}.`);

  const changes: SyllableChange[] = [];
  lines.forEach((l, k) => {
    const def = session.definition.lines[indices[k]!]!;
    if (l.words.length !== def.words.length) throw new Error(`Editor line ${k} has ${l.words.length} words but the lyrics line "${def.text}" has ${def.words.length}.`);
    l.words.forEach((w, wi) => {
      const dw = def.words[wi]!;
      if (w.w !== dw.w) throw new Error(`Editor line ${k} word ${wi} is "${w.w}" but the lyrics have "${dw.w}".`);
      if (w.sylText.join("|") !== dw.syllables.join("|")) changes.push({ line: def.index, word: wi, syllables: w.sylText });
    });
  });

  if (changes.length > 0) {
    const syncWords = changes.map((c) => {
      const line = sync.lines[c.line];
      const word = isRecord(line) && Array.isArray(line.words) ? line.words[c.word] : undefined;
      if (!isRecord(word)) throw new Error(`${project.syncFile} line ${c.line} word ${c.word} is not a {"w", "syllables"} object.`);
      return word;
    });
    session.setSyllables(changes);
    changes.forEach((c, k) => {
      syncWords[k]!.syllables = session.definition.lines[c.line]!.words[c.word]!.syllables;
      // A re-split word has other syllables than the "+" joins were written for.
      delete syncWords[k]!.sylJoin;
    });
    backupSongFiles(findSongDir(roots, id)!, ["user_input/lyrics.sync.json"], "reanalyze");
    fs.writeFileSync(project.syncFile, `${JSON.stringify(sync, null, 2)}\n`, "utf8");
  }

  const current: ReanalyzeJob = { project: id, state: "running", log: [] };
  job = current;
  const say = (m: string) => current.log.push(m);
  say(changes.length > 0 ? `Re-split ${changes.length} word${changes.length === 1 ? "" : "s"}: ${changes.map((c) => c.syllables.join("|")).join(", ")}.` : "Splits unchanged.");
  say("Checking audio evidence and boundary model…");
  const t0 = Date.now();
  session.prepare({ onProgress: (m) => say(`  ${m}`), device: inferenceDevice() }).then(
    (r) => {
      current.state = "done";
      say(
        r.skipped
          ? "Evidence is up to date."
          : r.incremental
            ? `Evidence updated in ${Date.now() - t0} ms (incremental: acoustic models skipped).`
            : `Evidence ready in ${((Date.now() - t0) / 1000).toFixed(0)} s.`
      );
    },
    (e: unknown) => {
      current.state = "error";
      current.error = e instanceof Error ? e.message : String(e);
    }
  );
  return current;
}

export interface UpdateLyricsInput {
  text: string;
  pronunciations?: Pronunciations;
  /**
   * The timing whose pins the new lyrics keep, when it is not the saved file: a backup the editor switched to (File > Backups…)
   * whose lyrics are being restored. Same shape as lyrics.calibrated.json.
   */
  calibration?: unknown;
}

export function updateLyrics(
  roots: SongsRoots,
  id: string,
  input: UpdateLyricsInput,
  busy: string | null
): ReanalyzeJob {
  if (job?.state === "running") throw new Error(`A job is already running for ${job.project}.`);
  if (busy) throw new Error(busy);

  const dir = findSongDir(roots, id);
  if (!dir) throw new Error(`Song "${id}" not found.`);
  const inputs = songInputs(roots, id);

  const check = checkLyrics(input.text, inputs.language, input.pronunciations ?? {});
  if (!check.ok) {
    throw new Error(check.error ?? `Lyrics have ${check.issues.length} issue(s).`);
  }
  const parsed = parseLyricsText(input.text, inputs.language, input.pronunciations ?? {});
  const def = parsed.definition;
  if (def.lines.length === 0) throw new Error("Lyrics cannot be empty.");

  const calFile = path.join(dir, "user_input", "lyrics.calibrated.json");
  interface RawCalWord {
    w?: string;
    sylText?: string[];
    syl?: Array<[number, number]>;
    sylCalibrated?: boolean[];
    calibrated?: boolean;
  }
  interface RawCalLine {
    text?: string;
    calibrated?: boolean;
    start?: number;
    end?: number;
    words?: RawCalWord[];
  }
  interface RawCalDoc {
    lines?: RawCalLine[];
  }
  let oldCal: RawCalDoc | null = null;
  if (input.calibration !== undefined) {
    if (!isRecord(input.calibration) || !Array.isArray(input.calibration.lines)) throw new Error("calibration must be a timing document with lines.");
    oldCal = input.calibration as RawCalDoc;
  } else if (fs.existsSync(calFile)) {
    try {
      oldCal = JSON.parse(fs.readFileSync(calFile, "utf8")) as RawCalDoc;
    } catch {}
  }

  // Derive preserved anchors from oldCal. Each new line takes the pins of the old line it matches (same text, words and syllable
  // counts), matched in order so a repeated line (a chorus) keeps its own pins, not the first copy's. A line the edit changed in
  // place keeps the pins of its unchanged words (carriedWords).
  const anchors = emptyAnchors();
  const oldLines = oldCal && Array.isArray(oldCal.lines) ? oldCal.lines : [];
  const oldSyllables = (ow: RawCalWord) => (Array.isArray(ow.sylText) ? ow.sylText.length : Array.isArray(ow.syl) ? ow.syl.length : 0);
  const sameLine = (newLine: (typeof def.lines)[number], ol: RawCalLine) =>
    ol.text === newLine.text &&
    Array.isArray(ol.words) &&
    ol.words.length === newLine.words.length &&
    newLine.words.every((nw, wi) => nw.syllables.length === oldSyllables(ol.words![wi]!));
  const matched = matchInOrder(def.lines, oldLines, sameLine);
  const edited = pairEditedLines(matched, oldLines.length);
  /** Per new line: the old line, whether it is the same line, and per word the old word's pin flags it keeps (null: none). */
  const carry = def.lines.map((newLine, li) => {
    const whole = matched[li] !== null;
    const oi = matched[li] ?? edited[li] ?? null;
    const ol = oi === null ? undefined : oldLines[oi];
    if (!ol || !Array.isArray(ol.words)) return null;
    const words = ol.words;
    const flagsOf = (ow: RawCalWord) => {
      const n = oldSyllables(ow);
      return Array.from({ length: n }, (_, s) => ol.calibrated === true || (ow.sylCalibrated?.length === n ? ow.sylCalibrated[s] === true : ow.calibrated === true));
    };
    const keys = (ws: Array<{ w?: string }>, count: (k: number) => number) => ws.map((w, k) => `${w.w ?? ""}\u0000${count(k)}`);
    const pairs = whole
      ? { words: words.map((_, k) => k as number | null), prefix: words.length, suffix: 0 }
      : carriedWords(keys(newLine.words, (k) => newLine.words[k]!.syllables.length), keys(words, (k) => oldSyllables(words[k]!)));
    const flags = pairs.words.map((owi) => (owi === null ? null : flagsOf(words[owi]!)));
    if (!whole) {
      // The syllables facing the edit lose their pin: their edge there must move to make room for (or close) the change.
      const facingEnd = pairs.prefix > 0 ? flags[pairs.prefix - 1] : null;
      if (facingEnd) facingEnd[facingEnd.length - 1] = false;
      const facingStart = pairs.suffix > 0 ? flags[newLine.words.length - pairs.suffix] : null;
      if (facingStart) facingStart[0] = false;
    }
    return { ol, whole, words: pairs.words.map((owi) => (owi === null ? null : words[owi]!)), flags };
  });
  // The pins are the ones Auto-time takes from the same flags (realign.ts / importCalibrated): both edges of each flagged
  // syllable (all of them on a calibrated line). Pinning less would let this solve move a flagged syllable's edge, and the
  // carried flag would then pin wherever it landed.
  for (const [li, newLine] of def.lines.entries()) {
    const c = carry[li];
    if (!c) continue;
    let flat = 0;
    for (const [wi, nw] of newLine.words.entries()) {
      const ow = c.words[wi];
      const n = nw.syllables.length;
      for (let s = 0; s < n; s++) {
        const syl = ow?.syl?.[s];
        if (!c.flags[wi]?.[s] || !syl) continue;
        setBoundary(anchors, def, li, flat + s, syl[0]);
        setBoundary(anchors, def, li, flat + s + 1, syl[1]);
      }
      flat += n;
    }
  }
  validateAnchors(anchors, def);

  // The edit rewrites the lyrics and, after the solve, the lead's calibration: keep them as they are now.
  backupSongFiles(dir, ["user_input/lyrics.txt", "user_input/lyrics.sync.json", "user_input/lyrics.calibrated.json"], "edit-lyrics");

  // Write user_input/lyrics.txt
  fs.writeFileSync(path.join(dir, "user_input", "lyrics.txt"), input.text.endsWith("\n") ? input.text : `${input.text}\n`, "utf8");

  // Write user_input/lyrics.sync.json
  const syncFile = path.join(dir, "user_input", "lyrics.sync.json");
  const syncData = { language: def.language, lines: syncLines(parsed) };
  fs.writeFileSync(syncFile, `${JSON.stringify(syncData, null, 2)}\n`, "utf8");

  // Update workspace session
  const session = Session.open(inputs.workspaceDir);
  session.setLyrics(def, anchors);

  const current: ReanalyzeJob = { project: id, state: "running", log: [] };
  job = current;
  const say = (m: string) => current.log.push(m);
  say(`Saved updated lyrics: ${def.lines.length} lines, ${def.lines.reduce((n, l) => n + syllableCount(l), 0)} syllables.`);
  say("Updating audio evidence (alignments, boundary queries)…");
  const t0 = Date.now();

  session.prepare({ onProgress: (m) => say(`  ${m}`), device: inferenceDevice() }).then(
    async () => {
      say("Solving timing around preserved pins…");
      const result = await session.solve({ anchors, device: inferenceDevice() });
      fs.mkdirSync(path.join(dir, "generated"), { recursive: true });
      fs.copyFileSync(session.paths.lyricsOut, path.join(dir, "generated", "lyrics.json"));
      const beats: unknown = JSON.parse(fs.readFileSync(inputs.beatsFile, "utf8"));
      const songEnd =
        typeof beats === "object" && beats !== null && "duration" in beats && typeof beats.duration === "number"
          ? beats.duration
          : result.lyrics.lines.at(-1)!.end;
      const outline = lyricsSectionOutline(input.text);
      const newCal = calibrationFromSolve(session.definition, result.lyrics.lines, outline, songEnd, parsed.sylJoin) as Record<string, unknown> & {
        lines: Array<{
          i: number;
          text: string;
          start: number;
          end: number;
          calibrated?: boolean;
          words: Array<{
            w: string;
            start: number;
            end: number;
            syl: Array<[number, number]>;
            sylText: string[];
            sylCalibrated?: boolean[];
            calibrated?: boolean;
          }>;
        }>;
      };
      // Carry the pin flags: a same line keeps its own; an edited line keeps those of its unchanged words (as pinned above).
      for (const [li, nl] of newCal.lines.entries()) {
        const c = carry[li];
        if (!c) continue;
        for (let wi = 0; wi < nl.words.length; wi++) {
          const nw = nl.words[wi]!;
          const ow = c.words[wi];
          if (!ow || nw.w !== ow.w || nw.sylText?.length !== ow.sylText?.length) continue;
          if (c.whole) {
            if (Array.isArray(ow.sylCalibrated)) nw.sylCalibrated = [...ow.sylCalibrated];
            if (ow.calibrated) nw.calibrated = true;
          } else if (c.flags[wi]?.some(Boolean)) {
            nw.sylCalibrated = [...c.flags[wi]!];
            if (c.flags[wi]!.every(Boolean)) nw.calibrated = true;
          }
        }
        if (c.whole && c.ol.calibrated) nl.calibrated = true;
      }

      fs.writeFileSync(calFile, `${JSON.stringify(newCal, null, 2)}\n`, "utf8");
      say(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s (${result.lyrics.lines.length} lines timed).`);
      current.state = "done";
    },
    (e: unknown) => {
      current.state = "error";
      current.error = e instanceof Error ? e.message : String(e);
      say(`Failed: ${current.error}`);
    }
  );

  return current;
}
