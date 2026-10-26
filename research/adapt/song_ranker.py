"""Per-song repair ranker, trained only on the syllables the user has calibrated in THIS song, at interaction speed.

Data: research/adapt/dump_candidates.ts output (.cache/adapt/data/<song>.bnd.jsonl): for each interior boundary of the free solve, the candidate times, 61 features
per candidate (solver score, votes and distances per evidence source, guide mass, durations, phone posteriors, beat phase ...) and the truth.
The cross-song repair model of 2026-10-20 (.cache/repair) failed on English stems because of the domain gap; a model fitted on the song itself has none.

usage (repo root, conda env chanenv):
  python research/adapt/song_ranker.py --song god_ish [--mode free] [--fracs 0.1,0.25,0.5] [--reps 20] [--margin 0.0,0.2,0.4]
Pin a random fraction of LINES (the user calibrates whole lines), fit a linear softmax listwise ranker on their boundaries, move held-out boundaries to the top
candidate when its probability beats the current choice's by `margin`. Reports interior start error on the held-out lines: solver vs repaired, fit time.
"""
import argparse
import json
import pathlib
import time

import numpy as np
import torch

TAU = 0.015


def load(song, mode):
    path = pathlib.Path('.cache/adapt/data') / f'{song}.bnd.jsonl'
    rows = [json.loads(line) for line in path.read_text(encoding='utf8').splitlines() if line]
    return [r for r in rows if r['mode'] == mode]


def add_tifa(rows, tifa_path, song_dir):
    # Append per-candidate TIFA features: signed / absolute / near distance of the candidate to TIFA's vowel onset and syllable start for this boundary.
    tifa = json.loads(pathlib.Path(tifa_path).read_text())
    cal = json.loads((pathlib.Path(song_dir) / 'user_input/lyrics.calibrated.json').read_text(encoding='utf8'))
    first, k = {}, 0
    for li, line in enumerate(cal['lines']):
        first[li] = k
        k += sum(len(w['syl']) for w in line['words'])
    for r in rows:
        t = tifa[first[r['line']] + r['j']]
        c = np.asarray(r['cands'])
        dv = np.clip(c - t['vowel'], -0.25, 0.25)
        ds = np.clip(c - t['start'], -0.25, 0.25)
        extra = np.stack([dv * 4, np.abs(dv) * 4, (np.abs(dv) < 0.03).astype(float), ds * 4, np.abs(ds) * 4, (np.abs(ds) < 0.03).astype(float)], axis=1)
        r['x'] = np.concatenate([np.asarray(r['x']), extra], axis=1).tolist()


def pack(rows):
    kmax = max(len(r['cands']) for r in rows)
    f = len(rows[0]['x'][0])
    X = np.zeros((len(rows), kmax, f), dtype=np.float32)
    M = np.zeros((len(rows), kmax), dtype=bool)
    T = np.zeros((len(rows), kmax), dtype=np.float32)
    C = np.zeros((len(rows), kmax), dtype=np.float64)
    for i, r in enumerate(rows):
        k = len(r['cands'])
        X[i, :k] = np.asarray(r['x'], dtype=np.float32)
        M[i, :k] = True
        C[i, :k] = r['cands']
        d = np.abs(np.asarray(r['cands']) - r['truth'])
        t = np.exp(-(d - d.min()) / TAU)
        T[i, :k] = t / t.sum()
    cur = np.array([r['cur_k'] for r in rows])
    truth = np.array([r['truth'] for r in rows])
    return X, M, T, C, cur, truth


HIDDEN = 0


