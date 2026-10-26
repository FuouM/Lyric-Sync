"""Which signal ranks the lines that need a human look? Truth: the solver's real per-line error on the calibrated song.

usage (repo root, conda env chanenv):
  python research/adapt/rank_lines.py --song .cache/adapt/songs/god_ish --tifa .cache/adapt/tifa/god_ish_lines_free/syllables.json \
      --free .cache/adapt/free_god_ish_snaptrue.json --review .cache/adapt/free_review_god_ish.json
Signals per line: review.json meanExpectedErrorMs (shipped), mean |solver - TIFA| start, share of syllables with |solver - TIFA| > 50 ms.
Reports Spearman with the real line error, and how many of the 10 worst lines (and how much of the total error) the top-10 / top-20% of each ranking catches.
"""
import argparse
import json
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from tifa_eval import load_truth  # noqa: E402


def spearman(a, b):
    ra = np.argsort(np.argsort(a))
    rb = np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--song', required=True)
    ap.add_argument('--tifa', required=True)
    ap.add_argument('--free', required=True)
    ap.add_argument('--review', required=True)
    a = ap.parse_args()
    truth = load_truth(pathlib.Path(a.song).resolve())
    tifa = json.loads(pathlib.Path(a.tifa).read_text())
    free = np.array(json.loads(pathlib.Path(a.free).read_text()))
    review = {r['line']: r['meanExpectedErrorMs'] for r in json.loads(pathlib.Path(a.review).read_text())}
    lines = sorted({t['line'] for t in truth})
    err, rev, dis_mean, dis_share = [], [], [], []
    for li in lines:
        ks = [k for k, t in enumerate(truth) if t['line'] == li]
        e = [(abs(free[k][0] - truth[k]['ts']) + abs(free[k][1] - truth[k]['te'])) / 2 * 1000 for k in ks]
        d = [abs(free[k][0] - tifa[k]['vowel']) * 1000 for k in ks]
        err.append(np.mean(e))
        rev.append(review[li])
        dis_mean.append(np.mean(d))
        dis_share.append(np.mean(np.array(d) > 50))
    err = np.array(err)
    total = err.sum()
    worst10 = set(np.argsort(-err)[:10])
    print(f'{len(lines)} lines; real line error mean {err.mean():.1f} ms; top-10 lines hold {err[list(worst10)].sum() / total * 100:.0f}% of the line-error sum')
    for name, sig in (('review.json expected error', rev), ('mean |solver - TIFA|', dis_mean), ('share |solver - TIFA| > 50ms', dis_share)):
        sig = np.array(sig)
        top = np.argsort(-sig)
        t10 = set(top[:10])
        t20 = list(top[: int(round(0.2 * len(lines)))])
        print(f'{name:30s} spearman {spearman(sig, err):5.2f}  top-10 catches {len(t10 & worst10)}/10 worst, {err[list(t10)].sum() / total * 100:3.0f}% of error; top-20% lines hold {err[t20].sum() / total * 100:3.0f}% of error')


if __name__ == '__main__':
    main()
