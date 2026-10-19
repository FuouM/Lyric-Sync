# Trains the line aligner (line_model.py) on GTSinger + Ritsu runs (build_dataset.py / build_ritsu_ds.py format), starting from a trained
# boundary-model checkpoint. Validation = the boundary trainer's song split (md5 % 10 == 0 of the title).
# Each training crop (10 s): every sung run lying wholly inside it becomes one line. Every boundary gets a candidate window around
# (truth + random shift) like the solver's spans. Loss per head (onset, vowel): the chain's negative log-likelihood of the true path per
# boundary + the window cross entropy of each boundary alone (keeps the unary scores usable on their own).
# usage: python research/aligner/train_line.py --out .cache/line_model/l1 --init .cache/boundary_model/ft_ritsu1/best.pt
#        [--data .cache/gtsinger_ds_full,.cache/ritsu_ds@0.3]
import argparse
import hashlib
import json
import os
import queue
import sys
import threading
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "boundary"))
from line_model import FPS, HEADS, MAX_DUR, MIN_DUR, NEG, SR, LineAligner, chain, load_ssl, path_score, query_inputs, unary  # noqa: E402
from train_boundary import AUG_PARTS, augment, is_val  # noqa: E402

CROP_S = 10.0
MAX_SYL = 40
WMAX = 161  # frames per boundary window (half-width <= 80)
CFG = {"context": True}


def line_of(lang, run):
    """Tokens and truth times of one run: ctx (M, 5), kind (M,), lang (M,), truth {head: (M,) seconds}."""
    ctx, kind, lg = [], [], []
    m = len(run)
    for j in range(m + 1):
        left = run[j - 1]["phones"] if j > 0 else None
        right = run[j]["phones"] if j < m else None
        k = "runStart" if j == 0 else "runEnd" if j == m else ("word" if run[j]["wordStart"] else "inner")
        c, ki, li = query_inputs(CFG, lang, left, right, k)
        ctx.append(c)
        kind.append(ki)
        lg.append(li)
    end = run[-1]["end"]
    truth = {"onset": np.array([s["start"] for s in run] + [end]), "vowel": np.array([s["vowel"] for s in run] + [end])}
    return np.array(ctx), np.array(kind), np.array(lg), truth


class Data:
    def __init__(self, ds):
        self.paths, shares, index = [], [], []
        for k, spec in enumerate(ds.split(",")):
            path, _, share = spec.partition("@")
            self.paths.append(os.path.join(path, "audio.int16"))
            shares.append(float(share) if share else None)
            for e in json.load(open(os.path.join(path, "index.json"), encoding="utf-8")):
                e["src"] = k
                e["lines"] = []
                for run in e["runs"]:
                    if not 1 <= len(run) <= MAX_SYL:
                        continue
                    gap = (MIN_DUR + 1) / FPS  # one frame of slack: truth frames are rounded
                    ok = all(run[i + 1]["start"] - run[i]["start"] >= gap and run[i + 1]["vowel"] - run[i]["vowel"] >= gap
                             for i in range(len(run) - 1)) and run[-1]["end"] - max(run[-1]["start"], run[-1]["vowel"]) >= gap
                    if ok:
                        e["lines"].append(line_of(e["lang"], run))
                del e["runs"]
                index.append(e)
        self.train = [e for e in index if not is_val(e["song"]) and e["lines"]]
        self.val = [e for e in index if is_val(e["song"]) and e["lines"]]
        length = np.array([e["length"] for e in self.train], dtype=np.float64)
        src = np.array([e["src"] for e in self.train])
        total = np.array([length[src == k].sum() for k in range(len(shares))])
        fixed = sum(s for s in shares if s is not None)
        free = total[[s is None for s in shares]].sum()
        share = np.array([s if s is not None else (1 - fixed) * total[k] / max(free, 1.0) for k, s in enumerate(shares)])
        self.weights = length / total[src] * share[src]
        self.weights /= self.weights.sum()

    def reader(self):
        files = [open(p, "rb") for p in self.paths]

        def wav(e, start=0, length=None):
            length = e["length"] - start if length is None else length
            f = files[e["src"]]
            f.seek(2 * (e["offset"] + start))
            return np.frombuffer(f.read(2 * length), dtype=np.int16).astype(np.float32) / 32768.0

        return wav


