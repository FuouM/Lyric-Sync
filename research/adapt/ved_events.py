"""Are VED events (AP, EP, GS) evidence for syllable boundaries? Mined from a tifa_lines.py run made with --model TIFA-1.0-ST --ved.

usage (repo root, conda env chanenv):
  python research/adapt/ved_events.py --song .cache/adapt/songs/god_ish --run .cache/adapt/tifa/god_ish_lines_stved --free .cache/adapt/free_god_ish_snaptrue.json
Per event type: how many, how they sit relative to the calibrated syllable starts / gaps, and whether they would have corrected the solver where it is
wrong (an event within --tol of the true start but not of the solver's start) or confirmed it where it is right.
"""
import argparse
import json
import pathlib
import sys

import numpy as np
import textgrid

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from tifa_eval import load_truth  # noqa: E402

VOWELS = ('a', 'i', 'u', 'e', 'o')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--song', required=True)
    ap.add_argument('--run', required=True)
    ap.add_argument('--free', required=True)
    ap.add_argument('--tol', type=float, default=0.03)
    a = ap.parse_args()
    song = pathlib.Path(a.song).resolve()
    run = pathlib.Path(a.run).resolve()
    truth = load_truth(song)
    offsets = {int(k): v for k, v in json.loads((run / 'offsets.json').read_text()).items()}
    free = np.array(json.loads(pathlib.Path(a.free).read_text()))
    definition = json.loads((song / 'lyricsync/lyrics.def.json').read_text(encoding='utf8'))
    first_syl = []  # text of every syllable, flat
    for line in definition['lines']:
        for w in line['words']:
            first_syl.extend(w['syllables'])
    ev = {'AP': [], 'EP': [], 'GS': []}
    for li, off in offsets.items():
        tg = textgrid.TextGrid.fromFile(str(run / 'tg' / f'l{li:03d}.TextGrid'))
        for t in tg:
            if t.name != 'phones':
                continue
            for iv in t:
                if iv.mark in ev:
                    ev[iv.mark].append((iv.minTime + off, iv.maxTime + off))
    ts = np.array([x['ts'] for x in truth])
    te = np.array([x['te'] for x in truth])
    ss = free[:, 0]
    gap_after = np.array([(truth[k + 1]['ts'] - te[k]) if k + 1 < len(truth) and truth[k + 1]['line'] == truth[k]['line'] else 9.9 for k in range(len(truth))])
    vowel_initial = np.array([s.strip('?!()').lower() in VOWELS for s in first_syl])
    err_s = np.abs(ss - ts)
    wrong = err_s > 0.1
    print(f'syllables {len(truth)}; vowel-initial {vowel_initial.sum()}; solver start wrong >100 ms: {wrong.sum()}')
    for name, spans in ev.items():
        if not spans:
            print(name, 'none')
            continue
        st = np.array([s for s, _ in spans])
        en = np.array([e for _, e in spans])
        dur = en - st
        d_start = np.array([np.min(np.abs(ts - s)) for s in st])
        d_end = np.array([np.min(np.abs(ts - e)) for e in en])
        in_gap = np.array([np.any((te - 0.02 <= s) & (e <= te + gap_after + 0.02) & (gap_after > 0.04)) for s, e in spans])
        print(f'\n{name}: {len(spans)} events, dur med {np.median(dur) * 1000:.0f} ms (p10 {np.percentile(dur, 10) * 1000:.0f}, p90 {np.percentile(dur, 90) * 1000:.0f})')
        print(f'  start within {a.tol * 1000:.0f} ms of a truth syllable start: {np.mean(d_start < a.tol) * 100:.0f}%   end within: {np.mean(d_end < a.tol) * 100:.0f}%   inside a truth gap between syllables: {np.mean(in_gap) * 100:.0f}%')
        # per syllable: is there an event edge within tol of its true start / the solver's start
        edge = np.concatenate([st, en])
        near_truth = np.array([np.any(np.abs(edge - t) < a.tol) for t in ts])
        near_solver = np.array([np.any(np.abs(edge - t) < a.tol) for t in ss])
        print(f'  syllables with an event edge at the true start: {near_truth.mean() * 100:.0f}% (vowel-initial {near_truth[vowel_initial].mean() * 100:.0f}%, other {near_truth[~vowel_initial].mean() * 100:.0f}%)')
        print(f'  where the solver is wrong (>100 ms): edge at the true start {near_truth[wrong].mean() * 100:.0f}%, at the solver\'s (wrong) start {near_solver[wrong].mean() * 100:.0f}%')
        print(f'  where the solver is right (<30 ms): edge at its start {near_solver[err_s < 0.03].mean() * 100:.0f}%')


