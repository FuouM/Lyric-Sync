# Joint training of the boundary model and the solver's heuristics on GTSinger (no project labels anywhere).
# Inputs: the cached backbone features of single segments (build_feature_cache.py --mode segments; val part with the "segments" group)
#         and lyricsync's own evidence for the same segments (extract_evidence.ts --subset ...: aligner phone posteriors, both phoneme-edge
#         sets, RMVPE / HarmoF0 / Swift notes, f0).
# --fusion: the evidence is also an input of the model (EV_DIM channels per 10 ms frame next to mHuBERT and log-mel).
# --loss crf: each sung run (a "line") is decoded by a chain CRF over 10 ms frames with the guided solver's terms (guided.ts):
#   unary  = beta * log P_model(boundary j at t) + votes (RMVPE / HarmoF0 / Swift note starts, both edge sets within 35 ms; x lineEdge at j = 0, m)
#   pair   = - dur |log(d / mean d)| - phase |d / s16 - round| (word / inner syllables) - inside min(3, note starts inside) + nucleus mean
#            posterior of the syllable's vowel - silence mean posterior; durations 0.08 .. MAX_DUR s.
#   The weights start at GUIDED_DESIGN's values and learn with the model from the CRF likelihood of the true boundaries.
#   What GTSinger cannot supply stays out: beat / eighth votes and beat snapping (no beat phase), the aligner-consensus prior (no lyrics
#   alignment); a run's mean syllable duration comes from its true span (the solver's consensus estimate stands in for it in a song).
# Validation (GTSinger val songs, clean): the model's window metrics (as train_cached.py) and the CRF's Viterbi decode of every run in a
# window of +-0.6 s around it: MAE / <=25 ms over all boundaries and over line starts (j = 0). Early stopping on the CRF validation NLL
# with --loss crf/both, else on the window NLL.
# usage: python scripts/gtsinger/train_joint.py --out .cache/boundary_model/j_x [--fusion] [--loss window|crf|both] [--init <run dir>] [--freeze-model]
import argparse
import json
import math
import os
import queue
import sys
import threading
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(__file__))
from boundary_model import KINDS, BoundaryModel, query_inputs  # noqa: E402
from train_boundary import Data, window_loss  # noqa: E402
from train_cached import Cache, local_window_eval  # noqa: E402

VOCAB = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "packages", "lyricsync", "models", "hubert-base", "vocab.json"),
                       encoding="utf-8"))["vocab"]
N_POST = 144
EV_DIM = N_POST + 3 + 3 + 2 + 2  # posteriors, note starts (rmvpe, harmo, swift), note ends, two edge sets, log f0 + voiced
CROP = 800  # 100 fps frames per training crop (8 s)
SPAN_PAD = 60  # frames either side of a run's true extent that the CRF searches (0.6 s)
MIN_DUR, MAX_DUR = 8, 200  # syllable durations the CRF allows, frames
RMVPE_LAG, HARMO_LAG = -0.012, 0.015  # GUIDED_DESIGN lags (s)
VOTE_WIN = 3.5  # frames (35 ms)
EDGE_MIN = 0.35
EN_VOWELS = {"aa", "ae", "ah", "ao", "aw", "ax", "ay", "eh", "er", "ey", "ih", "iy", "ow", "oy", "uh", "uw"}
JA_VOWELS = {"a", "i", "u", "e", "o", "N"}
# Learned heuristic weights and their GUIDED_DESIGN starting values (preset: swiftVote 0, silenceWeight 0; the second edge set and the
# model's log-probability have no counterpart there and start at 0 / 1).
WEIGHTS0 = {"model": 1.0, "rmvpe": 1.0, "harmo": 1.0, "swift": 0.0, "edge0": 3.0, "edge1": 0.0, "lineEdge": 1.0, "dur": 1.5, "phaseWord": 1.6,
            "phaseInner": 0.8, "inside": 1.0, "nucleus": 12.0, "silence": 0.0}


class Evidence:
    def __init__(self, d=".cache/gtsinger_ev"):
        self.e = {}
        for line in open(os.path.join(d, "index.jsonl"), encoding="utf-8"):
            if line.strip():
                x = json.loads(line)
                self.e[x["id"]] = x
        self.post = np.memmap(os.path.join(d, "posteriors.u8"), dtype=np.uint8, mode="r")

    def posteriors(self, x, T):
        p = np.asarray(self.post[x["postOffset"]: x["postOffset"] + x["frames"] * x["vocab"]]).reshape(x["frames"], x["vocab"])
        out = np.zeros((T, N_POST), dtype=np.float32)
        n = min(T, len(p))
        out[:n] = p[:n] / 255.0
        return out