def line_item(bi, line, t0, T, rng, fixed):
    """One line of a crop starting at t0 s with T frames, or None when the line does not lie wholly inside it.
    fixed: validation windows (centre within +-15 frames of the truth, half-width 75). -> dict of numpy arrays."""
    ctx, kind, lang, truth = line
    tf = {h: (truth[h] - t0) * FPS for h in HEADS}
    lo_all = min(tf["onset"].min(), tf["vowel"].min())
    hi_all = max(tf["onset"].max(), tf["vowel"].max())
    if lo_all < 15 or hi_all > T - 15:
        return None
    M = len(ctx)
    win, tidx = {}, {}
    for h in HEADS:
        w = np.zeros((M, WMAX), dtype=np.int64)
        valid = np.zeros((M, WMAX), dtype=bool)
        ti = np.zeros(M, dtype=np.int64)
        for j in range(M):
            t = tf[h][j]
            if fixed:
                center, half = t + rng.uniform(-15, 15), 75
            else:
                center, half = t + float(np.clip(rng.normal(0, 10), -30, 30)), int(rng.uniform(30, 80))
            lo = max(0, int(round(center - half)))
            hi = min(T - 1, int(round(center + half)))
            truth_f = int(round(t))
            lo, hi = min(lo, truth_f), max(hi, truth_f)
            n = hi - lo + 1
            w[j, :n] = np.arange(lo, hi + 1)
            w[j, n:] = hi
            valid[j, :n] = True
            ti[j] = truth_f - lo
        win[h], tidx[h] = (w, valid), ti
    span = (tf["onset"][-1] - tf["onset"][0]) / max(1, M - 1)
    mean_dur = span * (1.0 if fixed else float(np.exp(rng.normal(0, 0.1))))
    return {"b": bi, "ctx": ctx, "kind": kind, "lang": lang, "win": win, "tidx": tidx, "tf": tf, "mean_dur": mean_dur}


def make_batch(data, wav_of, rng, batch):
    crop = int(CROP_S * SR)
    T = crop // 160
    wavs, others, items = [], [], []
    for bi in range(batch):
        e = data.train[rng.choice(len(data.train), p=data.weights)]
        start = 0 if e["length"] <= crop else int(rng.integers(0, e["length"] - crop))
        x = wav_of(e, start, min(crop, e["length"]))
        wavs.append(np.pad(x, (0, crop - len(x))))
        o = data.train[rng.choice(len(data.train), p=data.weights)]
        ostart = 0 if o["length"] <= crop else int(rng.integers(0, o["length"] - crop))
        y = wav_of(o, ostart, min(crop, o["length"]))
        others.append(np.pad(y, (0, crop - len(y))))
        for line in e["lines"]:
            it = line_item(bi, line, start / SR, T, rng, fixed=False)
            if it is not None:
                items.append(it)
    return np.stack(wavs), np.stack(others), items


def collate(items, dev):
    """Pads a list of line items to (L, M, ...) tensors on dev."""
    L = len(items)
    M = max(len(it["ctx"]) for it in items)
    out = {"b": torch.tensor([it["b"] for it in items], device=dev), "mask": torch.zeros(L, M, dtype=torch.bool),
           "ctx": torch.zeros(L, M, items[0]["ctx"].shape[1], dtype=torch.long), "kind": torch.zeros(L, M, dtype=torch.long),
           "lang": torch.zeros(L, M, dtype=torch.long), "mean_dur": torch.tensor([it["mean_dur"] for it in items], dtype=torch.float32)}
    for h in HEADS:
        out["win_" + h] = torch.zeros(L, M, WMAX, dtype=torch.long)
        out["valid_" + h] = torch.zeros(L, M, WMAX, dtype=torch.bool)
        out["tidx_" + h] = torch.zeros(L, M, dtype=torch.long)
        out["tf_" + h] = torch.zeros(L, M, dtype=torch.float32)
    for i, it in enumerate(items):
        m = len(it["ctx"])
        out["mask"][i, :m] = True
        out["ctx"][i, :m] = torch.from_numpy(it["ctx"])
        out["kind"][i, :m] = torch.from_numpy(it["kind"])
        out["lang"][i, :m] = torch.from_numpy(it["lang"])
        for h in HEADS:
            w, v = it["win"][h]
            out["win_" + h][i, :m] = torch.from_numpy(w)
            out["win_" + h][i, m:] = int(w[m - 1, 0])
            out["valid_" + h][i, :m] = torch.from_numpy(v)
            out["tidx_" + h][i, :m] = torch.from_numpy(it["tidx"][h])
            out["tf_" + h][i, :m] = torch.from_numpy(it["tf"][h].astype(np.float32))
    return {k: v.to(dev, non_blocking=True) for k, v in out.items()}


