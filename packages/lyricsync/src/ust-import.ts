// src/ust-import.ts
// user_input/ust.map.json (written by hand) and the UST import: the placed UST notes of each lane, mapped to the syllables of its
// singer's lyrics file, become calibration files (one per singer).
//   { "v": 1, "lanes": { "<lane id>": [ { "line": <lyric line>, "notes": [[ustKana, target, ...], ...] }, ... ] }, "sections": [{ "name", "bar" }] }
// target: the next syllable of the line, "~" = the note continues the syllable before, "_" = the note is not a syllable.
// A row with several targets (D29: one note sings several morae, e.g. a closure or a long vowel) names consecutive syllables of the line;
// "~" and "_" are valid only as the single target. The import splits that note's span evenly across them and leaves them unpinned.
// No Node or Bun imports: the editor's browser code uses this module too.
import type { CalibrationDoc, CalLine, CalSection, CalWord } from "./calibration-doc.ts";
import type { Ust } from "./formats/ust.ts";
import { isNumber, isRecord, isStringArray } from "./guards.ts";
import type { ParsedLyrics } from "./lyrics/parse.ts";
import type { PlacedNote } from "./placed-notes.ts";
import type { Placements } from "./placements.ts";
import { calibratedFileFor, singerOfVoiceDir, type Singers } from "./singers.ts";

export interface UstMapEntry {
  /** 0-based index among the lyric lines of the singer's lyrics file (headers and blank lines do not count). */
  line: number;
  /** One row per sung UST note of the lane, in order: [ustKana, target]. */
  notes: string[][];
}

export interface UstMapSection {
  name: string;
  /** 1-based bar on the song grid. */
  bar: number;
}

export interface UstMap {
  v: 1;
  lanes: Record<string, UstMapEntry[]>;
  sections?: UstMapSection[];
}

/** One failure of the map check. `line` is the lyric line, `note` the UST note number ([#NNNN]); null when the failure has none. */
export interface UstMapIssue {
  lane: string | null;
  line: number | null;
  note: number | null;
  message: string;
}

export interface UstImportInput {
  map: UstMap;
  placements: Placements;
  /** lane.ust -> parsed UST, for every lane of the map. */
  usts: ReadonlyMap<string, Ust>;
  singers: Singers;
  /** Singer id -> parsed lyrics file, for every singer of a mapped lane. */
  lyrics: ReadonlyMap<string, ParsedLyrics>;
}

const MAP = "user_input/ust.map.json";
const CONTINUE = "~";
const FILLER = "_";

/** Validates the shape of user_input/ust.map.json content and returns it typed. The mapping itself is checked by checkUstMap. */
export function parseUstMap(raw: unknown): UstMap {
  if (!isRecord(raw)) throw new Error(`${MAP}: expected an object.`);
  if (raw.v !== 1) throw new Error(`${MAP}: "v" must be 1.`);
  if (!isRecord(raw.lanes)) throw new Error(`${MAP}: "lanes" must be an object (lane id -> entries).`);
  for (const [lane, entries] of Object.entries(raw.lanes)) {
    if (!Array.isArray(entries)) throw new Error(`${MAP}: lanes["${lane}"] must be an array.`);
    entries.forEach((e: unknown, k: number) => {
      const at = `${MAP}: lanes["${lane}"][${k}]`;
      if (!isRecord(e)) throw new Error(`${at} must be an object.`);
      if (!isNumber(e.line) || !Number.isInteger(e.line) || e.line < 0) throw new Error(`${at}.line must be a line index (integer >= 0).`);
      if (!Array.isArray(e.notes)) throw new Error(`${at}.notes must be an array.`);
      e.notes.forEach((r: unknown, j: number) => {
        if (!isStringArray(r) || r.length < 2) throw new Error(`${at}.notes[${j}] must be [ustKana, target].`);
      });
    });
  }
  if (raw.sections !== undefined) {
    if (!Array.isArray(raw.sections)) throw new Error(`${MAP}: "sections" must be an array.`);
    let prev = 0;
    raw.sections.forEach((s: unknown, k: number) => {
      const at = `${MAP}: sections[${k}]`;
      if (!isRecord(s) || typeof s.name !== "string" || s.name === "") throw new Error(`${at} needs a non-empty "name".`);
      if (!isNumber(s.bar) || !Number.isInteger(s.bar) || s.bar < 1) throw new Error(`${at}.bar must be a 1-based bar number.`);
      if (s.bar <= prev) throw new Error(`${at}.bar ${s.bar} must be after the bar of the section before (${prev}).`);
      prev = s.bar;
    });
  }
  // Every field was checked above.
  return raw as unknown as UstMap;
}

/**
 * One mapped note: the syllable (flat index in its line) that a sung note of a lane times. `part` of `parts`: the piece of the note
 * the syllable gets (parts > 1 for a row with several targets).
 */
interface MappedNote {
  lane: string;
  idx: number;
  line: number;
  syl: number;
  part: number;
  parts: number;
}

