// packages/lyricsync/web/server/beats.ts
// The beat grid of a song project (local dev server). The beat model runs once per mix; its logits are kept in
// <songs>/<id>/generated/beat_logits.json. A tempo map (user_input/prompt.yaml: nearest_bpm, then tempo_changes) turns them into
// beats, which costs milliseconds, so the editor can move a tempo change and see the grid follow.
//   trackSongBeats   the beats of a song from its logits (the wizard build and the re-fit use it)
//   readTempoMap     the tempo map (and beat pins) of a song
//   refitTempoMap    sets a new tempo map: re-fits the beats and rewrites generated/timing.ai.json, lyricsync/evidence/beats.json
//                    (what the editor reads) and prompt.yaml
import * as fs from "node:fs";
import * as path from "node:path";
import { BeatTracker, beatsFromLogits, checkBeatPins, checkTempoChanges, type BeatAnalysis, type BeatLogits, type BeatPin, type TempoChange } from "../../../beatsync/src/index.ts";
import type { BeatsDocument } from "../../src/index.ts";
import { isNumber, isRecord } from "../../src/guards.ts";
import { findSongDir, readPromptManifest, readSongPrompt, songFolderPaths, withBeatMap, type PromptManifest, type SongsRoots } from "../../src/song-folder.ts";
import { inferenceDevice } from "./device.ts";

/** The beat map of a song: its tempo (a prior for the beat tracker) and the beats fixed by hand. */
export interface TempoMap {
  /** BPM at the start of the song. */
  nearestBpm: number;
  /** From each `at` seconds the tempo is `bpm`; increasing in `at`. */
  tempoChanges: TempoChange[];
  /** Beat number `beat` (0 = the first beat) is at `at` seconds; the beats between pins are re-fitted. Increasing in both. */
  beatPins: BeatPin[];
}

/** The mix as it was when the logits were computed; another file means other logits. */
interface MixStamp {
  size: number;
  mtimeMs: number;
}

interface LogitsFile {
  v: 1;
  mix: MixStamp;
  fps: number;
  durationSec: number;
  beat: number[];
  downbeat: number[];
}

const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNumber);

function isLogitsFile(raw: unknown): raw is LogitsFile {
  return (
    isRecord(raw) &&
    raw.v === 1 &&
    isRecord(raw.mix) &&
    isNumber(raw.mix.size) &&
    isNumber(raw.mix.mtimeMs) &&
    isNumber(raw.fps) &&
    isNumber(raw.durationSec) &&
    isNumberArray(raw.beat) &&
    isNumberArray(raw.downbeat)
  );
}

/** The beat model's logits for the song's mix: read from generated/beat_logits.json, or computed (the slow step) and kept there. */
async function songLogits(dir: string, prompt: Pick<PromptManifest, "songPath" | "nearestBpm">): Promise<BeatLogits> {
  const file = path.join(dir, "generated", "beat_logits.json");
  const st = fs.statSync(prompt.songPath);
  if (fs.existsSync(file)) {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isLogitsFile(raw) && raw.mix.size === st.size && raw.mix.mtimeMs === st.mtimeMs) {
      return { fps: raw.fps, beat: Float32Array.from(raw.beat), downbeat: Float32Array.from(raw.downbeat), durationSec: raw.durationSec, inferenceTimeMs: 0 };
    }
  }
  if (prompt.nearestBpm === null) throw new Error("prompt.yaml has no nearest_bpm.");
  const tracker = new BeatTracker({ targetBpm: prompt.nearestBpm, device: inferenceDevice() });
  const logits = await tracker.trackLogitsFile(prompt.songPath);
  const out: LogitsFile = {
    v: 1,
    mix: { size: st.size, mtimeMs: st.mtimeMs },
    fps: logits.fps,
    durationSec: logits.durationSec,
    beat: Array.from(logits.beat),
    downbeat: Array.from(logits.downbeat),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out), "utf8");
  return logits;
}

/** The beats of the song in `dir` for the tempo map and first downbeat of `prompt` (its mix is analysed once, then the logits are reused). */
export async function trackSongBeats(dir: string, prompt: PromptManifest): Promise<BeatAnalysis> {
  if (prompt.nearestBpm === null) throw new Error("prompt.yaml has no nearest_bpm.");
  const logits = await songLogits(dir, prompt);
  return beatsFromLogits(logits, { targetBpm: prompt.nearestBpm, tempoChanges: prompt.tempoChanges, beatPins: prompt.beatPins, firstDownbeat: prompt.firstDownbeat ?? undefined });
}

/** generated/timing.ai.json as the beat tracker's output is written. */
export function beatsDocument(a: BeatAnalysis): BeatsDocument {
  return {
    v: 1,
    model: "beat_this",
    duration: Number(a.durationSec.toFixed(3)),
    bpm: a.bpm,
    beat_period: a.beatPeriod,
    beats: a.beats.map((b) => Number(b.toFixed(3))),
    downbeats: a.downbeats.map((d) => Number(d.toFixed(3))),
  };
}

