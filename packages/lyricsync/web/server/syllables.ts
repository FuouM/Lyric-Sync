// packages/lyricsync/web/server/syllables.ts
// Syllable splits of a song project (local dev server). The editor's lines are the project's lyrics lines minus the
// "unannotatedLines" of user_input/lyrics.sync.json; the workspace (<songs>/<id>/lyricsync) holds the analysed split.
//   analysedSplits   the workspace's syllables per editor line and word, and whether its evidence is up to date
//   reanalyze        writes the editor's splits to lyrics.sync.json and the workspace (Session.setSyllables), then runs
//                    `prepare` as a background job: the evidence depends on the syllables
import * as fs from "node:fs";
import * as path from "node:path";
import { Session, type SyllableChange } from "../../src/index.ts";
import { isRecord, isStringArray } from "../../src/guards.ts";
import { findSongDir, type SongsRoots } from "./song-inputs.ts";

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
