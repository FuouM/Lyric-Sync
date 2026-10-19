// Writes <workspace>/guide/contexts.json: every lyric line's syllables with their phones and whether each starts a word, in the order the
// solver flattens them (lyricsync's boundaryContexts, the same input the shipped model's queries get). export_guide.py builds a research
// checkpoint's queries from it.
// usage: bun scripts/gtsinger/export_contexts.ts <workspace dir>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { boundaryContexts } from '../../packages/lyricsync/src/evidence/boundary.ts';
import { parseStoredDefinition } from '../../packages/lyricsync/src/lyrics/parse.ts';

const ws = process.argv[2];
if (!ws) throw new Error('usage: bun scripts/gtsinger/export_contexts.ts <workspace dir>');
const def = parseStoredDefinition(JSON.parse(fs.readFileSync(path.join(ws, 'lyrics.def.json'), 'utf8')));
const lines = boundaryContexts(def);
fs.mkdirSync(path.join(ws, 'guide'), { recursive: true });
fs.writeFileSync(path.join(ws, 'guide', 'contexts.json'), JSON.stringify({ language: def.language, lines }));
console.log(`${ws}: ${lines.length} lines, ${lines.reduce((s, l) => s + l.syllables.length, 0)} syllables`);
