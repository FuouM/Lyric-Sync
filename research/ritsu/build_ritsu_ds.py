# Builds the Ritsu boundary-model training set in build_dataset.py's format (.cache/ritsu_ds/audio.int16 at 16 kHz + index.json), from
# the songs prepared by build_ritsu.ts / prepare_ritsu.ts. Every 5th song (sorted order, index % 5 == 2) is held out as the test set and
# is not written; train_boundary.py's own validation rule (md5 of the song title) takes its validation songs from the rest.
# Segments: consecutive runs grouped up to SEG_MAX_S, cut in the middle of the rests (at most PAD_S of rest kept on each side).
# usage: python research/ritsu/build_ritsu_ds.py
import json
import os

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = ".cache/ritsu"
OUT = ".cache/ritsu_ds"
SR = 16000
SEG_MAX_S = 12.0
PAD_S = 0.4


def test_ids(ids):
    return [s for i, s in enumerate(sorted(ids)) if i % 5 == 2]


def main():
    manifest = json.load(open(os.path.join(ROOT, "ritsu.training.json"), encoding="utf-8"))["songs"]
    ids = [s["id"] for s in manifest]
    test = set(test_ids(ids))
    os.makedirs(OUT, exist_ok=True)
    json.dump(sorted(test), open(os.path.join(OUT, "test_songs.json"), "w"), indent=1)
    index = []
    offset = 0
    with open(os.path.join(OUT, "audio.int16"), "wb") as fa:
        for s in manifest:
            if s["id"] in test:
                continue
            ws = os.path.join(ROOT, s["workspace"])
            cfg = json.load(open(os.path.join(ws, "lyricsync.json"), encoding="utf-8"))
            vocal = os.path.normpath(os.path.join(ws, cfg["vocal"].replace("\\", os.sep)))
            audio, sr = sf.read(vocal, dtype="float32", always_2d=True)
            audio = audio.mean(axis=1)
            g = np.gcd(sr, SR)
            audio = resample_poly(audio, SR // g, sr // g).astype(np.float32)
            runs = json.load(open(os.path.join(ROOT, "projects", s["id"], "runs.json"), encoding="utf-8"))
            dur = len(audio) / SR
            # group runs into segments
            groups = [[runs[0]]]
            for r in runs[1:]:
                if r[-1]["end"] - groups[-1][0][0]["start"] > SEG_MAX_S:
                    groups.append([r])
                else:
                    groups[-1].append(r)
            for gi, grp in enumerate(groups):
                prev_end = groups[gi - 1][-1][-1]["end"] if gi > 0 else 0.0
                next_start = groups[gi + 1][0][0]["start"] if gi + 1 < len(groups) else dur
                a = max(grp[0][0]["start"] - PAD_S, (prev_end + grp[0][0]["start"]) / 2, 0.0)
                b = min(grp[-1][-1]["end"] + PAD_S, (grp[-1][-1]["end"] + next_start) / 2, dur)
                seg = audio[int(a * SR): int(b * SR)]
                peak = float(np.abs(seg).max()) or 1.0
                pcm = np.clip(seg / peak * 0.9 * 32767, -32768, 32767).astype(np.int16)
                fa.write(pcm.tobytes())
                t0 = int(a * SR) / SR
                rel = [[{"start": round(m["start"] - t0, 4), "end": round(m["end"] - t0, 4), "vowel": round(m["vowel"] - t0, 4),
                         "phones": m["phones"], "wordStart": m["wordStart"]} for m in run] for run in grp]
                index.append({"id": "ritsu/%s/%03d" % (s["id"], gi), "lang": "ja", "singer": "ritsu", "group": "", "song": s["id"],
                              "offset": offset, "length": int(len(pcm)), "runs": rel})
                offset += len(pcm)
            print("%s: %d segments" % (s["id"], len(groups)), flush=True)
    json.dump(index, open(os.path.join(OUT, "index.json"), "w", encoding="utf-8"))
    nsyl = sum(len(r) for e in index for r in e["runs"])
    print("done: %d segments, %d syllables, %.2f h; %d test songs held out" % (len(index), nsyl, offset / SR / 3600, len(test)), flush=True)


if __name__ == "__main__":
    main()