def line_losses(model, fr, lb, sigma=1.5):
    """fr {head: (B, T, d+1)}, lb collated lines -> ({head: chain nll per boundary (L,)}, {head: window CE (scalar)}, {head: (window argmax
    frames, viterbi frames) (L, M)})."""
    x, hstate = model.line_tokens(lb["ctx"], lb["kind"], lb["lang"], lb["mask"])
    qs = model.line_queries(x, hstate)
    codes = model.syllable_codes(hstate)
    nll, wce, preds = {}, {}, {}
    n = lb["mask"].sum(1).float()
    for h in HEADS:
        un_full = unary(model, fr[h][lb["b"]], qs[h])  # (L, M, T)
        win = lb["win_" + h]
        un = torch.gather(un_full, 2, win).masked_fill(~lb["valid_" + h], NEG)
        pair = model.pair_table(h, codes, lb["mean_dur"])
        logz, vit = chain(un, win, pair, lb["mask"])
        ps = path_score(un, win, pair, lb["mask"], lb["tidx_" + h])
        nll[h] = (logz - ps) / n
        # window cross entropy of each real boundary alone against a narrow Gaussian at the truth
        f = win.float()
        tgt = torch.exp(-0.5 * ((f - lb["tf_" + h][:, :, None]) / sigma) ** 2) * lb["valid_" + h]
        tgt = tgt / tgt.sum(2, keepdim=True).clamp_min(1e-9)
        ce = -(tgt * F.log_softmax(un, dim=2)).sum(2)
        wce[h] = ce[lb["mask"]].mean()
        arg = torch.gather(win, 2, un.argmax(2, keepdim=True)).squeeze(2)
        preds[h] = (arg, vit)
    return nll, wce, preds


class Prefetcher:
    def __init__(self, data, batch, seed, depth=6):
        self.q = queue.Queue(maxsize=depth)
        self.stop = threading.Event()
        rng = np.random.default_rng(seed)
        wav_of = data.reader()

        def work():
            while not self.stop.is_set():
                wav, oth, items = make_batch(data, wav_of, rng, batch)
                if not items:
                    continue
                item = (torch.from_numpy(wav).pin_memory(), torch.from_numpy(oth).pin_memory(), items)
                while not self.stop.is_set():
                    try:
                        self.q.put(item, timeout=0.5)
                        break
                    except queue.Full:
                        continue

        self.thread = threading.Thread(target=work, daemon=True)
        self.thread.start()

    def next(self):
        return self.q.get()

    def close(self):
        self.stop.set()


