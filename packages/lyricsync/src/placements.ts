// src/placements.ts
// The rendered vocal tracks (generated/renders/index.json) and where the user placed them (user_input/placements.json).
// A lane holds clips. A clip plays UST ticks [from, to) of the render; its tick 0 is at beatTime(atBeat) on the song beat grid.
// Unknown fields are kept as read and written back unchanged.
// No Node or Bun imports: the editor's browser code uses this module too.
import { isNumber, isRecord } from "./guards.ts";

export interface RenderEntry {
  ust: string;
  wav: string;
  singer: string;
  fallback: boolean;
  tempo: number;
  ticks: number;
  leadSamples: number;
  seconds: number;
  ustSha256: string;
  [key: string]: unknown;
}

export interface RenderIndex {
  v: 1;
  tool: string;
  toolVersion: string;
  sampleRate: number;
  renders: RenderEntry[];
  [key: string]: unknown;
}

/** One piece of a render on a lane. Ticks are UST ticks (480 per quarter note) at the render tempo. */
export interface PlacementClip {
  /** Unique in the lane. */
  id: string;
  /** The beat of the song beat grid where UST tick 0 of this clip is. Null when the clip is parked (silent, not on the timeline). */
  atBeat: number | null;
  /** First tick of the render that the clip plays. Can be negative (the lead-in before tick 0). */
  from: number;
  /** End tick (exclusive) of the render that the clip plays. */
  to: number;
  [key: string]: unknown;
}

export interface PlacementLane {
  id: string;
  ust: string;
  /** The first line (romaji) of the lyric block the lane sings, as in the singer's lyrics file. Empty = the lane sings no lyrics. */
  block: string;
  clips: PlacementClip[];
  [key: string]: unknown;
}

export interface Placements {
  v: 2;
  lanes: PlacementLane[];
  [key: string]: unknown;
}

const RENDER_INDEX = "generated/renders/index.json";
const PLACEMENTS = "user_input/placements.json";

const STRING_FIELDS = ["ust", "wav", "singer", "ustSha256"] as const;
const NUMBER_FIELDS = ["tempo", "ticks", "leadSamples", "seconds"] as const;

/** Validates generated/renders/index.json content and returns it typed. */
export function parseRenderIndex(raw: unknown): RenderIndex {
  if (!isRecord(raw)) throw new Error(`${RENDER_INDEX}: expected an object.`);
  if (raw.v !== 1) throw new Error(`${RENDER_INDEX}: "v" must be 1.`);
  if (typeof raw.tool !== "string") throw new Error(`${RENDER_INDEX}: "tool" must be a string.`);
  if (typeof raw.toolVersion !== "string") throw new Error(`${RENDER_INDEX}: "toolVersion" must be a string.`);
  if (!isNumber(raw.sampleRate) || raw.sampleRate <= 0) throw new Error(`${RENDER_INDEX}: "sampleRate" must be a positive number.`);
  if (!Array.isArray(raw.renders)) throw new Error(`${RENDER_INDEX}: "renders" must be an array.`);
  const seen = new Set<string>();
  raw.renders.forEach((r: unknown, k: number) => {
    if (!isRecord(r)) throw new Error(`${RENDER_INDEX}: renders[${k}] must be an object.`);
    for (const f of STRING_FIELDS) if (typeof r[f] !== "string") throw new Error(`${RENDER_INDEX}: renders[${k}].${f} must be a string.`);
    for (const f of NUMBER_FIELDS) if (!isNumber(r[f])) throw new Error(`${RENDER_INDEX}: renders[${k}].${f} must be a number.`);
    if (typeof r.fallback !== "boolean") throw new Error(`${RENDER_INDEX}: renders[${k}].fallback must be a boolean.`);
    if (seen.has(r.ust as string)) throw new Error(`${RENDER_INDEX}: renders[${k}].ust "${r.ust}" is listed twice.`);
    seen.add(r.ust as string);
  });
  // Every field was checked above.
  return raw as unknown as RenderIndex;
}

/** The tick range of the wav of `r`: min is the start of the lead-in (negative), max is the end of the wav. */
export function clipTickRange(r: RenderEntry, sampleRate: number): { min: number; max: number } {
  const samplesPerTick = (60 / r.tempo / 480) * sampleRate;
  const wavSamples = r.seconds * sampleRate;
  return { min: -r.leadSamples / samplesPerTick, max: (wavSamples - r.leadSamples) / samplesPerTick };
}

