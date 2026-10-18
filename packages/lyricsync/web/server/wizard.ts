// packages/lyricsync/web/server/wizard.ts
// New-song wizard backend (local dev server): turns raw inputs into a song folder the editor opens, in the song-folder layout
// (server/song-inputs.ts; the same as probable-video-editor projects, so its project scripts work on it too).
//
// <songs>/<id>/
//   project.json                       video project with only the song asset (assets.song.src = the mix)
//   user_input/prompt.yaml             song and stem names, nearest_bpm, first_downbeat_s
//   user_input/<mix>, user_input/stems/<vocal>
//   user_input/lyrics.txt              the lyrics as typed;  user_input/lyrics.sync.json  the parsed lyrics contract
//   generated/timing.ai.json           beat grid (beatsync)
//   lyricsync/                         workspace: init + prepare (evidence), free solve -> out/lyrics.json
//   generated/lyrics.json              copy of the solver's out/lyrics.json (system generated)
//   user_input/lyrics.calibrated.json  start of the human calibration: the free solve, nothing pinned
//
// The build is a pipeline of stages; a stage whose result exists is skipped, so a failed build resumes where it stopped.
import * as fs from "node:fs";
import * as path from "node:path";
import { trackBeats } from "../../../beatsync/src/index.ts";
import {
  emptyAnchors,
  lintLyricsText,
  lyricsSectionOutline,
  parseLyricsText,
  pronunciationKey,
  Session,
  type AutoSplitNote,
  type Language,
  type LyricsDefinition,
  type LyricsIssue,
  type Pronunciations,
  type SectionOutline,
} from "../../src/index.ts";
import type { BeatsDocument, ConsensusLine } from "../../src/index.ts";
import { isRecord, isStringArray } from "../../src/guards.ts";
import { dictionaryG2P } from "../../src/lyrics/index.ts";
import { findSongDir, ID_RE, readPromptManifest, songDir, songInputs, type SongsRoots } from "./song-inputs.ts";

export interface WizardJob {
  project: string;
  state: "running" | "done" | "error";
  log: string[];
  error?: string;
}

let job: WizardJob | null = null;

export function currentJob(): WizardJob | null {
  return job;
}

export type LyricsCheckResult =
  | { ok: true; issues: []; lines: number; syllables: number; sections: SectionOutline[]; autoSplit: AutoSplitNote[] }
  | { ok: false; issues: LyricsIssue[]; error?: string };

/** Lints the lyrics (every unknown word at once); counts and automatic splits once there is no issue left. */
export function checkLyrics(text: string, language: Language, pronunciations: Pronunciations): LyricsCheckResult {
  let issues: LyricsIssue[];
  try {
    issues = lintLyricsText(text, language, pronunciations);
  } catch (e: unknown) {
    return { ok: false, issues: [], error: e instanceof Error ? e.message : String(e) };
  }
  if (issues.length > 0) return { ok: false, issues };
  const parsed = parseLyricsText(text, language, pronunciations);
  const sections = lyricsSectionOutline(text);
  return {
    ok: true,
    issues: [],
    lines: parsed.definition.lines.length,
    syllables: parsed.definition.lines.reduce((n, l) => n + l.words.reduce((m, w) => m + w.syllables.length, 0), 0),
    sections,
    autoSplit: parsed.autoSplit,
  };
}

/** Validates hand-added pronunciations: keys as pronunciationKey makes them, phones from the dictionary's inventory. */
export function parsePronunciations(raw: unknown, language: Language): Pronunciations {
  if (!isRecord(raw)) throw new Error("Pronunciations must be an object of word -> phones.");
  const inventory = dictionaryG2P(language).phoneSet();
  const out: Pronunciations = {};
  for (const [word, phones] of Object.entries(raw)) {
    if (!isStringArray(phones) || phones.length === 0 || !phones.every((p) => inventory.has(p))) {
      throw new Error(`The pronunciation of "${word}" must be phones of the ${language} dictionary.`);
    }
    out[pronunciationKey(word)] = phones;
  }
  return out;
}

export interface CreateInput {
  id: string;
  language: Language;
  bpm: number;
  firstDownbeat: number | null;
  lyrics: string;
  pronunciations: Pronunciations;
  mix: File;
  vocal: File;
}

const yamlString = (s: string) => JSON.stringify(s);
const safeName = (name: string, what: string) => {
  const base = path.basename(name);
  if (!/\.wav$/i.test(base)) throw new Error(`The ${what} must be a .wav file, got "${name}".`);
  return base;
};

