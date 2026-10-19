# Trains the text-conditioned syllable-boundary model (boundary_model.py) on the GTSinger set built by build_dataset.py. No beats anywhere.
# Validation = every segment of the song titles whose md5 % 10 == 0 (all singers and techniques of a title stay on one side).
# Each training example: a random crop; for every boundary inside it, a window around (truth + random shift); the loss is the cross entropy
# of the softmax over the window's frames against a narrow Gaussian at the truth.
# Augmentation, for the gap to separated song stems: a second vocal underneath (backing layers), reverb, noise, band limits.
# Speed: batches are read and pinned by a background thread; augmentation runs batched on the GPU; the validation set (clean audio and
# its query windows) is built once and kept on the GPU, evaluated in length-sorted batches.
# Stops by itself on a plateau of the validation loss (--patience); progress every --log-every steps.
# usage: python scripts/gtsinger/train_boundary.py --out .cache/boundary_model/run1 --data .cache/gtsinger_ds_full [--subset 0.25 ...]
#        fine-tuning on an added set: --init .cache/boundary_model/prod/best.pt --data .cache/gtsinger_ds_full,.cache/ritsu_ds@0.3
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
from boundary_model import FPS, LANGS, SR, build_model, query_inputs, trainable_state  # noqa: E402


def is_val(song):
    return int(hashlib.md5(song.strip().lower().encode("utf-8")).hexdigest(), 16) % 10 == 0


def boundaries_of(entry, target, cfg):
    """[(time_s, ctx ids, kind id, query lang id, right first phone, language)] for every boundary of the segment's runs.
    target "onset": a syllable starts with its first phone; "vowel": with its vowel (the sung note). A run's end is its last phone's end."""
    lang = entry["lang"]
    out = []
    for run in entry["runs"]:
        for j in range(len(run) + 1):
            left = run[j - 1]["phones"] if j > 0 else None
            right = run[j]["phones"] if j < len(run) else None
            t = run[j]["start" if target == "onset" else "vowel"] if j < len(run) else run[-1]["end"]
            kind = "runStart" if j == 0 else "runEnd" if j == len(run) else ("word" if run[j]["wordStart"] else "inner")
            ctx, kind_id, lang_id = query_inputs(cfg, lang, left, right, kind)
            out.append((t, ctx, kind_id, lang_id, right[0] if right else "SIL", lang))
    return out


class Data:
    def __init__(self, cfg, ds, subset=1.0, val_max=0):
        """ds: comma list of dataset dirs, each optionally "dir@share" (the share of training crops drawn from it; dirs without one share
        the rest by audio length). subset: fraction of the training segments kept (fixed by segment id), for quick ablations.
        val_max: cap on validation segments (0 = all)."""
        # Audio is read per crop from the file (no memmap): resident memory stays at the crops in use, not the whole set.
        self.paths, shares, index = [], [], []
        for k, spec in enumerate(ds.split(",")):
            path, _, share = spec.partition("@")
            self.paths.append(os.path.join(path, "audio.int16"))
            shares.append(float(share) if share else None)
            for e in json.load(open(os.path.join(path, "index.json"), encoding="utf-8")):
                e["src"] = k
                index.append(e)
        for e in index:
            e["bounds"] = boundaries_of(e, cfg["target"], cfg)
            if e["runs"]:
                e["edge_phones"] = (e["runs"][0][0]["phones"], e["runs"][-1][-1]["phones"])  # first and last syllable (spliced junctions)
            del e["runs"]
        keep = lambda e: int(hashlib.md5(e["id"].encode("utf-8")).hexdigest(), 16) % 1000 < subset * 1000
        self.train = [e for e in index if not is_val(e["song"]) and e["bounds"] and keep(e)]
        self.val = [e for e in index if is_val(e["song"]) and e["bounds"]]
        if 0 < val_max < len(self.val):
            self.val = [self.val[i] for i in sorted(np.random.default_rng(7).choice(len(self.val), val_max, replace=False))]
        length = np.array([e["length"] for e in self.train], dtype=np.float64)
        src = np.array([e["src"] for e in self.train])
        total = np.array([length[src == k].sum() for k in range(len(shares))])
        fixed = sum(s for s in shares if s is not None)
        free = total[[s is None for s in shares]].sum()
        share = np.array([s if s is not None else (1 - fixed) * total[k] / max(free, 1.0) for k, s in enumerate(shares)])
        self.weights = length / total[src] * share[src]
        self.weights /= self.weights.sum()
        self.shares = share / share.sum()

    def reader(self):
        """File handles of its own for each thread that reads audio."""
        files = [open(p, "rb") for p in self.paths]

        def wav(e, start=0, length=None):
            length = e["length"] - start if length is None else length
            f = files[e["src"]]
            f.seek(2 * (e["offset"] + start))
            return np.frombuffer(f.read(2 * length), dtype=np.int16).astype(np.float32) / 32768.0

        return wav