/** Walks the map. Returns every failure and, per singer id, the mapped notes. */
function walk(input: UstImportInput): { issues: UstMapIssue[]; mapped: Map<string, MappedNote[]> } {
  const { map, placements, usts, singers, lyrics } = input;
  const issues: UstMapIssue[] = [];
  const mapped = new Map<string, MappedNote[]>();
  const lineLanes = new Map<string, Map<number, string[]>>();
  const issue = (lane: string | null, line: number | null, note: number | null, message: string) => issues.push({ lane, line, note, message });

  for (const [laneId, entries] of Object.entries(map.lanes)) {
    const lane = placements.lanes.find((l) => l.id === laneId);
    if (!lane) {
      issue(laneId, null, null, "the lane is not in user_input/placements.json.");
      continue;
    }
    if (lane.block === "") issue(laneId, null, null, "the lane has no block: only lanes with a block can carry lyrics.");
    const ust = usts.get(lane.ust);
    if (!ust) {
      issue(laneId, null, null, `UST "${lane.ust}" was not read.`);
      continue;
    }
    const singer = singerOfVoiceDir(singers, ust.voiceDir);
    if (!singer) {
      issue(laneId, null, null, `the VoiceDir "${ust.voiceDir}" of ${lane.ust} is not in user_input/singers.json: the lane cannot carry lyrics.`);
      continue;
    }
    const parsed = lyrics.get(singer.id);
    if (!parsed) {
      issue(laneId, null, null, `singer "${singer.id}" has no lyrics.`);
      continue;
    }
    // The syllables of each lyric line, flat over the words.
    const lines = parsed.definition.lines.map((l) => l.words.flatMap((w) => w.syllables));
    const notes = mapped.get(singer.id) ?? [];
    mapped.set(singer.id, notes);
    const users = lineLanes.get(singer.id) ?? new Map<number, string[]>();
    lineLanes.set(singer.id, users);
    const sung = ust.notes.filter((n) => !n.rest);
    let k = 0;
    for (const entry of entries) {
      const syl = lines[entry.line];
      if (!syl) {
        issue(laneId, entry.line, null, `line ${entry.line} does not exist: the lyrics of singer "${singer.id}" have ${lines.length} lines.`);
        k += entry.notes.length;
        continue;
      }
      users.set(entry.line, [...(users.get(entry.line) ?? []), laneId]);
      let j = 0;
      entry.notes.forEach((row, r) => {
        const note = sung[k++];
        if (!note) {
          issue(laneId, entry.line, null, `row ${r} ["${row.join('", "')}"]: the UST has no sung note left (it has ${sung.length}).`);
          return;
        }
        const targets = row.slice(1);
        if (row[0] !== note.lyric) issue(laneId, entry.line, note.idx, `row ${r}: ustKana "${row[0]}" but the UST note lyric is "${note.lyric}".`);
        const target = targets[0]!;
        if (targets.length === 1 && target === FILLER) return;
        if (targets.length === 1 && target === CONTINUE) {
          if (j === 0) issue(laneId, entry.line, note.idx, `row ${r}: "~" continues no syllable (it is the first target of the line).`);
          else notes.push({ lane: laneId, idx: note.idx, line: entry.line, syl: j - 1, part: 0, parts: 1 });
          return;
        }
        targets.forEach((t, part) => {
          if (t === FILLER || t === CONTINUE) issue(laneId, entry.line, note.idx, `row ${r}: "${t}" is valid only as the single target of a row.`);
          else if (j >= syl.length) issue(laneId, entry.line, note.idx, `row ${r}: target "${t}" but the line has only ${syl.length} syllables.`);
          else if (t !== syl[j]) issue(laneId, entry.line, note.idx, `row ${r}: target "${t}" but syllable ${j} of the line is "${syl[j]}".`);
          else notes.push({ lane: laneId, idx: note.idx, line: entry.line, syl: j, part, parts: targets.length });
          j++;
        });
      });
      if (j < syl.length) issue(laneId, entry.line, null, `syllables ${j} to ${syl.length - 1} of the line (${syl.slice(j).join(" ")}) are not used.`);
    }
    if (k < sung.length) issue(laneId, null, sung[k]!.idx, `${sung.length - k} sung UST notes from note ${sung[k]!.idx} on are not listed.`);
  }

  for (const [singerId, users] of lineLanes) {
    const count = lyrics.get(singerId)!.definition.lines.length;
    for (let line = 0; line < count; line++) {
      const lanes = users.get(line);
      if (!lanes) issue(null, line, null, `line ${line} of singer "${singerId}" is not mapped by any lane.`);
      else if (lanes.length > 1) issue(lanes[1]!, line, null, `line ${line} of singer "${singerId}" is mapped more than once (lanes ${lanes.join(", ")}).`);
    }
  }
  return { issues, mapped };
}

/** Every failure of the map check (PLAN 9.2). Empty when the map is valid. */
export function checkUstMap(input: UstImportInput): UstMapIssue[] {
  return walk(input).issues;
}

