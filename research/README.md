# Lyric-Sync Research & Training Workbench

This directory contains the machine learning pipelines, dataset extraction tools, and benchmark harnesses used to train and evaluate Lyric-Sync's models.

---

## Structure

- **`boundary/`**: Syllable-boundary model architecture (mHuBERT-147 backbone + GRU head), PyTorch training loops, and INT8/FP16 ONNX graph export.
- **`ritsu/`**: Japanese singing database (Namine Ritsu Normal) conversion, mora segmentation, and fine-tuning dataset generation.
- **`eval/`**: Accuracy evaluation harnesses against calibrated ground truth (`bench4.ts`, `lyricsync_bench.ts`).

---

## 1. Boundary Model Training

The boundary model finds syllable onsets and offsets. It is trained on GTSinger and fine-tuned on Namine Ritsu.

### Training from scratch (GTSinger):
```bash
python research/boundary/train_boundary.py --out .cache/boundary_model/run1 --data .cache/gtsinger_ds_full
```

### Fine-tuning with Namine Ritsu:
```bash
python research/boundary/train_boundary.py \
  --init .cache/boundary_model/prod/best.pt \
  --data .cache/gtsinger_ds_full,.cache/ritsu_ds@0.3 \
  --lr 3e-4 \
  --eval-every 500 \
  --patience 4 \
  --out .cache/boundary_model/ft_ritsu1
```

### Exporting to ONNX:
Export the PyTorch `.pt` checkpoint to INT8 weight-only ONNX graphs (`frames.onnx`, `queries.onnx`, `config.json`):
```bash
python research/boundary/export_onnx.py \
  .cache/boundary_model/prod/best.pt \
  packages/lyricsync/models/boundary \
  --weights int8 \
  --check <path-to-test-vocal.wav>
```

---

## 2. Japanese Singing Database (Namine Ritsu)

Prepares the 50-song Namine Ritsu Japanese database for evaluation and fine-tuning:

1. **Extract mora-aligned song projects:**
   ```bash
   bun research/ritsu/build_ritsu.ts
   ```
2. **Build boundary training set (.cache/ritsu_ds):**
   ```bash
   python research/ritsu/build_ritsu_ds.py
   ```
3. **Pre-compute evidence workspaces:**
   ```bash
   bun research/ritsu/prepare_ritsu.ts
   ```
4. **Evaluate solver performance by mora phonetic category:**
   ```bash
   bun research/ritsu/analyze_ritsu.ts
   ```

---

## 3. Benchmarks & Evaluation

### 4-Song Calibrated Benchmark (`bench4.ts`):
Evaluates the guided solver against 4 human-calibrated ground truth songs (`breaked`, `breaked_retro`, `suika_retro`, `pdoom`):

```bash
bun research/eval/bench4.ts [--songs-dir <path>]
```
- Defaults `--songs-dir` to `../probable-video-editor/projects` if not in local `songs/`.
- Computes Syllable Mean Absolute Error (MAE in milliseconds) for both **anchored** (line edges known) and **free** (fully automated) modes.