def impulses(times, T, sigma=1.5, heights=None):
    """Sum of Gaussians (peak 1 x height) at times (s) on a T-frame 100 fps grid."""
    out = np.zeros(T, dtype=np.float32)
    f = np.arange(T, dtype=np.float32)
    for i, t in enumerate(times):
        c = t * 100
        if -10 < c < T + 10:
            lo, hi = max(0, int(c - 6)), min(T, int(c + 7))
            out[lo:hi] += (heights[i] if heights is not None else 1.0) * np.exp(-0.5 * ((f[lo:hi] - c) / sigma) ** 2)
    return out


class Segment:
    """One GTSinger segment: its runs (CRF lines), evidence events and (lazily) frame features."""

    def __init__(self, entry, raw, ev, tempo_bpm):
        self.id, self.lang, self.T = entry["id"], entry["lang"], entry["length"] // 160
        self.ev = ev
        self.s16 = 60.0 / tempo_bpm / 4 * 100 if tempo_bpm else None  # frames per sixteenth
        self.rmvpe = sorted(n[0] + RMVPE_LAG for n in ev["rmvpe"])
        self.harmo = sorted(n[0] + HARMO_LAG for n in ev["harmo"])
        self.swift = sorted(n[0] for n in ev["swift"])
        self.edges = [sorted(p["t"] for p in s if p["prob"] >= EDGE_MIN) for s in ev["edgeSets"][:2]]
        self.runs = []
        for run in raw["runs"]:
            m = len(run)
            g = [s["vowel"] for s in run] + [run[-1]["end"]]
            q = []
            for j in range(m + 1):
                left = run[j - 1]["phones"] if j > 0 else None
                right = run[j]["phones"] if j < m else None
                kind = "runStart" if j == 0 else "runEnd" if j == m else ("word" if run[j]["wordStart"] else "inner")
                q.append(query_inputs({}, self.lang, left, right, kind))
            vowels = EN_VOWELS if self.lang == "en" else JA_VOWELS
            nuc = []
            for s in run:
                v = next((p for p in s["phones"] if p in vowels), s["phones"][-1])
                nuc.append(VOCAB.get("%s/%s" % (self.lang, {"ax": "ah", "dx": "t"}.get(v, v)), 0))
            word = [run[j]["wordStart"] and (j + 1 == m or run[j + 1]["wordStart"]) for j in range(m)]  # a one-syllable word
            self.runs.append({"g": np.array(g) * 100, "q": q, "nuc": nuc, "word": word})

    def events_near(self, T, off):
        """(5, T) 0/1: an event of each voting source within VOTE_WIN frames of the frame (frames from `off`)."""
        out = np.zeros((5, T), dtype=np.float32)
        for k, times in enumerate([self.rmvpe, self.harmo, self.swift, self.edges[0], self.edges[1]]):
            for t in times:
                c = t * 100 - off
                lo, hi = max(0, int(math.ceil(c - VOTE_WIN))), min(T, int(math.floor(c + VOTE_WIN)) + 1)
                if lo < hi:
                    out[k, lo:hi] = 1
        return out

    def note_starts(self, T, off):
        """(T,) count of RMVPE + HarmoF0 note starts per frame (frames from `off`)."""
        out = np.zeros(T, dtype=np.float32)
        for t in self.rmvpe + self.harmo:
            f = int(round(t * 100 - off))
            if 0 <= f < T:
                out[f] += 1
        return out

    def features(self, evd, T, off):
        """(T, EV_DIM) model-input evidence frames from frame `off`."""
        post = evd.posteriors(self.ev, off + T)[off:]
        ends = [[n[1] for n in self.ev[k]] for k in ("rmvpe", "harmo", "swift")]
        rel = lambda ts: [t - off / 100 for t in ts]
        cols = [post]
        cols += [impulses(rel(ts), T)[:, None] for ts in (self.rmvpe, self.harmo, self.swift)]
        cols += [impulses(rel(ts), T)[:, None] for ts in ends]
        for s in self.ev["edgeSets"][:2]:
            cols.append(impulses(rel([p["t"] for p in s]), T, heights=[p["prob"] for p in s])[:, None])
        f0 = np.zeros(T, dtype=np.float32)
        src = np.asarray(self.ev["f0Hz"], dtype=np.float32)[off: off + T]
        f0[: len(src)] = src
        cols.append(np.where(f0 > 0, np.log2(np.maximum(f0, 1) / 220.0), 0)[:, None].astype(np.float32))
        cols.append((f0 > 0).astype(np.float32)[:, None])
        return np.concatenate(cols, axis=1)


