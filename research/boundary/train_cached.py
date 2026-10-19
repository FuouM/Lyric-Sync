# Trains the boundary model's head on precomputed features (build_feature_cache.py): no backbone in the loop, so a step costs the head only.
# Batches: random 5 s crops of the cached (augmented) sequences, the same per-boundary windows and loss as train_boundary.py.
# Validation (the cache's val part, clean): "segments" = each validation segment alone (comparable across runs; the early-stopping signal),
# "splice" = validation segments spliced into songs; reported per group overall and for line starts (runStart boundaries).
# Checkpoints load into the full model (build_model with the backbone): the cache's layer mix is written into them as layer_w.
# usage: python scripts/gtsinger/train_cached.py --out .cache/boundary_model/c_x --cache .cache/feat_cache/sub25_splice [--val .cache/feat_cache/sub25]
import argparse
import json
import os
import queue
import sys
import threading
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from boundary_model import KINDS, BoundaryModel  # noqa: E402
from train_boundary import window_loss  # noqa: E402

CROP = 500  # 100 fps frames (5 s)
RUN_START = KINDS.index("runStart")


class Cache:
    def __init__(self, d):
        meta = json.load(open(os.path.join(d, "index.json")))
        self.entries = meta["entries"]
        self.mix_from = meta["mix_from"]
        self.h = np.memmap(os.path.join(d, "h.f16"), dtype=np.float16, mode="r").reshape(-1, meta["h_dim"])
        self.m = np.memmap(os.path.join(d, "m.f16"), dtype=np.float16, mode="r").reshape(-1, meta["m_dim"])

    def arrays(self, e, s=0, n=None):
        """(h, m) of entry e from 100 fps frame s (even), n frames (None = to the end); h has n // 2 - 1 rows like a crop through the backbone."""
        n = e["m_len"] - s if n is None else n
        m = np.zeros((n, self.m.shape[1]), dtype=np.float16)
        mm = self.m[e["m_off"] + s: e["m_off"] + min(e["m_len"], s + n)]
        m[: len(mm)] = mm
        hn = max(1, n // 2 - 1)
        h = np.zeros((hn, self.h.shape[1]), dtype=np.float16)
        hh = self.h[e["h_off"] + s // 2: e["h_off"] + min(e["h_len"], s // 2 + hn)]
        h[: len(hh)] = hh
        return h, m


def make_batch(cache, rng, weights, batch):
    hs, ms, items = [], [], []
    for bi in range(batch):
        e = cache.entries[rng.choice(len(cache.entries), p=weights)]
        s = 0 if e["m_len"] <= CROP else 2 * int(rng.integers(0, (e["m_len"] - CROP) // 2 + 1))
        h, m = cache.arrays(e, s, CROP)
        hs.append(h)
        ms.append(m)
        for b in e["bounds"]:
            t, ctx, kind, lang = b[:4]
            tf = t * 100 - s
            if tf < 15 or tf > CROP - 15:
                continue
            center = tf + float(np.clip(rng.normal(0, 10), -30, 30))
            half = rng.uniform(30, 80)
            lo, hi = max(0, int(center - half)), min(CROP - 1, int(center + half))
            if lo <= tf <= hi:
                items.append((bi, tf, lo, hi, ctx, kind, lang))
    return np.stack(hs), np.stack(ms), items


class Prefetcher:
    def __init__(self, cache, batch, seed, depth=8):
        self.q = queue.Queue(maxsize=depth)
        self.stop = threading.Event()
        rng = np.random.default_rng(seed)
        w = np.array([e["m_len"] for e in cache.entries], dtype=np.float64)
        w /= w.sum()

        def work():
            while not self.stop.is_set():
                h, m, items = make_batch(cache, rng, w, batch)
                if not items:
                    continue
                item = (torch.from_numpy(h).pin_memory(), torch.from_numpy(m).pin_memory(), items)
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


class ValSet:
    """One validation group: whole sequences on the GPU in length-sorted batches, fixed query windows (centre within 0.15 s of the label)."""

    def __init__(self, cache, group, dev, max_frames=24000):
        rng = np.random.default_rng(123)
        seqs = sorted([e for e in cache.entries if e["group"] == group], key=lambda e: e["m_len"])
        self.batches, cur = [], []

        def flush():
            if not cur:
                return
            T = max(e["m_len"] for e, _, _ in cur)
            hs, ms, items, flags = [], [], [], []
            for bi, (e, its, fl) in enumerate(cur):
                h, m = cache.arrays(e, 0, T)
                hs.append(h)
                ms.append(m)
                items += [(bi,) + it[1:] for it in its]
                flags += fl
            self.batches.append((torch.from_numpy(np.stack(hs)).to(dev), torch.from_numpy(np.stack(ms)).to(dev), items, flags))
            cur.clear()

        for e in seqs:
            T = e["m_len"]
            its, fl = [], []
            for b in e["bounds"]:
                t, ctx, kind, lang = b[:4]
                tf = t * 100
                center = tf + rng.uniform(-15, 15)
                lo, hi = max(0, int(center - 75)), min(T - 1, int(center + 75))
                if lo <= tf <= hi:
                    its.append((0, tf, lo, hi, ctx, kind, lang))
                    fl.append(kind == RUN_START or (len(b) > 5 and b[5] == 1))  # a line start: after a rest, or a spliced junction
            if not its:
                continue
            if cur and (len(cur) + 1) * max(T, cur[-1][0]["m_len"]) > max_frames:
                flush()
            cur.append((e, its, fl))
        flush()


def local_window_eval(model, fr, items, width=151, sigma_frames=1.5):
    """The validation loss and argmax of each item, scoring only its own window's frames (memory ~ items x width, not items x sequence
    length). Same numbers as train_boundary.window_loss: frames outside a window were masked there anyway. -> (summed CE, argmax frames)."""
    dev = fr.device
    b = torch.tensor([it[0] for it in items], device=dev)
    lo = torch.tensor([it[2] for it in items], device=dev)
    hi = torch.tensor([it[3] for it in items], device=dev)
    idx = (lo[:, None] + torch.arange(width, device=dev)[None]).clamp_max(fr.shape[1] - 1)
    valid = idx <= hi[:, None]
    q = model.queries(torch.tensor([it[4] for it in items], device=dev), torch.tensor([it[5] for it in items], device=dev),
                      torch.tensor([it[6] for it in items], device=dev))
    logits = model.score(fr[b[:, None], idx], q).masked_fill(~valid, -1e9)
    tgt = torch.tensor([it[1] for it in items], device=dev, dtype=torch.float32)[:, None]
    target = torch.exp(-0.5 * ((idx.float() - tgt) / sigma_frames) ** 2) * valid
    target = target / target.sum(1, keepdim=True)
    ce = -(target * torch.log_softmax(logits, dim=1)).sum()
    return ce.item(), (lo + logits.argmax(1)).float().cpu().numpy()


@torch.no_grad()
def evaluate(model, val, chunk=2048):
    model.eval()
    errs, starts, nll = [], [], 0.0
    for h, m, items, flags in val.batches:
        with torch.autocast("cuda", dtype=torch.float16):
            fr = model.frame_out(model.head_forward(h, m)).float()
        for i in range(0, len(items), chunk):
            part = items[i: i + chunk]
            ce, pred = local_window_eval(model, fr, part)
            nll += ce
            errs += list(np.abs(pred - np.array([it[1] for it in part])) * 10.0)
        starts += flags
        del fr
    model.train()
    errs, rs = np.array(errs), np.array(starts, dtype=bool)
    return {"nll": float(nll / len(errs)), "mean_ms": float(errs.mean()), "le25": float((errs <= 25).mean()),
            "rs_mean_ms": float(errs[rs].mean()), "rs_le25": float((errs[rs] <= 25).mean()), "rs_n": int(rs.sum())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", required=True, help="feature cache dir (its train/ part)")
    ap.add_argument("--val", default=".cache/feat_cache/sub25", help="feature cache dir with the val/ part")
    ap.add_argument("--max-steps", type=int, default=40000)
    ap.add_argument("--batch", type=int, default=96, help="the BiGRU's cost is mostly sequential in time: big batches are nearly free")
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--eval-every", type=int, default=100)
    ap.add_argument("--log-every", type=int, default=50)
    ap.add_argument("--decay-patience", type=int, default=2)
    ap.add_argument("--patience", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    cfg = {"ssl": "mhubert", "finetune": 0, "target": "vowel", "context": True}
    json.dump({**cfg, "args": vars(args)}, open(os.path.join(args.out, "config.json"), "w"), indent=1)
    torch.manual_seed(args.seed)
    torch.backends.cudnn.benchmark = False  # validation batches come in many shapes: autotuning each would cost more than it saves
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    dev = torch.device("cuda")
    t_setup = time.time()
    train = Cache(os.path.join(args.cache, "train"))
    vcache = Cache(os.path.join(args.val, "val"))
    vals = {g: ValSet(vcache, g, dev) for g in dict.fromkeys(e["group"] for e in vcache.entries)}
    layer_w = torch.load(train.mix_from, map_location="cpu")["layer_w"]
    model = BoundaryModel(None, cached_dim=train.h.shape[1]).to(dev)
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 300))
    scaler = torch.amp.GradScaler("cuda")
    feed = Prefetcher(train, args.batch, args.seed)
    print("train: %d sequences (%s); model %.1fM params; setup %.1fs" % (
        len(train.entries), args.cache, sum(p.numel() for p in params) / 1e6, time.time() - t_setup), flush=True)

    def save(path):
        state = {k: v for k, v in model.state_dict().items()}
        state["layer_w"] = layer_w
        torch.save(state, path)

    best, best_step, since_best = None, 0, 0
    t0 = time.time()
    window = {"t": time.time(), "steps": 0, "wait": 0.0, "loss": torch.zeros((), device=dev)}
    curve = open(os.path.join(args.out, "curve.jsonl"), "a")
    try:
        for step in range(1, args.max_steps + 1):
            tw = time.time()
            h, m, items = feed.next()
            window["wait"] += time.time() - tw
            with torch.autocast("cuda", dtype=torch.float16):
                fr = model.frame_out(model.head_forward(h.to(dev, non_blocking=True), m.to(dev, non_blocking=True)))
            loss, _ = window_loss(model, fr.float(), items)
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
                print("step %d | loss %.4f | lr %.2e | %.0f ms/step (data wait %.0f ms) | %.1f min" % (
                    step, window["loss"].item() / window["steps"], opt.param_groups[0]["lr"], 1000 * dt / window["steps"],
                    1000 * window["wait"] / window["steps"], (time.time() - t0) / 60), flush=True)
                window = {"t": time.time(), "steps": 0, "wait": 0.0, "loss": torch.zeros((), device=dev)}
            if step % args.eval_every == 0:
                te = time.time()
                res = {g: evaluate(model, v) for g, v in vals.items()}
                row = {"step": step, "seconds": round(time.time() - t0), **{"%s_%s" % (g, k): v for g, r in res.items() for k, v in r.items()}}
                curve.write(json.dumps(row) + "\n")
                curve.flush()
                save(os.path.join(args.out, "step%d.pt" % step))
                cur = res["segments"]["nll"]
                improved = best is None or cur < best
                if improved:
                    best, best_step, since_best = cur, step, 0
                    save(os.path.join(args.out, "best.pt"))
                    json.dump(row, open(os.path.join(args.out, "best.json"), "w"))
                else:
                    since_best += 1
                print("EVAL step %d (%.1fs): %s%s" % (step, time.time() - te, " | ".join(
                    "%s nll %.4f le25 %.1f%%, line starts le25 %.1f%% mean %.1f (n=%d)" % (g, r["nll"], 100 * r["le25"], 100 * r["rs_le25"], r["rs_mean_ms"], r["rs_n"])
                    for g, r in res.items()), " (new best)" if improved else ""), flush=True)
                window = {"t": time.time(), "steps": 0, "wait": 0.0, "loss": torch.zeros((), device=dev)}
                if since_best >= args.patience:
                    print("PLATEAU: best segments nll %.4f at step %d" % (best, best_step), flush=True)
                    break
                if since_best > 0 and since_best % args.decay_patience == 0:
                    sched.base_lrs = [b * 0.5 for b in sched.base_lrs]
    finally:
        feed.close()
    print("done: %.1f min, best segments nll %.4f at step %d" % ((time.time() - t0) / 60, best, best_step), flush=True)


if __name__ == "__main__":
    main()
