# Workflow guide

From a vocal stem and lyrics to a corrected `lyrics.json`. Every command accepts `--json`; progress goes to stderr, results to stdout.

## 0. Gather the inputs

| Input | What it must be |
|---|---|
| vocal stem | isolated vocals, WAV preferred; includes sung backing vocals if your lyrics have them |
| lyrics | every sung line, in order (`.txt` or `.json`, see [formats.md](formats.md)) |
| language | `en`, or `ja` for romaji |
| beats | the full mix **and its approximate tempo** (`--mix song.wav --bpm 120`), or a beats JSON (`--beats beats.json`, the output of `beatsync`) |

The tempo is a tight prior for the beat tracker (beats are confined to about ±12% of it). Give the song's real tempo; there is no default because a wrong one silently gives wrong beats. If you have a first-downbeat time, add `--first-downbeat 0.32`.

## 1. `init`: create the workspace

```bash
lyricsync init ws --vocal vocal.wav --lyrics lyrics.txt --language en --mix song.wav --bpm 120
```

Check the output:

- `N lines, M syllables`: do they match what you expect? The syllable count is the timing granularity of the result.
- **`Auto-split K words`**: the syllables of those words were derived, not written. Skim the list. Where a split is wrong for your purposes (`wi|thout` where you wanted `with|out`), edit the lyrics file to `with|out` and re-run `init` in a new directory.
- An error naming a word means it is not in the dictionary: put it in a JSON lyrics file with explicit `phones`, or respell it.

## 2. `prepare`: compute the evidence

```bash
lyricsync prepare ws
```

Minutes of CPU (about 2 for a 3.5-minute song); the result is cached, and running it again is instant. If you change the lyrics, the vocal stem or the beat source, `solve` will refuse to run until you `prepare` again (`--force` recomputes).

## 3. `solve`: the first result

```bash
lyricsync solve ws --out lyrics.json
```

Seconds. With no anchors every line is solved *free*. The summary prints the mean expected error and the least certain lines.

## 4. `review` and `anchor`: improve it

```bash
lyricsync review ws --top 5
lyricsync anchor ws --line 24 --start 126.68 --end 128.44      # both edges: anchored, markedly more accurate
lyricsync anchor ws --boundary 25:4=129.83                      # one syllable start, exact
lyricsync anchor ws --import fixed.json --level line --lines 24,25
lyricsync anchor ws --list
lyricsync solve ws --out lyrics.json
```

See [refinement.md](refinement.md) for what each kind of pin does, the editor round trip and how to read `review`. Repeat until the uncertain boundaries left are ones you do not care about.

## 5. Use the result

`lyrics.json` (or `ws/out/lyrics.json`): `lines[].words[].syl` are the syllable intervals in seconds, `sylText` their texts. See [formats.md](formats.md).

## When the line timings are already known

Anchor everything up front; this is the most accurate mode:

```bash
lyricsync run ws --vocal vocal.wav --lyrics lyrics.txt --language en --mix song.wav --bpm 120 \
                 --anchors-from known.json --level line --out lyrics.json
```

`known.json` is lyrics.json-style (`lines[].start/end`). If it omits a sung line of your lyrics, name that lyric line with `--skip-lines`.

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `No pronunciation for "x"` | word not in the dictionary: add `phones` (JSON lyrics) or respell |
| `--mix needs --bpm <n>` | beat tracking needs the tempo prior; give the approximate BPM |
| `Give exactly one beat source` | pass either `--mix` or `--beats`, not both or neither |
| `Workspace is not prepared` / `changed since "prepare"` | run `lyricsync prepare ws` |
| `Workspace already exists` | `init` never overwrites: choose a new directory |
| `The imported file has N lines but the lyrics have M` | use `--skip-lines` for lyric lines the file lacks, or fix the file |
| `... must be earlier than boundary ...` | pinned times in one line are not increasing |
| `Decoding .mp3 files needs ffmpeg` | install ffmpeg or convert to WAV |
| `Bundled model file is missing` | the installed package is incomplete (its `models/` directory was not shipped) |
