// src/formats/midi.ts
// Standard MIDI files (format 0 and 1): tracks, notes (note on/off paired), tempo map, time signatures, program changes and text
// meta events. Text stays as bytes (the encoding of a MIDI file is not defined: Shift_JIS and UTF-8 both occur); `decodeMidiText`
// decodes it. SMPTE time division and format 2 files are errors.
// No Node or Bun imports: the editor's browser code uses this module too.

export interface MidiTempo {
  /** Tick of the change. */
  tick: number;
  /** Microseconds per quarter note. */
  usPerQuarter: number;
  bpm: number;
}

export interface MidiTimeSignature {
  tick: number;
  numerator: number;
  /** The note value of one beat of the bar (4 = quarter note). */
  denominator: number;
}

export interface MidiProgramChange {
  tick: number;
  /** Channel 0..15. */
  channel: number;
  /** Program 0..127 (General MIDI program number minus 1). */
  program: number;
}

export type MidiTextKind = "text" | "copyright" | "name" | "instrument" | "lyric" | "marker" | "cue";

export interface MidiText {
  tick: number;
  kind: MidiTextKind;
  /** The raw bytes. Decode with `decodeMidiText`. */
  bytes: Uint8Array;
}

export interface MidiNote {
  /** Channel 0..15. Channel 9 (the "channel 10" of the specification) is the drum channel. */
  channel: number;
  /** Key 0..127. On the drum channel it is the drum sound. */
  pitch: number;
  /** Velocity of the note on, 1..127. */
  velocity: number;
  tick: number;
  /** Tick of the matching note off (or of the end of the track when there was none). */
  endTick: number;
  drum: boolean;
}

export interface MidiTrack {
  /** 0-based index in the file. */
  index: number;
  /** Bytes of the first track name event, or null. */
  nameBytes: Uint8Array | null;
  programs: MidiProgramChange[];
  notes: MidiNote[];
  texts: MidiText[];
  /** Tick of the end of the track. */
  endTick: number;
}

export interface Midi {
  format: 0 | 1;
  /** Ticks per quarter note. */
  division: number;
  tracks: MidiTrack[];
  /** The tempo map, sorted by tick, merged over all tracks. Always has an entry at tick 0 (120 BPM when the file sets none). */
  tempos: MidiTempo[];
  /** Sorted by tick. Empty when the file has none (4/4 then). */
  timeSignatures: MidiTimeSignature[];
  /** Largest end tick of all tracks. */
  ticks: number;
}

const TEXT_KINDS: Readonly<Record<number, MidiTextKind>> = {
  0x01: "text",
  0x02: "copyright",
  0x03: "name",
  0x04: "instrument",
  0x05: "lyric",
  0x06: "marker",
  0x07: "cue",
};

/** The drum channel (0-based). */
export const MIDI_DRUM_CHANNEL = 9;

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array, readonly what: string) {}
  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }
  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error(`MIDI: ${this.what} ends in the middle of an event.`);
    return this.bytes[this.pos++]!;
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    throw new Error(`MIDI: ${this.what} has a variable-length number longer than 4 bytes.`);
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error(`MIDI: ${this.what} ends in the middle of an event.`);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  tag(): string {
    return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8());
  }
}

