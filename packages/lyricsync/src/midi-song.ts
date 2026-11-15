// src/midi-song.ts
// `lyricsync midi`: the notes of a MIDI file on the song beat grid. A MIDI tick is a musical position (tick / division quarter-note
// beats), so the MIDI tempo is not used: song beat = MIDI beat + offset, and the time comes from the song beat grid
// (generated/timing.ai.json), or from a constant tempo when one is given.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beatTime } from './beat-grid.ts';
import { GM_PROGRAM_NAMES, decodeMidiText, midiDrumRole, parseMidi, type Midi, type MidiDrumRole } from './formats/midi.ts';
import { readTimingAi } from './song-folder.ts';

export interface MidiNoteEvent {
  /** Index of the MIDI track. */
  track: number;
  /** Channel 1..16 (10 is the drum channel). */
  channel: number;
  /** General MIDI program 0..127 in force at the note; null for drums. */
  program: number | null;
  /** Drum role by key (kick, snare, hat, tom, crash, ride, other); null for a pitched note. */
  role: MidiDrumRole | null;
  pitch: number;
  velocity: number;
  /** Song beat of the note start (MIDI beat + offset). */
  beat: number;
  /** Song beat of the note end. */
  endBeat: number;
  start: number;
  end: number;
}

export interface MidiTrackInfo {
  track: number;
  name: string;
  channels: number[];
  programs: Array<{ program: number; name: string }>;
  notes: number;
}

export interface MidiNotesFile {
  v: 1;
  /** File name of the MIDI file (no folder). */
  source: string;
  offsetBeats: number;
  /** "beats": time from the song beat grid. A number: time = beat * 60 / bpm. */
  grid: 'beats' | number;
  /** Ticks per quarter note of the MIDI file. */
  division: number;
  midiBpm: number[];
  tracks: MidiTrackInfo[];
  /** Notes left out because they start before beat 0 or after the song end. */
  dropped: number;
  notes: MidiNoteEvent[];
}

export interface MidiNotesOptions {
  /** Song beats added to every MIDI beat. Default 0. */
  offsetBeats?: number;
  /** A constant tempo for the time of a beat, instead of the song beat grid. */
  bpm?: number;
  /** Text encoding of the track names (a TextDecoder label). Default: UTF-8, else Shift_JIS. */
  encoding?: string;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** The notes of `midi` on the beat grid `beats` (seconds per beat) of a song `duration` seconds long. Sorted by start, then track, then pitch. */
export function midiNotesFile(midi: Midi, source: string, beats: readonly number[], duration: number, options: MidiNotesOptions = {}): MidiNotesFile {
  const offset = options.offsetBeats ?? 0;
  const timeOf = options.bpm === undefined ? (b: number): number => beatTime(beats, b) : (b: number): number => (b * 60) / options.bpm!;
  const notes: MidiNoteEvent[] = [];
  const tracks: MidiTrackInfo[] = [];
  let dropped = 0;
  for (const t of midi.tracks) {
    const channels = [...new Set(t.notes.map((n) => n.channel + 1))].sort((a, b) => a - b);
    const programs = [...new Set(t.programs.map((p) => p.program))].map((program) => ({ program, name: GM_PROGRAM_NAMES[program] ?? `Program ${program}` }));
    tracks.push({ track: t.index, name: t.nameBytes === null ? '' : decodeMidiText(t.nameBytes, options.encoding), channels, programs, notes: t.notes.length });
    // Program changes of one channel, in tick order: the last one at or before the note counts. Before the first one, program 0.
    const changes = [...t.programs].sort((a, b) => a.tick - b.tick);
    for (const n of t.notes) {
      const beat = n.tick / midi.division + offset;
      const time = timeOf(beat);
      if (beat < 0 || time > duration) {
        dropped++;
        continue;
      }
      const endBeat = n.endTick / midi.division + offset;
      let program = 0;
      for (const c of changes) if (c.channel === n.channel && c.tick <= n.tick) program = c.program;
      notes.push({
        track: t.index,
        channel: n.channel + 1,
        program: n.drum ? null : program,
        role: n.drum ? midiDrumRole(n.pitch) : null,
        pitch: n.pitch,
        velocity: n.velocity,
        beat: round6(beat),
        endBeat: round6(endBeat),
        start: round6(time),
        end: round6(timeOf(endBeat)),
      });
    }
  }
  notes.sort((a, b) => a.start - b.start || a.track - b.track || a.pitch - b.pitch);
  return {
    v: 1,
    source,
    offsetBeats: offset,
    grid: options.bpm ?? 'beats',
    division: midi.division,
    midiBpm: [...new Set(midi.tempos.map((t) => round6(t.bpm)))],
    tracks,
    dropped,
    notes,
  };
}

/** Reads `file` and the beat grid of the song folder `dir`, and returns the notes on the grid. */
export function songMidiNotes(dir: string, file: string, options: MidiNotesOptions = {}): MidiNotesFile {
  const grid = readTimingAi(dir);
  let midi: Midi;
  try {
    midi = parseMidi(new Uint8Array(fs.readFileSync(file)));
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return midiNotesFile(midi, path.basename(file), grid.beats, grid.duration, options);
}
