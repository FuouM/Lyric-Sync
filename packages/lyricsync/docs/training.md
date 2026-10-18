# Training the DP weights

The boundary decoder is a linear-chain CRF over candidate boundary times. Its weights live in `weights/` and are fit on songs whose syllable timings were annotated by hand. You only need this if you have annotated songs of your own (more songs help; see the held-out numbers in the README for how much 3 songs can tell you).

```
lyricsync train <manifest.json> --out-dir <dir> [--held-out-dir <dir>] [--epochs 3] [--lr 0.1] [--l2 0.2] [--tau-ms 4]
```

Point `--out-dir` at a scratch directory first; copy into the package's `weights/` only if the held-out result is better than what ships.

## Manifest

```json
{ "songs": [
  { "id": "songA", "workspace": "ws/songA", "calibrated": "songA.calibrated.json", "skipLines": [37] },
  { "workspace": "ws/songB", "calibrated": "songB.calibrated.json" },
  { "workspace": "ws/songC", "calibrated": "songC.calibrated.json" }
] }
```

Paths are relative to the manifest. Each `workspace` must have been created with `init` and `prepare`d. `id` names the song in reports and held-out weight files (default: the workspace directory name; ids must be unique, so give one when several workspaces share a directory name). `calibrated` is a lyrics.json-style file with the ground-truth line, word and syllable timings; `skipLines` lists lyric lines it does not contain. **At least 3 songs are required**: with fewer there is no honest held-out result and training refuses to run.

## What it does

1. For each song builds the solver's own starting point (`prepareSolve`), so training sees exactly what solving sees.
2. Trains two **modes** independently:
   - `anchored`: every annotated line has its edges pinned (forced alignments cut to the window are used).
   - `free`: nothing pinned.
3. Each mode has two **stages**. Stage 2 re-runs the DP around stage 1's output. It is fit on out-of-fold stage-1 outputs (each song's stage 1 comes from weights fit without that song), so it never trains on an in-sample prior.
4. Reports leave-one-song-out syllable error (mean of start and end error, ms) for the consensus starting point, stage 1 and stage 2.
5. **A second stage ships only if it improves the held-out result.** It can compound stage-1 errors; on the reference songs it did in free mode.

## Output

- `<mode>.stage1.json` and, when it ships, `<mode>.stage2.json`: feature name -> weight.
- `index.json`: `{ version, trainedOn: [song ids], anchored: { stages, heldOutMaeMs }, free: { stages, heldOutMaeMs } }`. The loader reads it to know how many stages each mode uses and refuses to run without the files it names. A stale `*.stage2.json` left from an earlier run is ignored when the index says one stage.
- With `--held-out-dir`: `<mode>.<song>.stage{1,2}.json`, the weights fit **without** that song, for evaluating that song honestly.

## Notes

- Reported numbers are held-out. Weights fit on all songs (the shipped ones) have seen every song and must not be used to score those same songs.
- Evidence matters: weights are only as good a match as the evidence they were trained on. The shipped weights were trained on evidence produced by this package, not on the research pipeline's files.
