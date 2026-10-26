"""Is TIFA complementary to the shipped solver? Both scored on the calibrated truth of a song.

usage (repo root, conda env chanenv):
  python research/adapt/tifa_fuse.py --song .cache/adapt/songs/god_ish --tifa .cache/adapt/tifa/god_ish_lines/syllables.json --free .cache/adapt/free_god_ish_snaptrue.json
(--free is the [start, end] list written by research/adapt/baseline.ts)
"""
import argparse
import json
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from tifa_eval import load_truth, stats  # noqa: E402


def snap(t, beats, win):
    i = np.searchsorted(beats, t)
    cand = [beats[j] for j in (i - 1, i) if 0 <= j < len(beats)]
    b = min(cand, key=lambda x: abs(x - t))
    return b if abs(b - t) <= win else t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--song', required=True)
    ap.add_argument('--tifa', required=True)
    ap.add_argument('--free', required=True)
    a = ap.parse_args()
    song = pathlib.Path(a.song).resolve()
    truth = load_truth(song)
    beats = np.array(json.loads((song / 'generated/timing.ai.json').read_text())['beats'])
    tifa = json.loads(pathlib.Path(a.tifa).read_text())
    free = np.array(json.loads(pathlib.Path(a.free).read_text()))
    ts = np.array([x['ts'] for x in truth])
    flagged = np.array([x['flagged'] for x in truth])
    tv = np.array([x['vowel'] for x in tifa])
    sv = free[:, 0]
    e_s = np.abs(sv - ts) * 1000
    e_t = np.abs(tv - ts) * 1000
    stats('solver (free) start', e_s / 1000)
    stats('TIFA vowel start (oracle windows)', e_t / 1000)
    for win in (0.03, 0.055, 0.08):
        tsn = np.array([snap(t, beats, win) for t in tv])
        stats(f'TIFA vowel snapped to beat {int(win * 1000)}ms', np.abs(tsn - ts))
    print('corr of errors (log1p):', np.corrcoef(np.log1p(e_s), np.log1p(e_t))[0, 1].round(3))
    print('TIFA better than solver on', (e_t < e_s).mean().round(3), 'of syllables; on flagged', (e_t < e_s)[flagged].mean().round(3))
    stats('oracle best-of-two start', np.minimum(e_s, e_t) / 1000)
    # disagreement as a trust signal: where the two agree (<40 ms) take the mean; where they disagree take the solver or TIFA
    d = np.abs(sv - tv) * 1000
    for thr in (30, 50, 80):
        agree = d < thr
        print(f'agree<{thr}ms: {agree.mean():.2f} of syllables; solver err when agree {e_s[agree].mean():.1f}, when disagree {e_s[~agree].mean():.1f}; TIFA err when agree {e_t[agree].mean():.1f}, disagree {e_t[~agree].mean():.1f}')
    mean = (sv + tv) / 2
    stats('mean of solver and TIFA', np.abs(mean - ts))
    mean_snap = np.array([snap(t, beats, 0.055) for t in mean])
    stats('mean, snapped 55ms', np.abs(mean_snap - ts))


if __name__ == '__main__':
    main()
