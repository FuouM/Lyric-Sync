// src/subs-song.ts
// `lyricsync export subs`: subtitle files from the calibration files of a song folder (line by line, a syllable lit at a time).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCalibrationDoc } from './calibration-doc.ts';
import { calibrationTargets, type TargetSelector } from './calibration-files.ts';
import { calibrationCues, renderCues, type Cue, type SubFormat } from './formats/subs.ts';

export interface SubsExportOptions extends TargetSelector {
  formats: readonly SubFormat[];
  /** The folder the files go to. It is made when missing. */
  out: string;
  /** The `xml:lang` of TTML files. Default `und`. */
  lang?: string;
}

export interface SubsFile {
  file: string;
  format: SubFormat;
  /** The singers in the file, the lead first. */
  singers: string[];
  cues: number;
  first: number;
  last: number;
}

/**
 * Writes the subtitle files of the song folder `dir`. The file name is `<song>.<singer>.<format>`.
 * With `all` ASS and YTT also get `<song>.all.<format>` with every singer on its own row of the screen (the lead lowest),
 * so the lines of two singers may overlap. SRT and TTML have no rows, so they stay one file per singer.
 */
export function exportSubs(dir: string, opts: SubsExportOptions): SubsFile[] {
  const song = path.basename(path.resolve(dir));
  const out = path.resolve(opts.out);
  const lang = opts.lang ?? 'und';
  const perSinger = calibrationTargets(dir, opts).map((t) => {
    const doc = parseCalibrationDoc(JSON.parse(fs.readFileSync(t.file, 'utf8')) as unknown);
    return { singer: t.singer, cues: calibrationCues(doc, { role: t.singer }) };
  });
  fs.mkdirSync(out, { recursive: true });
  const written: SubsFile[] = [];
  const write = (name: string, format: SubFormat, singers: string[], cues: Cue[]): void => {
    const file = path.join(out, `${song}.${name}.${format}`);
    fs.writeFileSync(file, renderCues(cues, format, lang, singers), 'utf8');
    written.push({ file, format, singers, cues: cues.length, first: cues[0]?.start ?? 0, last: Math.max(0, ...cues.map((c) => c.end)) });
  };
  for (const format of opts.formats) {
    for (const s of perSinger) write(s.singer, format, [s.singer], s.cues);
    if ((format === 'ass' || format === 'ytt') && perSinger.length > 1) {
      // sorted by start time; Array.sort is stable, so cues that start together keep the order of the singers
      const all = perSinger.flatMap((s) => s.cues).sort((a, b) => a.start - b.start);
      write('all', format, perSinger.map((s) => s.singer), all);
    }
  }
  return written;
}
