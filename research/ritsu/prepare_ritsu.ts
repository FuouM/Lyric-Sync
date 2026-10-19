// Creates and prepares the lyricsync workspaces of the Ritsu benchmark (.cache/ritsu, built by build_ritsu.ts), one song at a
// time (one GPU job). Line anchors come from the truth (anchored mode); prepared workspaces are skipped.
// usage: bun research/ritsu/prepare_ritsu.ts [--init-only] [song ...]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { importCalibrated } from '../../packages/lyricsync/src/workspace/anchors.ts';
import { Session } from '../../packages/lyricsync/src/workspace/session.ts';
import { readTrainingManifest } from '../../packages/lyricsync/src/train/songs.ts';

const ROOT = path.resolve('.cache/ritsu');
const DB = path.resolve('.cache/ritsu_db/「波音リツ Normal」歌声データベース/DATABASE_normal');
const initOnly = process.argv.includes('--init-only');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

for (const entry of readTrainingManifest(path.join(ROOT, 'ritsu.training.json'))) {
  if (only.length && !only.includes(entry.id)) continue;
  const proj = path.join(ROOT, 'projects', entry.id);
  const t0 = Date.now();
  const session = fs.existsSync(path.join(entry.workspace, 'lyricsync.json'))
    ? Session.open(entry.workspace)
    : Session.init({
        dir: entry.workspace,
        vocalPath: path.join(DB, entry.id, `${entry.id}.wav`),
        lyricsPath: path.join(proj, 'lyrics.json'),
        language: 'ja',
        beats: { kind: 'file', path: path.join(proj, 'beats.json') },
      }).session;
  const anchors = session.loadAnchors();
  importCalibrated(anchors, session.definition, JSON.parse(fs.readFileSync(entry.calibrated, 'utf8')), { level: 'line' });
  session.saveAnchors(anchors);
  if (initOnly) {
    console.log(`${entry.id}: ${session.status().lines} lines, ${session.status().syllables} syllables`);
    continue;
  }
  const r = await session.prepare({ onProgress: (m) => console.log(`  [${entry.id}] ${m}`) });
  console.log(`${entry.id}: ${r.skipped ? 'up to date' : `prepared in ${((Date.now() - t0) / 1000).toFixed(0)} s`}`);
}
