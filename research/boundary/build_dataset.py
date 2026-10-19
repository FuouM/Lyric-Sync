# Builds the beat-free syllable-boundary training set from the downloaded GTSinger singing data (.cache/gtsinger).
# Output (.cache/gtsinger_ds):
#   audio.int16  every segment's audio, 16 kHz mono int16, concatenated
#   index.json   one entry per segment: where its audio is, who sings what, and its syllable runs. A run is a maximal sequence of
#                sung syllables with no rest between them; each syllable has start/end (s) and its phones in the lyricsync dictionary
#                phone names (English: CMUdict without stress; Japanese: the romaji phones of the base model's dictionary).
# English words are split into syllables by maximal onset (one consonant between vowels goes right; of two or more, the first stays left).
# Japanese words are split into morae: consonants + vowel, a lone moraic nasal (N) or a geminate stop (cl).
# usage: python scripts/gtsinger/build_dataset.py
import json
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

SRC = os.path.abspath(".cache/gtsinger")
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".cache/gtsinger_ds")
SR = 16000

EN_VOWELS = {"aa", "ae", "ah", "ao", "aw", "ax", "ay", "eh", "er", "ey", "ih", "iy", "ow", "oy", "uh", "uw"}
JA_VOWELS = {"a", "i", "u", "e", "o"}
# GTSinger Japanese IPA -> base-model romaji phone. Palatalised consonants are merged with the following y-glide by ja_mora().
JA_MAP = {
    "a": "a", "i": "i", "u": "u", "\u026f": "u", "e": "e", "o": "o",
    "k": "k", "\u0261": "g", "g": "g", "s": "s", "z": "z", "t": "t", "d": "d", "n": "n", "h": "h", "b": "b", "p": "p", "m": "m",
    "\u027e": "r", "r": "r", "w": "w", "j": "y", "\u0255": "sh", "\u0291": "j", "d\u0291": "j", "t\u0255": "ch", "ts": "ts",
    "dz": "z", "\u0272": "ny", "\u00e7": "hy", "\u0278": "f", "f": "f", "v": "v", "\u0274": "N", "N": "N", "t\u031a": "cl",
    "c": "ky", "\u025f": "gy", "k\u02b2": "ky", "\u0261\u02b2": "gy", "m\u02b2": "my", "p\u02b2": "py", "b\u02b2": "by",
    "\u027e\u02b2": "ry", "\u0263": "g", "\u0281": "r", "\u014b": "N", "\u0294": "cl",
    # unreleased stops (geminate closures) and tie-bar affricates
    "p\u031a": "cl", "k\u031a": "cl", "t\u0361s": "ts", "d\u0361z": "z", "t\u0361\u0255": "ch", "d\u0361\u0291": "j",
}
SILENT = {"<AP>", "<SP>", "AP", "SP", ""}


def en_phone(p):
    return p.rstrip("012").lower()


def en_syllables(phones):
    """Splits one word's phones into syllables (lists of phones) by maximal onset."""
    vow = [i for i, p in enumerate(phones) if p in EN_VOWELS]
    if len(vow) <= 1:
        return [list(range(len(phones)))]
    cuts = [0]
    for k in range(len(vow) - 1):
        n = vow[k + 1] - vow[k] - 1  # consonants between the two vowels
        cuts.append(vow[k] + 1 + (1 if n >= 2 else 0))
    cuts.append(len(phones))
    return [list(range(cuts[k], cuts[k + 1])) for k in range(len(vow))]


def ja_phone(p):
    q = p.replace("\u02d0", "")  # long-vowel mark: the vowel itself
    if q not in JA_MAP:
        raise ValueError("unmapped Japanese phone %r" % p)
    return JA_MAP[q]