/** Validates user_input/placements.json content and returns it typed. With `index`, every lane.ust must be a render of it and every clip must be inside the wav. */
export function parsePlacements(raw: unknown, index?: RenderIndex): Placements {
  if (!isRecord(raw)) throw new Error(`${PLACEMENTS}: expected an object.`);
  if (raw.v !== 2) throw new Error(`${PLACEMENTS}: "v" must be 2.`);
  if (!Array.isArray(raw.lanes)) throw new Error(`${PLACEMENTS}: "lanes" must be an array.`);
  const renders = index ? new Map(index.renders.map((r) => [r.ust, r])) : null;
  const ids = new Set<string>();
  raw.lanes.forEach((l: unknown, k: number) => {
    const at = `${PLACEMENTS}: lanes[${k}]`;
    if (!isRecord(l)) throw new Error(`${at} must be an object.`);
    if (typeof l.id !== "string" || l.id === "") throw new Error(`${at}.id must be a non-empty string.`);
    if (typeof l.ust !== "string") throw new Error(`${at}.ust must be a string.`);
    if (typeof l.block !== "string") throw new Error(`${at}.block must be a string.`);
    if (ids.has(l.id)) throw new Error(`${at}.id "${l.id}" is used twice.`);
    ids.add(l.id);
    let range: { min: number; max: number } | null = null;
    if (renders && index) {
      const r = renders.get(l.ust);
      if (!r) throw new Error(`${at}.ust "${l.ust}" is not in ${RENDER_INDEX}.`);
      range = clipTickRange(r, index.sampleRate);
    }
    if (!Array.isArray(l.clips)) throw new Error(`${at}.clips must be an array.`);
    const clipIds = new Set<string>();
    l.clips.forEach((c: unknown, j: number) => {
      const cat = `${at}.clips[${j}]`;
      if (!isRecord(c)) throw new Error(`${cat} must be an object.`);
      if (typeof c.id !== "string" || c.id === "") throw new Error(`${cat}.id must be a non-empty string.`);
      if (clipIds.has(c.id)) throw new Error(`${cat}.id "${c.id}" is used twice in the lane.`);
      clipIds.add(c.id);
      if (c.atBeat !== null && !isNumber(c.atBeat)) throw new Error(`${cat}.atBeat must be a number or null.`);
      if (!isNumber(c.from)) throw new Error(`${cat}.from must be a number.`);
      if (!isNumber(c.to)) throw new Error(`${cat}.to must be a number.`);
      if (c.from >= c.to) throw new Error(`${cat}.from must be less than to.`);
      if (range) {
        // A small tolerance: the range comes from float division.
        const eps = 1e-6;
        if (c.from < range.min - eps) throw new Error(`${cat}.from ${c.from} is before the start of the wav (${range.min}).`);
        if (c.to > range.max + eps) throw new Error(`${cat}.to ${c.to} is after the end of the wav (${range.max}).`);
      }
    });
  });
  // Every field was checked above.
  return raw as unknown as Placements;
}

/** One lane per render of `index`, id `<ust basename without .ust>#1`, block "", with one parked clip `<laneId>/1` over the whole wav. Two renders with the same basename get #1 and #2. */
export function defaultPlacements(index: RenderIndex): Placements {
  const used = new Set<string>();
  const lanes = index.renders.map((r): PlacementLane => {
    const base = r.ust.split(/[\\/]/).pop()!.replace(/\.ust$/i, "");
    let n = 1;
    while (used.has(`${base}#${n}`)) n++;
    const id = `${base}#${n}`;
    used.add(id);
    const { min, max } = clipTickRange(r, index.sampleRate);
    return { id, ust: r.ust, block: "", clips: [{ id: `${id}/1`, atBeat: null, from: min, to: max }] };
  });
  return { v: 2, lanes };
}

/** Cuts clip `clipId` of `lane` at `atTick` into two clips with the same atBeat. Returns a new lane. Throws when atTick is not strictly inside (from, to). */
export function splitClip(lane: PlacementLane, clipId: string, atTick: number): PlacementLane {
  const k = lane.clips.findIndex((c) => c.id === clipId);
  if (k < 0) throw new Error(`splitClip: lane "${lane.id}" has no clip "${clipId}".`);
  const c = lane.clips[k]!;
  if (!(atTick > c.from && atTick < c.to)) throw new Error(`splitClip: tick ${atTick} is not inside clip "${clipId}" (${c.from} to ${c.to}).`);
  let high = 0;
  const prefix = `${lane.id}/`;
  for (const o of lane.clips) {
    if (!o.id.startsWith(prefix)) continue;
    const n = Number(o.id.slice(prefix.length));
    if (Number.isInteger(n) && n > high) high = n;
  }
  const clips = [...lane.clips];
  clips.splice(k, 1, { ...c, to: atTick }, { ...c, id: `${prefix}${high + 1}`, from: atTick });
  return { ...lane, clips };
}