class ValCache:
    """Validation segments, clean and peak-normalised on the GPU in length-sorted batches, with fixed (seeded) windows."""

    def __init__(self, data, dev, max_batch_s=120.0):
        rng = np.random.default_rng(123)
        wav_of = data.reader()
        self.batches = []
        cur = []

        def flush():
            if not cur:
                return
            Lw = max(len(w) for w, _, _ in cur)
            audio = torch.zeros(len(cur), Lw, dtype=torch.float16)
            items, langs = [], []
            for bi, (w, its, lg) in enumerate(cur):
                audio[bi, : len(w)] = torch.from_numpy(w)
                for it in its:
                    it["b"] = bi
                items += its
                langs += lg
            self.batches.append((audio.to(dev), collate(items, dev), langs))
            cur.clear()

        for e in sorted(data.val, key=lambda e: e["length"]):
            w = wav_of(e)
            w = w / (np.abs(w).max() + 1e-6) * 0.9
            T = len(w) // 160
            its = [it for it in (line_item(0, line, 0.0, T, rng, fixed=True) for line in e["lines"]) if it is not None]
            if not its:
                continue
            if cur and (len(cur) + 1) * max(len(w), max(len(c[0]) for c in cur)) > max_batch_s * SR:
                flush()
            cur.append((w, its, [(e["lang"], e["src"])] * len(its)))
        flush()
        self.n_lines = sum(len(b[2]) for b in self.batches)


@torch.no_grad()
def evaluate(model, val):
    """Per head: chain nll per boundary, window-argmax and Viterbi error (ms) over all boundaries, by language."""
    model.eval()
    acc = {h: {"nll": [], "win": [], "vit": [], "lang": []} for h in HEADS}
    for audio, lb, langs in val.batches:
        with torch.autocast("cuda", dtype=torch.float16):
            fr = {k: v.float() for k, v in model.frames2(audio.float()).items()}
        nll, _, preds = line_losses(model, fr, lb)
        mask = lb["mask"]
        for h in HEADS:
            acc[h]["nll"] += (nll[h] * mask.sum(1)).tolist()
            truth = lb["tf_" + h]
            arg, vit = preds[h]
            acc[h]["win"] += ((arg.float() - truth).abs()[mask] * 10).tolist()
            acc[h]["vit"] += ((vit.float() - truth).abs()[mask] * 10).tolist()
            acc[h]["lang"] += [langs[i][0] for i in range(len(langs)) for _ in range(int(mask[i].sum()))]
    model.train()
    res = {}
    total = 0.0
    for h in HEADS:
        a = acc[h]
        nb = len(a["win"])
        res[h + "_nll"] = sum(a["nll"]) / nb
        total += res[h + "_nll"]
        for kind in ("win", "vit"):
            e = np.array(a[kind])
            lg = np.array(a["lang"])
            res["%s_%s_mae" % (h, kind)] = float(e.mean())
            res["%s_%s_le25" % (h, kind)] = float((e <= 25).mean())
            for L in ("en", "ja"):
                if (lg == L).any():
                    res["%s_%s_%s_mae" % (h, kind, L)] = float(e[lg == L].mean())
    res["nll"] = total
    return res


def build(dev, init):
    model = LineAligner(load_ssl()).to(dev)
    model.init_from_boundary(torch.load(init, map_location=dev))
    return model


