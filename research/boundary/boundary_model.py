# Text-conditioned syllable-boundary model.
# Audio: frozen mHuBERT-147 hidden states (learned layer mix, 50 fps, upsampled to 100 fps) + log-mel (100 fps) -> conv -> BiGRU -> frame embedding E_t.
# Text: one boundary's phone context (last two phones on the left, first three on the right, SIL past a rest; the boundary kind; the language)
#       -> embedding -> query q. Score of the boundary at frame t: E_t . q / sqrt(d) + g_t (a context-free boundary logit).
import math

import torch
import torch.nn as nn
import torch.nn.functional as F
import torchaudio

SR = 16000
FPS = 100
EN_PHONES = ["aa", "ae", "ah", "ao", "aw", "ax", "ay", "b", "ch", "d", "dh", "dx", "eh", "er", "ey", "f", "g", "hh", "ih", "iy", "jh", "k", "l", "m",
             "n", "ng", "ow", "oy", "p", "r", "s", "sh", "t", "th", "uh", "uw", "v", "w", "y", "z", "zh"]
JA_PHONES = ["N", "a", "b", "by", "ch", "cl", "d", "dy", "e", "f", "g", "gw", "gy", "h", "hy", "i", "j", "k", "kw", "ky", "m", "my", "n", "ny", "o", "p",
             "py", "r", "ry", "s", "sh", "t", "ts", "ty", "u", "v", "w", "y", "z"]
PHONES = ["<pad>", "SIL"] + ["en/" + p for p in EN_PHONES] + ["ja/" + p for p in JA_PHONES]
PHONE_ID = {p: i for i, p in enumerate(PHONES)}
KINDS = ["runStart", "runEnd", "word", "inner"]
LANGS = ["en", "ja"]
CTX = 5  # L2 L1 | R1 R2 R3


# The base model's dictionary writes the English schwa as ax and the flap as dx; GTSinger's ARPAbet has neither.
ALIASES = {"en/ax": "en/ah", "en/dx": "en/t"}


def context_ids(lang, left, right):
    """left/right: phone lists of the syllables either side (None = rest). Returns CTX phone ids."""
    sil = PHONE_ID["SIL"]
    pid = lambda p: PHONE_ID.get(ALIASES.get(lang + "/" + p, lang + "/" + p), PHONE_ID["<pad>"])
    L = [sil, sil] if left is None else ([PHONE_ID["<pad>"]] * 2 + [pid(p) for p in left])[-2:]
    R = [sil] * 3 if right is None else ([pid(p) for p in right] + [PHONE_ID["<pad>"]] * 3)[:3]
    return L + R


class LogMel(nn.Module):
    def __init__(self):
        super().__init__()
        self.mel = torchaudio.transforms.MelSpectrogram(sample_rate=SR, n_fft=1024, win_length=400, hop_length=160, n_mels=80, f_min=30, f_max=8000)

    def forward(self, wav):  # (B, S) -> (B, T, 80)
        m = self.mel(wav).clamp_min(1e-6).log()
        m = m - m.mean(dim=(1, 2), keepdim=True)
        return m.transpose(1, 2)