AUG_PARTS = ("backing", "reverb", "band", "noise")
REVERB_IR_S = 1.2  # one IR length, so one FFT size: every new cuFFT size caches a plan (and its workspace) on the GPU


def augment(wav, others, gen, parts=AUG_PARTS):
    """wav, others: (B, S) GPU tensors; gen: a CUDA torch.Generator. Returns augmented, peak-normalised audio, the whole batch at once.
    Per crop and independently: a second vocal underneath (p 0.5, -20..-6 dB), reverb (p 0.5, RT60 0.15..1 s, wet 0.1..0.6), high-pass
    (p 0.3, 60..300 Hz) and low-pass (p 0.3, 3.5..7.5 kHz) with a 2nd-order Butterworth magnitude response, noise (p 0.3, 20..45 dB SNR).
    parts: which augmentations may fire (ablations)."""
    B, S = wav.shape
    dev = wav.device

    def uniform(lo, hi):
        return lo + (hi - lo) * torch.rand(B, 1, device=dev, generator=gen)

    def fires(p, part):
        return ((torch.rand(B, 1, device=dev, generator=gen) < p) & (part in parts)).float()

    def rms(y):
        return y.pow(2).mean(1, keepdim=True).sqrt()

    x = wav
    x = x + fires(0.5, "backing") * 10 ** (uniform(-20, -6) / 20) * rms(x) / (rms(others) + 1e-6) * others
    n = int(SR * REVERB_IR_S)
    t = torch.arange(n, device=dev) / SR
    ir = torch.randn(B, n, device=dev, generator=gen) * torch.exp(-6.9 * t / uniform(0.15, 1.0))
    ir[:, 0] = 0
    ir = ir / (ir.norm(dim=1, keepdim=True) + 1e-6)
    wet = torch.fft.irfft(torch.fft.rfft(x, n=S + n) * torch.fft.rfft(ir, n=S + n), n=S + n)[:, :S]
    x = x + fires(0.5, "reverb") * uniform(0.1, 0.6) * wet * (x.norm(dim=1, keepdim=True) / (wet.norm(dim=1, keepdim=True) + 1e-6))
    f = torch.fft.rfftfreq(S, 1 / SR, device=dev)[None].clamp_min(1.0)
    high = 1 / torch.sqrt(1 + (uniform(60, 300) / f) ** 4)
    low = 1 / torch.sqrt(1 + (f / uniform(3500, 7500)) ** 4)
    hp, lp = fires(0.3, "band"), fires(0.3, "band")
    x = torch.fft.irfft(torch.fft.rfft(x, n=S) * (hp * high + (1 - hp)) * (lp * low + (1 - lp)), n=S)
    x = x + fires(0.3, "noise") * torch.randn(B, S, device=dev, generator=gen) * rms(x) * 10 ** (-uniform(20, 45) / 20)
    return x / (x.abs().amax(1, keepdim=True) + 1e-6) * uniform(0.3, 0.95)