class Heuristics(nn.Module):
    def __init__(self, learn):
        super().__init__()
        self.w = nn.ParameterDict({k: nn.Parameter(torch.tensor(float(v)), requires_grad=learn) for k, v in WEIGHTS0.items()})

    def values(self):
        return {k: round(float(v), 4) for k, v in self.w.items()}


def run_terms(H, logp, near, starts_cum, post_cum, run, s, L):
    """CRF terms of one run on its span [s, s + L) (crop frames). logp: (m+1, L) model log-probs; near (5, L); starts_cum (L+1,) cumsum of
    note starts; post_cum (L+1, N_POST) cumsum of posteriors. -> (unaries (m+1, L), pairs [(L, K)] per syllable)."""
    w = H.w
    m = logp.shape[0] - 1
    votes = (w["rmvpe"] * near[0] + w["harmo"] * near[1] + w["swift"] * near[2] + w["edge0"] * near[3] + w["edge1"] * near[4])
    one = torch.ones((), device=logp.device)
    scale = torch.stack([w["lineEdge"]] + [one] * (m - 1) + [w["lineEdge"]])[:, None]  # the line's first and last boundary
    U = w["model"] * logp + scale * votes[None]
    dev = logp.device
    K = MAX_DUR - MIN_DUR + 1
    t1 = torch.arange(L, device=dev)[:, None]
    d = (torch.arange(K, device=dev) + MIN_DUR)[None]
    t2 = t1 + d
    valid = t2 < L
    t2c = t2.clamp_max(L - 1)
    g = run["g"]
    mean_d = max((g[-1] - g[0]) / m, MIN_DUR)
    lo = (t1 + 3).expand_as(t2c)
    hi = (t2c - 3).clamp_min(0)
    inside = (starts_cum[hi] - starts_cum[torch.minimum(lo, hi)]).clamp(max=3)
    mg = torch.where(d > 12, 3, 0).expand_as(t2c)
    a, b = (t1 + mg).clamp_max(L - 1), (t2c - mg).clamp_min(0)
    b = torch.maximum(a + 1, b)
    span = (b - a).float()
    sil = (post_cum[b, 0] - post_cum[a, 0]) / span
    dur_term = -w["dur"] * torch.log(d.float() / mean_d).abs()
    pairs = []
    for j in range(1, m + 1):
        nuc = (post_cum[b, run["nuc"][j - 1]] - post_cum[a, run["nuc"][j - 1]]) / span
        P = dur_term - w["inside"] * inside + w["nucleus"] * nuc - w["silence"] * sil
        if run["s16"] is not None:
            x = d.float() / run["s16"]
            P = P - (w["phaseWord"] if run["word"][j - 1] else w["phaseInner"]) * (x - torch.round(x)).abs()
        pairs.append(P.masked_fill(~valid, -1e9))
    return U, pairs


def crf_forward(U, pairs, viterbi=False):
    """Chain over boundaries; pairs[j-1][t1, k]: boundary j-1 at t1, j at t1 + MIN_DUR + k. -> log Z (or best path with viterbi)."""
    L = U.shape[1]
    K = MAX_DUR - MIN_DUR + 1
    dev = U.device
    t2 = torch.arange(L, device=dev)[:, None]
    t1 = t2 - (torch.arange(K, device=dev) + MIN_DUR)[None]
    ok = t1 >= 0
    t1c = t1.clamp_min(0)
    kk = torch.arange(K, device=dev)[None].expand(L, K)
    alpha = U[0]
    back = []
    for j, P in enumerate(pairs, start=1):
        M = (alpha[:, None] + P)[t1c, kk].masked_fill(~ok, -1e9)
        if viterbi:
            best, arg = M.max(1)
            back.append(t1c.gather(1, arg[:, None])[:, 0])
            alpha = U[j] + best
        else:
            alpha = U[j] + torch.logsumexp(M, 1)
    if not viterbi:
        return torch.logsumexp(alpha, 0)
    path = [int(alpha.argmax())]
    for bp in reversed(back):
        path.append(int(bp[path[-1]]))
    return path[::-1]


