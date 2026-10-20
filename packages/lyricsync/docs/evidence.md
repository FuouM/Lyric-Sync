# Evidence: what `prepare` computes and from which model

`lyricsync prepare` turns the vocal stem into everything the solver needs. All of it runs locally with ONNX Runtime, using the model files shipped inside the package (`models/`). Nothing is downloaded and nothing needs Python.

**Device.** `--device gpu` (the default; `prepare({ device })` in the library) runs the models on the GPU provider of the platform's onnxruntime-node build: DirectML on Windows. Without a GPU provider, `gpu` runs on the CPU. `--device cpu` runs everything on the CPU. The GRUs of RMVPE and of the boundary model always run on the CPU: each of these models ships in two parts (`*.encoder.onnx`, `*.recurrent.onnx`, cut by `scripts/split_gru.py`), and only the encoder runs on the GPU. DirectML is slow to set up a GRU (about 2.7 ms per time step on the first run) and fails on long sequences.

The two devices give the same evidence up to float rounding (f0 within 0.0001 Hz, boundary frames within 0.001). On the three annotated songs every note, edge, breath and full-song alignment, and every solved syllable time, is the same on both.

| Evidence | Model / method | Used for |
|---|---|---|
| beats | the `beatsync` package (Beat This!, ~79 MB) on the full mix, or your own beat file | the 16th-note grid that boundaries snap toward |
| phone posteriors | HuBERT forced aligner, **base** model (`models/hubert-base`, ~208 MB) | per-frame phone probabilities; nucleus/edge phone features |
| boundary edge peaks + breath pauses | same base model | candidate boundary times; line-edge and breath cues |
| edge peaks (second opinion) | HuBERT forced aligner, **combined** model (`models/hubert-combined`, ~203 MB) | a second, independently trained set of boundary candidates |
| full-song forced alignment | base (and, for English, combined) | the starting point for lines that are not anchored (the base alignment; the combined alignment when the base one collapsed on the line, see below); DP features |
| per-line forced alignment | base (and, for English, combined), run on the audio cut to an anchored line | the starting point and features for anchored lines (computed on demand, cached; same collapse rule) |
| f0 contour + notes | RMVPE (`models/rmvpe`, ~181 MB in two parts), despiked and segmented | pitch-change boundaries, voicing |
| onset notes | Swift-F0 (`models/swift-f0`, ~0.1 MB) | note onsets |
| sustained notes | HarmoF0 (`models/harmof0`, ~5.5 MB), smoothed | sustained-note segmentation |
| boundary frames + queries | the syllable-boundary model (`models/boundary`, ~117 MB; mHuBERT-147 backbone; head trained on GTSinger, fine-tuned on the Namine Ritsu database), see [guided.md](guided.md) | the guided solver's score for every boundary candidate |

Dictionaries (`ds_cmudict-07b.txt` for English, `japanese_dict_full.txt` for romaji Japanese) sit next to the HuBERT models and give each word its phones. A word that is not in the dictionary is an error (give it explicit `phones` in a JSON lyrics file); words are never skipped, because skipping one would shift every later word of the alignment.

A forced alignment can collapse on a held melisma: one syllable takes most of the line and the remaining syllables move to its end (or into the next line). The solver detects this with the pitch notes (RMVPE and HarmoF0): a line alignment that has 3 or more note starts per syllable inside its syllables (the last syllable not counted, because a held line end can carry a melisma) has collapsed. When the base alignment of a line collapsed and the combined alignment has half or fewer note starts per syllable, the combined alignment is the starting point of that line.

## Model file sizes

The large models store their weights in reduced precision; the computation stays float32. HuBERT (both) and RMVPE keep every large weight as float16 behind a cast back to float32 (half the original size). The boundary model stores its MatMul weights as 8-bit integers (weight-only, a scale per block of 32) and the rest as float16. Measured on the three annotated songs against the float32 files, syllable MAE in ms (anchored / free):

| Method | float32 models | shipped | int8 HuBERT too (not shipped) |
|---|---|---|---|
| guided | 16.50 / 23.46 | 16.50 / 23.47 | 16.56 / 23.56 |
| trained | 14.24 / 23.63 | 14.23 / 23.63 | 15.11 / 23.73 |
| simple | 21.34 / 30.33 | 21.34 / 30.33 | 21.48 / 31.28 |
| analytic | 26.51 / 38.37 | 26.61 / 38.34 | 26.43 / 38.05 |

int8 HuBERT weights would save another 160 MB, but the forced alignments move enough to cost the trained and simple methods up to 1 ms. The guided row was measured before a later fix for pinned line ends (shipped now: 16.49 / 23.47). `scripts/onnx_weights.py` in the repository does the conversion (`fp16` or `int8`).

## Cost

For a 194 s song on an RTX 3060 and a 6-core Ryzen 5 3600, `prepare` takes about 20 s with `--device gpu` and about 90 s with `--device cpu` (both include beat tracking on the mix). Each anchored line adds about 0.5 s the first time it is solved (cached in `sliced/`). `solve` itself is seconds.

| Stage (194 s song) | gpu | cpu |
|---|---|---|
| beats (Beat This!) | 2.5 s | 7.3 s |
| RMVPE | 2.6 s | 6.8 s |
| Swift-F0 + HarmoF0 | 2.6 s | 24.6 s |
| HuBERT base + combined (one pass each) | 7.5 s | 28.8 s |
| boundary model | 5.1 s | 20.4 s |

## Input audio

A **clean, isolated vocal stem**. If backing vocals are sung and are in your lyrics (e.g. `(oh)`), the stem must contain them. WAV is decoded and resampled natively (16/24/32-bit PCM and 32-bit float, any channel count, any rate), so the result never depends on installed tools; every other format requires `ffmpeg` on `PATH` and fails with a clear error without it. No pre-processing is needed.

## How faithful is it to the research pipeline this package was extracted from?

Measured on a research song with the research evidence files as reference:

- Phone posteriors: bit-identical. Edge peaks (both models): identical counts, 100% matched within 10 ms. Breaths: identical.
- Forced alignments: within a few ms on average (the reference files were made on a different vocal stem file than the evidence).
- f0 / notes: the research notes came from a Python/PyTorch RMVPE plus Python smoothing; here RMVPE runs as ONNX and the smoothing is ported to TypeScript. Voicing agrees on 99% of frames; 80-93% of notes match within 20 ms start / 40 ms end. This costs accuracy (see the README).

The solver on identical evidence reproduces the research implementation **exactly** (max difference 0 s on all three songs), so any accuracy difference comes from the evidence, not the solver.
