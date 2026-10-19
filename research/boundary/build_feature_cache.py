# Precomputes the boundary model's input features (mHuBERT-147 hidden states mixed with a trained model's layer weights, 50 fps, fp16;
# log-mel, 100 fps, fp16) so heads train without running the backbone (train_cached.py).
#   --part train: `--copies` augmented copies of the training subset, as single segments (--mode segments), spliced into "songs" of
#                 3..6 segments joined by 0.1..1.2 s rests (--mode splice; augmentation runs over the whole song, so reverb tails reach
#                 into the gaps and every segment's opening phrase start has context before it), or spliced tightly the way sung lines
#                 follow each other (--mode tight; see assemble).
#   --part val:   the validation songs, clean: each segment alone ("segments"), spliced with rests ("splice") and tightly ("tight").
#   Every backbone call has one fixed shape (fixed windows, one augmentation length): GPU memory stays flat however long a song is.
# Output <out>/<part>/: h.f16 (N50, 768), m.f16 (N100, 80), index.json [{group, h_off, h_len, m_off, m_len, bounds: [[t, ctx, kind, lang, language, junction]]}].
# usage: python scripts/gtsinger/build_feature_cache.py --out .cache/feat_cache/sub25 --part train --mode splice --copies 3 --subset 0.25
import argparse
import json
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from boundary_model import SR, LogMel, build_model, query_inputs  # noqa: E402
from train_boundary import AUG_PARTS, Data, augment  # noqa: E402

HOP50 = 320  # samples per 50 fps backbone frame: segment offsets inside a spliced song stay on this grid


MAX_SONG_S = 120.0  # a spliced song stops growing at this length (augmentation runs at one fixed padded length)
CHUNK_S, PAD_S = 20.0, 3.0  # backbone windows as at inference (export_guide.py): 20 s kept, 3 s of context either side


def sequences(entries, rng, splice, same_lang=False):
    """Groups of entries: one per segment, or shuffled songs of 3..6 segments (at most MAX_SONG_S of audio, gaps excluded); same_lang: a song
    holds one language only (its junctions are asked with the previous clip's phones as context)."""
    if not splice:
        return [[e] for e in entries]
    order = [entries[i] for i in rng.permutation(len(entries))]
    if same_lang:
        order = [e for e in order if e["lang"] == "en"] + [e for e in order if e["lang"] == "ja"]
    out, i = [], 0
    while i < len(order):
        n, group, total = int(rng.integers(3, 7)), [], 0
        while i < len(order) and len(group) < n and total + order[i]["length"] / SR <= MAX_SONG_S - 8:
            group.append(order[i])
            total += order[i]["length"] / SR
            i += 1
        out.append(group)
    return out


