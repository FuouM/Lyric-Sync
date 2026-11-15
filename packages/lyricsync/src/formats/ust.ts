// src/formats/ust.ts
// UTAU .ust files (Shift_JIS text): the song settings and the notes, with absolute tick positions (480 ticks per quarter note).
// Sections: [#SETTING] (Tempo, VoiceDir, ...), then one [#NNNN] section per note (Length, Lyric, NoteNum, ...). Other sections
// ([#VERSION], [#TRACKEND], ...) and unknown keys are ignored.
// No Node or Bun imports: the editor's browser code uses this module too.

export interface UstNote {
  /** The note number NNNN of its [#NNNN] section. */
  idx: number;
  /** Start tick: the sum of the lengths of the notes before it. */
  tick: number;
  /** Length in ticks. */
  len: number;
  lyric: string;
  /** True for a rest (lyric "R", "r" or empty). */
  rest: boolean;
  /** MIDI note number (NoteNum). */
  note: number;
}

export interface Ust {
  tempo: number;
  /** VoiceDir of [#SETTING] without the `%VOICE%` prefix; "" when the file has none. */
  voiceDir: string;
  notes: UstNote[];
  /** Total length in ticks (end of the last note). */
  ticks: number;
}

/** UTAU ticks per quarter note. */
export const UST_TICKS_PER_BEAT = 480;

function number(value: string | undefined, what: string): number {
  const n = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n)) throw new Error(`UST: ${what} must be a number (got ${value === undefined ? "nothing" : JSON.stringify(value)}).`);
  return n;
}

/** Parses the bytes of a .ust file (Shift_JIS). */
export function parseUst(bytes: Uint8Array): Ust {
  const text = new TextDecoder("shift_jis").decode(bytes);
  const sections: Array<{ name: string; keys: Record<string, string> }> = [];
  for (const line of text.split(/\r?\n/)) {
    const head = /^\[#(.+)\]$/.exec(line);
    if (head) {
      sections.push({ name: head[1]!, keys: {} });
      continue;
    }
    const eq = line.indexOf("=");
    const cur = sections.at(-1);
    if (cur && eq > 0) cur.keys[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const setting = sections.find((s) => s.name === "SETTING");
  if (!setting) throw new Error("UST: no [#SETTING] section.");
  const tempo = number(setting.keys.Tempo, "[#SETTING] Tempo");
  if (tempo <= 0) throw new Error(`UST: [#SETTING] Tempo must be positive (got ${tempo}).`);
  const voiceDir = (setting.keys.VoiceDir ?? "").replace(/^%VOICE%/, "");
  const notes: UstNote[] = [];
  let tick = 0;
  for (const s of sections) {
    if (!/^\d+$/.test(s.name)) continue;
    const where = `[#${s.name}]`;
    const len = number(s.keys.Length, `${where} Length`);
    if (len < 0) throw new Error(`UST: ${where} Length must not be negative (got ${len}).`);
    const lyric = s.keys.Lyric ?? "";
    notes.push({ idx: Number(s.name), tick, len, lyric, rest: lyric === "R" || lyric === "r" || lyric === "", note: number(s.keys.NoteNum, `${where} NoteNum`) });
    tick += len;
  }
  return { tempo, voiceDir, notes, ticks: tick };
}