def gold_score(U, pairs, gold):
    s = U[0, gold[0]]
    for j, P in enumerate(pairs, start=1):
        s = s + U[j, gold[j]] + P[gold[j - 1], gold[j] - gold[j - 1] - MIN_DUR]
    return s


def gold_ok(gold, L):
    return all(0 <= x < L for x in gold) and all(MIN_DUR <= b - a <= MAX_DUR for a, b in zip(gold, gold[1:]))


def crf_runs(model, H, fr, batch_runs, viterbi=False):
    """batch_runs: [(batch idx, segment, run, crop offset, near (5, T) tensor, starts_cum, post_cum)] -> (sum NLL, n runs, decodes)."""
    nll, n, decodes = 0.0, 0, []
    for bi, seg, run, off, near, starts_cum, post_cum in batch_runs:
        g = [int(round(x - off)) for x in run["g"]]
        s = max(0, g[0] - SPAN_PAD)
        e = min(fr.shape[1], g[-1] + SPAN_PAD + 1)
        L = e - s
        gold = [x - s for x in g]
        if not gold_ok(gold, L):
            continue
        dev = fr.device
        ctx = torch.tensor([q[0] for q in run["q"]], device=dev)
        kind = torch.tensor([q[1] for q in run["q"]], device=dev)
        lang = torch.tensor([q[2] for q in run["q"]], device=dev)
        q = model.queries(ctx, kind, lang)  # (m+1, d)
        logp = F.log_softmax(model.score(fr[bi, s:e][None].expand(len(q), -1, -1), q).float(), dim=1)  # (m+1, L)
        run = dict(run, s16=seg.s16)
        sc = starts_cum[s: e + 1] - starts_cum[s]
        pc = post_cum[s: e + 1] - post_cum[s]
        U, pairs = run_terms(H, logp, near[:, s:e], sc, pc, run, s, L)
        if viterbi:
            decodes.append((gold, crf_forward(U, pairs, viterbi=True), [int(x) for x in logp.argmax(1)]))
        else:
            nll = nll + crf_forward(U, pairs) - gold_score(U, pairs, gold)
        n += 1
    return nll, n, decodes


def runs_inputs(seg, off, T, evd, dev):
    near = torch.from_numpy(seg.events_near(T, off)).to(dev)
    starts_cum = torch.from_numpy(np.concatenate([[0], np.cumsum(seg.note_starts(T, off))]).astype(np.float32)).to(dev)
    post = evd.posteriors(seg.ev, off + T)[off:]
    post_cum = torch.from_numpy(np.concatenate([np.zeros((1, N_POST), np.float32), np.cumsum(post, 0)]).astype(np.float32)).to(dev)
    return near, starts_cum, post_cum


def frames(model, h, m, ev, dev):
    with torch.autocast("cuda", dtype=torch.float16, enabled=dev.type == "cuda"):
        return model.frame_out(model.head_forward(h, m, ev)).float()