def chunked_features(model, logmel_cpu, x):
    """x (1, S) peak-normalised -> (h (S // 320, C) fp16, m (S // 160, 80) fp16). The backbone runs in fixed-size windows of CHUNK_S + 2 PAD_S
    (every call has the same shape, so neither the allocator nor cuFFT accumulate per-length state); each window's real audio is normalised
    before the zero padding, as the backbone's own input normalisation would. The log-mel runs on the CPU over the whole sequence."""
    S = x.shape[1]
    step, pad = int(CHUNK_S * SR), int(PAD_S * SR)
    W = step + 2 * pad
    mix = torch.softmax(model.layer_w, dim=0)
    h = np.zeros((S // 320, 768), dtype=np.float16)
    for c in range(0, S, step):
        a = max(0, c - pad)
        seg = x[:, a: a + W]
        w = torch.zeros(1, W, device=x.device)
        w[:, : seg.shape[1]] = (seg - seg.mean()) / (seg.std() + 1e-5)
        with torch.autocast("cuda", dtype=torch.float16):
            hs = model.ssl(input_values=w, output_hidden_states=True).hidden_states
        hw = sum(wt * t[0].float() for wt, t in zip(mix, hs)).half().cpu().numpy()
        k0, k1 = c // 320, min(S, c + step) // 320
        h[k0:k1] = hw[k0 - a // 320: k1 - a // 320]
    m = logmel_cpu(x.float().cpu())[0, : S // 160]
    m = torch.nn.functional.pad(m, (0, 0, 0, S // 160 - m.shape[0])).half().numpy()
    return h, m


def assemble(group, wav_of, rng, splice, cfg, tight=False):
    """-> (audio float32, bounds [[t, ctx, kind, lang, language, junction]]) of a group, times in the group's time base.
    tight: clips follow each other as sung lines do (40% no gap, else 0.05..0.4 s), and each junction is asked as at inference with
    export_guide.py --line-context: a word boundary after the previous clip's last syllable."""
    parts, bounds, t0 = [], [], 0
    for k, e in enumerate(group):
        if splice:
            if k == 0:
                gap = int(rng.uniform(0.0, 0.5) * SR)
            elif tight:
                gap = 0 if rng.random() < 0.4 else int(rng.uniform(0.05, 0.4) * SR)
            else:
                gap = int(rng.uniform(0.1, 1.2) * SR)
            gap += (-(t0 + gap)) % HOP50
            parts.append(np.zeros(gap, dtype=np.float32))
            t0 += gap
        x = wav_of(e)
        x = x / (np.abs(x).max() + 1e-6)
        parts.append(x)
        off = t0 / SR
        seg_bounds = [[t + off, ctx, kind, lang, language, 0] for (t, ctx, kind, lang, _, language) in e["bounds"]]
        if tight and k > 0:
            first, _ = e["edge_phones"]
            ctx, kind, lang = query_inputs(cfg, e["lang"], group[k - 1]["edge_phones"][1], first, "word")
            seg_bounds[0][1:4] = [ctx, kind, lang]  # the clip's first boundary: its first run's start
            seg_bounds[0][5] = 1  # a junction (line start without the silence context), reported apart in validation
        bounds += seg_bounds
        t0 += len(x)
        if splice:
            pad = (-t0) % HOP50
            parts.append(np.zeros(pad, dtype=np.float32))
            t0 += pad
    return np.concatenate(parts), bounds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--part", choices=["train", "val"], required=True)
    ap.add_argument("--mode", choices=["segments", "splice", "tight"], default="segments",
                    help="train part: single segments, spliced songs with rests between clips, or tightly spliced songs (see assemble)")
    ap.add_argument("--copies", type=int, default=3, help="train part: augmented copies")
    ap.add_argument("--subset", type=float, default=0.25)
    ap.add_argument("--data", default=".cache/gtsinger_ds_full")
    ap.add_argument("--mix-from", default=".cache/boundary_model/prod/best.pt", help="checkpoint whose learned layer mix the cached features use")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    out = os.path.join(args.out, args.part)
    os.makedirs(out, exist_ok=True)
    dev = torch.device("cuda")
    cfg = {"ssl": "mhubert", "target": "vowel"}
    data = Data(cfg, args.data, args.subset)
    model = build_model(cfg).to(dev).eval()
    model.layer_w.data.copy_(torch.load(args.mix_from, map_location=dev)["layer_w"])
    wav_of = data.reader()
    gen = torch.Generator(device=dev)
    gen.manual_seed(args.seed)
    logmel_cpu = LogMel().eval()
    aug_len = int(MAX_SONG_S * SR) if args.mode != "segments" else 32 * SR  # one FFT size for the whole run (segments are <= 30 s)
    hf, mf = open(os.path.join(out, "h.f16"), "wb"), open(os.path.join(out, "m.f16"), "wb")
    index, h_off, m_off = [], 0, 0
    splice, tight = args.mode != "segments", args.mode == "tight"
    if args.part == "train":
        plan = [("copy%d" % c, sequences(data.train, np.random.default_rng(args.seed + c), splice, tight), splice, tight, True, c)
                for c in range(args.copies)]
    else:
        plan = [("segments", sequences(data.val, None, False), False, False, False, 0),
                ("splice", sequences(data.val, np.random.default_rng(1234), True), True, False, False, 0),
                ("tight", sequences(data.val, np.random.default_rng(1235), True, True), True, True, False, 0)]
    t_start = time.time()
    with torch.no_grad():
        for name, groups, splice, tight, aug, c in plan:
            rng = np.random.default_rng(10_000 + args.seed + c)
            for gi, group in enumerate(groups):
                audio, bounds = assemble(group, wav_of, rng, splice, cfg, tight)
                n = len(audio)
                x = torch.from_numpy(audio).to(dev)[None]
                if aug:
                    assert n <= aug_len, n
                    o = np.concatenate([wav_of(data.train[int(i)]) for i in rng.integers(0, len(data.train), 12)])
                    # Augmented at one fixed padded length (one cuFFT plan); the peak normalisation sees the real audio only.
                    xa = torch.nn.functional.pad(x, (0, aug_len - n))
                    oa = torch.from_numpy(np.resize(o, aug_len)).to(dev)[None]
                    oa[:, n:] = 0
                    x = augment(xa, oa, gen, AUG_PARTS)[:, :n]
                else:
                    x = x / (x.abs().max() + 1e-6) * 0.9
                h, m = chunked_features(model, logmel_cpu, x)
                hf.write(h.tobytes())
                mf.write(m.tobytes())
                index.append({"group": name, "h_off": h_off, "h_len": len(h), "m_off": m_off, "m_len": len(m), "bounds": bounds})
                h_off += len(h)
                m_off += len(m)
                if gi % 200 == 0:
                    print("%s %d/%d | %.1f GB on disk | %.1f min | gpu allocated %.2f GB, reserved %.2f GB" % (
                        name, gi, len(groups), h_off * 768 * 2 / 2**30, (time.time() - t_start) / 60,
                        torch.cuda.memory_allocated() / 2**30, torch.cuda.memory_reserved() / 2**30), flush=True)
    hf.close()
    mf.close()
    json.dump({"h_dim": 768, "m_dim": 80, "mix_from": args.mix_from, "mode": args.mode, "entries": index}, open(os.path.join(out, "index.json"), "w"))
    print("done: %d sequences, %.1f GB h, %.1f min" % (len(index), h_off * 768 * 2 / 2**30, (time.time() - t_start) / 60), flush=True)


if __name__ == "__main__":
    main()
