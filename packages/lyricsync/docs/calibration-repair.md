# Repairing a song's calibration

Use when a song's timing is scrambled, Auto-time fails with `The editor's lines do not match the lyricsync lyrics: …`, or sections overlap/go backwards. Songs live in `songs/<id>/`, which is gitignored: there is no git history, so back up before writing anything.

## Backups: check these first
Before overwriting a hand-made file, the app copies it to `<song>/backups/<UTC time>_<reason>/<path in the song folder>` (`src/backup-policy.ts`, `src/song-backups.ts`), together with the song's `lyrics.txt` and `lyrics.sync.json`, so each backup also holds the lyrics its timing belongs to. Reasons: `save` (editor save, server or folder picker; only when the content changes), `edit-lyrics` (before Edit Lyrics), `reanalyze`, `tempo-map` (`prompt.yaml`), `retime`. The newest 50 snapshots are kept. A snapshot holds the files as they were just before that operation, so the snapshot taken by the operation that broke a song is the state to restore: copy its files back over the song's (reload the song in the editor without saving), or use it as the reference for a partial repair.

In the editor, **File > Backups…** lists the backups of the open calibration file. Picking one shows its line, section and pin counts. **Use this backup** loads it as one undoable, unsaved edit (Save writes it, and backs up the file it replaces). When the backup's lyrics differ from the open ones (it is from before a lyrics edit), **Use this backup and its lyrics…** opens Edit Lyrics with its lyrics; Apply makes them the song's lyrics again and redoes the analysis, keeping the backup's pins. Backups taken before snapshots held the lyrics get the nearest saved `lyrics.txt`, with the lines that differ rebuilt from the backup's timing.

## Files (per song)
- `user_input/lyrics.calibrated.json`: what the editor loads and saves. `lines[i].start/end/calibrated`, `words[].syl[[s,e]]`, `sylCalibrated[]`, `calibrated`; `sections[{id,name,start,end}]`.
- `user_input/lyrics.txt`, `user_input/lyrics.sync.json` (`unannotatedLines`), `lyricsync/anchors.json`, `lyricsync/lyrics.def.json`, `generated/timing.ai.json` (`duration` = song end).
- Code: `packages/lyricsync/web/server/syllables.ts` (`updateLyrics` = Edit Lyrics), `realign.ts` (Auto-time), `wizard.ts` (`calibrationFromSolve`, `sectionsFromOutline`); pin rules in `packages/lyricsync/src/workspace/anchors.ts` (`importCalibrated`, `validateAnchors`).

## Pin semantics (keep them consistent)
- Calibrated line: every syllable boundary is pinned. Calibrated syllable: both of its edges are pinned (`importCalibrated` level `flagged`).
- Pins within a line must increase by at least `MIN_GAP_SEC`; a zero-length calibrated syllable makes Auto-time fail.
- Anything that carries pins across an edit must apply the same rules. Otherwise a solve moves a "pinned" edge and the carried flag then freezes the wrong time.

## 1. Look at the data
```ts
const cal = JSON.parse(await Bun.file("songs/<id>/user_input/lyrics.calibrated.json").text());
for (const l of cal.lines) {
  const pins = l.words.flatMap((w) => w.syl.map((s, i) => (w.sylCalibrated?.[i] ? s[0].toFixed(2) : null))).filter(Boolean);
  console.log(l.i, l.start.toFixed(2), l.end.toFixed(2), l.calibrated ? "C" : " ", pins.join(","), "|", l.text);
}
```
Red flags: line starts going backwards; a repeated line (chorus) whose pins equal an earlier copy's; `start > end`; zero-length calibrated syllables; section starts going backwards.

## 2. Run Auto-time's pin check offline
Run from `packages/lyricsync` (the imports need that package's dependencies). Save as a throwaway file and delete it afterwards:
```ts
// packages/lyricsync/check-pins.tmp.ts
import * as L from "./src/index.ts";
const root = "../../songs/<id>";
const cal = JSON.parse(await Bun.file(root + "/user_input/lyrics.calibrated.json").text());
const def = L.Session.open(root + "/lyricsync").definition;
const skip = JSON.parse(await Bun.file(root + "/user_input/lyrics.sync.json").text()).unannotatedLines ?? [];
for (const [k, l] of cal.lines.entries()) {
  try {
    L.importCalibrated(L.emptyAnchors(), def, { lines: cal.lines }, { level: l.calibrated ? "syllable" : "flagged", lines: [k], skipDefinitionLines: skip });
  } catch (e) {
    console.log(k, e instanceof Error ? e.message : e);
  }
}
```
`cd packages/lyricsync && bun check-pins.tmp.ts`. Every line must pass before Auto-time can.

## 3. Find the cause in code before touching data
Damaged data usually has a code cause; fix that first or it comes back. Known example: `updateLyrics` used to pair old and new lines with `find(text === …)`, which gave every repeated line the first copy's pins. It now uses `matchInOrder` (an LCS), so the k-th copy pairs with the k-th copy. Search for other first-match-by-text lookups across line lists.

## 4. Repair the data (minimal, reversible)
1. Back up: copy the file to `lyrics.calibrated.before-<what>.json` next to it (`backups/` only covers writes the app makes).
2. Change only what is provably wrong:
   - Copied pins: a line with the same text as an earlier line and identical interior pins (compare boundaries 1..m-1, not the line start) → clear the line's `calibrated`, the words' `calibrated`, and set `sylCalibrated` all false.
   - Zero-length calibrated syllable (`end - start < 0.01`) → unflag it. Check whether a neighbouring flagged syllable still pins its start; if not, that pin is lost: tell the user.
   - Sections: keep every start that is in order; replace only the backwards ones with the `sectionsFromOutline(lyricsSectionOutline(lyrics.txt), cal.lines, duration)` values; then each `end` = the next `start` (the last keeps the song end). Auto-time never recomputes sections.
3. Write with `JSON.stringify(cal, null, 2) + "\n"` (the server's format, LF).
4. Run step 2 again: it must report no errors.

## 5. Hand back to the user
- Restart the dev server (`bun run dev` does not reload server code).
- Reload the song without saving first: the editor holds the old document in memory, and Auto-time sends the in-memory lines, not the file.
- Then run Auto-time unpinned. Say which pins were lost and need redoing, and name the backup files.
- Pins overwritten by a bad save cannot be recovered (no history); say so plainly.

## Verify
`bun run typecheck` and `bun run test` from the repo root after any code change. Song data is gitignored: never commit it.
