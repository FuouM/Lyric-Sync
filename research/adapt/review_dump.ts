// usage (repo root): bun research/adapt/review_dump.ts [--song god_ish]
// Free solve through Session.solve; writes the per-line review (meanExpectedErrorMs, uncertain boundaries) to .cache/adapt/free_review_<id>.json
import * as fs from 'node:fs';
import { argFlag, loadSong } from './lib.ts';
import { emptyAnchors } from '../../packages/lyricsync/src/workspace/anchors.ts';

const id = argFlag('--song', 'god_ish');
const song = await loadSong(id);
const r = await song.session.solve({ anchors: emptyAnchors(), snapToBeats: true, device: argFlag('--device', 'gpu') === 'cpu' ? 'cpu' : 'gpu' });
fs.writeFileSync(`.cache/adapt/free_review_${id}.json`, JSON.stringify(r.review));
console.log('lines', r.review.length);
