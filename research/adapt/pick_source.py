"""Can a tiny per-song model pick, where the solver and TIFA disagree, which one is right? Learned from labelled syllables of the same song.

usage (repo root, conda env chanenv):
  python research/adapt/pick_source.py --song .cache/adapt/songs/god_ish --tifa .cache/adapt/tifa/god_ish_lines_free/syllables.json \
      --free .cache/adapt/free_god_ish_snaptrue.json [--folds 5]
Disagreement = interior syllable whose solver and TIFA starts differ by > --dis ms. Features: syllable class, grid distance of each candidate, signed
difference, gap sizes. Grouped K-fold by line (a fold's lines are unseen), and a learning curve: train on the first N labelled disagreements (what a user
who has calibrated a few lines provides), evaluate on the other lines.
"""
import argparse
import json
import pathlib
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from tifa_eval import load_truth  # noqa: E402

VOWELS = set('aiueo')


def beat_pos(beats, t):
    i = np.clip(np.searchsorted(beats, t, side='right') - 1, 0, len(beats) - 2)
    return i + (t - beats[i]) / (beats[i + 1] - beats[i])


def grid_dist(beats, t, div=4):
    p = beat_pos(beats, t) * div
    i = int(np.clip(np.searchsorted(beats, t, side='right') - 1, 0, len(beats) - 2))
    return abs(p - round(p)) / div * (beats[i + 1] - beats[i]) * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--song', required=True)
    ap.add_argument('--tifa', required=True)
    ap.add_argument('--free', required=True)
    ap.add_argument('--dis', type=float, default=30)
    ap.add_argument('--folds', type=int, default=5)
    a = ap.parse_args()
    song = pathlib.Path(a.song).resolve()
    truth = load_truth(song)
    beats = np.array(json.loads((song / 'generated/timing.ai.json').read_text())['beats'])
    tifa = np.array([x['vowel'] for x in json.loads(pathlib.Path(a.tifa).read_text())])
    sol = np.array(json.loads(pathlib.Path(a.free).read_text()))[:, 0]
    definition = json.loads((song / 'lyricsync/lyrics.def.json').read_text(encoding='utf8'))
    texts = [s.strip('?!()').lower() for line in definition['lines'] for w in line['words'] for s in w['syllables']]
    ts = np.array([t['ts'] for t in truth])
    line = np.array([t['line'] for t in truth])
    n = len(truth)
    idx = [k for k in range(1, n) if line[k - 1] == line[k] and abs(sol[k] - tifa[k]) * 1000 > a.dis]
    feats, y, lines = [], [], []
    for k in idx:
        t = texts[k]
        prev = texts[k - 1]
        cl = t in ('p', 'k', 't', 's', 'c')
        f = [
            t in VOWELS, cl, t == 'n', prev in ('p', 'k', 't', 's', 'c'),
            grid_dist(beats, sol[k]) / 50, grid_dist(beats, tifa[k]) / 50,
            (grid_dist(beats, sol[k]) - grid_dist(beats, tifa[k])) / 50,
            (tifa[k] - sol[k]) * 4, np.sign(tifa[k] - sol[k]), min(abs(tifa[k] - sol[k]), 1.0),
            (sol[k] - sol[k - 1]) * 4, (tifa[k] - tifa[k - 1]) * 4,
        ]
        feats.append(f)
        y.append(abs(tifa[k] - ts[k]) < abs(sol[k] - ts[k]))  # TIFA is the better one
        lines.append(line[k])
    X = np.array(feats, dtype=float)
    y = np.array(y)
    lines = np.array(lines)
    ks = np.array(idx)
    err_s = np.abs(sol[ks] - ts[ks]) * 1000
    err_t = np.abs(tifa[ks] - ts[ks]) * 1000
    print(f'{len(ks)} disagreeing interior syllables; TIFA better on {y.mean() * 100:.0f}%')
    print(f'always solver {err_s.mean():.1f}  always TIFA {err_t.mean():.1f}  oracle {np.minimum(err_s, err_t).mean():.1f}  (mean ms over these)')
    ul = np.unique(lines)
    rng = np.random.default_rng(0)
    rng.shuffle(ul)
    fold_of = {l: i % a.folds for i, l in enumerate(ul)}
    fold = np.array([fold_of[l] for l in lines])
    pred = np.zeros(len(ks))
    for f in range(a.folds):
        tr, te = fold != f, fold == f
        m = LogisticRegression(C=1.0, max_iter=2000).fit(X[tr], y[tr])
        pred[te] = m.predict_proba(X[te])[:, 1]
    pick = pred > 0.5
    chosen = np.where(pick, err_t, err_s)
    print(f'grouped {a.folds}-fold, all labelled lines: picked mean error {chosen.mean():.1f} ms; picks the better source {np.mean(pick == y) * 100:.0f}% of the time')
    # learning curve: train on disagreements of the first lines (random line order), test on the remaining lines
    for frac in (0.1, 0.2, 0.3, 0.5, 0.7):
        res = []
        for rep in range(20):
            order = np.random.default_rng(rep).permutation(ul)
            train_lines = set(order[: int(round(frac * len(ul)))])
            tr = np.array([l in train_lines for l in lines])
            if tr.sum() < 6 or len(set(y[tr])) < 2:
                continue
            m = LogisticRegression(C=0.3, max_iter=2000).fit(X[tr], y[tr])
            p = m.predict_proba(X[~tr])[:, 1] > 0.5
            res.append((np.where(p, err_t[~tr], err_s[~tr]).mean(), err_s[~tr].mean(), tr.sum()))
        r = np.array(res)
        print(f'  {frac * 100:3.0f}% of lines labelled (~{r[:, 2].mean():.0f} disagreements): picked {r[:, 0].mean():.1f} ms vs always-solver {r[:, 1].mean():.1f} ms on the other lines')


if __name__ == '__main__':
    main()
