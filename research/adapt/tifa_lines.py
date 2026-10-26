"""TIFA per lyric line: cut the vocal stem to a window around each line, align, stitch, score.

usage (repo root, conda env chanenv):
  python research/adapt/tifa_lines.py --song .cache/adapt/songs/god_ish --out .cache/adapt/tifa/god_ish_lines --windows truth [--pad 0.25] [--model TIFA-1.0]
windows: truth = the calibrated line extents (oracle: what anchored mode gives once a user pins both line edges);
         free:<file.json> = per-line [start, end] list from a solver run (the free case).
"""
import argparse
import json
import pathlib
import subprocess
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from tifa_eval import load_tifa, load_truth, stats  # noqa: E402
from tifa_run import TIFA, load_dict, phones_for  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--song', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--windows', default='truth')
    ap.add_argument('--pad', type=float, default=0.25)
    ap.add_argument('--model', default='TIFA-1.0')
    ap.add_argument('--ved', action='store_true', help='insert AP/EP/GS events (needs --model TIFA-1.0-ST)')
    ap.add_argument('--skip-run', action='store_true')
    a = ap.parse_args()
    song = pathlib.Path(a.song).resolve()
    out = pathlib.Path(a.out).resolve()
    work = out / 'in'
    work.mkdir(parents=True, exist_ok=True)
    d = load_dict(TIFA / 'weights' / a.model / 'dictionaries/japanese_dict_full.txt')
    definition = json.loads((song / 'lyricsync/lyrics.def.json').read_text(encoding='utf8'))
    manifest = json.loads((song / 'lyricsync/lyricsync.json').read_text(encoding='utf8'))
    audio, sr = sf.read(str((song / 'lyricsync' / manifest['vocal']).resolve()), always_2d=True)
    audio = audio.mean(axis=1)
    truth = load_truth(song)
    by_line = {}
    for k, t in enumerate(truth):
        by_line.setdefault(t['line'], []).append(k)
    if a.windows == 'truth':
        wins = {li: (truth[ks[0]]['ts'], truth[ks[-1]]['te']) for li, ks in by_line.items()}
    else:
        wins = {int(k): v for k, v in json.loads(pathlib.Path(a.windows.split(':', 1)[1]).read_text()).items()}
    offsets = {}
    if not a.skip_run:
        for li, line in enumerate(definition['lines']):
            w = []
            for word in line['words']:
                for syl in word['syllables']:
                    w.append(f'<word text="{syl}" script="{syl}" phonemes="' + ' '.join('ja/' + p for p in phones_for(syl, d)) + '"/>')
            lo = max(0.0, wins[li][0] - a.pad)
            hi = min(len(audio) / sr, wins[li][1] + a.pad)
            offsets[li] = lo
            sf.write(str(work / f'l{li:03d}.wav'), audio[int(lo * sr):int(hi * sr)].astype(np.float32), sr)
            (work / f'l{li:03d}.pfml').write_text('<scope language="ja">' + '\n'.join(w) + '</scope>', encoding='utf8')
        (out / 'offsets.json').write_text(json.dumps(offsets))
        cmd = [sys.executable, 'infer.py', str(work), '-m', f'weights/{a.model}/model.pt', '-l', 'ja', '--fill', 'SP', '-o', str(out / 'tg'),
               '--skip-handling', 'preserve', '--batch-size', '8', '--num-workers', '0']
        if a.ved:
            cmd += ['--ved-model', 'weights/VED-2026.10/model.pt']
        r = subprocess.run(cmd, cwd=TIFA, capture_output=True, text=True)
        print(r.stdout[-600:], r.stderr[-600:])
        if r.returncode != 0:
            raise SystemExit(r.returncode)
    offsets = {int(k): v for k, v in json.loads((out / 'offsets.json').read_text()).items()}
    res = [None] * len(truth)
    bad = 0
    for li, ks in by_line.items():
        tgf = out / 'tg' / f'l{li:03d}.TextGrid'
        try:
            t = load_tifa(tgf)
        except Exception:
            t = []
        if len(t) != len(ks):
            bad += 1
            t = [{'start': np.nan, 'vowel': np.nan, 'end': np.nan}] * len(ks)
        for k, x in zip(ks, t):
            res[k] = {key: v + offsets[li] for key, v in x.items()}
    print('lines with missing/odd output:', bad)
    flagged = np.array([x['flagged'] for x in truth])
    ts = np.array([x['ts'] for x in truth])
    te = np.array([x['te'] for x in truth])
    ok = np.array([not np.isnan(r['start']) for r in res])
    for conv in ('start', 'vowel'):
        st = np.array([r[conv] for r in res])
        en = np.array([r['end'] for r in res])
        for k in range(len(res) - 1):
            if truth[k]['line'] == truth[k + 1]['line']:
                en[k] = st[k + 1]
        es = np.abs(st - ts)
        err = (es + np.abs(en - te)) / 2
        stats(f'{conv}: syllable err all', err[ok])
        stats(f'{conv}: syllable err flagged', err[ok & flagged])
        stats(f'{conv}: start-only all', es[ok])
    (out / 'syllables.json').write_text(json.dumps(res))


if __name__ == '__main__':
    main()