@torch.no_grad()
def evaluate_runs(model, H, val, vcache, evd, fusion, dev):
    """val: [(cache entry, Segment)] -> the model's window metrics and the CRF's Viterbi decode errors (all boundaries / line starts)."""
    model.eval()
    werr, wnll, wn = [], 0.0, 0
    crf_nll, crf_n = 0.0, 0
    err_crf, err_model, err_crf_start, err_model_start = [], [], [], []
    vr = np.random.default_rng(123)
    for ce, seg in val:
        T = ce["m_len"]
        h, m = vcache.arrays(ce, 0, T)
        ev = torch.from_numpy(seg.features(evd, T, 0))[None].to(dev) if fusion else None
        fr = frames(model, torch.from_numpy(h)[None].to(dev), torch.from_numpy(m)[None].to(dev), ev, dev)
        items = []
        for run in seg.runs:
            for t, qq in zip(run["g"], run["q"]):
                c = t + vr.uniform(-15, 15)
                a, b = max(0, int(c - 75)), min(T - 1, int(c + 75))
                if a <= t <= b:
                    items.append((0, t, a, b) + tuple(qq))
        if items:
            ce_sum, pred = local_window_eval(model, fr, items)
            wnll += ce_sum
            wn += len(items)
            werr += list(np.abs(pred - np.array([it[1] for it in items])) * 10)
        near, sc, pc = runs_inputs(seg, 0, T, evd, dev)
        br = [(0, seg, run, 0, near, sc, pc) for run in seg.runs]
        nll, n, _ = crf_runs(model, H, fr, br)
        crf_nll += float(nll)
        crf_n += n
        _, _, dec = crf_runs(model, H, fr, br, viterbi=True)
        for gold, path, arg in dec:
            for j, (g, p, a) in enumerate(zip(gold, path, arg)):
                err_crf.append(abs(p - g) * 10)
                err_model.append(abs(a - g) * 10)
                if j == 0:
                    err_crf_start.append(abs(p - g) * 10)
                    err_model_start.append(abs(a - g) * 10)
    model.train()
    f = lambda xs: (float(np.mean(xs)), float(np.mean(np.array(xs) <= 25)))
    res = {"window_nll": wnll / max(wn, 1), "window_le25": float(np.mean(np.array(werr) <= 25)), "crf_nll": crf_nll / max(crf_n, 1), "runs": crf_n}
    for name, xs in (("crf", err_crf), ("model", err_model), ("crf_start", err_crf_start), ("model_start", err_model_start)):
        res[name + "_mae"], res[name + "_le25"] = f(xs)
    return res


def load_segments(data_list, raw_by_id, evd, grids):
    segs = []
    for e in data_list:
        ev = evd.e.get(e["id"])
        if ev is None:
            continue
        gr = grids.get(e["id"])
        segs.append(Segment(e, raw_by_id[e["id"]], ev, gr["tempo_bpm"] if gr and gr.get("quality") == "good" else None))
    return segs


