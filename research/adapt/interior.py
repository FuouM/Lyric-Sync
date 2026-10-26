"""Where is the INTERIOR syllable-start error (line starts/ends excluded)? Free solve vs calibrated truth.

usage (repo root, conda env chanenv):
  python research/adapt/interior.py --song .cache/adapt/songs/god_ish --free .cache/adapt/free_god_ish_snaptrue.json
Breakdowns by syllable class, word position, duration (beats), beat phase, previous syllable, error sign.
"""
import argparse
import json
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from tifa_eval import load_truth  # noqa: E402

VOWELS = set('aiueo')


def beat_pos(beats, t):
    i = np.clip(np.searchsorted(beats, t, side='right') - 1, 0, len(beats) - 2)
    return i + (t - beats[i]) / (beats[i + 1] - beats[i])


def cls(text):
    t = text.strip('?!()').lower()
    if t in VOWELS:
        return 'vowel-only (a, i, u, e, o)'
    if t == 'n':
        return 'moraic n'
    if t in ('p', 'k', 't', 's', 'c'):
        return 'closure (p, k, t, s, c)'
    if t.endswith(tuple(VOWELS)) and len(t) <= 4:
        return 'consonant+vowel'
    return 'other'


def row(name, e, tot):
    e = np.asarray(e)
    if len(e) == 0:
        return
    print(f'  {name:34s} n={len(e):4d} mean {e.mean():6.1f} med {np.median(e):5.1f} >50ms {100 * (e > 50).mean():3.0f}% >150ms {100 * (e > 150).mean():3.0f}%  share of error {100 * e.sum() / tot:3.0f}%')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--song', required=True)
    ap.add_argument('--free', required=True)
    a = ap.parse_args()
    song = pathlib.Path(a.song).resolve()
    truth = load_truth(song)
    beats = np.array(json.loads((song / 'generated/timing.ai.json').read_text())['beats'])
    free = np.array(json.loads(pathlib.Path(a.free).read_text()))
    definition = json.loads((song / 'lyricsync/lyrics.def.json').read_text(encoding='utf8'))
    texts, wordstart = [], []
    for line in definition['lines']:
        for w in line['words']:
            for si, s in enumerate(w['syllables']):
                texts.append(s)
                wordstart.append(si == 0)
    n = len(truth)
    ts = np.array([t['ts'] for t in truth])
    te = np.array([t['te'] for t in truth])
    line = np.array([t['line'] for t in truth])
    j = np.array([t['j'] for t in truth])
    last_of_line = np.array([k == n - 1 or line[k + 1] != line[k] for k in range(n)])
    interior = (j > 0)  # line start excluded; line-final syllable START is interior
    signed = (free[:, 0] - ts) * 1000
    err = np.abs(signed)
    tot = err[interior].sum()
    print(f'interior syllable starts: {interior.sum()} of {n}; mean {err[interior].mean():.1f} ms, med {np.median(err[interior]):.1f}; line starts (j=0): {err[~interior].mean():.1f} ms')
    print('\nby syllable class')
    c = np.array([cls(t) for t in texts])
    for name in sorted(set(c)):
        row(name, err[interior & (c == name)], tot)
    print('\nby word position')
    ws = np.array(wordstart)
    row('word start', err[interior & ws], tot)
    row('inside a word', err[interior & ~ws], tot)
    print('\nby true duration (beats)')
    dur = np.array([beat_pos(beats, te[k]) - beat_pos(beats, ts[k]) for k in range(n)])
    for lo, hi in ((0, 0.15), (0.15, 0.25), (0.25, 0.4), (0.4, 0.8), (0.8, 99)):
        row(f'dur {lo}-{hi} beats', err[interior & (dur >= lo) & (dur < hi)], tot)
    print('\nby beat phase of the truth start (16th grid)')
    ph = np.array([(beat_pos(beats, ts[k]) * 4) % 1 for k in range(n)])
    grid = np.minimum(ph, 1 - ph)
    row('on a 16th gridline (<0.1)', err[interior & (grid < 0.1)], tot)
    row('near (0.1-0.25)', err[interior & (grid >= 0.1) & (grid < 0.25)], tot)
    row('between (>=0.25)', err[interior & (grid >= 0.25)], tot)
    print('\nby previous syllable')
    prev_same = np.array([k > 0 and line[k - 1] == line[k] and texts[k - 1].strip('?!()').lower()[-1:] == texts[k].strip('?!()').lower()[-1:] and texts[k].strip('?!()').lower() in VOWELS for k in range(n)])
    row('vowel-only after the same vowel (a a, u u)', err[interior & prev_same], tot)
    prev_closure = np.array([k > 0 and line[k - 1] == line[k] and cls(texts[k - 1]) == 'closure (p, k, t, s, c)' for k in range(n)])
    row('right after a closure', err[interior & prev_closure], tot)
    prev_long = np.array([k > 0 and line[k - 1] == line[k] and dur[k - 1] > 0.8 for k in range(n)])
    row('right after a long (>0.8 beat) syllable', err[interior & prev_long], tot)
    print('\nerror sign (solver - truth), interior')
    s = signed[interior]
    print(f'  early (< -50 ms) {100 * (s < -50).mean():.0f}%   late (> +50 ms) {100 * (s > 50).mean():.0f}%   within 50 ms {100 * (np.abs(s) <= 50).mean():.0f}%')
    print('\nmisses > 100 ms, interior: by run length of consecutive misses in a line')
    miss = interior & (err > 100)
    runs, cur = [], 0
    for k in range(n):
        if miss[k] and (k == 0 or line[k - 1] == line[k]):
            cur += 1
        else:
            if cur:
                runs.append(cur)
            cur = 1 if miss[k] else 0
    if cur:
        runs.append(cur)
    runs = np.array(runs)
    print(f'  {miss.sum()} missed syllables in {len(runs)} runs; isolated (run of 1): {(runs == 1).sum()} runs ({(runs == 1).sum()} syl), runs of 2-3: {((runs >= 2) & (runs <= 3)).sum()} ({runs[(runs >= 2) & (runs <= 3)].sum()} syl), runs of 4+: {(runs >= 4).sum()} ({runs[runs >= 4].sum()} syl)')


if __name__ == '__main__':
    main()
