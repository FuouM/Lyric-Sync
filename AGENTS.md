# AGENTS.md: Lyric-Sync Repository & Workflow Guide

Terse operating instructions for automated agents working on the Lyric-Sync repository.

---

## 1. Branching Strategy & Separation of Concerns

- **`main`**: Production library and web editor only.
  - Stays lean, lightweight, and publishable.
  - Contains only production packages (`packages/lyricsync`, `packages/beatsync`, `packages/lyricsync/web`), `models.json`, and root build scripts.
  - **NEVER** track or merge the `research/` directory, training datasets, or Python dependencies into `main`.
- **`research`**: Machine learning training, fine-tuning, and research workbench.
  - Dedicated branch containing `research/` (`boundary/`, `ritsu/`, `eval/`).
  - Contains PyTorch boundary training loops, dataset extraction pipelines, and 4-song accuracy benchmarks (`bench4.ts`).
  - Large feature caches, HuggingFace weights, and checkpoints live in `.cache/` (strictly gitignored).

---

## 2. Workflow: Developing on `research` and Promoting to `main`

1. **Work on `research` branch:**
   - Any model training, solver experimentation, or benchmark evaluation must happen on the `research` branch.
   - Run benchmarks:
     ```bash
     bun research/eval/bench4.ts [--songs-dir <path>]
     ```
   - Train boundary models:
     ```bash
     python research/boundary/train_boundary.py --out .cache/boundary_model/run1 --data .cache/gtsinger_ds_full
     ```
   - Export ONNX weights:
     ```bash
     python research/boundary/export_onnx.py <checkpoint.pt> packages/lyricsync/models/boundary --weights int8
     ```
2. **Promoting to `main`:**
   - When a solver fix, engine improvement, or new model is ready for production:
     - Check out `main`.
     - Cherry-pick the engine commit or open a focused PR containing only changes inside `packages/` (e.g. `packages/lyricsync/src/`).
     - Release new model weights as assets on GitHub Releases and update `models.json`.
   - `main` remains clean, fast to clone, and free of ML development dependencies.

---

## 3. Large Assets & Ground Truth Songs

- Never track multi-track audio stems or song project directories in Git on either branch.
- Calibrated benchmark songs (`breaked`, `breaked_retro`, `suika_retro`, `pdoom`) are loaded via `--songs-dir <path>` or `SONGS_DIR` from an external directory (e.g., peer video editor projects).
- User-facing sample songs are packaged as GitHub Release zip archives (`sample-pdoom`, `sample-breaked_jazzpop`).
