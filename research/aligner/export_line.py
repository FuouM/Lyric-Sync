# Runs a trained line aligner on lyricsync workspaces. Writes inside each workspace:
#   <out>/line.json         {fps, dim, frames, syl_dim, lines: [{index, q: {onset, vowel}: [[d] per boundary], codes: [[syl_dim] per syllable]}]}
#   <out>/frames_onset.f32, frames_vowel.f32   (T, d+1) float32 at 100 fps
#   <out>/pair.json         {head: {w1, b1, w2, b2}} the pair MLPs (input: log d s, log d/mean, its square, d < 12 frames, syllable code)
#   <out>_onset/, <out>_vowel/   the same scores in the guided solver's guide format (frames.f32 + queries.json), for --guide-dir
# Needs <ws>/guide/contexts.json (research/boundary/export_contexts.ts).
# usage: python research/aligner/export_line.py <run dir> <workspace>... [--out line] [--mc N] [--shifts K]
import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly

sys.path.insert(0, os.path.dirname(__file__))
from line_model import EV_DIM, FPS, HEADS, SR, LineAligner, ev_features, load_ssl, query_inputs  # noqa: E402

CHUNK_S = 20.0
PAD_S = 3.0
CFG = {"context": True}


def frames_of(model, audio, dev, delay, ev=None):
    """Frames of `audio` delayed by `delay` samples (< 160), read back on the original 10 ms grid by linear interpolation.
    ev: (T, EV_DIM) evidence features of the undelayed audio (evidence models only; those take no delay)."""
    if ev is not None and delay:
        raise ValueError("sub-frame shifts are not defined for evidence models")
    x_all = np.concatenate([np.zeros(delay, dtype=np.float32), audio])
    T = len(audio) // 160
    Tx = len(x_all) // 160
    raw = {h: np.zeros((Tx, model.d + 1), dtype=np.float32) for h in HEADS}
    step, pad = int(CHUNK_S * FPS), int(PAD_S * FPS)
    for f0 in range(0, Tx, step):
        a, b = max(0, f0 - pad), min(Tx, f0 + step + pad)
        x = torch.from_numpy(x_all[a * 160: b * 160]).to(dev)[None]
        e = torch.from_numpy(ev[a:b]).to(dev)[None] if ev is not None else None
        with torch.autocast("cuda", dtype=torch.float16):
            fr = model.frames2(x, e)
        for h in HEADS:
            raw[h][f0: min(Tx, f0 + step)] = fr[h].float()[0].cpu().numpy()[f0 - a: f0 - a + min(Tx, f0 + step) - f0]
    # grid frame f (time f / FPS) sits at fractional frame f + delay / 160 of the delayed signal
    pos = np.arange(T) + delay / 160.0
    i0 = np.clip(np.floor(pos).astype(np.int64), 0, Tx - 1)
    i1 = np.clip(i0 + 1, 0, Tx - 1)
    w = (pos - np.floor(pos))[:, None].astype(np.float32)
    return {h: raw[h][i0] * (1 - w) + raw[h][i1] * w for h in HEADS}


def workspace_ev(ws, T):
    """Evidence features from the workspace's prepared evidence (the same RMVPE pitch and beats the solver uses)."""
    meta = json.load(open(os.path.join(ws, "evidence", "meta.json"), encoding="utf-8"))
    notes = json.load(open(os.path.join(ws, "evidence", "notes.json"), encoding="utf-8"))["rmvpeNotes"]
    return ev_features(T, meta["f0Hz"], [(n["start"], n["end"]) for n in notes], sorted(meta["beats"]))