/** One issue as one line of text: lane, line and UST note number first. */
export function formatUstMapIssue(i: UstMapIssue): string {
  const where = [i.lane !== null ? `lane ${i.lane}` : null, i.line !== null ? `line ${i.line}` : null, i.note !== null ? `note #${String(i.note).padStart(4, "0")}` : null].filter((s) => s !== null);
  return `${where.join(", ")}: ${i.message}`;
}

export interface UstImportGrid {
  /** Bar starts of the song grid (seconds); downbeats[0] is bar 1. */
  downbeats: readonly number[];
  /** Song length in seconds: the end of the last section. */
  duration: number;
}

export interface UstImportFile {
  singer: string;
  /** Relative to the song folder. */
  file: string;
  doc: CalibrationDoc;
}

/** The sections of the map on the song grid: bar b starts at downbeat b - 1; each section ends where the next starts, the last at the song end. */
export function mapSections(sections: readonly UstMapSection[], grid: UstImportGrid): CalSection[] {
  const starts = sections.map((s) => {
    const t = grid.downbeats[s.bar - 1];
    if (t === undefined) throw new Error(`${MAP}: section "${s.name}" starts at bar ${s.bar}, the song grid has ${grid.downbeats.length} bars.`);
    return t;
  });
  return sections.map((s, k) => ({
    id: `${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${k}`,
    name: s.name,
    start: starts[k]!,
    end: k + 1 < sections.length ? starts[k + 1]! : grid.duration,
  }));
}

/**
 * The calibration file of every singer with mapped lanes (PLAN 9.4). A syllable starts at the start of its first placed note and ends
 * at the end of its last placed note ("~" notes included). A note of a row with several targets is split evenly across them, in order;
 * those syllables are not pinned, every other syllable is. Lines are ordered by start. The lead file gets the sections. Throws with
 * every failure listed when the map check fails or a syllable has no placed note.
 */
export function importUst(input: UstImportInput, notes: readonly PlacedNote[], grid: UstImportGrid): UstImportFile[] {
  const { issues, mapped } = walk(input);
  if (issues.length > 0) throw new Error(`${MAP} check failed (${issues.length}):\n${issues.map(formatUstMapIssue).join("\n")}`);
  const placed = new Map(notes.map((n) => [`${n.lane}\n${n.idx}`, n]));
  const missing: string[] = [];
  const files: UstImportFile[] = [];
  for (const singer of input.singers.singers) {
    const list = mapped.get(singer.id);
    if (!list) continue;
    const parsed = input.lyrics.get(singer.id)!;
    // The placed pieces of each syllable, in map order (line -> flat syllable -> pieces), and every mapped note (for the error).
    type Piece = { start: number; end: number; split: boolean };
    const bySyl = parsed.definition.lines.map((l) => l.words.flatMap((w) => w.syllables).map((): Piece[] => []));
    const listed = parsed.definition.lines.map((l) => l.words.flatMap((w) => w.syllables).map((): MappedNote[] => []));
    for (const m of list) {
      listed[m.line]![m.syl]!.push(m);
      const n = placed.get(`${m.lane}\n${m.idx}`);
      if (!n) continue;
      const step = (n.end - n.start) / m.parts;
      const end = m.part === m.parts - 1 ? n.end : n.start + step * (m.part + 1);
      bySyl[m.line]![m.syl]!.push({ start: n.start + step * m.part, end, split: m.parts > 1 });
    }
    const lines: CalLine[] = parsed.definition.lines.map((l, li) => {
      let flat = 0;
      const words: CalWord[] = l.words.map((w, wi) => {
        const pinned: boolean[] = [];
        const syl = w.syllables.map((text): [number, number] => {
          const ps = bySyl[li]![flat]!;
          if (ps.length === 0) {
            const from = listed[li]![flat]!.map((m) => `${m.lane} note #${String(m.idx).padStart(4, "0")}`).join(", ");
            missing.push(`singer ${singer.id}, line ${li}, syllable ${flat} "${text}": no placed note (${from || "no note"}).`);
          }
          flat++;
          pinned.push(!ps.some((p) => p.split));
          return ps.length === 0 ? [0, 0] : [ps[0]!.start, ps.at(-1)!.end];
        });
        const join = parsed.sylJoin[li]?.[wi];
        return { w: w.w, start: syl[0]![0], end: syl.at(-1)![1], syl, sylText: w.syllables, sylCalibrated: pinned, ...(join ? { sylJoin: join } : {}) };
      });
      return { i: li, text: l.text, start: words[0]!.start, end: words.at(-1)!.end, words };
    });
    lines.sort((a, b) => a.start - b.start);
    lines.forEach((l, k) => (l.i = k));
    const sections = singer.lead === true ? mapSections(input.map.sections ?? [], grid) : [];
    files.push({ singer: singer.id, file: calibratedFileFor(singer), doc: { format: "words", fps: 60, method: "ust", sections, lines } });
  }
  if (missing.length > 0) throw new Error(`UST import failed: ${missing.length} syllables have no placed note:\n${missing.join("\n")}`);
  return files;
}