/** Validates everything that can be checked up front, writes the inputs, then starts the build. */
export async function createSong(songsRoot: string, input: CreateInput): Promise<void> {
  if (job?.state === "running") throw new Error(`A build is already running (${job.project}). Wait for it to finish.`);
  if (!ID_RE.test(input.id)) throw new Error("The song id must be lowercase letters, digits, - or _, starting with a letter or digit.");
  if (!Number.isFinite(input.bpm) || input.bpm < 40 || input.bpm > 260) throw new Error("The tempo must be between 40 and 260 BPM.");
  if (input.firstDownbeat !== null && !(input.firstDownbeat >= 0)) throw new Error("The first downbeat must be a time in seconds, 0 or more.");
  const dir = songDir(songsRoot, input.id);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists. Choose another id, or resume its build.`);
  const check = checkLyrics(input.lyrics, input.language, input.pronunciations);
  if (!check.ok) throw new Error(check.error ?? `The lyrics have ${check.issues.length} problem(s), e.g. ${check.issues[0]!.message}`);
  const mixName = safeName(input.mix.name, "mix");
  const vocalName = safeName(input.vocal.name, "vocal stem");

  fs.mkdirSync(path.join(dir, "user_input", "stems"), { recursive: true });
  await Bun.write(path.join(dir, "user_input", mixName), input.mix);
  await Bun.write(path.join(dir, "user_input", "stems", vocalName), input.vocal);
  fs.writeFileSync(path.join(dir, "user_input", "lyrics.txt"), input.lyrics.endsWith("\n") ? input.lyrics : `${input.lyrics}\n`, "utf8");
  const prompt = [
    `project_code: ${input.id}`,
    `song_name: ${yamlString(input.id)}`,
    "timing_mode: ai",
    `nearest_bpm: ${input.bpm}`,
    ...(input.firstDownbeat === null ? [] : [`first_downbeat_s: ${input.firstDownbeat}`]),
    "files:",
    `  song: ${yamlString(mixName)}`,
    "  lyrics: lyrics.txt",
    "  stems:",
    "    folder: stems",
    `    vocal: ${yamlString(vocalName)}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "user_input", "prompt.yaml"), prompt, "utf8");
  const definition = parseLyricsText(input.lyrics, input.language, input.pronunciations).definition;
  writeJson(path.join(dir, "user_input", "lyrics.sync.json"), {
    language: definition.language,
    lines: definition.lines.map((l) => ({
      ...(l.section ? { section: l.section } : {}),
      text: l.text,
      words: l.words.map((w) => ({ w: w.w, syllables: w.syllables, ...(w.phones ? { phones: w.phones } : {}) })),
    })),
  });
  writeJson(path.join(dir, "project.json"), {
    v: 1,
    id: input.id,
    engine: "0.1",
    fps: 60,
    output: { size: [1920, 1080], fit: "contain" },
    assets: { song: { kind: "audio", src: `user_input/${mixName}` } },
    markers: {},
    tracks: [],
  });
  startBuild(songsRoot, input.id);
}