def export(ws, model, dev, out, mc=1, shifts=1):
    cfg = json.load(open(os.path.join(ws, "lyricsync.json"), encoding="utf-8"))
    vocal = os.path.normpath(os.path.join(ws, cfg["vocal"].replace("\\", os.sep)))
    ctx = json.load(open(os.path.join(ws, "guide", "contexts.json"), encoding="utf-8"))
    lang = ctx["language"]
    audio, sr = sf.read(vocal, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    g = np.gcd(sr, SR)
    audio = resample_poly(audio, SR // g, sr // g).astype(np.float32)
    audio = audio / (np.abs(audio).max() + 1e-6) * 0.9
    T = len(audio) // 160
    frames = {h: np.zeros((T, model.d + 1), dtype=np.float32) for h in HEADS}
    ev = workspace_ev(ws, T) if model.ev_dim else None
    lines = []
    with torch.no_grad():
        # Monte Carlo: mc passes with dropout on (the frozen backbone stays in eval mode) x `shifts` sub-frame delays; the unary score is
        # linear in the frame vectors, so the mean frame gives the mean score.
        if mc > 1:
            model.train()
            model.ssl.eval()
        n = 0
        for _ in range(mc):
            for k in range(shifts):
                fr = frames_of(model, audio, dev, int(round(k * 160 / shifts)), ev)
                for h in HEADS:
                    frames[h] += fr[h]
                n += 1
        for h in HEADS:
            frames[h] /= n
        model.eval()
        for line in ctx["lines"]:
            syl = line["syllables"]
            ids, kinds, langs = [], [], []
            for j in range(len(syl) + 1):
                left = syl[j - 1]["phones"] if j > 0 else None
                right = syl[j]["phones"] if j < len(syl) else None
                kind = "runStart" if j == 0 else "runEnd" if j == len(syl) else ("word" if syl[j]["wordStart"] else "inner")
                c, k, l = query_inputs(CFG, lang, left, right, kind)
                ids.append(c)
                kinds.append(k)
                langs.append(l)
            t = lambda v: torch.tensor([v], device=dev)
            mask = torch.ones(1, len(ids), dtype=torch.bool, device=dev)
            xin, hs = model.line_tokens(t(ids), t(kinds), t(langs), mask)
            qs = model.line_queries(xin, hs)
            codes = model.syllable_codes(hs)[0].cpu().numpy()
            r = lambda m: [[round(float(v), 5) for v in row] for row in m]
            lines.append({"index": line["index"], "q": {h: r(qs[h][0].cpu().numpy()) for h in HEADS}, "codes": r(codes)})
    d = os.path.join(ws, out)
    os.makedirs(d, exist_ok=True)
    for h in HEADS:
        frames[h].tofile(os.path.join(d, "frames_%s.f32" % h))
        gd = os.path.join(ws, "%s_%s" % (out, h))
        os.makedirs(gd, exist_ok=True)
        frames[h].tofile(os.path.join(gd, "frames.f32"))
        json.dump({"fps": FPS, "dim": model.d, "frames": T, "lines": [{"index": l["index"], "q": l["q"][h]} for l in lines]},
                  open(os.path.join(gd, "queries.json"), "w"))
    json.dump({"fps": FPS, "dim": model.d, "frames": T, "syl_dim": len(lines[0]["codes"][0]) if lines and lines[0]["codes"] else 0, "lines": lines},
              open(os.path.join(d, "line.json"), "w"))
    pair = {}
    for h in HEADS:
        seq = model.pair[h]
        pair[h] = {"w1": seq[0].weight.tolist(), "b1": seq[0].bias.tolist(), "w2": seq[2].weight.tolist(), "b2": seq[2].bias.tolist()}
    json.dump(pair, open(os.path.join(d, "pair.json"), "w"))
    print("%s: %d frames, %d lines" % (ws, T, len(lines)), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("workspaces", nargs="+")
    ap.add_argument("--out", default="line")
    ap.add_argument("--mc", type=int, default=1, help="Monte Carlo dropout passes averaged (1 = dropout off)")
    ap.add_argument("--shifts", type=int, default=1, help="sub-frame audio delays averaged (k * 10 ms / shifts, k = 0..shifts-1)")
    args = ap.parse_args()
    dev = torch.device("cuda")
    run_cfg = json.load(open(os.path.join(args.run, "config.json"), encoding="utf-8"))["args"]
    model = LineAligner(load_ssl(), ev_dim=EV_DIM if run_cfg.get("ev") else 0).to(dev).eval()
    missing, unexpected = model.load_state_dict(torch.load(os.path.join(args.run, "best.pt"), map_location=dev), strict=False)
    assert not unexpected and all(k.startswith("ssl.") for k in missing), (missing, unexpected)
    for ws in args.workspaces:
        export(ws, model, dev, args.out, args.mc, args.shifts)


if __name__ == "__main__":
    main()