def fit(X, M, T, l2=1.0):
    mu = X[M].mean(0)
    sd = X[M].std(0) + 1e-6
    Xn = torch.from_numpy((X - mu) / sd)
    Mt = torch.from_numpy(M)
    Tt = torch.from_numpy(T)
    torch.manual_seed(0)
    net = torch.nn.Linear(X.shape[2], 1) if HIDDEN == 0 else torch.nn.Sequential(torch.nn.Linear(X.shape[2], HIDDEN), torch.nn.ReLU(), torch.nn.Linear(HIDDEN, 1))
    opt = torch.optim.Adam(net.parameters(), lr=3e-3, weight_decay=l2 * 1e-2)
    for _ in range(150 if HIDDEN else 1):
        if HIDDEN == 0:
            break
        opt.zero_grad()
        s = net(Xn).squeeze(-1).masked_fill(~Mt, -1e9)
        loss = -(Tt * torch.log_softmax(s, dim=1)).sum(1).mean()
        loss.backward()
        opt.step()
    if HIDDEN == 0:
        lb = torch.optim.LBFGS(net.parameters(), max_iter=60, line_search_fn='strong_wolfe')

        def closure():
            lb.zero_grad()
            s = net(Xn).squeeze(-1).masked_fill(~Mt, -1e9)
            loss = -(Tt * torch.log_softmax(s, dim=1)).sum(1).mean() + l2 * 1e-2 * sum((p ** 2).sum() for p in net.parameters())
            loss.backward()
            return loss

        lb.step(closure)
    return mu, sd, net


def probs(model, X, M):
    mu, sd, net = model
    with torch.no_grad():
        s = net(torch.from_numpy((X - mu) / sd)).squeeze(-1).masked_fill(~torch.from_numpy(M), -1e9)
    return torch.softmax(s, dim=1).numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--song', default='god_ish')
    ap.add_argument('--mode', default='free')
    ap.add_argument('--fracs', default='0.1,0.25,0.5')
    ap.add_argument('--reps', type=int, default=20)
    ap.add_argument('--margin', default='0,0.2,0.4')
    ap.add_argument('--l2', type=float, default=1.0)
    ap.add_argument('--tifa', help='syllables.json of a tifa_lines.py run: adds TIFA distance features')
    ap.add_argument('--hidden', type=int, default=0, help='0 = linear; else one hidden layer')
    a = ap.parse_args()
    global HIDDEN
    HIDDEN = a.hidden
    rows = load(a.song, a.mode)
    if a.tifa:
        add_tifa(rows, a.tifa, f'.cache/adapt/songs/{a.song}')
    X, M, T, C, cur, truth = pack(rows)
    lines = np.array([r['line'] for r in rows])
    n = len(rows)
    idx = np.arange(n)
    cur_t = C[idx, cur]
    err_cur = np.abs(cur_t - truth) * 1000
    oracle = np.array([np.abs(C[i, M[i]] - truth[i]).min() for i in range(n)]) * 1000
    print(f'{a.song} {a.mode}: {n} interior boundaries, solver mean error {err_cur.mean():.1f} ms (med {np.median(err_cur):.1f}); '
          f'candidate oracle {oracle.mean():.1f} ms, truth within 20 ms of a candidate for {np.mean(oracle < 20) * 100:.0f}%')
    margins = [float(m) for m in a.margin.split(',')]
    ul = np.unique(lines)
    for frac in [float(f) for f in a.fracs.split(',')]:
        res = {m: [] for m in margins}
        base, fit_ms, moved = [], [], {m: [] for m in margins}
        for rep in range(a.reps):
            rng = np.random.default_rng(rep)
            train_lines = set(rng.permutation(ul)[: max(1, int(round(frac * len(ul))))])
            tr = np.array([l in train_lines for l in lines])
            te = ~tr
            t0 = time.perf_counter()
            model = fit(X[tr], M[tr], T[tr], a.l2)
            fit_ms.append((time.perf_counter() - t0) * 1000)
            p = probs(model, X[te], M[te])
            top = p.argmax(1)
            pc = p[np.arange(te.sum()), cur[te]]
            pt = p[np.arange(te.sum()), top]
            base.append(err_cur[te].mean())
            for m in margins:
                go = (pt - pc) >= m
                new = np.where(go, C[te][np.arange(te.sum()), top], cur_t[te])
                res[m].append(np.abs(new - truth[te]).mean() * 1000)
                moved[m].append(go.mean())
        print(f'  lines pinned {frac * 100:3.0f}% (train ~{int(round(frac * n))} boundaries, fit {np.mean(fit_ms):.0f} ms): solver {np.mean(base):.1f} ms', end='')
        for m in margins:
            print(f' | margin {m}: {np.mean(res[m]):.1f} ms (moves {np.mean(moved[m]) * 100:.0f}%)', end='')
        print()


if __name__ == '__main__':
    main()
