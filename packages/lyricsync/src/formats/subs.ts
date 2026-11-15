// src/formats/subs.ts
// Subtitle cues with a karaoke highlight, and the writers for SRT, TTML, ASS and YTT (YouTube timed text, srv3).
// The token that is sung now is yellow, the tokens before it are white and the tokens after it are grey. A subtitle file has no
// running highlight, so every change of state is its own cue: the whole line again, with another token lit.
// Pure functions. No Node or Bun imports, no file access.
import type { CalibrationDoc } from '../calibration-doc.ts';

export type CueState = 'pending' | 'sung' | 'done';
export type SubFormat = 'ttml' | 'srt' | 'ass' | 'ytt';
export const SUB_FORMATS: readonly SubFormat[] = ['ttml', 'srt', 'ass', 'ytt'];

/** A stretch of a row that has one state, or the `gap` (the space between two such stretches), which has no colour. */
export interface Run {
  text: string;
  state: CueState | 'gap';
}

/**
 * The text on screen from `start` to `end` (s): one or two rows of runs.
 * `role` names the place of the cue in the picture (for example one singer). Cues of one role never overlap.
 * Cues of different roles may overlap: ASS and YTT put each role on its own row of the screen.
 */
export interface Cue {
  start: number;
  end: number;
  rows: Run[][];
  role?: string;
}

export const COLORS: Record<CueState, string> = { sung: '#FFD84A', done: '#FFFFFF', pending: '#A0A0A0' };

/** `[text, from, to]`, or `[text, from, to, true]` when no joiner goes before the token (the next syllable of a word). */
export type CueToken = [text: string, from: number, to: number, glued?: boolean];

/** A line of one row: its time (s), its tokens, and the text that goes between two tokens (a space for words, nothing for Japanese). */
export interface CueLine {
  start: number;
  end: number;
  tokens: CueToken[];
  joiner: string;
}

export interface CueOptions {
  /** A line shows this long (s) before its first token is sung. */
  lead: number;
  /** A line shows this long (s) after its last token. */
  tail: number;
  /** Nothing runs past this time (s). */
  limit?: number;
  /** The role of every cue. */
  role?: string;
}

/** The lead and the tail that `export subs` uses. */
export const CUE_LEAD = 0.25;
export const CUE_TAIL = 0.7;

/** Two state changes closer than this (s) are one: a cue this short is not read. */
const MIN_CUE = 0.03;

const t3 = (x: number): number => Math.round(x * 1000) / 1000;

/** The state of the token [from, to) over the interval [a, b). */
function stateOf(from: number, to: number, a: number, b: number): CueState {
  const m = (a + b) / 2;
  if (to <= m) return 'done';
  return from <= m ? 'sung' : 'pending';
}

/** The runs of a row: the tokens of one state are one run, and the space between two runs is a gap of its own, so no coloured run starts or ends with a space. */
function rowRuns(line: CueLine, a: number, b: number): Run[] {
  const runs: Run[] = [];
  for (const [raw, from, to, glued] of line.tokens) {
    const text = raw.trim();
    if (!text) continue;
    const joiner = glued === true ? '' : line.joiner;
    const state = stateOf(from, to, a, b);
    const last = runs[runs.length - 1];
    if (last && last.state === state) last.text += joiner + text;
    else {
      if (last && joiner) runs.push({ text: joiner, state: 'gap' });
      runs.push({ text, state });
    }
  }
  return runs;
}

/**
 * The cues of a list of line groups, in time order. A group is the rows that show together (the romaji and the Japanese of one line).
 * Each group shows from `lead` before its first token to `tail` after its last. The next group may take the end of this one.
 */
export function buildCues(groups: CueLine[][], opts: CueOptions): Cue[] {
  const limit = opts.limit ?? Infinity;
  const out: Cue[] = [];
  let prevEnd = 0;
  groups.forEach((rows, gi) => {
    const first = Math.min(...rows.map((r) => r.start));
    const last = Math.max(...rows.map((r) => r.end));
    const next = groups[gi + 1] ? Math.min(...groups[gi + 1]!.map((r) => r.start)) : Infinity;
    const start = Math.max(first - opts.lead, prevEnd);
    const end = t3(Math.max(last, Math.min(last + opts.tail, next - opts.lead)));
    // every start and end of a token inside the line is a change of state
    const marks = new Set<number>([t3(start), end]);
    for (const r of rows) for (const [, from, to] of r.tokens) for (const x of [from, to]) if (x > start && x < end) marks.add(t3(x));
    const cuts: number[] = [];
    for (const x of [...marks].sort((a, b) => a - b)) {
      if (!cuts.length || x - cuts[cuts.length - 1]! >= MIN_CUE || x === end) cuts.push(x);
    }
    const pieces: Cue[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i]!;
      const b = cuts[i + 1]!;
      if (b <= a) continue;
      const rowsHere = rows.map((r) => rowRuns(r, a, b));
      const prev = pieces[pieces.length - 1];
      if (prev && JSON.stringify(prev.rows) === JSON.stringify(rowsHere)) prev.end = b;
      else pieces.push({ start: a, end: b, rows: rowsHere });
    }
    out.push(...pieces);
    prevEnd = end;
  });
  const kept = out.filter((c) => c.start < limit).map((c) => (c.end > limit ? { ...c, end: limit } : c));
  const cs = quantizeCues(kept);
  return opts.role === undefined ? cs : cs.map((c) => ({ ...c, role: opts.role }));
}

