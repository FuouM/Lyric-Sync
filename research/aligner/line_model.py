# Line aligner: the boundary model (../boundary/boundary_model.py) extended to a whole sung line.
# Audio: the same trunk (frozen mHuBERT-147 layer mix + log-mel -> conv -> BiGRU), two frame heads: syllable start (first phone, "onset")
#        and vowel onset ("vowel"); each head gives a d-wide embedding and a context-free logit per 10 ms frame.
# Text:  every boundary j = 0..m of a line is a token (its 5-phone context, kind, language, the old model's input). A small transformer
#        over the line's tokens adds line-wide context to each boundary's query; one query per head. The transformer's output enters as a
#        residual on the old query MLP (zero-initialised), so a fresh model scores exactly like the checkpoint it starts from.
# Chain: the line's boundaries are decoded jointly. Score of a path b_0 < ... < b_m (frames) =
#        sum_j unary_j(b_j) + sum_s pair_s(b_s+1 - b_s), unary = E_t . q_j / sqrt(d) + g_t, pair_s = MLP(duration features, syllable embedding).
#        Trained by the chain's log-likelihood of the true path (forward algorithm over each boundary's candidate window).
import copy
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "boundary"))
from boundary_model import CTX, FPS, KINDS, LANGS, PHONES, SR, BoundaryModel, load_ssl, query_inputs  # noqa: E402,F401

HEADS = ("onset", "vowel")
MIN_DUR = 3  # frames: shortest syllable the chain allows (30 ms; Japanese "cl" and fast English syllables go below the solver's 80 ms)
MAX_DUR = 400  # frames: durations past this score like MAX_DUR
SYL_DIM = 8
# Per-frame evidence (ev_features): voiced, log2(f0 / 220), its frame difference, RMVPE note start / end impulses, beat / eighth / sixteenth
# impulses, beat phase (sin, cos).
EV_DIM = 10


def ev_features(T, f0, notes, beats):
    """T frames at 100 fps from t = 0. f0: Hz per frame (0 = unvoiced; any length, cut / zero-padded to T); notes: [(start, end)] s;
    beats: sorted beat times s ([] = no beat channel). -> (T, EV_DIM) float32 numpy array."""
    import numpy as np
    out = np.zeros((T, EV_DIM), dtype=np.float32)
    f = np.zeros(T, dtype=np.float32)
    f0 = np.asarray(f0, dtype=np.float32)[:T]
    f[: len(f0)] = f0
    voiced = f > 0
    out[:, 0] = voiced
    lf = np.where(voiced, np.log2(np.maximum(f, 1.0) / 220.0), 0.0)
    out[:, 1] = lf
    d = np.zeros(T, dtype=np.float32)
    both = voiced[1:] & voiced[:-1]
    d[1:] = np.where(both, np.clip(lf[1:] - lf[:-1], -1.0, 1.0), 0.0)
    out[:, 2] = d
    t = np.arange(T, dtype=np.float32) / FPS

    def impulses(times, ch, sigma):
        for x in times:
            c = int(round(x * FPS))
            if -4 * sigma <= c < T + 4 * sigma:
                lo, hi = max(0, c - int(4 * sigma)), min(T, c + int(4 * sigma) + 1)
                out[lo:hi, ch] = np.maximum(out[lo:hi, ch], np.exp(-0.5 * ((t[lo:hi] - x) * FPS / sigma) ** 2))

    impulses([n[0] for n in notes], 3, 1.5)
    impulses([n[1] for n in notes], 4, 1.5)
    if len(beats) >= 2:
        b = np.asarray(beats, dtype=np.float64)
        mids = (b[1:] + b[:-1]) / 2
        quarters = np.concatenate([b[:-1] + (b[1:] - b[:-1]) * 0.25, b[:-1] + (b[1:] - b[:-1]) * 0.75])
        impulses(b, 5, 2.0)
        impulses(mids, 6, 2.0)
        impulses(quarters, 7, 2.0)
        k = np.clip(np.searchsorted(b, t, side="right") - 1, 0, len(b) - 2)
        phase = (t - b[k]) / (b[k + 1] - b[k])
        inside = (t >= b[0]) & (t <= b[-1])
        out[:, 8] = np.where(inside, np.sin(2 * np.pi * phase), 0.0)
        out[:, 9] = np.where(inside, np.cos(2 * np.pi * phase), 0.0)
    return out