function parseTrack(chunk: Uint8Array, index: number, tempos: MidiTempo[], signatures: MidiTimeSignature[]): MidiTrack {
  const r = new Reader(chunk, `track ${index}`);
  const track: MidiTrack = { index, nameBytes: null, programs: [], notes: [], texts: [], endTick: 0 };
  // Open note ons per channel and key, oldest first. A note off closes the oldest one.
  const open = new Map<number, MidiNote[]>();
  let tick = 0;
  let status = 0;
  let ended = false;
  while (!r.eof && !ended) {
    tick += r.vlq();
    let first = r.u8();
    if (first < 0x80) {
      if (status === 0) throw new Error(`MIDI: track ${index} starts with a data byte and has no running status.`);
      r.pos--;
      first = status;
    } else if (first < 0xf0) {
      status = first;
    }
    if (first === 0xff) {
      const type = r.u8();
      const data = r.take(r.vlq());
      if (type === 0x2f) {
        ended = true;
      } else if (type === 0x51) {
        if (data.length !== 3) throw new Error(`MIDI: track ${index} has a tempo event of ${data.length} bytes.`);
        const us = (data[0]! << 16) | (data[1]! << 8) | data[2]!;
        if (us <= 0) throw new Error(`MIDI: track ${index} has a tempo of 0.`);
        tempos.push({ tick, usPerQuarter: us, bpm: 60e6 / us });
      } else if (type === 0x58) {
        if (data.length < 2) throw new Error(`MIDI: track ${index} has a short time signature event.`);
        signatures.push({ tick, numerator: data[0]!, denominator: 2 ** data[1]! });
      } else {
        const kind = TEXT_KINDS[type];
        if (kind) {
          const bytes = data.slice();
          track.texts.push({ tick, kind, bytes });
          if (kind === "name" && track.nameBytes === null) track.nameBytes = bytes;
        }
      }
      continue;
    }
    if (first === 0xf0 || first === 0xf7) {
      r.take(r.vlq());
      continue;
    }
    const type = first & 0xf0;
    const channel = first & 0x0f;
    if (type === 0xc0) {
      track.programs.push({ tick, channel, program: r.u8() });
    } else if (type === 0xd0) {
      r.u8();
    } else {
      const a = r.u8();
      const b = r.u8();
      if (type === 0x90 && b > 0) {
        const note: MidiNote = { channel, pitch: a, velocity: b, tick, endTick: tick, drum: channel === MIDI_DRUM_CHANNEL };
        track.notes.push(note);
        const key = channel * 128 + a;
        const list = open.get(key);
        if (list) list.push(note);
        else open.set(key, [note]);
      } else if (type === 0x80 || type === 0x90) {
        const list = open.get(channel * 128 + a);
        const note = list?.shift();
        if (note) note.endTick = tick;
      }
    }
  }
  track.endTick = tick;
  for (const list of open.values()) for (const n of list) n.endTick = tick;
  track.notes.sort((x, y) => x.tick - y.tick || x.pitch - y.pitch);
  return track;
}

/** Parses the bytes of a Standard MIDI file (format 0 or 1). */
export function parseMidi(bytes: Uint8Array): Midi {
  const r = new Reader(bytes, "file");
  if (bytes.length < 14 || r.tag() !== "MThd") throw new Error("MIDI: the file does not start with MThd.");
  const headerLen = r.u32();
  if (headerLen < 6) throw new Error(`MIDI: the header chunk has ${headerLen} bytes (6 needed).`);
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  r.take(headerLen - 6);
  if (format > 1) throw new Error(`MIDI: format ${format} is not supported (format 0 and 1 are).`);
  if (division & 0x8000) throw new Error("MIDI: SMPTE time division is not supported (ticks per quarter note are).");
  if (division === 0) throw new Error("MIDI: the time division is 0.");
  const tempos: MidiTempo[] = [];
  const signatures: MidiTimeSignature[] = [];
  const tracks: MidiTrack[] = [];
  while (tracks.length < trackCount && !r.eof) {
    if (r.bytes.length - r.pos < 8) throw new Error("MIDI: the file ends in the middle of a chunk header.");
    const tag = r.tag();
    const len = r.u32();
    const body = r.take(len);
    if (tag === "MTrk") tracks.push(parseTrack(body, tracks.length, tempos, signatures));
  }
  if (tracks.length < trackCount) throw new Error(`MIDI: the header says ${trackCount} tracks, the file has ${tracks.length}.`);
  tempos.sort((a, b) => a.tick - b.tick);
  // Of several tempo events at the same tick the last one counts.
  const map: MidiTempo[] = [];
  for (const t of tempos) {
    if (map.length > 0 && map[map.length - 1]!.tick === t.tick) map[map.length - 1] = t;
    else map.push(t);
  }
  if (map.length === 0 || map[0]!.tick > 0) map.unshift({ tick: 0, usPerQuarter: 500000, bpm: 120 });
  signatures.sort((a, b) => a.tick - b.tick);
  return { format: format as 0 | 1, division, tracks, tempos: map, timeSignatures: signatures, ticks: Math.max(0, ...tracks.map((t) => t.endTick)) };
}