class BoundaryModel(nn.Module):
    def __init__(self, ssl, finetune=0, d=64, hidden=256, cached_dim=0, ev_dim=0):
        """ssl: the backbone, or None for a log-mel-only model. finetune: how many of its top transformer layers train (in fp32); the rest stay
        frozen. cached_dim > 0 (with ssl None): the head trains on precomputed, already layer-mixed backbone features of that width
        (head_forward; build_feature_cache.py / train_cached.py). ev_dim > 0: per-frame lyricsync evidence is an input too (train_joint.py)."""
        super().__init__()
        self.ssl = ssl
        self.finetune = finetune if ssl is not None else 0
        if ssl is not None:
            for p in ssl.parameters():
                p.requires_grad_(False)
            layers = ssl.encoder.layers
            for layer in layers[len(layers) - self.finetune:] if self.finetune > 0 else []:
                layer.float()
                for p in layer.parameters():
                    p.requires_grad_(True)
            self.layer_w = nn.Parameter(torch.zeros(ssl.config.num_hidden_layers + 1))
        self.logmel = LogMel()
        self.inp = nn.Linear((ssl.config.hidden_size if ssl is not None else cached_dim) + 80 + ev_dim, hidden)
        self.conv = nn.Sequential(nn.Conv1d(hidden, hidden, 5, padding=2), nn.GELU(), nn.Conv1d(hidden, hidden, 5, padding=2), nn.GELU())
        self.gru = nn.GRU(hidden, hidden, num_layers=2, batch_first=True, bidirectional=True, dropout=0.1)
        self.frame_out = nn.Linear(2 * hidden, d + 1)
        self.phone_emb = nn.Embedding(len(PHONES), 48)
        self.pos_emb = nn.Parameter(torch.zeros(CTX, 48))
        self.kind_emb = nn.Embedding(len(KINDS), 16)
        self.lang_emb = nn.Embedding(len(LANGS), 8)
        self.query = nn.Sequential(nn.Linear(CTX * 48 + 16 + 8, 256), nn.GELU(), nn.Linear(256, d))
        self.d = d

    def features(self, wav):
        """wav (B, S) at 16 kHz, peak-normalised -> (layer-mixed backbone features (B, T50, 768) or None, log-mel (B, T, 80)), T = S // 160."""
        T = wav.shape[1] // 160
        m = self.logmel(wav)[:, :T]
        if m.shape[1] < T:
            m = F.pad(m, (0, 0, 0, T - m.shape[1]))
        if self.ssl is None:
            return None, m
        # Gradients reach only the fine-tuned top layers: nothing below them requires grad.
        with torch.set_grad_enabled(self.finetune > 0 and torch.is_grad_enabled()):
            x = (wav - wav.mean(dim=1, keepdim=True)) / (wav.std(dim=1, keepdim=True) + 1e-5)
            hs = torch.stack(self.ssl(x, output_hidden_states=True).hidden_states, dim=0)  # (L, B, T50, C)
        w = torch.softmax(self.layer_w, dim=0)
        return (w[:, None, None, None] * hs.float()).sum(0), m

    def head_forward(self, h, m, ev=None):
        """h: backbone features (B, T', C) or None; m: log-mel (B, T, 80); ev: evidence (B, T, ev_dim) when ev_dim > 0 -> (B, T, 2 hidden) at 100 fps."""
        parts = [m.float()] + ([ev.float()] if ev is not None else [])
        if h is not None:
            parts.insert(0, F.interpolate(h.float().transpose(1, 2), size=m.shape[1], mode="linear", align_corners=False).transpose(1, 2))
        z = self.inp(torch.cat(parts, dim=-1))
        z = z + self.conv(z.transpose(1, 2)).transpose(1, 2)
        return self.gru(z)[0]

    def frames(self, wav):
        """wav (B, S) at 16 kHz, peak-normalised -> (B, T, d+1) at 100 fps, T = S // 160."""
        return self.frame_out(self.head_forward(*self.features(wav)))

    def queries(self, ctx, kind, lang):
        """ctx (N, CTX) phone ids, kind (N,), lang (N,) -> (N, d)."""
        e = (self.phone_emb(ctx) + self.pos_emb).flatten(1)
        return self.query(torch.cat([e, self.kind_emb(kind), self.lang_emb(lang)], dim=-1))

    def score(self, fr, q):
        """fr (..., T, d+1), q (..., d) broadcastable -> (..., T) logits."""
        return (fr[..., : self.d] * q.unsqueeze(-2)).sum(-1) / math.sqrt(self.d) + fr[..., self.d]


def load_ssl(cache_dir=".cache/hf"):
    """Frozen backbone in fp16 (it only runs under autocast); the safetensors weights load lazily, without an fp32 CPU copy.
    Attention through PyTorch's fused scaled-dot-product kernel."""
    from transformers import HubertModel
    return HubertModel.from_pretrained("utter-project/mHuBERT-147", cache_dir=cache_dir, dtype=torch.float16, use_safetensors=True,
                                       low_cpu_mem_usage=True, attn_implementation="sdpa").eval()


def build_model(cfg):
    """cfg (saved as config.json next to the checkpoints): {"ssl": "mhubert" | "none", "finetune": top SSL layers trained}."""
    return BoundaryModel(None if cfg.get("ssl", "mhubert") == "none" else load_ssl(), finetune=cfg.get("finetune", 0))


def trainable_state(model):
    """What a checkpoint holds: everything except the frozen backbone."""
    keep = {n for n, p in model.named_parameters() if p.requires_grad}
    return {k: v for k, v in model.state_dict().items() if not k.startswith("ssl.") or k in keep}


def query_inputs(cfg, lang, left, right, kind):
    """(ctx ids, kind id, lang id) of one boundary's query. cfg["context"] False (ablation): every boundary gets the same query,
    so the model is a context-free syllable-boundary detector."""
    if cfg.get("context", True) is False:
        return [PHONE_ID["<pad>"]] * CTX, 0, 0
    return context_ids(lang, left, right), KINDS.index(kind), LANGS.index(lang)