def trainable_state(model):
    keep = {n for n, p in model.named_parameters() if p.requires_grad}
    return {k: v for k, v in model.state_dict().items() if not k.startswith("ssl.") or k in keep}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--init", required=True, help="boundary-model checkpoint to start from")
    ap.add_argument("--data", default=".cache/gtsinger_ds_full,.cache/ritsu_ds@0.3")
    ap.add_argument("--max-steps", type=int, default=30000)
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--lr", type=float, default=1e-3, help="new parts (text encoder, residual heads, pair MLPs)")
    ap.add_argument("--trunk-lr", type=float, default=1e-4, help="parts that come from the checkpoint")
    ap.add_argument("--eval-every", type=int, default=500)
    ap.add_argument("--log-every", type=int, default=50)
    ap.add_argument("--patience", type=int, default=5)
    ap.add_argument("--decay-patience", type=int, default=2)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    json.dump({"model": "line_aligner", "args": vars(args)}, open(os.path.join(args.out, "config.json"), "w"), indent=1)
    torch.manual_seed(args.seed)
    torch.set_num_threads(4)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    dev = torch.device("cuda")
    gen = torch.Generator(device=dev)
    gen.manual_seed(args.seed)

    t_setup = time.time()
    data = Data(args.data)
    print("data: %d train segments (%d lines), %d val segments (%d lines)" % (
        len(data.train), sum(len(e["lines"]) for e in data.train), len(data.val), sum(len(e["lines"]) for e in data.val)), flush=True)
    val = ValCache(data, dev)
    model = build(dev, args.init)
    res = evaluate(model, val)
    print("EVAL step 0 (init %s): %s" % (args.init, json.dumps({k: round(v, 3) for k, v in res.items()})), flush=True)
    old = {n for n in torch.load(args.init, map_location="cpu")}
    new_params = [p for n, p in model.named_parameters() if p.requires_grad and n not in old and not n.startswith("ssl.")]
    old_params = [p for n, p in model.named_parameters() if p.requires_grad and n in old]
    params = new_params + old_params
    opt = torch.optim.AdamW([{"params": new_params, "lr": args.lr}, {"params": old_params, "lr": args.trunk_lr}], weight_decay=0.01)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 300))
    scaler = torch.amp.GradScaler("cuda")
    feed = Prefetcher(data, args.batch, args.seed)
    print("model: %.2fM new + %.2fM checkpoint parameters training; setup %.0fs; %d val lines" % (
        sum(p.numel() for p in new_params) / 1e6, sum(p.numel() for p in old_params) / 1e6, time.time() - t_setup, val.n_lines), flush=True)

    best, best_step, since_best = None, 0, 0
    t0 = time.time()
    window = {"t": time.time(), "steps": 0, "loss": torch.zeros((), device=dev)}
    curve = open(os.path.join(args.out, "curve.jsonl"), "a")
    try:
        for step in range(1, args.max_steps + 1):
            wav, oth, items = feed.next()
            wav = augment(wav.to(dev, non_blocking=True), oth.to(dev, non_blocking=True), gen, AUG_PARTS)
            with torch.autocast("cuda", dtype=torch.float16):
                fr = model.frames2(wav)
            fr = {k: v.float() for k, v in fr.items()}
            lb = collate(items, dev)
            nll, wce, _ = line_losses(model, fr, lb)
            loss = sum(nll[h].mean() + wce[h] for h in HEADS)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            scaler.step(opt)
            scaler.update()
            sched.step()
            window["steps"] += 1
            window["loss"] += loss.detach()
            if step % args.log_every == 0:
                dt = time.time() - window["t"]
                print("step %d | loss %.4f | %.2f step/s | vram peak %.1f GB | %.1f min" % (
                    step, window["loss"].item() / window["steps"], window["steps"] / dt, torch.cuda.max_memory_allocated() / 2**30,
                    (time.time() - t0) / 60), flush=True)
                window = {"t": time.time(), "steps": 0, "loss": torch.zeros((), device=dev)}
            if step % args.eval_every == 0:
                res = evaluate(model, val)
                res.update(step=step, seconds=round(time.time() - t0))
                curve.write(json.dumps(res) + "\n")
                curve.flush()
                state = trainable_state(model)
                improved = best is None or res["nll"] < best
                if improved:
                    best, best_step, since_best = res["nll"], step, 0
                    torch.save(state, os.path.join(args.out, "best.pt"))
                    json.dump(res, open(os.path.join(args.out, "best.json"), "w"))
                else:
                    since_best += 1
                print("EVAL step %d: %s%s" % (step, json.dumps({k: round(v, 3) for k, v in res.items() if not k.endswith("_ja_mae") and not k.endswith("_en_mae")}),
                                             " (new best)" if improved else ""), flush=True)
                window = {"t": time.time(), "steps": 0, "loss": torch.zeros((), device=dev)}
                if since_best >= args.patience:
                    print("PLATEAU at step %d; best nll %.4f at step %d" % (step, best, best_step), flush=True)
                    break
                if since_best > 0 and since_best % args.decay_patience == 0:
                    sched.base_lrs = [b * 0.5 for b in sched.base_lrs]
                    print("lr halved", flush=True)
    finally:
        feed.close()
    print("done: %.1f min, best nll %.4f at step %d" % ((time.time() - t0) / 60, best if best is not None else float("nan"), best_step), flush=True)


if __name__ == "__main__":
    main()
