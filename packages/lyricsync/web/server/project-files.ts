// packages/lyricsync/web/server/project-files.ts
// Song folder access through the dev server, for songs the editor opens without the folder picker (a song the wizard just built).
//   GET /api/project/<id>/file/<path>   file bytes; header X-Mtime-Ms; 404 when missing
//   PUT /api/project/<id>/file/<path>   writes the body; only the calibration files (lyrics.calibrated.json and lyrics.calibrated.<singer id>.json),
//                                       prompt.yaml (bar 1) and placements.json are writable; a changed file is first copied to
//                                       backups/ (src/song-backups.ts); returns { mtimeMs }
// GET serves any file of the song folder, so the render wavs under generated/renders are readable. PUT never writes there.
// Paths stay inside <songs>/<id> (dev.ts --songs).
import * as fs from "node:fs";
import * as path from "node:path";
import { findSongDir, type SongsRoots } from "../../src/song-folder.ts";
import { backupSongFiles } from "../../src/song-backups.ts";

const WRITABLE: Record<string, true> = {
  "user_input/lyrics.calibrated.json": true,
  "user_input/prompt.yaml": true,
  "user_input/placements.json": true,
};
/** The calibration file of a singer other than the lead (src/singers.ts calibratedFileFor). */
const SINGER_CALIBRATION_RE = /^user_input\/lyrics\.calibrated\.[a-z0-9_]+\.json$/;

export class ProjectFileError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function resolve(roots: SongsRoots, id: string, rel: string): string {
  const dir = findSongDir(roots, id);
  if (!dir) throw new ProjectFileError(404, `Song "${id}" not found.`);
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep)) throw new ProjectFileError(400, `Path "${rel}" is outside the song folder.`);
  return file;
}

export function readProjectFile(roots: SongsRoots, id: string, rel: string): { file: string; mtimeMs: number } {
  const file = resolve(roots, id, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ProjectFileError(404, `${id}/${rel} not found.`);
  return { file, mtimeMs: fs.statSync(file).mtimeMs };
}

export function writeProjectFile(roots: SongsRoots, id: string, rel: string, body: Uint8Array): { mtimeMs: number } {
  if (!WRITABLE[rel] && !SINGER_CALIBRATION_RE.test(rel)) {
    throw new ProjectFileError(403, `Only ${Object.keys(WRITABLE).join(", ")} and user_input/lyrics.calibrated.<singer id>.json are writable.`);
  }
  const file = resolve(roots, id, rel);
  if (fs.existsSync(file) && !Buffer.from(body).equals(fs.readFileSync(file))) backupSongFiles(findSongDir(roots, id)!, [rel], "save");
  fs.writeFileSync(file, body);
  return { mtimeMs: fs.statSync(file).mtimeMs };
}
