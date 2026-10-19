# The guided solver (default, `--method guided`)

The simple solver's vote-count chain ([simple.md](simple.md)) plus a trained **syllable-boundary model** that says, for every boundary of every line, where in the audio that particular boundary is likely to be. It is the default of `lyricsync solve` and `session.solve()`: on a song it has not seen, it is the most accurate method in both modes (the trained method only beats it in-sample, on the songs its weights were fitted to).

## The boundary model

`models/boundary/` (`frames.onnx`, `queries.onnx`, `config.json`), run by `prepare` (about 10 s for a 3.5 min song with DirectML, about 20 s on CPU). The output goes into the evidence (`boundary.bin`, `boundary.json`). The evidence key includes a fingerprint of the model, so after a model update `prepare` extracts the evidence of each workspace again (the first `prepare` after the update takes the full time).

- **Audio side** (`frames.onnx`): the vocal is resampled to 16 kHz with a band-limited (windowed-sinc) resampler and peak-normalised, then cut into fixed 26 s windows (20 s kept, 3 s of context either side). Each window goes through a frozen mHuBERT-147 backbone (its 13 hidden layers mixed with learned weights) and a log-mel front end, then a convolution and a two-layer bidirectional GRU. Out comes, at 100 frames per second, a 64-wide embedding and a context-free boundary logit.
- **Text side** (`queries.onnx`): each boundary is described by its phone context: the last two phones before it, the first three after it (`SIL` past a rest), the kind of boundary (line start, line end, word start, inside a word) and the language. English words are split into their sung syllables by maximal onset, the same rule the training labels follow. That description becomes a 64-wide query.
- Score of boundary j at frame t: `embedding_t . query_j / 8 + logit_t`. Inside a boundary's candidate span (plus 0.1 s either side) a softmax over frames turns the scores into a distribution P.

**Training**: GTSinger (English and Japanese studio singing, word- and phone-level labels), then fine-tuned on 40 songs of the Namine Ritsu Normal singing database (Japanese, hand-made phone labels; see below), targets at the **vowel onset** of each syllable. Fine-tuning started from the GTSinger checkpoint, with 30% of the training crops from Ritsu and 70% from GTSinger. The checkpoint was chosen by validation loss on GTSinger and Ritsu validation songs alone. The model never saw the annotated songs or the 10 Ritsu test songs used below. The training and benchmark code (`scripts/gtsinger/`, `scripts/ritsu/`, used in the commands below) lives in the research repository this package came from (probable-video-editor), not in this repository.

**Weights**: the MatMul weights are stored as 8-bit integers (weight-only, blocks of 32 values with their own scale) and the other large weights as float16. Activations stay float32. That makes 117 MB instead of 394 MB, at no measurable cost. Measured on the previous (GTSinger-only) model:

| `frames.onnx` | Size | Anchored | Free |
|---|---|---|---|
| float32 | 394 MB | 16.47 | 23.46 |
| float16 weights | 197 MB | 16.47 | 23.46 |
| **int8 weights** (shipped) | **117 MB** | **16.49** | **23.47** |
| int4 weights | 74 MB | 15.82 | 24.19 |

int4 moves results by up to 1.7 ms per song in either direction (free mode got worse overall), so it was not used.

## The solver

`solveGuided` (`src/engine/guided.ts`) with `GUIDED_DESIGN` and `GUIDE_SCORING`:

- Every unpinned boundary gets up to 3 extra candidates: the strongest local maxima of P (each at least 30% of the top one).
- Every candidate gets `4.5 x` the probability mass of P within 35 ms of it, on top of the simple solver's votes and syllable terms.
- Changes from the simple solver's constants, each kept because it helped on all three songs: Swift-F0 note starts and the silence posterior do not count; the second (combined) phoneme-boundary model votes (2) on lines whose start and end are pinned; a line followed by at least 1 s without voice ends where its pitch notes stop, instead of running on to the next line.
- Lines are solved in time order and never overlap: each line starts at or after the previous line's last syllable start plus the minimum syllable length (and after its end when that end is pinned), and an unpinned line end past the next line's start is clipped.
- Decoding: each line gets the path with the least expected absolute error under the chain's own posterior (`mbrPath`), not the single best path. The chain's scores are divided by a temperature (`mbrTemp`, 0.25) before the posterior is computed. `mbrTemp: 0` gives the best path (Viterbi). Mean error (ms), best path -> least expected error:

  | | Annotated songs | Ritsu test songs |
  |---|---|---|
  | Snap (default), anchored / free | 15.60 / 23.43 -> 15.59 / 23.28 | 18.22 / 26.80 -> 18.09 / 26.74 |
  | No snap, anchored / free | 18.74 / 26.92 -> 18.80 / 26.77 | 14.88 / 22.42 -> 14.62 / 21.95 |

  The temperature was chosen from 0.25, 0.5, 0.75, 1, 2 and 4: 0.25 is the only value that is not worse on any of the annotated songs, the two partly calibrated hard-case songs (pdoom, breaked_jazzpop) and the Ritsu test songs. A solve takes about 30% longer (one more forward-backward pass per line).