def line_edges(song, run, free):
    """AP vs line edges: does a breath mark the end of a line / the start of the next, and does it fix the solver's line-edge error?"""
    truth = load_truth(song)
    offsets = {int(k): v for k, v in json.loads((run / 'offsets.json').read_text()).items()}
    aps = []
    for li, off in offsets.items():
        tg = textgrid.TextGrid.fromFile(str(run / 'tg' / f'l{li:03d}.TextGrid'))
        for t in tg:
            if t.name == 'phones':
                aps += [(iv.minTime + off, iv.maxTime + off) for iv in t if iv.mark == 'AP']
    aps = sorted(set((round(s, 3), round(e, 3)) for s, e in aps))
    lines = sorted({t['line'] for t in truth})
    first = {li: min(k for k, t in enumerate(truth) if t['line'] == li) for li in lines}
    last = {li: max(k for k, t in enumerate(truth) if t['line'] == li) for li in lines}
    inside, between = 0, 0
    for s, e in aps:
        within = any(truth[first[li]]['ts'] < s and e < truth[last[li]]['te'] for li in lines)
        inside += within
        between += not within
    print(f'\nAP events (deduplicated): {len(aps)}; inside a line: {inside}; between lines / at edges: {between}')
    rows = []
    for li in lines:
        k0, k1 = first[li], last[li]
        start_ap = [e for s, e in aps if abs(e - truth[k0]['ts']) < 0.05]
        end_ap = [s for s, e in aps if abs(s - truth[k1]['te']) < 0.05]
        rows.append((li, bool(start_ap), bool(end_ap), abs(free[k0][0] - truth[k0]['ts']) * 1000, abs(free[k1][1] - truth[k1]['te']) * 1000))
    sa = np.array([r[1] for r in rows]); ea = np.array([r[2] for r in rows])
    ds = np.array([r[3] for r in rows]); de = np.array([r[4] for r in rows])
    print(f'line starts with an AP ending within 50 ms: {sa.sum()}/{len(rows)}; solver start error there {ds[sa].mean():.0f} ms vs {ds[~sa].mean():.0f} ms elsewhere')
    print(f'line ends with an AP starting within 50 ms: {ea.sum()}/{len(rows)}; solver end error there {de[ea].mean():.0f} ms vs {de[~ea].mean():.0f} ms elsewhere')
    print(f'solver line start error mean {ds.mean():.0f} ms (>100 ms on {int((ds > 100).sum())} lines); line end error mean {de.mean():.0f} ms (>100 ms on {int((de > 100).sum())} lines)')
    big_s = ds > 100
    print(f'lines where the solver start is >100 ms off: an AP ends at the true start on {sa[big_s].sum()}/{big_s.sum()}')
    # rule: a line that ends before the next line starts, with a breath in between, ends where the breath starts
    new_de, old_de, fixed = [], [], 0
    for idx, li in enumerate(lines):
        k1 = last[li]
        nxt = first[lines[idx + 1]] if idx + 1 < len(lines) else None
        lo = free[k1][0] + 0.08
        hi = free[nxt][0] if nxt is not None else free[k1][1] + 2.0
        cand = [s for s, e in aps if lo <= s <= hi]
        old = abs(free[k1][1] - truth[k1]['te']) * 1000
        new = abs(min(cand) - truth[k1]['te']) * 1000 if cand else old
        fixed += bool(cand)
        old_de.append(old); new_de.append(new)
    old_de, new_de = np.array(old_de), np.array(new_de)
    print(f'rule "line ends where the breath starts": applies to {fixed}/{len(lines)} lines; line-end error {old_de.mean():.0f} -> {new_de.mean():.0f} ms; >100 ms on {int((old_de > 100).sum())} -> {int((new_de > 100).sum())} lines')
    n = len(truth)
    print(f'effect on the song mean syllable error: about {(old_de.mean() - new_de.mean()) / 2 * len(lines) / n:.1f} ms of 46')


if __name__ == '__main__':
    main()
    _a = argparse.ArgumentParser(); _a.add_argument('--song'); _a.add_argument('--run'); _a.add_argument('--free'); _a.add_argument('--tol'); _x, _ = _a.parse_known_args()
    line_edges(pathlib.Path(_x.song).resolve(), pathlib.Path(_x.run).resolve(), np.array(json.loads(pathlib.Path(_x.free).read_text())))
