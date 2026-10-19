# Exports a trained boundary model (boundary_model.py) to the ONNX files lyricsync ships in packages/lyricsync/models/boundary/:
#   frames.onnx   waveform (1, S) float32, 16 kHz, peak-normalised over the whole song -> frames (1, S // 160, d + 1) float32 at 100 fps.
#                 The backbone (mHuBERT-147, fp32, eager attention), its learned layer mix, the log-mel front end (an STFT as a convolution with
#                 a precomputed windowed DFT basis, so no complex ops) and the head are one graph.
#   queries.onnx  ctx (N, 5) int64 phone ids, kind (N,) int64, lang (N,) int64 -> q (N, d) float32.
#   config.json   what the TypeScript side needs to build query inputs and run frames.onnx (phone list, aliases, kinds, languages, window).
# Weight storage (--weights, scripts/onnx_weights.py): fp32 as trained; fp16 = large float initializers stored as float16 (computation stays
# float32, file half the size); int8 = weight-only int8 MatMul weights (MatMulNBits, per block of --block input rows) + fp16 for the rest.
# The package ships int8: on the annotated songs it scores within 0.01 ms of fp32 (int4 cost 0.7 ms free-mode MAE).
# usage: python scripts/gtsinger/export_onnx.py <checkpoint.pt> <out dir> [--weights fp32|fp16|int8] [--block 32] [--check <wav>]
#   --check: compare frames.onnx (onnxruntime, CPU) with the PyTorch model (fp32) on the first 26 s of the wav and print the largest difference.
import json
import math
import os
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import onnx_weights  # noqa: E402
from boundary_model import ALIASES, CTX, FPS, KINDS, LANGS, PHONES, SR, BoundaryModel  # noqa: E402

N_FFT, WIN, HOP = 1024, 400, 160
# Window the TypeScript runner feeds frames.onnx: CHUNK_S of output per run with PAD_S of context either side (export_guide.py's chunking).
CHUNK_S, PAD_S = 20.0, 3.0


