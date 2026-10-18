# AGENTS.md: using lyricsync

Terse operating guide for automated agents. Human-oriented docs: `README.md`, `docs/workflow.md`.

## What it does

`vocal stem + lyrics text (+ beats)` -> `lyrics.json` with word and **syllable** start/end seconds. It can improve a result incrementally from timings you supply. It cannot know the lyrics: the text must be right and complete.

## Preconditions you must satisfy (ask the user if unknown)

1. An **isolated vocal stem** (WAV preferred).
2. **Every sung line** of the lyrics, in order, as `.txt` (one line per line) or `.json`.
3. Language: `en` or `ja` (romaji). Nothing else is supported.
4. Beats: either the full mix **and the song's approximate BPM** (`--mix song.wav --bpm N`) or a `beatsync` JSON (`--beats file.json`). Never guess the BPM; a wrong tempo gives wrong beats.

## Commands (always pass `--json`; progress is on stderr, the result is one JSON document on stdout)

```bash
lyricsync init    <ws> --vocal V --lyrics L --language en|ja (--mix M --bpm N [--first-downbeat S] | --beats B)
lyricsync prepare <ws> [--force]                     # minutes, cached; required before solve
lyricsync solve   <ws> [--out lyrics.json] [--method guided|trained|analytic|simple] [--no-snap]   # guided (default) is the most accurate; --no-snap keeps acoustic times instead of snapping to beats
lyricsync review  <ws> [--top 5]
lyricsync anchor  <ws> --line N [--start S] [--end S] | --boundary N:J=S ... | --import F --level line|word|syllable|flagged [--lines a,b] [--skip-lines a,b] | --clear [--line N] | --list
lyricsync status  <ws>
lyricsync run     <ws> <init options> [--anchors-from F --level L] [--out lyrics.json]   # init + prepare + solve
```

| Command | `--json` result |
|---|---|
| `init` | `{workspace, language, lines, syllables, autoSplit: [{line, word, syllables}]}` |
| `prepare` | `{skipped}` |
| `solve` / `run` | `{out, anchors: {anchoredLines, partialLines, freeLines, pinnedBoundaries}, meanExpectedErrorMs, review: [LineReview]}` |
| `review` | `{lines: [LineReview]}`, `LineReview = {line, mode: "free"\|"anchored", meanExpectedErrorMs, uncertain: [{boundary, time, expectedErrorMs, anchored, syllable}]}` |
| `anchor` | `{changed, anchors}`; with `--list`: `{anchors, lines: [{line, text, pins: [[boundary, seconds]]}]}` |
| `status` | `{dir, language, lines, syllables, prepared, evidenceFresh, anchors, solved}` |

Errors: exit code `1` (or `2` for usage mistakes), a message on stderr, and with `--json` also `{"error": {"message": "..."}}` on stdout. Messages say what to fix; see the table in `docs/workflow.md`.

## Procedure

1. `init`. Read `autoSplit`: these words had their syllable split **derived** (about 72-75% match a human annotator for English). If a split matters, rewrite that word as `a|b|c` in the lyrics and `init` again in a new directory. Unknown-word errors: add `phones` in a JSON lyrics file.
2. `prepare`, then `solve`.
3. `review`. The listed lines/boundaries are where the model was least certain. **Only pin a time you actually measured or were given**, from a human, an annotation file or an independent verifier. Never pin a value you merely estimated from the current result: it adds no information and removes the solver's freedom.
4. Prefer pinning **both edges of a line** (`--start/--end`): that switches the line to the more accurate anchored mode. Pin single syllable boundaries (`--boundary line:j=seconds`) when one syllable is wrong. Import a hand-corrected `lyrics.json` with `--import ... --level line|word|syllable`.
5. `solve` again and re-`review`. Stop when the uncertain boundaries left do not matter to the user, or no more trustworthy timings are available.

## Rules

- Do not edit workspace files by hand; use the commands (`anchors.json` is the only file meant to be edited, through `anchor`).
- Boundary index `j` is the **start of the line's j-th syllable, 0-based, counted across the whole line's words**; `0` is the line start and `m` (the syllable count) the line end. Use `review`'s `boundary` numbers as they are.
- After changing lyrics, the vocal stem or the beat source you must `prepare` again; `solve` refuses to run otherwise (by design). A workspace prepared by an older lyricsync version needs `prepare --force` (the error says so).
- `meanExpectedErrorMs` / `expectedErrorMs` rank uncertainty; they are not calibrated error bars and are not ground truth.
- Read-only for you: `lyrics.def.json`, `evidence/`, `sliced/`, `out/`. The deliverable is `out/lyrics.json` (or `--out`).

## Library equivalents

`Session.init / open`, `session.prepare()`, `session.solve()`, `session.reviewTop(n)`, `session.loadAnchors() / saveAnchors()` with `setLineBounds`, `setBoundary`, `importCalibrated`, `clearAnchors`. Types: `LyricsJson`, `LineReview`, `Anchors`. See `README.md` and `src/index.ts`.