/** (Re)starts the build of an existing wizard project; finished stages are skipped. */
export function resumeSong(roots: SongsRoots, id: string): void {
  if (job?.state === "running") throw new Error(`A build is already running (${job.project}). Wait for it to finish.`);
  const dir = findSongDir(roots, id);
  if (!dir || !fs.existsSync(path.join(dir, "user_input", "prompt.yaml"))) {
    throw new Error(`Song ${id} has no user_input/prompt.yaml; it was not made by the wizard.`);
  }
  startBuild(roots, id);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function startBuild(roots: SongsRoots, id: string): void {
  const current: WizardJob = { project: id, state: "running", log: [] };
  job = current;
  const say = (m: string) => current.log.push(m);
  build(roots, id, say).then(
    () => {
      current.state = "done";
      say("Done. Open the song to start calibrating.");
    },
    (e: unknown) => {
      current.state = "error";
      current.error = e instanceof Error ? e.message : String(e);
    }
  );
}

async function build(roots: SongsRoots, id: string, say: (m: string) => void): Promise<void> {
  const dir = songDir(roots, id);
  const beatsFile = path.join(dir, "generated", "timing.ai.json");

  if (fs.existsSync(beatsFile)) say("Beats: generated/timing.ai.json exists, kept.");
  else {
    const prompt = readPromptManifest(roots, id);
    if (prompt.nearestBpm === null) throw new Error("prompt.yaml has no nearest_bpm.");
    say(`Tracking beats on ${path.basename(prompt.songPath)} (tempo prior ${prompt.nearestBpm} BPM)…`);
    const a = await trackBeats(prompt.songPath, { targetBpm: prompt.nearestBpm, firstDownbeat: prompt.firstDownbeat ?? undefined });
    const doc: BeatsDocument = {
      v: 1,
      model: "beat_this",
      duration: Number(a.durationSec.toFixed(3)),
      bpm: a.bpm,
      beat_period: a.beatPeriod,
      beats: a.beats.map((b) => Number(b.toFixed(3))),
      downbeats: a.downbeats.map((d) => Number(d.toFixed(3))),
    };
    writeJson(beatsFile, doc);
    say(`  ${doc.beats.length} beats, ${doc.downbeats.length} bars, ${doc.bpm} BPM.`);
  }

  const inputs = songInputs(roots, id);
  let session: Session;
  if (fs.existsSync(path.join(inputs.workspaceDir, "lyricsync.json"))) session = Session.open(inputs.workspaceDir);
  else {
    const created = Session.init({
      dir: inputs.workspaceDir,
      vocalPath: inputs.vocalPath,
      lyricsPath: inputs.lyricsFile,
      language: inputs.language,
      beats: { kind: "file", path: inputs.beatsFile },
    });
    session = created.session;
    say(`Workspace created (vocal ${path.basename(inputs.vocalPath)}).`);
  }

  say("Preparing audio evidence (pitch, alignment, boundary model). This takes a few minutes…");
  const t0 = Date.now();
  const prepared = await session.prepare({ onProgress: (m) => say(`  ${m}`) });
  say(prepared.skipped ? "Evidence is up to date." : `Evidence ready in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);

  const calibrated = path.join(dir, "user_input", "lyrics.calibrated.json");
  if (fs.existsSync(calibrated)) {
    say("user_input/lyrics.calibrated.json exists, kept.");
    return;
  }
  say("Solving (nothing pinned yet)…");
  const result = await session.solve({ anchors: emptyAnchors() });
  fs.mkdirSync(path.join(dir, "generated"), { recursive: true });
  fs.copyFileSync(session.paths.lyricsOut, path.join(dir, "generated", "lyrics.json"));
  const beats: unknown = JSON.parse(fs.readFileSync(inputs.beatsFile, "utf8"));
  const songEnd = typeof beats === "object" && beats !== null && "duration" in beats && typeof beats.duration === "number" ? beats.duration : result.lyrics.lines.at(-1)!.end;
  const outline = lyricsSectionOutline(fs.readFileSync(path.join(dir, "user_input", "lyrics.txt"), "utf8"));
  writeJson(calibrated, calibrationFromSolve(session.definition, result.lyrics.lines, outline, songEnd));
  say(`Wrote user_input/lyrics.calibrated.json (${result.lyrics.lines.length} lines, mean expected error ${result.meanExpectedErrorMs.toFixed(0)} ms).`);
}

/** The project calibration file for a free solve: solver times, no pins, sections from the lyrics' headers (sectionsFromOutline). */
function calibrationFromSolve(def: LyricsDefinition, solved: ConsensusLine[], outline: SectionOutline[], songEnd: number) {
  if (solved.length !== def.lines.length) throw new Error(`The solver returned ${solved.length} lines for ${def.lines.length} lyric lines.`);
  const lines = def.lines.map((l, i) => {
    const s = solved[i]!;
    return {
      i,
      text: l.text,
      start: s.start,
      end: s.end,
      words: l.words.map((w, wi) => {
        const sw = s.words[wi];
        if (!sw?.syl || sw.syl.length !== w.syllables.length) throw new Error(`The solver returned no syllable times for "${w.w}" in line ${i}.`);
        return { w: w.w, start: sw.start, end: sw.end, syl: sw.syl, sylText: w.syllables };
      }),
    };
  });
  return { format: "words", fps: 60, method: "lyricsync", sections: sectionsFromOutline(outline, lines, songEnd), lines };
}

/**
 * One section per `[Section]` header, tiling the song. A section with lines starts at its first line (the first section at 0).
 * Sections without lines (instrumental: intro, interlude, outro) share the gap between the lines around them evenly.
 * `lines` are the song's lyric lines in order; lines before the first header belong to no section.
 */
export function sectionsFromOutline(outline: SectionOutline[], lines: Array<{ start: number; end: number }>, songEnd: number) {
  const entries: Array<{ name: string; first: number; count: number }> = [];
  let next = lines.length - outline.reduce((n, o) => n + o.lines, 0);
  for (const o of outline) {
    entries.push({ name: o.name, first: next, count: o.lines });
    next += o.lines;
  }
  const starts = entries.map((e, k) => (e.count > 0 ? (k === 0 ? 0 : lines[e.first]!.start) : Number.NaN));
  for (let k = 0; k < entries.length; ) {
    if (entries[k]!.count > 0) {
      k++;
      continue;
    }
    let j = k;
    while (j < entries.length && entries[j]!.count === 0) j++;
    const prev = entries[k - 1];
    const gapStart = prev ? lines[prev.first + prev.count - 1]!.end : 0;
    const gapEnd = j < entries.length ? lines[entries[j]!.first]!.start : songEnd;
    for (let m = k; m < j; m++) starts[m] = gapStart + ((gapEnd - gapStart) * (m - k)) / (j - k);
    k = j;
  }
  const round = (t: number) => Number(t.toFixed(3));
  return entries.map((e, k) => ({
    id: `${e.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${k}`,
    name: e.name,
    start: round(starts[k]!),
    end: round(k + 1 < entries.length ? starts[k + 1]! : songEnd),
  }));
}