def ja_morae(phones):
    """Splits one word's (romaji) phones into morae: index lists."""
    out = []
    cur = []
    for i, p in enumerate(phones):
        cur.append(i)
        if p in JA_VOWELS or p in ("N", "cl"):
            out.append(cur)
            cur = []
    if cur:  # trailing consonant without a vowel: attach to the last mora (or keep alone)
        if out:
            out[-1] += cur
        else:
            out.append(cur)
    return out


def segment_runs(words, lang):
    runs = []
    cur = []
    for w in words:
        if w["word"].strip() in SILENT or all(p in SILENT for p in w["ph"]):
            if cur:
                runs.append(cur)
                cur = []
            continue
        if lang == "en":
            phones = [en_phone(p) for p in w["ph"]]
            groups = en_syllables(phones)
        else:
            phones = [ja_phone(p) for p in w["ph"]]
            groups = ja_morae(phones)
        vowels = EN_VOWELS if lang == "en" else JA_VOWELS | {"N", "cl"}
        for g in groups:
            nucleus = next((i for i in g if phones[i] in vowels), g[0])
            cur.append({
                "start": round(float(w["ph_start"][g[0]]), 4),
                "end": round(float(w["ph_end"][g[-1]]), 4),
                # where the sung vowel (the note) begins: the time the annotated songs mark as the syllable start
                "vowel": round(float(w["ph_start"][nucleus]), 4),
                "phones": [phones[i] for i in g],
                "wordStart": g[0] == 0,
            })
    if cur:
        runs.append(cur)
    # A run must be contiguous: split where a syllable does not start where the previous one ended.
    out = []
    for run in runs:
        piece = [run[0]]
        for s in run[1:]:
            if abs(s["start"] - piece[-1]["end"]) > 0.002:
                out.append(piece)
                piece = []
            piece.append(s)
        out.append(piece)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    jsons = []
    for root, _, files in os.walk(SRC):
        for f in files:
            if f.endswith(".json") and os.path.exists(os.path.join(root, f[:-5] + ".wav")):
                jsons.append(os.path.join(root, f))
    jsons.sort()
    print("segments with audio: %d" % len(jsons), flush=True)
    index = []
    offset = 0
    skipped = 0
    with open(os.path.join(OUT, "audio.int16"), "wb") as fa:
        for n, jf in enumerate(jsons):
            rel = os.path.relpath(jf, SRC).split(os.sep)
            lang = "en" if rel[0] == "English" else "ja"
            try:
                words = json.load(open(jf, encoding="utf-8"))
                runs = segment_runs(words, lang)
            except (ValueError, KeyError, IndexError) as err:
                skipped += 1
                print("skip %s: %s" % (ascii("/".join(rel)), ascii(str(err))), flush=True)
                continue
            audio, sr = sf.read(jf[:-5] + ".wav", dtype="float32", always_2d=True)
            audio = audio.mean(axis=1)
            if sr != SR:
                g = np.gcd(sr, SR)
                audio = resample_poly(audio, SR // g, sr // g).astype(np.float32)
            peak = float(np.abs(audio).max()) or 1.0
            pcm = np.clip(audio / peak * 0.9 * 32767, -32768, 32767).astype(np.int16)
            fa.write(pcm.tobytes())
            index.append({
                "id": "/".join(rel)[:-5], "lang": lang, "singer": rel[1], "group": rel[4] if len(rel) > 4 else "",
                "song": rel[3] if len(rel) > 3 else "", "offset": offset, "length": int(len(pcm)), "runs": runs,
            })
            offset += len(pcm)
            if (n + 1) % 1000 == 0:
                print("%d/%d, %.1f h" % (n + 1, len(jsons), offset / SR / 3600), flush=True)
    json.dump(index, open(os.path.join(OUT, "index.json"), "w", encoding="utf-8"))
    nsyl = sum(len(r) for e in index for r in e["runs"])
    print("done: %d segments, %d syllables, %.2f h, skipped %d" % (len(index), nsyl, offset / SR / 3600, skipped), flush=True)


if __name__ == "__main__":
    sys.exit(main())