def make_batch(train_entries, segs_by_id, cache, evd, fusion, rng, batch):
    hs, ms, evs, items, runs = [], [], [], [], []
    while len(hs) < batch:
        ci = int(rng.integers(len(train_entries)))
        entry, sid = train_entries[ci]
        seg = segs_by_id.get(sid)
        if seg is None or not seg.runs:
            continue
        r = seg.runs[int(rng.integers(len(seg.runs)))]
        lo_ok = int(r["g"][-1] + SPAN_PAD + 1 - CROP)
        hi_ok = int(r["g"][0] - SPAN_PAD)
        lo, hi = max(0, lo_ok), min(hi_ok, max(0, entry["m_len"] - CROP))
        if hi < lo:
            continue
        off = int(rng.integers(lo, hi + 1)) // 2 * 2
        bi = len(hs)
        h, m = cache.arrays(entry, off, CROP)
        hs.append(h)
        ms.append(m)
        if fusion:
            evs.append(seg.features(evd, CROP, off))
        for run in seg.runs:
            for j, (t, q) in enumerate(zip(run["g"], run["q"])):
                tf = t - off
                if 15 <= tf <= CROP - 15:
                    center = tf + float(np.clip(rng.normal(0, 10), -30, 30))
                    half = rng.uniform(30, 80)
                    a, b = max(0, int(center - half)), min(CROP - 1, int(center + half))
                    if a <= tf <= b:
                        items.append((bi, tf, a, b) + tuple(q))
            if run["g"][0] - SPAN_PAD >= off and run["g"][-1] + SPAN_PAD + 1 <= off + CROP:
                runs.append((bi, seg, run, off))
    return np.stack(hs), np.stack(ms), (np.stack(evs) if fusion else None), items, runs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", default=".cache/feat_cache/sub25_seg")
    ap.add_argument("--val", default=".cache/feat_cache/sub25v3")
    ap.add_argument("--evidence", default=".cache/gtsinger_ev")
    ap.add_argument("--grids", default=".cache/research/beats/grids.json", help="per-segment GTSinger tempo (the 16th-phase term)")
    ap.add_argument("--fusion", action="store_true", help="the evidence is a model input too")
    ap.add_argument("--loss", choices=["window", "crf", "both"], default="both")
    ap.add_argument("--fixed-weights", action="store_true", help="the heuristic weights stay at their GUIDED_DESIGN values")
    ap.add_argument("--init", default=None, help="run dir to start the model (and weights.json if present) from")
    ap.add_argument("--freeze-model", action="store_true", help="only the heuristic weights train (with --init)")
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--weights-lr", type=float, default=1e-2)
    ap.add_argument("--max-steps", type=int, default=20000)
    ap.add_argument("--eval-every", type=int, default=200)
    ap.add_argument("--log-every", type=int, default=50)
    ap.add_argument("--patience", type=int, default=4)
    ap.add_argument("--val-max", type=int, default=0, help="cap on validation segments (0 = all)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", default="cuda")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    cfg = {"ssl": "mhubert", "finetune": 0, "target": "vowel", "context": True, "ev_dim": EV_DIM if args.fusion else 0}
    json.dump({**cfg, "args": vars(args)}, open(os.path.join(args.out, "config.json"), "w"), indent=1)
    torch.manual_seed(args.seed)
    dev = torch.device(args.device)
    t_setup = time.time()

    data = Data({"target": "vowel"}, ".cache/gtsinger_ds_full", 0.25)
    raw_by_id = {e["id"]: e for e in json.load(open(".cache/gtsinger_ds_full/index.json", encoding="utf-8"))}
    evd = Evidence(args.evidence)
    grids = json.load(open(args.grids, encoding="utf-8")) if os.path.exists(args.grids) else {}
    train_cache = Cache(os.path.join(args.cache, "train"))
    n_tr = len(data.train)
    assert len(train_cache.entries) % n_tr == 0, (len(train_cache.entries), n_tr)
    train_entries = []
    for i, ce in enumerate(train_cache.entries):
        e = data.train[i % n_tr]
        assert ce["m_len"] == e["length"] // 160, (i, ce["m_len"], e["length"])
        train_entries.append((ce, e["id"]))
    segs_by_id = {s.id: s for s in load_segments(data.train, raw_by_id, evd, grids)}
    train_entries = [(ce, sid) for ce, sid in train_entries if sid in segs_by_id]
    vcache = Cache(os.path.join(args.val, "val"))
    vents = [ce for ce in vcache.entries if ce["group"] == "segments"]
    assert len(vents) == len(data.val)
    val = [(ce, s) for ce, e in zip(vents, data.val) for s in load_segments([e], raw_by_id, evd, grids)]
    if 0 < args.val_max < len(val):
        val = [val[i] for i in sorted(np.random.default_rng(7).choice(len(val), args.val_max, replace=False))]
    print("train: %d cached segment copies with evidence (%d segments); val: %d segments (%d runs); setup %.1fs" % (
        len(train_entries), len(segs_by_id), len(val), sum(len(s.runs) for _, s in val), time.time() - t_setup), flush=True)

    model = BoundaryModel(None, cached_dim=train_cache.h.shape[1], ev_dim=cfg["ev_dim"]).to(dev)
    H = Heuristics(learn=not args.fixed_weights).to(dev)
    layer_w = torch.load(train_cache.mix_from, map_location="cpu")["layer_w"]
    if args.init:
        state = torch.load(os.path.join(args.init, "best.pt"), map_location=dev)
        state.pop("layer_w", None)
        model.load_state_dict(state)
        wfile = os.path.join(args.init, "weights.json")
        if os.path.exists(wfile):
            for k, v in json.load(open(wfile)).items():
                H.w[k].data.fill_(v)
    if args.freeze_model:
        for p in model.parameters():
            p.requires_grad_(False)
    groups = []
    mp = [p for p in model.parameters() if p.requires_grad]
    if mp:
        groups.append({"params": mp, "lr": args.lr, "weight_decay": 0.01})
    hp = [p for p in H.parameters() if p.requires_grad]
    if hp and args.loss != "window":
        groups.append({"params": hp, "lr": args.weights_lr, "weight_decay": 0.0})
    opt = torch.optim.AdamW(groups)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 200))
    rng = np.random.default_rng(args.seed)
    q = queue.Queue(maxsize=6)
    stop = threading.Event()

    def work():
        r = np.random.default_rng(args.seed + 1)
        while not stop.is_set():
            b = make_batch(train_entries, segs_by_id, train_cache, evd, args.fusion, r, args.batch)
            while not stop.is_set():
                try:
                    q.put(b, timeout=0.5)
                    break
                except queue.Full:
                    continue

    threading.Thread(target=work, daemon=True).start()
    frames_of = lambda h, m, ev: frames(model, h, m, ev, dev)
    evaluate = lambda: evaluate_runs(model, H, val, vcache, evd, args.fusion, dev)

    def save(path):
        state = dict(model.state_dict())
        state["layer_w"] = layer_w
        torch.save(state, path)

    key = "window_nll" if args.loss == "window" else "crf_nll"
    best, best_step, since = None, 0, 0
    t0 = time.time()
    win = {"t": time.time(), "n": 0, "w": 0.0, "c": 0.0, "wait": 0.0}
    curve = open(os.path.join(args.out, "curve.jsonl"), "a")
    res = evaluate()
    print("EVAL step 0: %s | weights %s" % (json.dumps({k: round(v, 4) if isinstance(v, float) else v for k, v in res.items()}), H.values()), flush=True)
    try:
        for step in range(1, args.max_steps + 1):
            tw = time.time()
            h, m, ev, items, runs = q.get()
            win["wait"] += time.time() - tw
            hg, mg = torch.from_numpy(h).to(dev), torch.from_numpy(m).to(dev)
            evg = torch.from_numpy(ev).to(dev) if ev is not None else None
            fr = frames_of(hg, mg, evg)
            loss = torch.zeros((), device=dev)
            if args.loss in ("window", "both") and items and not args.freeze_model:
                wl, _ = window_loss(model, fr, items)
                loss = loss + wl
                win["w"] += float(wl)
            if args.loss in ("crf", "both") and runs:
                br = []
                for bi, seg, run, off in runs:
                    near, sc, pc = runs_inputs(seg, off, CROP, evd, dev)
                    br.append((bi, seg, run, off, near, sc, pc))
                nll, n, _ = crf_runs(model, H, fr, br)
                if n:
                    cl = nll / n
                    loss = loss + cl
                    win["c"] += float(cl)
            opt.zero_grad(set_to_none=True)
            if loss.requires_grad:
                loss.backward()
                torch.nn.utils.clip_grad_norm_([p for g in groups for p in g["params"]], 1.0)
                opt.step()
            sched.step()
            win["n"] += 1
            if step % args.log_every == 0:
                dt = time.time() - win["t"]
                print("step %d | window %.4f crf %.4f | %.0f ms/step (data wait %.0f ms) | %.1f min" % (
                    step, win["w"] / win["n"], win["c"] / win["n"], 1000 * dt / win["n"], 1000 * win["wait"] / win["n"], (time.time() - t0) / 60), flush=True)
                win = {"t": time.time(), "n": 0, "w": 0.0, "c": 0.0, "wait": 0.0}
            if step % args.eval_every == 0:
                te = time.time()
                res = evaluate()
                row = {"step": step, **res, "weights": H.values()}
                curve.write(json.dumps(row) + "\n")
                curve.flush()
                improved = best is None or res[key] < best
                if improved:
                    best, best_step, since = res[key], step, 0
                    save(os.path.join(args.out, "best.pt"))
                    json.dump(H.values(), open(os.path.join(args.out, "weights.json"), "w"), indent=1)
                    json.dump(row, open(os.path.join(args.out, "best.json"), "w"))
                else:
                    since += 1
                print("EVAL step %d (%.0fs): window nll %.4f le25 %.1f%% | crf nll %.3f | CRF decode MAE %.1f ms le25 %.1f%% (line starts %.1f ms) | model argmax MAE %.1f ms (line starts %.1f) | %s%s" % (
                    step, time.time() - te, res["window_nll"], 100 * res["window_le25"], res["crf_nll"], res["crf_mae"], 100 * res["crf_le25"],
                    res["crf_start_mae"], res["model_mae"], res["model_start_mae"], H.values(), " (new best)" if improved else ""), flush=True)
                win = {"t": time.time(), "n": 0, "w": 0.0, "c": 0.0, "wait": 0.0}
                if since >= args.patience:
                    print("PLATEAU: best %s %.4f at step %d" % (key, best, best_step), flush=True)
                    break
                if since > 0 and since % 2 == 0:
                    for g in opt.param_groups:
                        g["lr"] *= 0.5
                    sched.base_lrs = [b * 0.5 for b in sched.base_lrs]
    finally:
        stop.set()
    print("done: %.1f min, best %s %.4f at step %d" % ((time.time() - t0) / 60, key, best if best is not None else float("nan"), best_step), flush=True)


if __name__ == "__main__":
    main()