def window_logits(model, fr, items):
    """items: list of (batch idx, truth frame (float), lo frame, hi frame, ctx, kind, lang) -> (N, T) logits, -1e9 outside each item's window."""
    dev = fr.device
    b = torch.tensor([it[0] for it in items], device=dev)
    q = model.queries(torch.tensor([it[4] for it in items], device=dev), torch.tensor([it[5] for it in items], device=dev),
                      torch.tensor([it[6] for it in items], device=dev))
    logits = model.score(fr[b], q)  # (N, T)
    f = torch.arange(logits.shape[1], device=dev)[None]
    lo = torch.tensor([it[2] for it in items], device=dev)[:, None]
    hi = torch.tensor([it[3] for it in items], device=dev)[:, None]
    return logits.masked_fill(~((f >= lo) & (f <= hi)), -1e9)


def window_loss(model, fr, items, sigma_frames=1.5):
    """Mean CE of the softmax over each item's window against a narrow Gaussian at the truth. -> (loss, masked logits)."""
    logits = window_logits(model, fr, items)
    f = torch.arange(logits.shape[1], device=fr.device, dtype=torch.float32)[None]
    tgt = torch.tensor([it[1] for it in items], device=fr.device, dtype=torch.float32)[:, None]
    target = torch.exp(-0.5 * ((f - tgt) / sigma_frames) ** 2) * (logits > -1e8)
    target = target / target.sum(1, keepdim=True)
    return -(target * F.log_softmax(logits, dim=1)).sum(1).mean(), logits


def make_batch(data, wav_of, rng, batch, crop_s):
    crop = int(crop_s * SR)
    wavs, others, items = [], [], []
    for bi in range(batch):
        e = data.train[rng.choice(len(data.train), p=data.weights)]
        start = 0 if e["length"] <= crop else rng.integers(0, e["length"] - crop)
        x = wav_of(e, start, min(crop, e["length"]))
        x = np.pad(x, (0, crop - len(x)))
        o = data.train[rng.choice(len(data.train), p=data.weights)]
        ostart = 0 if o["length"] <= crop else rng.integers(0, o["length"] - crop)
        y = wav_of(o, ostart, min(crop, o["length"]))
        y = np.pad(y, (0, crop - len(y)))
        wavs.append(x)
        others.append(y)
        t0 = start / SR
        T = crop // 160
        for (t, ctx, kind, lang, _, _) in e["bounds"]:
            tf = (t - t0) * FPS
            if tf < 15 or tf > T - 15:
                continue
            # The solver asks over a ~1.5 s candidate span centred within ~0.15 s of the label; train on that and narrower.
            center = tf + float(np.clip(rng.normal(0, 10), -30, 30))
            half = rng.uniform(30, 80)
            lo = max(0, int(center - half))
            hi = min(T - 1, int(center + half))
            if not (lo <= tf <= hi):
                continue
            items.append((bi, tf, lo, hi, ctx, kind, lang))
    return np.stack(wavs), np.stack(others), items