- `review`: each boundary's expected error comes from the chain's own posterior, its scores read as log-potentials. On the annotated songs (free mode) the mean expected error of the listed boundaries is 40 ms against 35 ms real, and it ranks lines about as well as the trained method's CRF posterior (Spearman 0.51 against 0.55). It ranks, it does not measure: treat it as "look here first".

## Accuracy

Mean syllable-edge error against the calibrated labels, in ms, on the three annotated songs (the previous, GTSinger-only model in brackets):

| | breaked | breaked_retro | suika_retro | mean |
|---|---|---|---|---|
| Anchored | 14.9 (15.4) | 16.0 (16.2) | 15.9 (17.8) | **15.6** (16.5) |
| Free | 23.6 (22.7) | 23.0 (23.0) | 23.3 (24.6) | **23.3** (23.5) |

How honest these numbers are: the model is held-out (never trained on these songs). The solver's constants, the guide weight and the vowel-onset convention were chosen on these same three songs with the previous model, so the solver side is in-sample. Re-tuning the constants leave-one-song-out gave 18.1 anchored and 26.5 free (previous model), worse than the fixed preset, so the preset was kept. For comparison the trained method is 14.2 / 23.6 in-sample and 22.9 / 33.3 held-out, and the simple method 21.3 / 30.3 (in-sample).

Where the error is left, in free mode (previous model): 58-60% of the error beyond 20 ms is at interior syllable starts, 24-27% at line ends (most line ends join the next line's start, so they inherit its error) and 15% at line starts. The right time is among the candidates within 20 ms for 93-98% of boundaries; what is missing is the scoring.

## Beat snap and natural timing

After the chain is decoded, a boundary within 55 ms of a beat moves onto the beat (`beatSnapSec`). The hand-calibrated songs were made with a tool that snaps labels to the beat grid, and snapped lyrics look tidier in a video. The snap is the default. `--no-snap` (`session.solve({ snapToBeats: false })`, the editor's Solve › Snap Auto-timing to Beats) keeps the acoustic times. Only the guided method has this option.

| | Annotated songs (snapped labels) | Ritsu test songs (acoustic labels) |
|---|---|---|
| Snap (default), anchored / free | **15.6** / **23.3** | 18.1 / 26.7 |
| No snap, anchored / free | 18.8 / 26.8 | **14.6** / **22.0** |

Use the snap when the timing must look like hand-calibrated lyrics. Use natural timing when it must follow the voice.

## Japanese benchmark (Namine Ritsu)

The Namine Ritsu Normal singing database ("Namine Ritsu", by Canon) has 50 a cappella Japanese songs with phone labels made by hand. `scripts/ritsu/` converts it to 50 workspaces: 1,855 lines and 21,704 morae. A syllable starts at its vowel. Lines break at rests of 0.25 s or more. Beats come from the UST score. The vowel onsets are 15 ms from a score note start (median). The boundary model is fine-tuned on 40 of the songs; the other 10 (`.cache/ritsu/ritsu.test.json`: every 5th song in sorted order) are the test set. The solver constants were not set on this data.

Test songs, guided, mean error (ms) with the previous model and with the fine-tuned model (best-path decoding; with the default least-expected-error decoding the fine-tuned model gives 18.1 / 26.7 with the snap and 14.6 / 22.0 without):

| | Previous | Fine-tuned |
|---|---|---|
| Snap, anchored / free | 20.1 / 28.9 | **18.2** / **26.9** |
| No snap, anchored / free | 17.4 / 25.0 | **14.9** / **22.5** |

Start error by kind of mora, no snap, anchored, previous -> fine-tuned (mean ms): consonant + vowel 14.0 -> 11.6; a different vowel after a vowel ("ko i") 21.7 -> 17.9; the same vowel again on a new note ("ka a") 50.7 -> 40.0; N 20.9 -> 16.2; cl 14.2 -> 9.8. Line ends did not change: in free mode most line ends run on to the next line and end about 180 ms late, because Ritsu lines always end at a rest and the rest detector only acts on rests of 1 s or more (`restMinSec`).

```bash
bun scripts/ritsu/build_ritsu.ts && bun scripts/ritsu/prepare_ritsu.ts       # once; prepare is about 40 s a song on the GPU
python scripts/ritsu/build_ritsu_ds.py                                       # training set (40 songs), .cache/ritsu_ds
python scripts/gtsinger/train_boundary.py --out .cache/boundary_model/ft_ritsu1 --init .cache/boundary_model/prod/best.pt \
  --data .cache/gtsinger_ds_full,.cache/ritsu_ds@0.3 --lr 3e-4 --eval-every 500 --patience 4 --max-steps 8000
bun scripts/gtsinger/bench_guided.ts --manifest .cache/ritsu/ritsu.test.json [--set beatSnapSec=0]
bun scripts/ritsu/analyze_ritsu.ts --manifest .cache/ritsu/ritsu.test.json --only guided   # error breakdown
```

## Reproducing

From the repository root, with the three projects prepared:

```bash
bun scripts/gtsinger/bench_guided.ts                 # the shipped configuration
python scripts/gtsinger/export_onnx.py <checkpoint.pt> packages/lyricsync/models/boundary --weights int8 --check <vocal.wav>
```
