// packages/lyricsync/web/server/project-files.ts
// Song folder access through the dev server, for songs the editor opens without the folder picker (a song the wizard just built).
//   GET /api/project/<id>/file/<path>   file bytes; header X-Mtime-Ms; 404 when missing
//   PUT /api/project/<id>/file/<path>   writes the body; only the calibration and prompt.yaml (bar 1) are writable; returns { mtimeMs }
// Paths stay inside <songs>/<id> (dev.ts --songs).
import * as fs from "node:fs";
import * as path from "node:path";
import { findSongDir, type SongsRoots } from "../../src/song-folder.ts";

const WRITABLE: Record<string, true> = { "user_input/lyrics.calibrated.json": true, "user_input/prompt.yaml": true };

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
  if (!WRITABLE[rel]) throw new ProjectFileError(403, `Only ${Object.keys(WRITABLE).join(" and ")} are writable.`);
  const file = resolve(roots, id, rel);
  fs.writeFileSync(file, body);
  return { mtimeMs: fs.statSync(file).mtimeMs };
}