class StftLogMel(nn.Module):
    """LogMel (boundary_model.py) without complex ops: reflect padding, a conv with the Hann-windowed DFT basis, power, mel matrix, log,
    per-window mean. Same numbers as torchaudio's MelSpectrogram up to float rounding."""

    def __init__(self, logmel):
        super().__init__()
        win = torch.hann_window(WIN, periodic=True, dtype=torch.float64)
        w = torch.zeros(N_FFT, dtype=torch.float64)
        w[(N_FFT - WIN) // 2:(N_FFT - WIN) // 2 + WIN] = win
        n = torch.arange(N_FFT, dtype=torch.float64)
        k = torch.arange(N_FFT // 2 + 1, dtype=torch.float64)[:, None]
        ang = 2 * math.pi * k * n / N_FFT
        basis = torch.cat([torch.cos(ang) * w, -torch.sin(ang) * w], dim=0)  # (2 * 513, 1024)
        self.register_buffer("basis", basis.float()[:, None, :])
        self.register_buffer("fb", logmel.mel.mel_scale.fb.float().clone())  # (513, 80)

    def forward(self, wav):  # (1, S) -> (1, T, 80)
        x = F.pad(wav[:, None, :], (N_FFT // 2, N_FFT // 2), mode="reflect")
        spec = F.conv1d(x, self.basis, stride=HOP)  # (1, 1026, T + 1)
        re, im = spec[:, : N_FFT // 2 + 1], spec[:, N_FFT // 2 + 1:]
        power = (re * re + im * im).transpose(1, 2)  # (1, T + 1, 513)
        m = torch.matmul(power, self.fb).clamp_min(1e-6).log()
        return m - m.mean(dim=(1, 2), keepdim=True)


class FramesGraph(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.ssl = model.ssl
        self.logmel = StftLogMel(model.logmel)
        self.register_buffer("mix", torch.softmax(model.layer_w.detach().float(), dim=0))
        self.model = model

    def forward(self, wav):
        T = wav.shape[1] // HOP
        m = self.logmel(wav)[:, :T]
        x = (wav - wav.mean(dim=1, keepdim=True)) / (wav.std(dim=1, keepdim=True) + 1e-5)
        hs = torch.stack(self.ssl(x, output_hidden_states=True).hidden_states, dim=0)  # (13, 1, T50, 768)
        h = (self.mix[:, None, None, None] * hs).sum(0)
        return self.model.frame_out(self.model.head_forward(h, m))


class QueryGraph(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, ctx, kind, lang):
        return self.model.queries(ctx, kind, lang)


def load(ckpt):
    from transformers import HubertModel
    run_cfg = json.load(open(os.path.join(os.path.dirname(ckpt), "config.json"), encoding="utf-8"))
    if run_cfg.get("ssl", "mhubert") != "mhubert" or run_cfg.get("context", True) is False:
        raise ValueError("only mHuBERT models with phone context are exported")
    ssl = HubertModel.from_pretrained("utter-project/mHuBERT-147", cache_dir=".cache/hf", dtype=torch.float32, attn_implementation="eager").eval()
    model = BoundaryModel(ssl, finetune=run_cfg.get("finetune", 0)).eval()
    missing, unexpected = model.load_state_dict(torch.load(ckpt, map_location="cpu"), strict=False)
    assert not unexpected and all(k.startswith("ssl.") for k in missing), (missing, unexpected)
    return model.float()


def main():
    ckpt, out = sys.argv[1], sys.argv[2]
    weights = sys.argv[sys.argv.index("--weights") + 1] if "--weights" in sys.argv else "fp32"
    if weights not in ("fp32", "fp16", "int8"):
        raise ValueError("--weights must be fp32, fp16 or int8")
    block = int(sys.argv[sys.argv.index("--block") + 1]) if "--block" in sys.argv else 32
    os.makedirs(out, exist_ok=True)
    model = load(ckpt)
    frames_path = os.path.join(out, "frames.onnx")
    graph = FramesGraph(model).eval()
    wav = torch.randn(1, int(SR * (CHUNK_S + 2 * PAD_S))) * 0.1
    with torch.no_grad():
        torch.onnx.export(graph, (wav,), frames_path, input_names=["waveform"], output_names=["frames"],
                          dynamic_axes={"waveform": {1: "samples"}, "frames": {1: "frames"}}, opset_version=17, dynamo=False)
    if weights != "fp32":
        onnx_weights.convert(frames_path, frames_path, weights, block)
    q = QueryGraph(model).eval()
    n = 4
    with torch.no_grad():
        torch.onnx.export(q, (torch.zeros(n, CTX, dtype=torch.long), torch.zeros(n, dtype=torch.long), torch.zeros(n, dtype=torch.long)),
                          os.path.join(out, "queries.onnx"), input_names=["ctx", "kind", "lang"], output_names=["q"],
                          dynamic_axes={"ctx": {0: "n"}, "kind": {0: "n"}, "lang": {0: "n"}, "q": {0: "n"}}, opset_version=17, dynamo=False)
    cfg = {
        "sampleRate": SR, "hop": HOP, "fps": FPS, "dim": model.d, "chunkSec": CHUNK_S, "padSec": PAD_S, "weights": weights,
        "phones": PHONES, "aliases": ALIASES, "kinds": KINDS, "languages": LANGS, "context": CTX,
    }
    with open(os.path.join(out, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    for name in ("frames.onnx", "queries.onnx"):
        print("%s: %.1f MB" % (name, os.path.getsize(os.path.join(out, name)) / 1e6))
    if "--check" in sys.argv:
        import onnxruntime as ort
        import soundfile as sf
        from scipy.signal import resample_poly
        audio, sr = sf.read(sys.argv[sys.argv.index("--check") + 1], dtype="float32", always_2d=True)
        audio = audio.mean(axis=1)
        gcd = np.gcd(sr, SR)
        audio = resample_poly(audio, SR // gcd, sr // gcd).astype(np.float32)
        audio = (audio / (np.abs(audio).max() + 1e-6) * 0.9)[: int(SR * (CHUNK_S + 2 * PAD_S))]
        with torch.no_grad():
            ref = model.frames(torch.from_numpy(audio)[None]).numpy()
        sess = ort.InferenceSession(frames_path, providers=["CPUExecutionProvider"])
        got = sess.run(None, {"waveform": audio[None]})[0]
        d = model.d
        print("frames %s vs torch %s; max |diff| embedding %.5f, logit %.5f (torch ranges %.2f / %.2f)" % (
            got.shape, ref.shape, np.abs(got[..., :d] - ref[..., :d]).max(), np.abs(got[..., d] - ref[..., d]).max(),
            np.abs(ref[..., :d]).max(), np.abs(ref[..., d]).max()))


if __name__ == "__main__":
    main()
