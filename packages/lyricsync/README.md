# lyricsync

Singing-voice lyrics timing, end to end: a vocal stem and the lyrics text in, word- and **syllable**-level timings out (`lyrics.json`). It works with nothing known about the song (*free*), with the start and end of lines known (*anchored*), and as an **interactive loop** where you (or an agent) pin the timings you trust and the solver re-decodes everything around them.

Everything runs locally (ONNX Runtime; DirectML on Windows where it can, otherwise CPU): the forced-alignment, pitch, beat and syllable-boundary models ship inside the package, there is no Python and no network access.

```
vocal stem ─┐                                       ┌─ free solve
lyrics ─────┼─► prepare ─► evidence ─► solve ─► lyrics.json ─► review ─► anchor ─┐
mix / beats ┘   (minutes, cached)         ▲                                       │
                                           └───────────────────────────────────────┘
```

## Install and requirements

```bash
npm install lyricsync        # Node >= 20 (also runs on Bun)
```

- A **clean, isolated vocal stem** (include backing vocals if your lyrics contain them). WAV is read natively; mp3/flac/m4a/ogg need `ffmpeg` on `PATH`.
- The song's **beats**: either the full mix plus its approximate tempo (`--mix song.wav --bpm 120`; tracked with the `beatsync` package it depends on), or a beats JSON you already have (`--beats beats.json`).
- English or Japanese (romaji) lyrics. Not supported: Chinese, and lyrics in any other language.
- Disk: the package is large (about 720 MB) because the models ship with it: HuBERT forced aligner (two models), RMVPE, HarmoF0, Swift-F0 and the syllable-boundary model. Their weights are stored in reduced precision at no measurable accuracy cost ([docs/evidence.md](docs/evidence.md#model-file-sizes)). In a source checkout the model weights are not in git: run `bun run fetch-models` at the repository root.

## Quick start

```bash
lyricsync init  ws --vocal vocal.wav --lyrics lyrics.txt --language en --mix song.wav --bpm 120
lyricsync prepare ws                     # ~1 min for a 3.5 min song (DirectML; longer on CPU); cached
lyricsync solve ws --out lyrics.json     # seconds
lyricsync review ws                      # the lines the solver is least sure about
lyricsync anchor ws --line 7 --start 41.20 --end 44.85     # pin what you know ...
lyricsync solve ws --out lyrics.json                       # ... and re-solve
```

`lyrics.txt` is one lyric line per line; write `re|con|cil|i|a|tion` to fix a syllable split. Every command takes `--json` for machine-readable output. `lyricsync --help` lists everything.

### Already know the line timings?

```bash
lyricsync run ws --vocal vocal.wav --lyrics lyrics.txt --language en --mix song.wav --bpm 120 \
                 --anchors-from my_lines.json --level line --out lyrics.json
```


### Web Editor (GUI)

A standalone web app conforming to the **SoulWindow** design system (WinForms aesthetic, Segoe UI, light/dark themes) is located in `web/` and deployable to GitHub Pages.

- **Pure Browser & Local Folder:** Runs in desktop Chrome with the File System Access API. You pick a library folder holding your song folders; everything stays on disk.
- **Calibration & Solver Separation:** Confirmed human/agent work is saved to `lyrics.calibrated.json` with confirmed `calibrated` and `sylCalibrated` flags; `out/lyrics.json` is purely generated and overwritten on each solve.
- **Interactive Timeline:** Interactive canvas displaying the beats grid, waveforms, syllable blocks, line bars, and draggable section diamond handles.
- **Development** (from the repository root, after `bun install` and `bun run fetch-models`):
  ```bash
  bun run dev                                  # songs in <repository>/songs
  bun run dev --songs path/to/my/song-folders  # or edit another project's song folders in place
  ```
  The server ([docs/editor-spec.md](docs/editor-spec.md#6a-development-build-current-state)) adds Auto-time, the New Song wizard and re-analysis on top of the browser editor.
Pinning both edges of every line is the most accurate mode (see below). `--level word|syllable|flagged` pins more of what your file knows.

### Library

```ts
import { Session, setLineBounds } from 'lyricsync';

const { session } = Session.init({ dir: 'ws', vocalPath, lyricsPath, language: 'en',
                                   beats: { kind: 'mix', path: mixPath, targetBpm: 120 } });
await session.prepare();
let { lyrics, review } = await session.solve();            // free

const anchors = session.loadAnchors();
setLineBounds(anchors, session.definition, 7, 41.20, 44.85);
session.saveAnchors(anchors);
({ lyrics, review } = await session.solve());              // re-solve around it

session.setSyllables([{ line: 3, word: 2, syllables: ['wa', 'alls'] }]);  // re-split a word (pins move along)
await session.prepare();                                    // the evidence depends on the syllables
```

## Accuracy

Syllable-boundary error (mean of start and end error against hand-annotated timings, ms; lower is better) on three annotated songs (two English, one Japanese), 389 + 389 + 342 syllables. **Anchored** = every line's start and end pinned; **free** = nothing known.

| Method | Anchored | Free | How honest |
|---|---|---|---|
| **guided** (default) | **15.6** | **23.4** | model held-out (trained on GTSinger and the Namine Ritsu database, not on these songs); solver constants chosen on these songs |
| trained | 14.2 / held-out 22.9 | 23.6 / held-out 33.3 | DP weights fitted on these songs; held-out = leave-one-song-out |
| simple | 21.3 | 30.3 | hand-set constants, in-sample |
| analytic | 26.6 | 38.3 | hand-set constants, in-sample |

What to take from this:

- `--method guided` ([docs/guided.md](docs/guided.md)) adds a trained syllable-boundary model to the simple solver. The model has never seen these songs; only the solver's handful of constants were set on them. The trained method's in-sample numbers look better in anchored mode, but its held-out ones (22.9 / 33.3) are what a new song gets: its 3,500 weights fit the three songs.
- The guided method snaps boundaries within 55 ms of a beat onto the beat, as the calibrated songs are. `--no-snap` keeps the acoustic times. On acoustic labels it is more accurate: on 10 held-out songs of the Namine Ritsu database, 14.9 / 22.5 without the snap against 18.2 / 26.9 with it ([docs/guided.md](docs/guided.md#beat-snap-and-natural-timing)).
- Knowing the line edges is worth about 7 ms. Pinning even a few lines you have verified helps those lines directly.
- **Three songs is a small sample.** Treat these as an indication, not a guarantee; accuracy on a new song and singer can differ, particularly for sustained notes and melismas.

`--method trained` ([docs/training.md](docs/training.md)) uses one DP stage in free mode and two in anchored mode: a second stage was kept only where it helped held-out accuracy. The research implementation it was extracted from reaches about 20.2 ms held-out (anchored) with its own evidence files; the solver here reproduces that implementation exactly on identical evidence, and the remaining gap is the evidence ([docs/evidence.md](docs/evidence.md)).

`--method analytic` scores the candidates with an explicit model and no learned weights ([docs/analytic.md](docs/analytic.md)); `--method simple` is the smaller vote-count model the guided solver is built on ([docs/simple.md](docs/simple.md)).

## Credits

The syllable-boundary model (`models/boundary/`) is trained on [GTSinger](https://github.com/AaronZ345/GTSinger) and fine-tuned on the **"Namine Ritsu" singing database by Canon** (「波音リツ」歌声データベース, https://canon-voice.com/). The model only finds syllable boundaries; it does not produce singing voice.

## How it works (short)

`prepare` runs a HuBERT forced aligner over the vocal (full song, and per anchored line), pitch trackers (RMVPE, Swift-F0, HarmoF0), the beat track, acoustic boundary/breath detectors and the syllable-boundary model. The default `solve` builds a starting alignment, refines it by pitch/beat/edge consensus, then picks every line's boundaries as the best-scoring chain of candidate times: votes from the evidence sources, duration and beat-grid terms, and the boundary model's probability that each particular boundary sits at that time. Pinned boundaries are single-candidate nodes, so they come out exactly and their neighbours adapt. The `review` ranking comes from each boundary's posterior.

## Docs

- [docs/workflow.md](docs/workflow.md) is the step-by-step guide; [AGENTS.md](AGENTS.md) is the terse version for automated agents.
- [docs/refinement.md](docs/refinement.md): the interactive loop, anchor levels, editor round trip.
- [docs/formats.md](docs/formats.md): every input and output file.
- [docs/evidence.md](docs/evidence.md): what `prepare` computes, models, fidelity to the research pipeline.
- [docs/training.md](docs/training.md): training weights on your own annotated songs.
- [docs/guided.md](docs/guided.md): the default method, its boundary model, accuracy and model size.
- [docs/analytic.md](docs/analytic.md): the training-free method, its constants and accuracy.
- [docs/simple.md](docs/simple.md): the simplest training-free method, how it was built up step by step, and what did not help.
- [docs/publishing.md](docs/publishing.md): releasing this package.

## Development

```bash
bun install
bun test tests/unit      # fast, no models
bun test tests/e2e       # runs the whole workflow on the shipped models (a synthetic vocal)
bun x tsc -p tsconfig.json
```

License: unspecified (`UNLICENSED` in package.json). The bundled models have their own upstream licenses; check them before redistributing.