class LineAligner(BoundaryModel):
    def __init__(self, ssl, d=64, hidden=256, text=128, ev_dim=0):
        super().__init__(ssl, finetune=0, d=d, hidden=hidden, ev_dim=ev_dim)
        self.ev_dim = ev_dim
        # Two frame heads; the inherited frame_out / query are the vowel head (the checkpoint's own target).
        self.frame_out_onset = nn.Linear(2 * hidden, d + 1)
        self.query_onset = copy.deepcopy(self.query)
        self.tok = nn.Linear(CTX * 48 + 16 + 8, text)
        self.tok_pos = nn.Embedding(128, text)
        layer = nn.TransformerEncoderLayer(text, 4, 2 * text, dropout=0.1, batch_first=True, norm_first=True)
        self.text = nn.TransformerEncoder(layer, 2)
        self.res = nn.ModuleDict({h: nn.Linear(text, d) for h in HEADS})
        for lin in self.res.values():
            nn.init.zeros_(lin.weight)
            nn.init.zeros_(lin.bias)
        self.syl = nn.Linear(2 * text, SYL_DIM)
        self.pair = nn.ModuleDict({h: nn.Sequential(nn.Linear(4 + SYL_DIM, 32), nn.GELU(), nn.Linear(32, 1)) for h in HEADS})

    def init_from_boundary(self, state):
        """Loads a boundary-model checkpoint (trainable_state of BoundaryModel) and copies its vowel head into the onset head."""
        missing, unexpected = self.load_state_dict(state, strict=False)
        assert not unexpected, unexpected
        self.frame_out_onset.load_state_dict(self.frame_out.state_dict())
        self.query_onset.load_state_dict(self.query.state_dict())

    def init_from_line(self, state):
        """Loads a line-aligner checkpoint trained without evidence; the evidence columns of the input layer start at zero, so the model
        scores exactly like that checkpoint until it learns to use them."""
        w = state["inp.weight"]
        if w.shape[1] != self.inp.weight.shape[1]:
            grown = torch.zeros_like(self.inp.weight)
            grown[:, : w.shape[1]] = w
            state = {**state, "inp.weight": grown}
        missing, unexpected = self.load_state_dict(state, strict=False)
        assert not unexpected and all(k.startswith("ssl.") for k in missing), (missing, unexpected)

    def frames2(self, wav, ev=None):
        """wav (B, S), ev (B, T, ev_dim) when ev_dim > 0 -> {head: (B, T, d+1)} at 100 fps."""
        h, m = self.features(wav)
        z = self.head_forward(h, m, ev[:, : m.shape[1]] if ev is not None else None)
        return {"vowel": self.frame_out(z), "onset": self.frame_out_onset(z)}

    def line_tokens(self, ctx, kind, lang, mask):
        """ctx (L, M, CTX), kind (L, M), lang (L, M), mask (L, M) True = real token -> (old-query input (L, M, 264), text states (L, M, text))."""
        e = (self.phone_emb(ctx) + self.pos_emb).flatten(2)
        x = torch.cat([e, self.kind_emb(kind), self.lang_emb(lang)], dim=-1)
        pos = torch.arange(ctx.shape[1], device=ctx.device).clamp_max(127)
        h = self.text(self.tok(x) + self.tok_pos(pos)[None], src_key_padding_mask=~mask)
        return x, h

    def line_queries(self, x, h):
        """-> {head: (L, M, d)} queries of every boundary."""
        return {"vowel": self.query(x) + self.res["vowel"](h), "onset": self.query_onset(x) + self.res["onset"](h)}

    def syllable_codes(self, h):
        """(L, M, text) boundary states -> (L, M-1, SYL_DIM): syllable s sits between boundaries s and s+1."""
        return self.syl(torch.cat([h[:, :-1], h[:, 1:]], dim=-1))

    def pair_table(self, head, codes, mean_dur):
        """codes (L, S, SYL_DIM), mean_dur (L,) frames -> (L, S, MAX_DUR + 1) pair score of every duration 0..MAX_DUR frames
        (-inf below MIN_DUR)."""
        dur = torch.arange(MAX_DUR + 1, device=codes.device, dtype=torch.float32).clamp_min(1.0)
        logd = torch.log(dur / FPS)[None, None, :]
        ratio = torch.log(dur[None, :] / mean_dur[:, None].clamp_min(1.0))[:, None, :]
        L, S, _ = codes.shape
        feats = torch.stack([logd.expand(L, S, -1), ratio.expand(L, S, -1), ratio.expand(L, S, -1) ** 2,
                             (dur < 12).float()[None, None, :].expand(L, S, -1)], dim=-1)
        x = torch.cat([feats, codes[:, :, None, :].expand(-1, -1, MAX_DUR + 1, -1)], dim=-1)
        out = self.pair[head](x).squeeze(-1)
        return out.masked_fill(torch.arange(MAX_DUR + 1, device=codes.device)[None, None, :] < MIN_DUR, NEG)


