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

## Fixed beat grid (`grid: fixed`, `lyricsync grid <song>`)

A song with one constant tempo can skip the beat tracker. The tracker is a model. Its beats drift by tens of milliseconds from the true grid. A fixed grid has no error.

Set this in `user_input/prompt.yaml`:

```yaml
grid: fixed          # "tracked" is the default
nearest_bpm: 135     # the tempo
first_downbeat_s: 0  # time of bar 1, in seconds. Default 0.
```

Run `lyricsync grid <song>`, or turn on Exact BPM in the editor's Tempo Map group or the New Song wizard (they write `grid: fixed` for you). `lyricsync grid` writes `generated/timing.ai.json` in the same schema as the tracker (`v`, `model`, `duration`, `bpm`, `beat_period`, `beats`, `downbeats`). `model` is `"fixed"`. It needs no model and no GPU. The wizard and the tempo re-fit of the editor write the same grid when the song says `grid: fixed`. The grid is beatsync's `exactBeatGrid`, which `beatsync <mix> --bpm <n> --exact-bpm` also prints.

- Beat `k` is at `first_downbeat_s + k * 60 / nearest_bpm`. Times are rounded to 1e-6 s. The tracker rounds to 1e-3 s.
- `duration` is the length of the mix (`files.song`), rounded to 1e-3 s.
- The grid has every beat in the song, up to the end of the mix. A beat up to 0.5 ms after `duration` still counts, because `duration` is rounded. A song of 170.667 s at 135 BPM has 385 beats (0 to 384) and 97 downbeats.
- When `first_downbeat_s` is more than 0, the grid also has the beats before bar 1 (pickup beats), down to 0 s.
- Bar 1 is a downbeat. Every 4th beat from it, forward and back, is a downbeat (4/4).
- `tempo_changes` and `beat_pins` in the file are ignored. They stay in the file, so you can go back to `grid: tracked`.
- A `grid` value other than `tracked` or `fixed` is an error. `lyricsync grid` on a song without `grid: fixed` is an error.
- Calibration files, `generated/notes.json` and the other files that use the grid do not change by themselves. Run `lyricsync notes <song>` again to put the notes on the new grid.

## Render index (`generated/renders/index.json`)

The tool that renders the UST files writes this file. The wav files are in the same folder. The editor reads them but does not write them.

```json
{ "v": 1, "tool": "utau", "toolVersion": "1.0", "sampleRate": 44100,
  "renders": [
    { "ust": "verse1.ust", "wav": "verse1.wav", "singer": "teto", "fallback": false,
      "tempo": 120, "ticks": 7680, "leadSamples": 2205, "seconds": 16.05, "ustSha256": "..." } ] }
```

- `leadSamples` is the number of samples before UST tick 0 in the wav.
- `fallback` is true when the tool used a fallback singer.
- Each `ust` occurs one time only.

## Placements (`user_input/placements.json`)

The user sets this file in the lyrics editor. Each rendered vocal track is a lane. A lane holds clips. A clip is one piece of the render at one position on the song beat grid.

```json
{ "v": 2, "lanes": [ { "id": "verse1#1", "ust": "verse1.ust", "block": "nannen mae ka no koto deshita", "clips": [
  { "id": "verse1#1/1", "atBeat": 32, "from": -48, "to": 960 },
  { "id": "verse1#1/2", "atBeat": 40, "from": 960, "to": 3840 }
] } ] }
```

Lane fields:

- `id` is unique. The default id is the UST file name without `.ust`, then `#1` (`verse1#1`). A second copy of the same render gets `#2`.
- `ust` must be a `ust` of the render index.
- `block` is the first line (romaji, as in the singer's lyrics file) of the lyric block that the lane sings. Empty (`""`) means that the lane sings no lyrics.
- `clips` is the list of clips. It can be empty.

Clip fields:

- `id` is unique in the lane. The first clip is `<laneId>/1`. A split gives the new clip `<laneId>/<n>`, where `n` is 1 more than the highest `n` in the lane.
- `atBeat` is the beat of the song beat grid where UST tick 0 of this clip is. It can be a fraction. `null` means that the clip is parked: it is silent and not on the timeline.
- `from` and `to` are UST ticks of the render. The clip plays ticks `from` to `to` (`to` is not included). `from` must be less than `to`. They can be fractions.
- `from` and `to` must be in the wav: from `min = -leadSamples / samplesPerTick` to `max = (seconds * sampleRate - leadSamples) / samplesPerTick`. Negative ticks are the lead-in before tick 0. The lead-in holds the first consonant.

Other rules:

- When the file is absent, each render gets one lane with one parked clip from `min` to `max` (the full wav).
- Unknown fields stay in the file when the editor writes it.
- An error names the file, the lane index, the clip index and the field.

Tick mapping (480 ticks per quarter note, at the render tempo):

- `secPerTick = 60 / tempo / 480`. `samplesPerTick = secPerTick * sampleRate`.
- Tick `t` is at sample `leadSamples + t * samplesPerTick` of the wav.

Clip time: `tick0 = beatTime(atBeat)`. `beatTime` uses the `beats` of `generated/timing.ai.json`. Between two beats, it interpolates linearly. Before the first beat and after the last beat, it extrapolates linearly. The clip starts at `tick0 + from * secPerTick` and stops at `tick0 + to * secPerTick`. In a clip, the render tempo does not change. The anchor of a clip is tick `max(from, 0)`: tick 0 when the clip holds it, else the clip start (a cut after tick 0). When the editor moves a clip, it snaps the time `T` of the anchor and sets `atBeat = beatOf(T - anchor * secPerTick)`, where `beatOf` is the inverse of `beatTime`. So with beat or bar snap, a clip that holds tick 0 gets an integer `atBeat`.

## Singers (`user_input/singers.json`)

The singers of the song. A UST belongs to the singer whose `voiceDir` is the UST `VoiceDir`.

```json
{ "v": 1, "singers": [
  { "id": "te", "voiceDir": "重音テト音声ライブラリー", "lead": true },
  { "id": "ko", "voiceDir": "koronba_04c" }
] }
```

- `id` matches `[a-z0-9_]+` and is unique.
- `voiceDir` is the UST `VoiceDir` without `%VOICE%`. It is unique.
- Exactly one singer has `"lead": true`.
- Files of a singer: the lead uses `user_input/lyrics.txt` (lyrics) and `user_input/lyrics.calibrated.json` (calibration). Each other singer uses `user_input/lyrics.<id>.txt` and `user_input/lyrics.calibrated.<id>.json`.
- A UST with a `VoiceDir` that is not in the list has no singer. Its notes go to `generated/notes.json` with `"singer": null`. It cannot carry lyrics.
- The lyrics files use the plain text syntax of this page in Japanese romaji: `|` splits syllables, `+` joins two syllables for display, `[Section]` headers. Each syllable is one mora.

## UST files (`user_input/ust/*.ust`)

UTAU files, Shift_JIS text. A lane's `ust` is the file name in `user_input/ust/`. The parser reads `Tempo` and `VoiceDir` of `[#SETTING]` and, of each `[#NNNN]` section, `Length` (ticks), `Lyric` and `NoteNum`. A note starts at the sum of the lengths of the notes before it. The lyric `R`, `r` or an empty lyric is a rest. Other sections and keys are ignored.

## MIDI files (`lyricsync/formats`)

`parseMidi(bytes)` reads a Standard MIDI file of format 0 or 1. It has no dependencies and no file access, so the browser can use it. Format 2 and SMPTE time division are errors.

- `division` is the number of ticks per quarter note. `tempos` is the tempo map of all tracks, sorted, with an entry at tick 0 (120 BPM when the file has none). `timeSignatures` is sorted by tick. `midiTickToSeconds(midi, tick)` uses the tempo map.
- Each track has `nameBytes`, `programs` (program changes with their channel), `notes`, `texts` and `endTick`.
- A note has `channel` (0 to 15), `pitch`, `velocity`, `tick`, `endTick` and `drum`. `drum` is true on channel 10 (index 9). A note on with velocity 0 is a note off. Running status works. A note off closes the oldest open note of the same channel and pitch, so overlapping notes of one pitch pair first in, first out. A note that has no off ends at the end of its track.
- Text events (text, copyright, track name, instrument, lyric, marker, cue) stay as bytes in `texts`. The file does not say which encoding it uses. `decodeMidiText(bytes, encoding?)` tries UTF-8 first and then Shift_JIS. Pass `encoding` (a `TextDecoder` label such as `gbk`) when you know it. `midiTrackName(track, encoding?)` decodes the track name.
- `GM_PROGRAM_NAMES` names the 128 General MIDI programs. `midiDrumRole(key)` gives the role of a drum key: kick (35, 36), snare (37 to 40), hat (42, 44, 46), tom, crash, ride or other.

## MIDI notes (`lyricsync midi <song> --file <mid> --out <file>`)

The command puts the notes of a MIDI file on the song beat grid. It never writes into the song folder unless you pass a file in it as `--out`.

| Option | Meaning |
|---|---|
| `--file` | The MIDI file. |
| `--out` | The JSON file to write. |
| `--offset-beats` | Song beats added to every MIDI beat. Default 0. |
| `--bpm` | Time of a beat = beat * 60 / bpm, instead of the beat grid. |
| `--encoding` | The text encoding of the track names (a `TextDecoder` label). |

A MIDI tick is a musical position. Song beat = tick / division + offset. The MIDI tempo is not used. `start` and `end` are `beatTime` of the song beat grid (`generated/timing.ai.json`), or beat * 60 / bpm with `--bpm`. A note that starts before beat 0 or after the song end is dropped and counted in `dropped`.

```json
{ "v": 1, "source": "song.mid", "offsetBeats": 16, "grid": "beats", "division": 96, "midiBpm": [135],
  "tracks": [ { "track": 5, "name": "bass", "channels": [15], "programs": [{ "program": 39, "name": "Synth Bass 2" }], "notes": 663 } ],
  "dropped": 0,
  "notes": [
    { "track": 19, "channel": 10, "program": null, "role": "kick", "pitch": 36, "velocity": 99,
      "beat": 16, "endBeat": 16.25, "start": 7.1111, "end": 7.1778 }
  ] }
```

- `channel` is 1 to 16. `program` is the General MIDI program in force on the channel at the note start (0 to 127), and null for drums. `role` is the drum role of the key, and null for a pitched note.
- `beat` and `endBeat` are song beats. `start` and `end` are seconds. All four are rounded to 1e-6.
- Notes are sorted by `start`, then track, then pitch.

## Placed notes (`generated/notes.json`)

`lyricsync notes <song>` writes this file. It lists every sung UST note that a placed clip plays, for the video.

```json
{ "v": 1, "notes": [
  { "lane": "te_0#2", "clip": "te_0#2/1", "ust": "te_0.ust", "singer": "te", "idx": 5,
    "kana": "し", "pitch": 62, "beat": 239.25, "start": 106.33, "end": 106.44 }
] }
```

- A note at tick `t` with length `l` counts when a placed clip of its lane holds `t` (`from <= t < to`). When two clips of the lane hold it, the clip with the lowest index has it.
- `beat = atBeat + t / 480`. `start = beatTime(beat)`. `end = beatTime(atBeat + min(t + l, to) / 480)`: a note stops at the clip end.
- `idx` is the UST note number (`[#NNNN]`). `kana` is the UST lyric, `pitch` the `NoteNum`. Rests are not listed.
- `beat`, `start` and `end` are rounded to 1e-6. The notes are sorted by `start`, then by lane id.

## UST map (`user_input/ust.map.json`)

Written by hand. It maps the sung UST notes of each lane to the syllables of the singer's lyrics file.

```json
{ "v": 1,
  "lanes": {
    "te_a_1#1": [
      { "line": 0, "notes": [["な", "na"], ["ん", "n"], ["ね", "ne"], ["ん", "n"], ["ま", "ma"], ["え", "~"], ["ぎ", "gi", "t"]] }
    ]
  },
  "sections": [{ "name": "Intro", "bar": 1 }, { "name": "Verse 1", "bar": 9 }]
}
```

- The key is a lane id of `placements.json`. Only lanes with a `block` occur. The singer of the lane is the singer of its UST.
- Each entry covers one line of the singer's lyrics file. `line` is the 0-based index among the lyric lines (section headers and blank lines do not count).
- `notes` has one row per sung note of the lane's UST (rests are skipped), in order: `[ustKana, target, ...]`. `ustKana` is the UST note lyric.
- A target is the next syllable of the line, as written in the lyrics file. `"~"`: the note continues the syllable before it (a held vowel, a melisma). `"_"`: the note is not a syllable (a filler). `"~"` and `"_"` are valid only as the single target of a row.
- A row with several targets: one note sings several consecutive syllables of the line (a closure, a long vowel, two vowels across a word gap). The targets can cross a word gap.
- `sections` (optional): 1-based bars on the song grid (`downbeats` of `generated/timing.ai.json`, bar 1 = the first downbeat), in increasing order. Each section ends where the next starts, the last at the song end (`duration`).

Checks (`lyricsync import ust`). Each failure names the lane, the line and the UST note number:

- Every `ustKana` equals the lyric of the UST note at that position.
- Every target equals the next syllable of the line, in order. Every syllable of the line is used exactly once.
- Every sung note of the UST is listed exactly once, over the entries of the lane.
- Every lyric line of a singer with mapped lanes is mapped by exactly one lane.

## UST import (`lyricsync import ust <song>`)

For each singer with mapped lanes, the import writes the singer's calibration file (`lyrics.calibrated.json` format) from the placed notes (see Placed notes) and the map:

- A syllable starts at the start of its first placed note and ends at the end of its last placed note, `"~"` notes included.
- A note of a row with several targets is split evenly over those syllables, in order. These syllables get `sylCalibrated: false`. Every other syllable gets `sylCalibrated: true`. `calibrated` of a word or a line is not set.
- Word and line bounds come from their syllables. Lines are sorted by start. `method` is `"ust"`.
- The lead singer's file gets the sections of the map. The files of the other singers have no sections.
- The import overwrites the calibration files of the singers with mapped lanes and does not touch other files. A failed check or a syllable without a placed note stops the import before it writes a file. `--dry` runs every check and writes nothing.

## Subtitles (`lyricsync export subs <song> --out <dir>`)

The command writes subtitle files from the calibration files. It never writes into the song folder unless you pass that folder as `--out`.

| Option | Meaning |
|---|---|
| `--format` | `ttml`, `srt`, `ass`, `ytt` or `all`. A comma list also works. Default `ass`. |
| `--singer <id>` | The calibration file of one singer. |
| `--all` | Every singer, the lead first. |
| none of the two | The lead. |
| `--lang <code>` | The `xml:lang` of TTML. Default `und`. |

Each file is `<song>.<singer>.<format>`. With `--all`, ASS and YTT also get `<song>.all.<format>`. In that file each singer has one row of the screen, the lead lowest. The lines of two singers may overlap in time. SRT and TTML have no rows, so they stay one file per singer.

A line shows 0.25 s before its first syllable and 0.7 s after its last. The syllable that is sung now is yellow (`#FFD84A`), the syllables before it are white and the syllables after it are grey. A subtitle file has no running highlight, so every change of state is its own cue. Times are whole centiseconds. A cue that touches the next one keeps the same time as it. The syllables of one word are shown as one word, and a space goes between words. A syllable written `(o)` is only for the timing and is not shown.

- **ASS**: one `Style` for each singer. The cue text has an inline colour for each state. A backslash, `{` and `}` in the lyrics are escaped.
- **YTT**: YouTube timed text (srv3). It has one `pen` for each colour and one `wp` (window position) for each singer.

The writers are pure functions in `lyricsync/formats` (`buildCues`, `toSrt`, `toTtml`, `toAss`, `toYtt`). The pve command `pve subs` uses them too.

## Retime (`lyricsync retime <song> --by <seconds>`)

The command adds one constant to every time of the calibration files: sections, lines, words and syllables. Pins, text, flags and other fields stay as they are. `generated/` and the cache stay as they are. `--singer <id>` or `--all` choose the files (default: the lead). A negative shift needs the form `--by=-0.5`. A shift that moves any time below 0 is an error, and then no file is written. Run `prepare` after the shift when the audio changed.

## Training manifest

See [training.md](training.md).