class Prefetcher:
    """Builds training batches on a background thread (its own file handle and RNG) and hands them over pinned, `depth` ahead."""

    def __init__(self, data, batch, crop_s, seed, depth=6):
        self.q = queue.Queue(maxsize=depth)
        self.stop = threading.Event()
        rng = np.random.default_rng(seed)
        wav_of = data.reader()

        def work():
            while not self.stop.is_set():
                wav, oth, items = make_batch(data, wav_of, rng, batch, crop_s)
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
    """The validation set, built once: clean peak-normalised audio on the GPU (fp16) in length-sorted batches with their fixed query
    windows (~1.5 s, centre within 0.15 s of the label, seeded), so every evaluation sees exactly the same questions."""

    def __init__(self, data, dev, max_batch_s=120.0):
        rng = np.random.default_rng(123)
        wav_of = data.reader()
        segs = sorted(data.val, key=lambda e: e["length"])
        self.batches = []
        cur = []

        def flush():
            if not cur:
                return
            L = max(len(w) for w, _, _ in cur)
            audio = torch.zeros(len(cur), L, dtype=torch.float16)
            items, langs = [], []
            for bi, (w, its, lg) in enumerate(cur):
                audio[bi, : len(w)] = torch.from_numpy(w)
                items += [(bi,) + it[1:] for it in its]
                langs += lg
            self.batches.append((audio.to(dev), items, langs))
            cur.clear()

        for e in segs:
            w = wav_of(e)
            w = w / (np.abs(w).max() + 1e-6) * 0.9
            T = len(w) // 160
            its, lg = [], []
            for (t, ctx, kind, lang, _, language) in e["bounds"]:
                tf = t * FPS
                center = tf + rng.uniform(-15, 15)
                lo, hi = max(0, int(center - 75)), min(T - 1, int(center + 75))
                if lo <= tf <= hi:
                    its.append((0, tf, lo, hi, ctx, kind, lang))
                    lg.append((language, e["src"]))
            if not its:
                continue
            if cur and (len(cur) + 1) * max(len(w), max(len(c[0]) for c in cur)) > max_batch_s * SR:
                flush()
            cur.append((w, its, lg))
        flush()
        self.n_items = sum(len(b[1]) for b in self.batches)
        self.megabytes = sum(b[0].numel() * 2 for b in self.batches) / 2**20