def unary(model, fr, q):
    """fr (L, T, d+1) frames of each line's audio row, q (L, M, d) -> (L, M, T) scores."""
    d = model.d
    return torch.einsum("ltd,lmd->lmt", fr[..., :d], q) / math.sqrt(d) + fr[..., d][:, None, :]


NEG = -1e4  # finite "impossible": all-(-inf) rows would give NaN gradients in logsumexp


def chain(un, win, pair, mask):
    """Forward algorithm and Viterbi over each line's boundaries.
    un (L, M, W) unary score of each boundary's window frames (NEG outside a boundary's real window), win (L, M, W) their frame indices
    (long), pair (L, M-1, MAX_DUR+1) (NEG below MIN_DUR), mask (L, M) real boundaries (a prefix of each row).
    -> logZ (L,), Viterbi frame of every boundary (L, M) (long; padded boundaries repeat the last real one)."""
    L, M, W = un.shape
    alpha = un[:, 0]
    best = un[:, 0]
    back = []
    for j in range(1, M):
        dur = win[:, j, :, None] - win[:, j - 1, None, :]  # (L, W_b, W_a)
        p = torch.gather(pair[:, j - 1], 1, dur.clamp(0, MAX_DUR).flatten(1)).view(L, W, W).masked_fill(dur < 0, NEG)
        live = mask[:, j, None]
        alpha = torch.where(live, un[:, j] + torch.logsumexp(alpha[:, None, :] + p, dim=2), alpha)
        b_new, arg = (best[:, None, :] + p).max(dim=2)
        best = torch.where(live, un[:, j] + b_new, best)
        back.append(arg)
    logz = torch.logsumexp(alpha, dim=1)
    last = mask.sum(1) - 1
    cur = best.argmax(dim=1)  # window index of the last real boundary
    path = torch.zeros(L, M, dtype=torch.long, device=un.device)
    for j in range(M - 1, 0, -1):
        path[:, j] = cur
        cur = torch.where(j <= last, torch.gather(back[j - 1], 1, cur[:, None]).squeeze(1), cur)
    path[:, 0] = cur
    frames = torch.gather(win, 2, path[:, :, None]).squeeze(2)
    frames = torch.where(mask, frames, torch.gather(frames, 1, last[:, None]))
    return logz, frames


def path_score(un, win, pair, mask, truth_idx):
    """Score of the true path. truth_idx (L, M) window index of each boundary's truth frame."""
    L, M, _ = un.shape
    s = torch.gather(un, 2, truth_idx[:, :, None]).squeeze(2).masked_fill(~mask, 0).sum(1)
    tf = torch.gather(win, 2, truth_idx[:, :, None]).squeeze(2)
    dur = (tf[:, 1:] - tf[:, :-1]).clamp(0, MAX_DUR)
    p = torch.gather(pair, 2, dur[:, :, None]).squeeze(2)
    live = mask[:, 1:]
    return s + p.masked_fill(~live, 0).sum(1)
