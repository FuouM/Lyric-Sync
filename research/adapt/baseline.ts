// usage (repo root): bun research/adapt/baseline.ts [--songs a,b] [--device cpu|gpu]
// Free solve (no pins) per song vs the full calibrated truth, snap on and off; dumps the solved times to .cache/adapt/free_<id>_snap<bool>.json
import * as fs from 'node:fs';
import { argFlag, fmt, loadSong, score, SONG_IDS, solve } from './lib.ts';
import { emptyAnchors } from '../../packages/lyricsync/src/workspace/anchors.ts';

const ids = argFlag('--songs', SONG_IDS.join(',')).split(',');
for (const id of ids) {
  const song = await loadSong(id);
  for (const snap of [true, false]) {
    const t0 = performance.now();
    const out = await solve(song, emptyAnchors(), snap);
    const ms = performance.now() - t0;
    fs.writeFileSync(`.cache/adapt/free_${id}_snap${snap}.json`, JSON.stringify(out));
    console.log(`${id.padEnd(16)} snap=${String(snap).padEnd(5)} ${fmt(score(song, out))}  (${ms.toFixed(0)} ms)`);
  }
}
