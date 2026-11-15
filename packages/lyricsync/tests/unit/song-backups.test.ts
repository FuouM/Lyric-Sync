// packages/lyricsync/tests/unit/song-backups.test.ts
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BACKUP_DIR, snapshotsToPrune } from '../../src/backup-policy.ts';
import { backupSongFiles } from '../../src/song-backups.ts';

let dir = '';
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('song backups', () => {
  test('a snapshot keeps the files, and the lyrics they belong to, as they were before the operation, also when it writes twice', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricsync-backup-'));
    const cal = path.join(dir, 'user_input', 'lyrics.calibrated.json');
    fs.mkdirSync(path.dirname(cal), { recursive: true });
    fs.writeFileSync(cal, 'before');
    fs.writeFileSync(path.join(dir, 'user_input', 'lyrics.txt'), 'old lyrics');

    const at = new Date('2026-11-15T09:17:02.400Z');
    const snap = backupSongFiles(dir, ['user_input/lyrics.calibrated.json'], 'save', at)!;
    fs.writeFileSync(path.join(dir, 'user_input', 'lyrics.txt'), 'new lyrics');
    fs.writeFileSync(cal, 'first write');
    expect(backupSongFiles(dir, ['user_input/lyrics.calibrated.json'], 'save', new Date('2026-11-15T09:17:02.900Z'))).toBeNull();
    fs.writeFileSync(cal, 'second write');

    expect(path.basename(snap)).toBe('2026-11-15T09-17-02Z_save');
    expect(fs.readFileSync(path.join(snap, 'user_input', 'lyrics.calibrated.json'), 'utf8')).toBe('before');
    expect(fs.readFileSync(path.join(snap, 'user_input', 'lyrics.txt'), 'utf8')).toBe('old lyrics');
    expect(fs.existsSync(path.join(snap, 'user_input', 'lyrics.sync.json'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, BACKUP_DIR))).toEqual([path.basename(snap)]);
    expect(backupSongFiles(dir, ['user_input/missing.json'], 'save')).toBeNull();
  });

  test('pruning drops the oldest snapshots and ignores other folders', () => {
    const names = ['2026-11-15T09-00-02Z_save', 'notes', '2026-11-14T23-59-59Z_retime', '2026-11-15T09-00-01Z_save'];
    expect(snapshotsToPrune(names, 2)).toEqual(['2026-11-14T23-59-59Z_retime']);
    expect(snapshotsToPrune(names, 5)).toEqual([]);
  });
});