/** Seconds at `tick`, through the tempo map. */
export function midiTickToSeconds(midi: Midi, tick: number): number {
  let seconds = 0;
  let last = midi.tempos[0]!;
  for (let i = 1; i < midi.tempos.length; i++) {
    const next = midi.tempos[i]!;
    if (next.tick >= tick) break;
    seconds += ((next.tick - last.tick) * last.usPerQuarter) / midi.division / 1e6;
    last = next;
  }
  return seconds + ((tick - last.tick) * last.usPerQuarter) / midi.division / 1e6;
}

/**
 * Decodes the bytes of a MIDI text event. UTF-8 when the bytes are valid UTF-8 (pure ASCII included), else Shift_JIS (CP932).
 * `encoding` forces one ("utf-8", "shift_jis", "gbk" or another label of TextDecoder). The file does not say which one it uses, so
 * the default can be wrong for a Chinese file (GBK bytes often read as valid Shift_JIS).
 */
export function decodeMidiText(bytes: Uint8Array, encoding?: string): string {
  if (encoding !== undefined) return new TextDecoder(encoding).decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** The decoded name of a track, or "" when it has none. */
export function midiTrackName(track: MidiTrack, encoding?: string): string {
  return track.nameBytes === null ? "" : decodeMidiText(track.nameBytes, encoding);
}

/** The General MIDI instrument names, by program number 0..127. */
export const GM_PROGRAM_NAMES: readonly string[] = [
  "Acoustic Grand Piano", "Bright Acoustic Piano", "Electric Grand Piano", "Honky-tonk Piano", "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet",
  "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
  "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
  "Acoustic Guitar (nylon)", "Acoustic Guitar (steel)", "Electric Guitar (jazz)", "Electric Guitar (clean)", "Electric Guitar (muted)", "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics",
  "Acoustic Bass", "Electric Bass (finger)", "Electric Bass (pick)", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
  "Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani",
  "String Ensemble 1", "String Ensemble 2", "Synth Strings 1", "Synth Strings 2", "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
  "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass Section", "Synth Brass 1", "Synth Brass 2",
  "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet",
  "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
  "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)", "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass + lead)",
  "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)", "Pad 5 (bowed)", "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)",
  "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)", "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)",
  "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
  "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
  "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet", "Telephone Ring", "Helicopter", "Applause", "Gunshot",
];

/** The General MIDI drum key names that matter for reactivity. Other keys are named "Drum <key>". */
export const GM_DRUM_NAMES: Readonly<Record<number, string>> = {
  35: "Acoustic Bass Drum", 36: "Bass Drum 1", 37: "Side Stick", 38: "Acoustic Snare", 39: "Hand Clap", 40: "Electric Snare",
  41: "Low Floor Tom", 42: "Closed Hi-Hat", 43: "High Floor Tom", 44: "Pedal Hi-Hat", 45: "Low Tom", 46: "Open Hi-Hat",
  47: "Low-Mid Tom", 48: "Hi-Mid Tom", 49: "Crash Cymbal 1", 50: "High Tom", 51: "Ride Cymbal 1", 52: "Chinese Cymbal",
  53: "Ride Bell", 54: "Tambourine", 55: "Splash Cymbal", 56: "Cowbell", 57: "Crash Cymbal 2", 59: "Ride Cymbal 2",
};

export type MidiDrumRole = "kick" | "snare" | "hat" | "tom" | "crash" | "ride" | "other";

/** The role of a drum key: kick 35/36, snare 37/38/40 (and clap 39), hat 42/44/46, toms 41/43/45/47/48/50, crash 49/55/57/52, ride 51/53/59. */
export function midiDrumRole(key: number): MidiDrumRole {
  if (key === 35 || key === 36) return "kick";
  if (key === 37 || key === 38 || key === 39 || key === 40) return "snare";
  if (key === 42 || key === 44 || key === 46) return "hat";
  if (key === 41 || key === 43 || key === 45 || key === 47 || key === 48 || key === 50) return "tom";
  if (key === 49 || key === 52 || key === 55 || key === 57) return "crash";
  if (key === 51 || key === 53 || key === 59) return "ride";
  return "other";
}
