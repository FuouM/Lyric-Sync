// src/calibration-files.ts
// Which calibration files of a song folder a command works on: the lead's, one singer's, or every singer's.
import * as path from 'node:path';
import { calibratedFileFor } from './singers.ts';
import { readSingers, songFolderPaths } from './song-folder.ts';

export interface CalibrationTarget {
  /** The singer id. `lead` for a song without user_input/singers.json. */
  singer: string;
  /** The calibration file (absolute). */
  file: string;
}

export interface TargetSelector {
  /** One singer of user_input/singers.json. */
  singer?: string;
  /** Every singer, the lead first. */
  all?: boolean;
}

/**
 * The calibration files `sel` names, the lead first, then the other singers in the order of user_input/singers.json.
 * Without a selector it is the lead's file, user_input/lyrics.calibrated.json (also the file of a song without singers.json).
 */
export function calibrationTargets(dir: string, sel: TargetSelector = {}): CalibrationTarget[] {
  if (sel.singer !== undefined && sel.all === true) throw new Error('Use --singer or --all, not both.');
  const paths = songFolderPaths(dir);
  const singers = readSingers(dir);
  if (!singers) {
    if (sel.singer !== undefined) throw new Error(`Singer "${sel.singer}": ${paths.singersFile} not found.`);
    return [{ singer: 'lead', file: paths.calibratedFile }];
  }
  const ordered = [...singers.singers].sort((a, b) => Number(b.lead === true) - Number(a.lead === true));
  const lead = ordered[0]!;
  let chosen = [lead];
  if (sel.all === true) chosen = ordered;
  else if (sel.singer !== undefined) {
    const one = ordered.find((s) => s.id === sel.singer);
    if (!one) throw new Error(`Singer "${sel.singer}" is not in ${paths.singersFile} (singers: ${ordered.map((s) => s.id).join(', ')}).`);
    chosen = [one];
  }
  return chosen.map((s) => ({ singer: s.id, file: path.join(dir, calibratedFileFor(s)) }));
}
