# File formats

## Lyrics input (`--lyrics`)

Every sung line of the song, in order. The forced aligner reads the lyrics as one continuous text, so a sung line you leave out shifts everything after it.

### Plain text (`.txt`)

```
[Verse 1]                         section header (optional, applies to the lines below)
# a comment                       ignored, as are blank lines
i looking at the walls            one lyric line per line, words separated by spaces
re|con|cil|i|a|tion (oh) any      "|" gives explicit syllables; "(oh)" is a backing-vocal word
```

- Words with no `|` get their syllables automatically: the **count** comes from the dictionary pronunciation (one per vowel phone), the **split** from a maximal-onset rule (`loo|king`, `de|spair`).
- Auto-split is a heuristic. Measured against three human-annotated songs: syllable count agrees on 100% (English) / 99% (Japanese romaji) of words; the exact split of multi-syllable words agrees on ~72-75% (English) / 99% (Japanese). `init` prints every auto-split word so you can override the ones that matter with `|`.
- Syllable *texts* only feed an onset/coda letter class, so a respelling such as `fay|ding` is fine. The syllable **count** is what the timing granularity is.
- Japanese is romaji, split into morae (`ko|yo|i`); explicit syllables must be single morae, and the automatic split written out with `|` is always valid (also `ko|n|ni|chi|wa`, where the doubled `n` is a closure mora).
- Japanese `+` is a `|` whose two syllables the editor shows as one unit (`ko+n|ni|chi|wa`: `kon`, `ni`, `chi`, `wa`; `ni+i` for a held `nii`). It is display only: the syllables and the solver are the same as with `|`. The join is stored as `sylJoin` (one boolean per gap between a word's syllables) in `lyrics.sync.json` and `lyrics.calibrated.json`, never in the workspace definition. The karaoke monitor draws a joined run as one unit that fills over its whole span; the timeline and the lines panel keep one box per syllable.
- A word the dictionary does not know is an error naming the word.

### JSON (`.json`)

```json
{ "language": "en",
  "lines": [
    "plain text line, parsed like the .txt format",
    { "section": "chorus", "text": "optional display text",
      "words": [ "free",
                 { "w": "any", "syllables": ["an", "y"] },
                 { "w": "zzxqv", "phones": ["z", "ae", "k"] } ] }
  ] }
```

`phones` (dictionary phone names: lowercase ARPAbet for English, mora phones such as `k`, `a` for Japanese) replaces the dictionary lookup; it is how you align a word the dictionary lacks.

## Workspace (`<ws>/`)

```
lyricsync.json     manifest: language, vocal path, beat source, evidence key
lyrics.def.json    the resolved lyrics (words, syllables, phones)
anchors.json       pinned timings
evidence/          meta.json, notes.json, alignments.json, posteriors.bin, boundary.bin, boundary.json, beats.json
sliced/<line>.json cached per-line forced alignments of anchored lines
out/lyrics.json    the result            out/review.json   uncertainty ranking
```

The manifest's `evidenceKey` hashes the lyrics, the content of the vocal stem and of the beat source, the evidence format and the bundled boundary model. Paths in `lyricsync.json` are stored relative to the workspace with `/` separators, so a song folder can be copied or zipped to another machine and stays prepared. `solve` throws if the key no longer matches; `prepare` refreshes it (only the boundary queries when just the syllables changed).

## `anchors.json`

```json
{ "version": 1,
  "lines": { "3": { "start": 12.30, "end": 15.10, "boundaries": { "2": 13.42 } } } }
```

Key = line index (0-based). `start` is boundary 0 and `end` is boundary `m` (syllable count); `boundaries` holds interior boundaries `1..m-1`; boundary `j` is the start of the line's `j`-th syllable counted across its words. Times are seconds from the start of the vocal stem. A line with both `start` and `end` is solved in anchored mode.

## Output: `out/lyrics.json`

```json
{ "format": "words", "fps": 60, "method": "lyricsync",
  "lines": [ { "i": 0, "text": "i looking at the walls", "start": 38.6, "end": 43.66,
    "words": [ { "w": "looking", "start": 39.1, "end": 39.7, "conf": 0.95,
                 "syl": [[39.1, 39.4], [39.4, 39.7]], "sylText": ["loo", "king"] } ] } ] }
```

Times are seconds. Syllables tile their word and words tile their line contiguously. For a syllable whose both edges you pinned, the word also carries `sylCalibrated: [..booleans..]` and `calibrated: true` (the convention of the lyrics editor this format comes from). `conf` is a constant placeholder; use `review` for uncertainty.

## `out/review.json`

```json
{ "lines": [ { "line": 24, "mode": "free", "meanExpectedErrorMs": 147.2,
    "uncertain": [ { "boundary": 3, "time": 128.3, "expectedErrorMs": 255, "anchored": false, "syllable": "" } ] } ] }
```

`syllable` is the text of the syllable that starts at that boundary (empty for the line end). `expectedErrorMs` is a ranking signal, not a calibrated error bar (see [refinement.md](refinement.md)).

## Beats (`--beats`)

The JSON `beatsync` prints: `{ "v": 1, "model": "beat_this", "duration": 194.26, "bpm": 100, "beat_period": 0.6, "beats": [...], "downbeats": [...] }`. Only `beats` (strictly increasing seconds, at least 4) is required.

## Training manifest

See [training.md](training.md).