@torch.no_grad()
def evaluate(model, val):
    """nll = mean cross entropy over the validation queries (the early-stopping signal); argmax error statistics in ms."""
    model.eval()
    errs, langs, nll = [], [], []
    for audio, items, lg in val.batches:
        with torch.autocast("cuda", dtype=torch.float16):
            fr = model.frames(audio.float()).float()
        loss, logits = window_loss(model, fr, items)
        nll.append(loss.item() * len(items))
        pred = logits.argmax(1).float().cpu().numpy()
        errs += list(np.abs(pred - np.array([it[1] for it in items])) * 10.0)
        langs += lg
    model.train()
    errs = np.array(errs)
    res = {"n": int(len(errs)), "nll": float(sum(nll) / len(errs)), "mean_ms": float(errs.mean()), "median_ms": float(np.median(errs)),
           "le25": float((errs <= 25).mean()), "le50": float((errs <= 50).mean())}
    for L in LANGS:
        m = np.array([l == L for l, _ in langs])
        if m.any():
            res[L + "_mean_ms"] = float(errs[m].mean())
            res[L + "_le25"] = float((errs[m] <= 25).mean())
    srcs = sorted({s for _, s in langs})
    if len(srcs) > 1:
        for s in srcs:
            m = np.array([k == s for _, k in langs])
            res["src%d_mean_ms" % s] = float(errs[m].mean())
            res["src%d_le25" % s] = float((errs[m] <= 25).mean())
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-steps", type=int, default=40000)
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--crop", type=float, default=5.0)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--eval-every", type=int, default=500)
    ap.add_argument("--log-every", type=int, default=50)
    ap.add_argument("--decay-patience", type=int, default=2, help="evals without a new best val nll before the lr is halved")
    ap.add_argument("--patience", type=int, default=5, help="evals without a new best val nll before training stops (plateau)")
    ap.add_argument("--no-aug", action="store_true")
    ap.add_argument("--aug", default=",".join(AUG_PARTS), help="comma list of augmentation parts: " + ",".join(AUG_PARTS))
    ap.add_argument("--target", choices=["onset", "vowel"], default="vowel")
    ap.add_argument("--data", default=".cache/gtsinger_ds_full", help='comma list of dataset dirs, each optionally "dir@share" of the crops')
    ap.add_argument("--init", default=None, help="checkpoint (.pt) to start from (fine-tuning); its run must have the same model config")
    ap.add_argument("--subset", type=float, default=1.0, help="fraction of training segments (quick ablations)")
    ap.add_argument("--val-max", type=int, default=0, help="cap on validation segments (0 = all)")
    ap.add_argument("--ssl", choices=["mhubert", "none"], default="mhubert")
    ap.add_argument("--finetune", type=int, default=0, help="top SSL transformer layers to fine-tune (lr x0.03)")
    ap.add_argument("--no-context", action="store_true", help="ablation: no phone context in the query (context-free detector)")
    ap.add_argument("--seed", type=int, default=0, help="initialisation, batch sampling and augmentation seed (the validation set is fixed)")
    ap.add_argument("--teacher", default=None, help="run dir of a trained model (its config.json + best.pt): distil its window distributions")
    ap.add_argument("--distill", type=float, default=1.0, help="weight of the KL(teacher || student) term (with --teacher)")
    ap.add_argument("--distill-t", type=float, default=1.0, help="distillation temperature")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    cfg = {"ssl": args.ssl, "finetune": args.finetune, "target": args.target, "context": not args.no_context}
    json.dump({**cfg, "args": vars(args)}, open(os.path.join(args.out, "config.json"), "w"), indent=1)
    torch.manual_seed(args.seed)
    torch.set_num_threads(4)
    torch.backends.cudnn.benchmark = True  # fixed crop size: let cuDNN pick its fastest kernels once
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    dev = torch.device("cuda")
    gen = torch.Generator(device=dev)
    gen.manual_seed(args.seed)
    parts = tuple(args.aug.split(","))

    t_setup = time.time()
    data = Data(cfg, args.data, args.subset, args.val_max)
    print("data: %d train segments (%d boundaries), %d val segments (%d boundaries); crop shares per source %s" % (
        len(data.train), sum(len(e["bounds"]) for e in data.train), len(data.val), sum(len(e["bounds"]) for e in data.val),
        ", ".join("%.2f" % s for s in data.shares)), flush=True)
    val = ValCache(data, dev)
    print("val cache: %d queries in %d batches, %.0f MB on the GPU (%.1fs)" % (val.n_items, len(val.batches), val.megabytes, time.time() - t_setup), flush=True)
    model = build_model(cfg).to(dev)
    if args.init:
        missing, unexpected = model.load_state_dict(torch.load(args.init, map_location=dev), strict=False)
        assert not unexpected and all(k.startswith("ssl.") for k in missing), (missing, unexpected)
        res = evaluate(model, val)
        print("EVAL step 0 (init %s): %s" % (args.init, json.dumps({k: round(v, 4) for k, v in res.items()})), flush=True)
    teacher = None
    if args.teacher:
        tcfg = json.load(open(os.path.join(args.teacher, "config.json"), encoding="utf-8"))
        teacher = build_model(tcfg).to(dev).eval()
        missing, unexpected = teacher.load_state_dict(torch.load(os.path.join(args.teacher, "best.pt"), map_location=dev), strict=False)
        assert not unexpected and all(k.startswith("ssl.") for k in missing), (missing, unexpected)
        for p in teacher.parameters():
            p.requires_grad_(False)
    ssl_params = [p for n, p in model.named_parameters() if p.requires_grad and n.startswith("ssl.")]
    head_params = [p for n, p in model.named_parameters() if p.requires_grad and not n.startswith("ssl.")]
    params = ssl_params + head_params
    groups = [{"params": head_params, "lr": args.lr}] + ([{"params": ssl_params, "lr": args.lr * 0.03}] if ssl_params else [])
    opt = torch.optim.AdamW(groups, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 300))
    scaler = torch.amp.GradScaler("cuda")
    feed = Prefetcher(data, args.batch, args.crop, seed=args.seed)
    print("model: %.1fM trainable parameters; setup %.1fs; training (eval every %d steps, stop after %d evals without a better val nll)" % (
        sum(p.numel() for p in params) / 1e6, time.time() - t_setup, args.eval_every, args.patience), flush=True)

    best, best_step, since_best = None, 0, 0
    t0 = time.time()
    run = 0.0  # mean training loss of the last log window
    window = {"t": time.time(), "wait": 0.0, "steps": 0, "loss": torch.zeros((), device=dev)}
    curve = open(os.path.join(args.out, "curve.jsonl"), "a")
    torch.cuda.reset_peak_memory_stats()
    try:
        for step in range(1, args.max_steps + 1):
            tw = time.time()
            wav, oth, items = feed.next()
            window["wait"] += time.time() - tw
            wav = wav.to(dev, non_blocking=True)
            if not args.no_aug:
                wav = augment(wav, oth.to(dev, non_blocking=True), gen, parts)
            with torch.autocast("cuda", dtype=torch.float16):
                fr = model.frames(wav)
            loss, logits = window_loss(model, fr.float(), items)
            if teacher is not None:
                # KL(teacher || student) of the window distributions.
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
                    tlogits = window_logits(teacher, teacher.frames(wav).float(), items).float() / args.distill_t
                kl = (F.softmax(tlogits, dim=1) * (F.log_softmax(tlogits, dim=1) - F.log_softmax(logits / args.distill_t, dim=1))).sum(1)
                loss = loss + args.distill * args.distill_t ** 2 * kl.mean()
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            scaler.step(opt)
            scaler.update()
            sched.step()
            window["steps"] += 1
            window["loss"] += loss.detach()  # summed on the GPU: no sync per step
            if step % args.log_every == 0:
                run = window["loss"].item() / window["steps"]
                dt = time.time() - window["t"]
                rate = window["steps"] / dt
                to_eval = args.eval_every - step % args.eval_every
                print("step %d/%d | loss %.4f | lr %.2e | %.2f step/s (%.0f ms/step, data wait %.0f ms) | next eval in %d steps (~%.1f min) | vram peak %.1f GB | %.1f min" % (
                    step, args.max_steps, run, opt.param_groups[0]["lr"], rate, 1000 / rate, 1000 * window["wait"] / window["steps"],
                    to_eval % args.eval_every or args.eval_every, (to_eval % args.eval_every or args.eval_every) / rate / 60,
                    torch.cuda.max_memory_allocated() / 2**30, (time.time() - t0) / 60), flush=True)
                window = {"t": time.time(), "wait": 0.0, "steps": 0, "loss": torch.zeros((), device=dev)}
            if step % args.eval_every == 0:
                te = time.time()
                res = evaluate(model, val)
                res.update(step=step, train_loss=run, lr=opt.param_groups[0]["lr"], seconds=round(time.time() - t0))
                curve.write(json.dumps(res) + "\n")
                curve.flush()
                state = trainable_state(model)
                torch.save(state, os.path.join(args.out, "step%d.pt" % step))
                improved = best is None or res["nll"] < best
                if improved:
                    best, best_step, since_best = res["nll"], step, 0
                    torch.save(state, os.path.join(args.out, "best.pt"))
                    json.dump(res, open(os.path.join(args.out, "best.json"), "w"))
                else:
                    since_best += 1
                print("EVAL step %d (%.1fs): val nll %.4f%s | median %.0f ms, mean %.1f ms, <=25 ms %.1f%%, <=50 ms %.1f%% | best %.4f at step %d, %d/%d evals without improvement" % (
                    step, time.time() - te, res["nll"], " (new best, saved best.pt)" if improved else "", res["median_ms"], res["mean_ms"],
                    100 * res["le25"], 100 * res["le50"], best, best_step, since_best, args.patience), flush=True)
                window = {"t": time.time(), "wait": 0.0, "steps": 0, "loss": torch.zeros((), device=dev)}
                if since_best >= args.patience:
                    print("PLATEAU: stopping at step %d; best val nll %.4f at step %d -> %s" % (step, best, best_step, os.path.join(args.out, "best.pt")), flush=True)
                    break
                if since_best > 0 and since_best % args.decay_patience == 0:
                    sched.base_lrs = [b * 0.5 for b in sched.base_lrs]
                    print("lr halved to %.2e" % (sched.base_lrs[0]), flush=True)
    finally:
        feed.close()
    print("done: %.1f min, best val nll %.4f at step %d" % ((time.time() - t0) / 60, best if best is not None else float("nan"), best_step), flush=True)


if __name__ == "__main__":
    main()
