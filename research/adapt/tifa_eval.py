"""Parse TIFA's TextGrid for a lyricsync song and score it against the calibrated truth.

usage (repo root, conda env chanenv):
  python research/adapt/tifa_eval.py --song .cache/adapt/songs/god_ish --tg .cache/adapt/tifa/god_ish/tg/song.TextGrid [--dump out.json]

One TIFA word = one syllable (see tifa_run.py). Two start conventions: the first phone of the syllable, and its first vowel phone (the
convention of the user's labels). Reports start error, and syllable error as in the benchmarks: mean(|d start|, |d end|), end = next start
inside a line (tiling), line end = the syllable's own end.
"""
import argparse
import json
import pathlib

import numpy as np
import textgrid

VOWELS = {'a', 'i', 'u', 'e', 'o'}
NON_SYLLABLE = {'SP', 'AP', 'EP', 'GS'}  # silence and the VED events TIFA-1.0-ST can insert


def load_truth(song):
    cal = json.loads((song / 'user_input/lyrics.calibrated.json').read_text(encoding='utf8'))
    out = []
    for li, line in enumerate(cal['lines']):
        j = 0
        for w in line['words']:
            for si, s in enumerate(w['syl']):
                flagged = bool(line.get('calibrated')) or bool(w.get('calibrated')) or bool((w.get('sylCalibrated') or [False] * len(w['syl']))[si])
                out.append({'line': li, 'j': j, 'ts': s[0], 'te': s[1], 'flagged': flagged})
                j += 1
    return out


def load_tifa(tg_path):
    tg = textgrid.TextGrid.fromFile(str(tg_path))
    tiers = {t.name: t for t in tg}
    words = [iv for iv in tiers['words'] if iv.mark and iv.mark not in NON_SYLLABLE]
    phones = list(tiers['phones'])
    res = []
    for w in words:
        inside = [p for p in phones if p.mark and p.mark not in NON_SYLLABLE and p.minTime >= w.minTime - 1e-6 and p.maxTime <= w.maxTime + 1e-6]
        vowel = next((p.minTime for p in inside if p.mark.split('/')[-1] in VOWELS), None)
        if vowel is None and inside:
            vowel = inside[-1].minTime  # N / cl: the last phone
        res.append({'start': w.minTime, 'vowel': vowel if vowel is not None else w.minTime, 'end': w.maxTime})
    return res


def stats(name, e):
    e = np.asarray(e) * 1000
    print(f'{name:34s} n={len(e):4d} mae {e.mean():6.1f} clip500 {np.minimum(e, 500).mean():6.1f} med {np.median(e):5.1f} >50ms {100 * (e > 50).mean():3.0f}% >150ms {100 * (e > 150).mean():3.0f}%')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--song', required=True)
    ap.add_argument('--tg', required=True)
    ap.add_argument('--dump')
    a = ap.parse_args()
    truth = load_truth(pathlib.Path(a.song).resolve())
    t = load_tifa(pathlib.Path(a.tg).resolve())
    print('truth syllables', len(truth), 'tifa syllables', len(t))
    if len(truth) != len(t):
        raise SystemExit('count mismatch (zero-width syllables were dropped?)')
    flagged = np.array([x['flagged'] for x in truth])
    for conv in ('start', 'vowel'):
        st = np.array([x[conv] for x in t])
        ts = np.array([x['ts'] for x in truth])
        es = np.abs(st - ts)
        stats(f'{conv} onset, all', es)
        stats(f'{conv} onset, flagged', es[flagged])
        stats(f'{conv} onset, unflagged', es[~flagged])
        # tiled end
        ends = np.array([x['end'] for x in t])
        for k in range(len(t) - 1):
            if truth[k]['line'] == truth[k + 1]['line']:
                ends[k] = st[k + 1]
        te = np.array([x['te'] for x in truth])
        stats(f'{conv} syllable err (start+end)/2', (es + np.abs(ends - te)) / 2)
    if a.dump:
        pathlib.Path(a.dump).write_text(json.dumps(t))


if __name__ == '__main__':
    main()
