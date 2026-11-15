// src/song-backups.ts
// Node side of the song backups (policy and layout: backup-policy.ts): copy files into a snapshot before overwriting them.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BACKUP_DIR, BACKUP_WITH, backupSnapshotName, snapshotsToPrune } from './backup-policy.ts';

/**
 * Copies the existing files among `rels` (paths in the song folder, forward slashes) into the snapshot of `reason` at `now`, with
 * the lyrics files (BACKUP_WITH), then prunes old snapshots. Missing files are skipped; a file already in that snapshot is kept
 * (it is the older state). Returns the snapshot folder, or null when none of `rels` was copied.
 */
export function backupSongFiles(songDir: string, rels: readonly string[], reason: string, now: Date = new Date()): string | null {
  const root = path.join(songDir, BACKUP_DIR);
  const snapshot = path.join(root, backupSnapshotName(reason, now));
  let copied = 0;
  for (const rel of rels) {
    const src = path.join(songDir, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const dst = path.join(snapshot, rel);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
  }
  if (copied === 0) return null;
  for (const rel of BACKUP_WITH) {
    const src = path.join(songDir, rel);
    const dst = path.join(snapshot, rel);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  for (const old of snapshotsToPrune(fs.readdirSync(root))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  return snapshot;
}
