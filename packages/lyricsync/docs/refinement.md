# Interactive refinement

lyricsync is built for a loop: solve, find what is probably wrong, tell the solver what you know, solve again. Whoever fixes things (a person with a waveform view, or an agent with a verifier) only has to supply **timings they trust**; the solver re-decodes everything around them.

```
init -> prepare -> solve -> review -> (you fix a few boundaries) -> anchor -> solve -> review -> ...
```

## What you can pin

A **boundary** is the start of a syllable (the end of the previous one). For a line with `m` syllables there are `m + 1` boundaries, numbered `0..m`, flat across the line's words: boundary `0` is the line start, boundary `m` is the line end.

| You know | Command | Effect |
|---|---|---|
| where a line starts and ends | `anchor --line 3 --start 12.30 --end 15.10` | the line becomes **anchored**: both edges exact, and it is solved with the more accurate anchored weights and a forced alignment cut to that window |
| only the start or only the end of a line | `anchor --line 3 --start 12.30` | boundary pinned exactly; the line stays **free** (free weights) |
| where one syllable starts | `anchor --boundary 3:4=13.42` | that boundary is exact; its neighbours are re-decoded around it |
| everything, from a hand-corrected file | `anchor --import fixed.json --level syllable` | every boundary of the imported lines is pinned |
| only what the editor marked calibrated | `anchor --import saved.json --level flagged` | only the edges of syllables flagged `sylCalibrated` (or `calibrated` on the word/line) |

Levels for `--import`: `line` (start/end), `word` (also every word start), `syllable` (every syllable boundary), `flagged` (editor flags). `--lines 0,3` restricts which lines are read; `--skip-lines 37` names lyric lines that have no counterpart in the imported file (a sung line the annotator left out).

Pinned times are written to `anchors.json`; `lyricsync anchor --list` shows them, `--clear [--line n]` removes them.

## Two solving modes, chosen per line

- **free**: nothing known about the line. Uses a full-song forced alignment as the starting point.
- **anchored**: both line edges pinned. Uses a forced alignment cut to the pinned window and weights trained for that situation. This is markedly more accurate, so **pinning line edges is the highest-value thing you can do** (see the accuracy table in the README).

A single solve mixes both: anchored lines and free lines side by side, each with its own weights. Extra pinned boundaries inside either kind of line are always honoured exactly.

## Finding what to fix: `review`

```
lyricsync review <ws> --top 5
```

For every line the solver reports, per unpinned boundary, `expectedErrorMs`: the posterior-expected absolute error of the chosen time under the model (minimum-Bayes-risk decoding). Lines are ranked by their mean. It is a **ranking signal, not a calibrated error bar**: it tells you where the model was torn between candidates, which is where a human check pays off most. Pinned boundaries are 0 and are not listed.

`out/review.json` has the same data for every line (`mode`, `meanExpectedErrorMs`, up to 5 `uncertain` boundaries with their time and the syllable that starts there).

## A good loop

1. `solve` with no anchors. Listen/look at the top of `review`.
2. For lines you can place, pin both edges (`--start/--end`), or import a corrected file at `line` level. Re-`solve`.
3. For individual wrong syllables, pin the boundary (`--boundary line:j=seconds`). Re-`solve`: the neighbours move too.
4. Repeat on the new `review` top. Stop when the remaining uncertain boundaries are ones you do not care about.

## Round trip with the lyrics editor

`lyrics.json` produced by `solve` marks syllables whose both edges you pinned with `sylCalibrated: true` (and `calibrated: true` on the word). That is the convention of the repository's timing editor, so you can open the file there, correct more syllables (which sets the flags), save, and feed it back with `anchor --import saved.json --level flagged`. Syllables the editor did not flag stay free and are re-solved.

## Things that fail loudly (by design)

- Pinned times that are not strictly increasing within a line, or a boundary index outside `0..m`.
- An imported file whose line, word or syllable counts do not match the lyrics (use `--skip-lines`).
- `solve` after the lyrics, vocal stem or beat source changed without a new `prepare`.

Nothing is silently dropped, re-guessed or substituted.
