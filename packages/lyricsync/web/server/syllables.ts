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
  type LineAnchor,
  type Pronunciations,
  type SyllableChange,
} from "../../src/index.ts";
import { isRecord, isStringArray } from "../../src/guards.ts";
import { findSongDir, songInputs, type SongsRoots } from "./song-inputs.ts";
import { calibrationFromSolve, checkLyrics } from "./wizard.ts";

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
    });
    fs.writeFileSync(project.syncFile, `${JSON.stringify(sync, null, 2)}\n`, "utf8");
  }

  const current: ReanalyzeJob = { project: id, state: "running", log: [] };
  job = current;
  const say = (m: string) => current.log.push(m);
  say(changes.length > 0 ? `Re-split ${changes.length} word${changes.length === 1 ? "" : "s"}: ${changes.map((c) => c.syllables.join("|")).join(", ")}.` : "Splits unchanged.");
  say("Checking audio evidence and boundary model…");
  const t0 = Date.now();
  session.prepare({ onProgress: (m) => say(`  ${m}`) }).then(
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
  if (fs.existsSync(calFile)) {
    try {
      oldCal = JSON.parse(fs.readFileSync(calFile, "utf8")) as RawCalDoc;
    } catch {}
  }

  // Write user_input/lyrics.txt
  fs.writeFileSync(path.join(dir, "user_input", "lyrics.txt"), input.text.endsWith("\n") ? input.text : `${input.text}\n`, "utf8");

  // Write user_input/lyrics.sync.json
  const syncFile = path.join(dir, "user_input", "lyrics.sync.json");
  const syncData = {
    language: def.language,
    lines: def.lines.map((l) => ({
      ...(l.section ? { section: l.section } : {}),
      text: l.text,
      words: l.words.map((w) => ({ w: w.w, syllables: w.syllables, ...(w.phones ? { phones: w.phones } : {}) })),
    })),
  };
  fs.writeFileSync(syncFile, `${JSON.stringify(syncData, null, 2)}\n`, "utf8");

  // Derive preserved anchors from oldCal
  const anchors = emptyAnchors();
  if (oldCal && Array.isArray(oldCal.lines)) {
    for (let li = 0; li < def.lines.length; li++) {
      const newLine = def.lines[li]!;
      const oldLine = oldCal.lines.find(
        (ol) => ol.text === newLine.text && Array.isArray(ol.words) && ol.words.length === newLine.words.length
      );
      if (oldLine) {
        let sylsMatch = true;
        for (let wi = 0; wi < newLine.words.length; wi++) {
          const nw = newLine.words[wi]!;
          const ow = oldLine.words![wi]!;
          const owSylLen = Array.isArray(ow.sylText) ? ow.sylText.length : Array.isArray(ow.syl) ? ow.syl.length : 0;
          if (nw.syllables.length !== owSylLen) {
            sylsMatch = false;
            break;
          }
        }
        if (sylsMatch) {
          const m = syllableCount(newLine);
          const lineAnchor: LineAnchor = {};
          if (oldLine.calibrated === true) {
            if (typeof oldLine.start === "number") lineAnchor.start = oldLine.start;
            if (typeof oldLine.end === "number") lineAnchor.end = oldLine.end;
          }
          let boundaryIdx = 0;
          const boundaries: Record<string, number> = {};
          for (let wi = 0; wi < newLine.words.length; wi++) {
            const ow = oldLine.words![wi]!;
            const sylCount = newLine.words[wi]!.syllables.length;
            for (let si = 0; si < sylCount; si++) {
              if (boundaryIdx > 0 && boundaryIdx < m) {
                if (ow.sylCalibrated?.[si] === true && Array.isArray(ow.syl?.[si]) && typeof ow.syl[si]![0] === "number") {
                  boundaries[String(boundaryIdx)] = ow.syl[si]![0];
                }
              }
              boundaryIdx++;
            }
          }
          if (Object.keys(boundaries).length > 0) lineAnchor.boundaries = boundaries;
          if (lineAnchor.start !== undefined || lineAnchor.end !== undefined || lineAnchor.boundaries !== undefined) {
            anchors.lines[String(li)] = lineAnchor;
          }
        }
      }
    }
  }

  // Update workspace session
  const session = Session.open(inputs.workspaceDir);
  session.setLyrics(def, anchors);

  const current: ReanalyzeJob = { project: id, state: "running", log: [] };
  job = current;
  const say = (m: string) => current.log.push(m);
  say(`Saved updated lyrics: ${def.lines.length} lines, ${def.lines.reduce((n, l) => n + syllableCount(l), 0)} syllables.`);
  say("Updating audio evidence (alignments, boundary queries)…");
  const t0 = Date.now();

  session.prepare({ onProgress: (m) => say(`  ${m}`) }).then(
    async () => {
      say("Solving timing around preserved pins…");
      const result = await session.solve({ anchors });
      fs.mkdirSync(path.join(dir, "generated"), { recursive: true });
      fs.copyFileSync(session.paths.lyricsOut, path.join(dir, "generated", "lyrics.json"));
      const beats: unknown = JSON.parse(fs.readFileSync(inputs.beatsFile, "utf8"));
      const songEnd =
        typeof beats === "object" && beats !== null && "duration" in beats && typeof beats.duration === "number"
          ? beats.duration
          : result.lyrics.lines.at(-1)!.end;
      const outline = lyricsSectionOutline(input.text);
      const newCal = calibrationFromSolve(session.definition, result.lyrics.lines, outline, songEnd) as Record<string, unknown> & {
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
      // Carry forward sylCalibrated flags from oldCal
      if (oldCal && Array.isArray(oldCal.lines)) {
        for (const nl of newCal.lines) {
          const ol = oldCal.lines.find((o) => o.text === nl.text && o.words?.length === nl.words?.length);
          if (ol) {
            for (let wi = 0; wi < nl.words.length; wi++) {
              const nw = nl.words[wi]!;
              const ow = ol.words![wi]!;
              if (ow && nw.w === ow.w && nw.sylText?.length === ow.sylText?.length) {
                if (Array.isArray(ow.sylCalibrated)) nw.sylCalibrated = [...ow.sylCalibrated];
                if (ow.calibrated) nw.calibrated = true;
              }
            }
            if (ol.calibrated) nl.calibrated = true;
          }
        }
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
