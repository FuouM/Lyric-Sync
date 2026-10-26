"""Align a lyricsync song's vocal stem with TIFA (reference forced aligner) and dump syllable timings.

usage (repo root, conda env chanenv):
  python research/adapt/tifa_run.py --song .cache/adapt/songs/god_ish --out .cache/adapt/tifa/god_ish [--model TIFA-1.0] [--ved]

Every syllable of the song's lyrics.def.json becomes one direct PFML word (explicit Japanese phones), so TIFA's word tier is the syllable tier.
Writes <out>/syllables.json: [{line, j, text, start, vowel, end}] in flat syllable order (start = first phone, vowel = first vowel phone).
"""
import argparse
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path.cwd()
TIFA = (ROOT / '.cache/.reference/TIFA').resolve()
VOWELS = {'a', 'i', 'u', 'e', 'o'}


def load_dict(path):
    d = {}
    for line in path.read_text(encoding='utf8').splitlines():
        k, v = line.split('\t')
        d[k] = v.split()
    return d


def phones_for(text, d):
    """Phones of one Japanese mora written as romaji; closure letters ('p' of 'p po') -> cl, 'n' -> N."""
    t = text.strip('?!()').lower()
    if t == 'n':
        return ['N']
    if t in d:
        return d[t]
    if t in {'p', 'k', 't', 's', 'c', 'cl'}:
        return ['cl']
    raise SystemExit(f'no phones for mora "{text}"')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--song', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default='TIFA-1.0')
    ap.add_argument('--ved', action='store_true')
    ap.add_argument('--lines-sp', action='store_true', help='put an SP word between lyric lines')
    a = ap.parse_args()
    song = pathlib.Path(a.song).resolve()
    out = pathlib.Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    d = load_dict(TIFA / 'weights' / a.model / 'dictionaries/japanese_dict_full.txt')
    definition = json.loads((song / 'lyricsync/lyrics.def.json').read_text(encoding='utf8'))
    manifest = json.loads((song / 'lyricsync/lyricsync.json').read_text(encoding='utf8'))
    vocal = (song / 'lyricsync' / manifest['vocal']).resolve()

    words, meta = [], []
    for li, line in enumerate(definition['lines']):
        j = 0
        for w in line['words']:
            for syl in w['syllables']:
                ph = phones_for(syl, d)
                words.append(f'<word text="{syl}" script="{syl}" phonemes="' + ' '.join('ja/' + p for p in ph) + '"/>')
                meta.append({'line': li, 'j': j, 'text': syl, 'phones': ph})
                j += 1
        if a.lines_sp:
            words.append('<word text="SP" script="SP" phonemes="SP"/>')
    work = out / 'in'
    work.mkdir(exist_ok=True)
    (work / 'song.pfml').write_text('<scope language="ja">' + '\n'.join(words) + '</scope>', encoding='utf8')
    wav = work / 'song.wav'
    if not wav.exists():
        wav.hardlink_to(vocal)
    cmd = [sys.executable, 'infer.py', str(work), '-m', f'weights/{a.model}/model.pt', '-l', 'ja', '--fill', 'SP', '-o', str(out / 'tg'),
           '--skip-handling', 'preserve', '--batch-size', '1', '--num-workers', '0']
    if a.ved:
        cmd += ['--ved-model', 'weights/VED-2026.10/model.pt']
    print(' '.join(cmd))
    r = subprocess.run(cmd, cwd=TIFA, capture_output=True, text=True)
    print(r.stdout[-3000:])
    print(r.stderr[-3000:])
    if r.returncode != 0:
        raise SystemExit(r.returncode)


if __name__ == '__main__':
    main()