/** The song is in none of the known song directories. */
export class SongNotFoundError extends Error {}

function songDirOf(roots: SongsRoots, id: string): string {
  const dir = findSongDir(roots, id);
  if (!dir) throw new SongNotFoundError(`Song "${id}" was not found in any known song directories.`);
  return dir;
}

export function readTempoMap(roots: SongsRoots, id: string): TempoMap {
  const prompt = readSongPrompt(songDirOf(roots, id));
  if (prompt.nearestBpm === null) throw new Error("prompt.yaml has no nearest_bpm.");
  return { nearestBpm: prompt.nearestBpm, tempoChanges: prompt.tempoChanges, beatPins: prompt.beatPins };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Sets the tempo map of song `id` and re-fits its beats. The lyricsync workspace's evidence still holds the old beats: the next
 * Auto-time prepares it again first (its inputs changed).
 */
export function refitTempoMap(roots: SongsRoots, id: string, map: TempoMap, busy: string | null): Promise<{ tempoMap: TempoMap; beats: BeatsDocument }> {
  if (busy) return Promise.reject(new Error(busy));
  const run = queue.then(() => refit(roots, id, map));
  queue = run.catch(() => undefined);
  return run;
}

async function refit(roots: SongsRoots, id: string, map: TempoMap): Promise<{ tempoMap: TempoMap; beats: BeatsDocument }> {
  const dir = songDirOf(roots, id);
  const inRange = (bpm: number) => Number.isFinite(bpm) && bpm >= 40 && bpm <= 260;
  if (!inRange(map.nearestBpm)) throw new Error("The starting tempo must be between 40 and 260 BPM.");
  checkTempoChanges(map.nearestBpm, map.tempoChanges);
  for (const c of map.tempoChanges) if (!inRange(c.bpm)) throw new Error(`The tempo from ${c.at} s must be between 40 and 260 BPM.`);
  checkBeatPins(map.beatPins);

  const paths = songFolderPaths(dir);
  const prompt = readPromptManifest(roots, id);
  const analysis = await trackSongBeats(dir, { ...prompt, nearestBpm: map.nearestBpm, tempoChanges: map.tempoChanges, beatPins: map.beatPins });
  const doc = beatsDocument(analysis);

  const json = `${JSON.stringify(doc, null, 2)}\n`;
  fs.mkdirSync(path.dirname(paths.timingFile), { recursive: true });
  fs.writeFileSync(paths.timingFile, json, "utf8");
  const evidenceBeats = path.join(paths.workspaceDir, "evidence", "beats.json");
  if (fs.existsSync(evidenceBeats)) fs.writeFileSync(evidenceBeats, `${JSON.stringify(doc)}\n`, "utf8");
  fs.writeFileSync(paths.promptFile, withBeatMap(fs.readFileSync(paths.promptFile, "utf8"), map.nearestBpm, map.tempoChanges, map.beatPins), "utf8");

  return { tempoMap: { nearestBpm: map.nearestBpm, tempoChanges: map.tempoChanges, beatPins: map.beatPins }, beats: doc };
}

/** The `tempoChanges` of a request: a JSON list of { at, bpm } numbers. */
export function parseTempoChanges(raw: unknown): TempoChange[] {
  if (!Array.isArray(raw) || !raw.every((c) => isRecord(c) && typeof c.at === "number" && typeof c.bpm === "number")) {
    throw new Error("Tempo changes must be a list of { at: seconds, bpm: number }.");
  }
  return raw.map((c: { at: number; bpm: number }) => ({ at: c.at, bpm: c.bpm }));
}

/** The `beatPins` of a request: a JSON list of { beat, at } numbers. */
export function parseBeatPins(raw: unknown): BeatPin[] {
  if (!Array.isArray(raw) || !raw.every((p) => isRecord(p) && typeof p.beat === "number" && typeof p.at === "number")) {
    throw new Error("Beat pins must be a list of { beat: beat number, at: seconds }.");
  }
  return raw.map((p: { beat: number; at: number }) => ({ beat: p.beat, at: p.at }));
}

/** A tempo map request body: { nearestBpm, tempoChanges, beatPins }. */
export function parseTempoMap(raw: unknown): TempoMap {
  if (!isRecord(raw) || typeof raw.nearestBpm !== "number") throw new Error("Needs nearestBpm (a number), tempoChanges and beatPins.");
  return { nearestBpm: raw.nearestBpm, tempoChanges: parseTempoChanges(raw.tempoChanges), beatPins: raw.beatPins === undefined ? [] : parseBeatPins(raw.beatPins) };
}
