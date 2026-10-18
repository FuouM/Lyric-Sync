// packages/lyricsync/tests/unit/train.test.ts
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTrainingManifest } from '../../src/train/songs.ts';

function manifest(songs: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricsync-manifest-'));
  const file = path.join(dir, 'training.json');
  fs.writeFileSync(file, JSON.stringify({ songs }));
  return file;
}

describe('training manifest', () => {
  test('an unnamed song is named after its workspace directory, an explicit id wins, paths resolve against the manifest', () => {
    const file = manifest([
      { workspace: 'ws/songA', calibrated: 'a.json' },
      { id: 'b', workspace: 'songs/b/lyricsync', calibrated: 'b.json', skipLines: [37] },
    ]);
    const [a, b] = readTrainingManifest(file);
    expect(a!.id).toBe('songA');
    expect(b!.id).toBe('b');
    expect(b!.skipLines).toEqual([37]);
    expect(a!.skipLines).toEqual([]);
    expect(a!.workspace).toBe(path.resolve(path.dirname(file), 'ws/songA'));
  });

  test('two songs with the same id are rejected, so workspaces that share a directory name need explicit ids', () => {
    const shared = manifest([
      { workspace: 'a/lyricsync', calibrated: 'a.json' },
      { workspace: 'b/lyricsync', calibrated: 'b.json' },
    ]);
    expect(() => readTrainingManifest(shared)).toThrow(/two songs named "lyricsync"/);
    const named = manifest([
      { id: 'a', workspace: 'a/lyricsync', calibrated: 'a.json' },
      { id: 'b', workspace: 'b/lyricsync', calibrated: 'b.json' },
    ]);
    expect(readTrainingManifest(named).map((s) => s.id)).toEqual(['a', 'b']);
  });
});