/**
 * Every time is a whole number of centiseconds, as in YouTube Studio. A cue that touches the next one keeps the
 * same time as it, and a gap under 50 ms (a dropped cue leaves one) is closed: a gap makes the subtitle flash.
 * A cue shorter than two centiseconds is dropped. Give the cues of one role.
 */
export function quantizeCues(cs: Cue[]): Cue[] {
  const cs100 = (x: number): number => Math.round(x * 100) / 100;
  const out = cs.map((c) => ({ ...c, start: cs100(c.start), end: cs100(c.end) })).filter((c) => c.end - c.start >= 0.02 - 1e-9);
  for (let i = 0; i + 1 < out.length; i++) if (out[i + 1]!.start - out[i]!.end < 0.05) out[i]!.end = out[i + 1]!.start;
  return out;
}

/** `hh:mm:ss<sep>mmm`. The time is rounded to whole milliseconds first, so 59.9995 s is 00:01:00.000 and never 00:00:59.1000. */
function stamp(s: number, sep: '.' | ','): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000), 2)}:${p(Math.floor(ms / 60_000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)}${sep}${p(ms % 1000, 3)}`;
}

const xml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const html = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** SubRip: `<font color>` runs. For offline players. */
export function toSrt(cs: Cue[]): string {
  return cs
    .map((c, i) => {
      const body = c.rows.map((row) => row.map((r) => (r.state === 'gap' ? html(r.text) : `<font color="${COLORS[r.state]}">${html(r.text)}</font>`)).join('')).join('\n');
      return `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${body}\n`;
    })
    .join('\n');
}

/** TTML: one `p` per cue, a coloured `span` per run, a `br` between rows. */
export function toTtml(cs: Cue[], lang: string): string {
  const ps = cs.map((c) => {
    const body = c.rows.map((row) => row.map((r) => (r.state === 'gap' ? xml(r.text) : `<span tts:color="${COLORS[r.state]}">${xml(r.text)}</span>`)).join('')).join('<br/>');
    return `      <p begin="${stamp(c.start, '.')}" end="${stamp(c.end, '.')}" xml:space="preserve">${body}</p>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xml:lang="${xml(lang)}">`,
    '  <body>',
    '    <div>',
    ...ps,
    '    </div>',
    '  </body>',
    '</tt>',
    '',
  ].join('\n');
}

const DEFAULT_ROLE = 'main';

/** The roles of `cs` in order of first appearance (the first role sits lowest on the screen), or `roles` when given. */
function rolesOf(cs: Cue[], roles?: readonly string[]): string[] {
  const out = roles ? [...roles] : [];
  for (const c of cs) {
    const r = c.role ?? DEFAULT_ROLE;
    if (!out.includes(r)) out.push(r);
  }
  return out.length ? out : [DEFAULT_ROLE];
}

export interface AssOptions {
  /** The roles from the lowest row of the screen up. Default: order of first appearance. */
  roles?: readonly string[];
  fontName?: string;
  /** Pixels on a 1080 px high picture. */
  fontSize?: number;
}

const ASS_W = 1920;
const ASS_H = 1080;
const ZWSP = '\u200B';

/** The ASS time `h:mm:ss.cc`, rounded to whole centiseconds first. */
function assStamp(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const p = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${Math.floor(cs / 360_000)}:${p(Math.floor(cs / 6000) % 60, 2)}:${p(Math.floor(cs / 100) % 60, 2)}.${p(cs % 100, 2)}`;
}

/** `#RRGGBB` as the ASS colour `&HBBGGRR&`. */
function assColor(hex: string): string {
  return `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`;
}

/**
 * ASS text: `{` and `}` are escaped as `\{` and `\}`, a line break in the text is a space, and a backslash gets a zero width space
 * after it so that it never makes `\N`, `\n` or `\h` or a tag.
 */
function assText(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/[\\{}]/g, (c) => (c === '\\' ? `\\${ZWSP}` : `\\${c}`));
}

/**
 * Advanced SubStation Alpha: one Style per role. Each role has its own row of the screen, the first role lowest, so cues of
 * different roles may overlap in time and still never cover each other. A cue of two rows is one Dialogue with `\N` between the rows.
 */
