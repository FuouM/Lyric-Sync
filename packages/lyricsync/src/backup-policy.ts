// src/backup-policy.ts
// Backups of a song's hand-made files, taken before something overwrites them (an editor save, Edit Lyrics, a tempo map, retime).
// One snapshot per operation: <song>/backups/<UTC time>_<reason>/<the file's path in the song folder>, holding the files as they
// were just before. Only the newest BACKUP_KEEP snapshots are kept. No node imports: the browser editor (folder picker) takes
// the same snapshots through the File System Access API (lib/song-files.ts); the server and CLI through song-backups.ts.

export const BACKUP_DIR = 'backups';
export const BACKUP_KEEP = 50;

const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[a-z0-9-]+$/;

/**
 * The snapshot folder name for an operation at `now`: "2026-11-15T09-17-02Z_edit-lyrics". Names sort by time. Writes of one
 * operation within the same second share the folder; the first copy of a file there wins, so it holds the state before the operation.
 */
export function backupSnapshotName(reason: string, now: Date = new Date()): string {
  const tag = reason.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'backup';
  return `${now.toISOString().slice(0, 19).replace(/:/g, '-')}Z_${tag}`;
}

/** The snapshot folders of `names` (a listing of the backups folder) to delete so that the newest `keep` remain. */
export function snapshotsToPrune(names: readonly string[], keep: number = BACKUP_KEEP): string[] {
  const snapshots = names.filter((n) => SNAPSHOT_RE.test(n)).sort();
  return snapshots.slice(0, Math.max(0, snapshots.length - keep));
}
