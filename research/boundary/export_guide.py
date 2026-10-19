# Runs the trained boundary model on lyricsync workspaces and writes what the guided solver reads:
#   <ws>/<out>/frames.f32   (T, d+1) float32 frame embeddings at 100 fps of the workspace's vocal
#   <ws>/<out>/queries.json {fps, dim, lines: [{index, q: [[d floats] per boundary j = 0..syllables]}]}
# Needs <ws>/guide/contexts.json from export_contexts.ts. The model is loaded once for all workspaces.
# usage: python scripts/gtsinger/export_guide.py <checkpoint.pt> <workspace dir>... [--out guide] [--vocal <wav>] [--line-context]
#   --out: directory name inside each workspace (default guide); bench_guided.ts --guide-dir reads it.
#   --vocal: run the model on another time-aligned stem (e.g. the lead vocal) instead of the workspace's vocal; the solver's evidence is
#            unchanged. One workspace only.
#   --line-context: a line's first boundary is asked as a word boundary after the previous line's last syllable (songs run lines into each
#                   other), not as a phrase start after silence; the song's first line keeps the silence context.
import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly

sys.path.insert(0, os.path.dirname(__file__))
from boundary_model import FPS, SR, build_model, query_inputs  # noqa: E402

CHUNK_S = 20.0
PAD_S = 3.0


def export(ws, model, run_cfg, dev, out, vocal_override=None, line_context=False):
    cfg = json.load(open(os.path.join(ws, "lyricsync.json"), encoding="utf-8"))
    vocal = os.path.normpath(os.path.join(ws, cfg["vocal"].replace("\\", os.sep)))
    if vocal_override is not None:
        if sf.info(vocal_override).duration < sf.info(vocal).duration - 0.5:
            raise ValueError("%s is shorter than the workspace vocal: not the same timeline" % vocal_override)
        vocal = vocal_override
    ctx = json.load(open(os.path.join(ws, "guide", "contexts.json"), encoding="utf-8"))
    lang = ctx["language"]
    audio, sr = sf.read(vocal, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    g = np.gcd(sr, SR)
    audio = resample_poly(audio, SR // g, sr // g).astype(np.float32)
    audio = audio / (np.abs(audio).max() + 1e-6) * 0.9
    T = len(audio) // 160
    frames = np.zeros((T, model.d + 1), dtype=np.float32)
    step = int(CHUNK_S * FPS)
    pad = int(PAD_S * FPS)
    with torch.no_grad():
        for f0 in range(0, T, step):
            a = max(0, f0 - pad)
            b = min(T, f0 + step + pad)
            x = torch.from_numpy(audio[a * 160: b * 160]).to(dev)[None]
            with torch.autocast("cuda", dtype=torch.float16):
                fr = model.frames(x).float()[0].cpu().numpy()
            frames[f0: min(T, f0 + step)] = fr[f0 - a: f0 - a + min(T, f0 + step) - f0]
        lines = []
        prev_last = None
        for line in ctx["lines"]:
            syl = line["syllables"]
            ids, kinds, langs = [], [], []
            for j in range(len(syl) + 1):
                left = syl[j - 1]["phones"] if j > 0 else None
                right = syl[j]["phones"] if j < len(syl) else None
                kind = "runStart" if j == 0 else "runEnd" if j == len(syl) else ("word" if syl[j]["wordStart"] else "inner")
                if j == 0 and line_context and prev_last is not None:
                    left, kind = prev_last, "word"
                c, k, l = query_inputs(run_cfg, lang, left, right, kind)
                ids.append(c)
                kinds.append(k)
                langs.append(l)
            q = model.queries(torch.tensor(ids, device=dev), torch.tensor(kinds, device=dev), torch.tensor(langs, device=dev))
            lines.append({"index": line["index"], "q": [[round(float(v), 5) for v in row] for row in q.cpu().numpy()]})
            prev_last = syl[-1]["phones"] if syl else prev_last
    os.makedirs(os.path.join(ws, out), exist_ok=True)
    frames.tofile(os.path.join(ws, out, "frames.f32"))
    json.dump({"fps": FPS, "dim": model.d, "frames": T, "lines": lines}, open(os.path.join(ws, out, "queries.json"), "w"))
    print("%s: %d frames, %d lines" % (ws, T, len(lines)), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("workspaces", nargs="+")
    ap.add_argument("--out", default="guide")
    ap.add_argument("--vocal", default=None)
    ap.add_argument("--line-context", action="store_true")
    args = ap.parse_args()
    if args.vocal is not None and len(args.workspaces) != 1:
        raise ValueError("--vocal needs exactly one workspace")
    dev = torch.device("cuda")
    run_cfg = json.load(open(os.path.join(os.path.dirname(args.checkpoint), "config.json"), encoding="utf-8"))
    model = build_model(run_cfg).to(dev).eval()
    missing, unexpected = model.load_state_dict(torch.load(args.checkpoint, map_location=dev), strict=False)
    assert not unexpected and all(k.startswith("ssl.") for k in missing), (missing, unexpected)
    for ws in args.workspaces:
        export(ws, model, run_cfg, dev, args.out, args.vocal, args.line_context)


if __name__ == "__main__":
    main()