export function toAss(cs: Cue[], opts: AssOptions = {}): string {
  const roles = rolesOf(cs, opts.roles);
  // a style name has no comma and no line break
  const names = roles.map((role) => role.replace(/[,\r\n]/g, '_').trim() || DEFAULT_ROLE);
  if (new Set(names).size !== names.length) throw new Error(`ASS style names are not unique: ${names.join(', ')}`);
  const font = opts.fontName ?? 'Arial';
  const size = opts.fontSize ?? 54;
  const slot = Math.round(size * 1.3 * Math.max(1, ...cs.map((c) => c.rows.length)));
  const base = Math.round(size * 0.75);
  const primary = assColor(COLORS.done).replace('&H', '&H00').slice(0, -1);
  const styles = roles.map((_, i) => `Style: ${names[i]},${font},${size},${primary},&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,${base + i * slot},1`);
  const events = cs.map((c) => {
    const style = names[roles.indexOf(c.role ?? DEFAULT_ROLE)]!;
    const body = c.rows.map((row) => row.map((r) => (r.state === 'gap' ? assText(r.text) : `{\\c${assColor(COLORS[r.state])}}${assText(r.text)}`)).join('')).join('\\N');
    return `Dialogue: 0,${assStamp(c.start)},${assStamp(c.end)},${style},,0,0,0,,${body}`;
  });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${ASS_W}`,
    `PlayResY: ${ASS_H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

export interface YttOptions {
  /** The roles from the lowest row of the screen up. Default: order of first appearance. */
  roles?: readonly string[];
}

const YTT_PENS: Record<CueState, number> = { sung: 1, done: 2, pending: 3 };

/**
 * YouTube timed text (srv3): a pen for each colour and a window position for each role. The first role is lowest on the screen.
 * Every `p` has `t` and `d` in whole milliseconds. A row break is a line feed. A space between two runs goes in front of the next run.
 */
export function toYtt(cs: Cue[], opts: YttOptions = {}): string {
  const roles = rolesOf(cs, opts.roles);
  const slot = Math.max(1, ...cs.map((c) => c.rows.length)) * 9;
  const pens = (Object.keys(YTT_PENS) as CueState[]).map((s) => `<pen id="${YTT_PENS[s]}" fc="${COLORS[s]}" fo="254" bo="0"/>`);
  const windows = roles.map((_, i) => `<wp id="${i + 1}" ap="7" ah="50" av="${Math.max(0, 94 - i * slot)}"/>`);
  const ps = cs.map((c) => {
    const wp = roles.indexOf(c.role ?? DEFAULT_ROLE) + 1;
    const t = Math.round(c.start * 1000);
    const d = Math.round(c.end * 1000) - t;
    const rows = c.rows.map((row) => {
      let pending = '';
      let out = '';
      for (const r of row) {
        if (r.state === 'gap') pending += r.text;
        else {
          out += `<s p="${YTT_PENS[r.state]}">${xml(pending + r.text)}</s>`;
          pending = '';
        }
      }
      return out;
    });
    return `<p t="${t}" d="${d}" wp="${wp}" ws="1">${rows.join('\n')}</p>`;
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<timedtext format="3">',
    '<head>',
    ...pens,
    '<ws id="1" ju="2" pd="0" sd="0"/>',
    ...windows,
    '</head>',
    '<body>',
    ...ps,
    '</body>',
    '</timedtext>',
    '',
  ].join('\n');
}

/** The cues as the text of a subtitle file. `lang` goes into TTML only. `roles` (the rows of the screen, lowest first) go into ASS and YTT only. */
export function renderCues(cs: Cue[], format: SubFormat, lang: string, roles?: readonly string[]): string {
  switch (format) {
    case 'srt':
      return toSrt(cs);
    case 'ttml':
      return toTtml(cs, lang);
    case 'ass':
      return toAss(cs, { roles });
    case 'ytt':
      return toYtt(cs, { roles });
  }
}

/** A sung syllable that is only for the timing, written `(o)`. It is never shown. */
const isGhost = (s: string): boolean => /^\(.*\)$/.test(s.trim());

/**
 * The lines of a calibration file as cue lines: one token per syllable, so a line lights syllable by syllable. The syllables of a word
 * are glued (`re` `con` `cil` show as `reconcil`) and a space goes between words. Ghost syllables `(o)` are left out.
 */
export function calibrationCueLines(doc: CalibrationDoc, joiner = ' '): CueLine[] {
  return doc.lines
    .map((line) => {
      const tokens: CueToken[] = [];
      for (const word of line.words) {
        let first = true;
        word.syl.forEach(([from, to], si) => {
          const text = word.sylText[si] ?? '';
          if (!text.trim() || isGhost(text)) return;
          tokens.push([text, from, to, !first]);
          first = false;
        });
      }
      return { start: line.start, end: line.end, tokens, joiner };
    })
    .filter((l) => l.tokens.length > 0)
    .sort((a, b) => a.start - b.start);
}

/** The cues of a calibration file: each line alone on the screen, as `buildCues` shows it. */
export function calibrationCues(doc: CalibrationDoc, opts: Partial<CueOptions> = {}): Cue[] {
  const lines = calibrationCueLines(doc);
  return buildCues(
    lines.map((l) => [l]),
    { lead: CUE_LEAD, tail: CUE_TAIL, ...opts },
  );
}
