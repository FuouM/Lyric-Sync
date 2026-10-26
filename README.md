# Lyric-Sync

Singing-voice lyrics timing to the syllable, with a DAW-style editor to check and fix it.

| Package | What it is |
|---|---|
| [`packages/lyricsync`](packages/lyricsync/README.md) | Library + CLI: a vocal stem and the lyrics in, word- and syllable-level timings out (free, line-anchored, or refined around the timings you pin). |
| [`packages/lyricsync/web`](packages/lyricsync/docs/editor-spec.md) | The editor: timeline, waveform, pitch, syllable clips, Auto-time, New Song wizard. |
| [`packages/beatsync`](packages/beatsync/README.md) | Beat and downbeat tracking (Beat This!), used for the beat grid. |

## Setup

```bash
bun install            # also builds packages/beatsync/dist
bun run fetch-models   # the ONNX models (about 800 MB) from the GitHub release in models.json
```

The model weights are not in git. `models.json` lists each file with its SHA-256 and the release (`repo`, `tag`) it comes from; `fetch-models` skips files that already match. With the release assets in a local folder: `bun run fetch-models --from <dir>`.

## The editor

```bash
bun run dev                              # http://localhost:3000, song folders in ./songs
bun run dev --songs <folder> --port 3001 # work on song folders somewhere else, in place
bun run dev --device cpu                 # run the models on the CPU (Solve › Run Models on GPU switches it while running)
```

- **Standalone:** File › New Song… builds a song folder from a mix, a vocal stem and the lyrics (beats, analysis, a first timing), then you calibrate it.
- **In your project:** point `--songs` at the folder that holds your song folders. Each song folder follows one layout (`project.json`, `user_input/`, `generated/timing.ai.json`, `generated/features.json`, `lyricsync/`; see `packages/lyricsync/src/song-folder.ts`). The editor reads and writes only inside it: `user_input/lyrics.calibrated.json` is your timing, `lyricsync/` the analysis cache.
- **Sharing:** zip a song folder. It opens prepared on another machine with the same models (a different model version re-analyses it once).

## The CLI and library

See [packages/lyricsync/README.md](packages/lyricsync/README.md). Run the CLI from source with `bun packages/lyricsync/src/cli.ts <command>`.

## Development

```bash
bun run typecheck
bun run test
bun run build:web
```

## Credits

The syllable-boundary model is trained on [GTSinger](https://github.com/AaronZ345/GTSinger) and fine-tuned on the **"Namine Ritsu" singing database by Canon** (「波音リツ」歌声データベース, https://canon-voice.com/). Beat tracking uses [Beat This!](https://github.com/CPJKU/beat_this); forced alignment uses [HubertFA](https://github.com/wolfgitpr/HubertFA) models. Every model's source, license and required credit: [MODELS-LICENSE.md](MODELS-LICENSE.md).

## AI Disclosure

Developed with AI assistance using Gemini 3.8 Flash, Claude Sonnet 5.5, and Claude Opus 5.5.

## License

The code is [Apache-2.0](LICENSE). The model files have their own licenses, listed in [MODELS-LICENSE.md](MODELS-LICENSE.md): the syllable-boundary model and the combined forced aligner are CC BY-NC-SA 4.0 (non-commercial), and `prepare` runs both.
