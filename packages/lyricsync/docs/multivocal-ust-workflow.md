# Multi-vocal and Synthesizer Workflow

This guide documents the workflow for complex songs with vocal synthesizers (such as UTAU or OpenUtau). Use this workflow when machine-learning vocal separation from the master mix fails, or when a song has multiple singers, overlapping lyrics, and DAW edits after synthesis.

## 1. When to use this workflow

The standard `init -> prepare -> solve` workflow assumes:
1. You have a clean, isolated vocal stem.
2. The vocals follow one continuous, non-overlapping stream.
3. Syllable boundaries are discovered from acoustic audio features.

Complex synthesizer songs violate these assumptions:
- **No isolated vocal stem:** Instrumental and vocal separation tools produce severe artifacts on dense mixes.
- **Multiple concurrent singers:** Lead lines, doubled choruses, counter-melodies, and backing choirs sing at the same time. Single-stream calibration documents reject overlapping time intervals.
- **Post-synthesis DAW editing:** Synthesizer source files (such as `.ust` or `.ustx`) are split into sections. Producers chop, nudge, and rearrange these sections in a DAW.
- **Phonetic versus display divergence:** Synthesizer notes use phonetic kana (such as `わ` for *wa* or `お` for *o*), extra vowel notes for held melismas, and closure notes for double consonants. These do not match the display lyrics one to one.

This workflow uses the synthesizer notes as ground truth for timing. It bypasses acoustic forced alignment and produces exact, sample-accurate calibration documents.

```
Synthesizer files (.ust) ─┐
Mix audio (.wav) ─────────┼─► Headless Render ─► Multi-Vocal Lanes & Clips (Editor)
Voicebanks ───────────────┘   (with lead pad)     (beat snap, razor tool, mixer)
                                                          │
                                                          ▼
Singers schema (singers.json) ────────────────► ust.map.json (Agent / Hand)
Syllabified lyrics (lyrics.<id>.txt) ─────────────────────┤
                                                          ▼
                                              lyricsync import ust
                                                          │
                             ┌────────────────────────────┴───────────────────────────┐
                             ▼                                                        ▼
           lyrics.calibrated.<id>.json (pinned)                             generated/notes.json
           (per-singer streams for player)                                  (all notes for video engine)
```

---

## 2. Stage 1: Headless Voicebank Rendering with Lead Padding

Do not attempt neural vocal separation on dense tracks when project files exist. Render the synthesizer project files to clean WAV stems directly from the voicebanks.

### The pre-utterance problem
Synthesizer voicebanks define two timing parameters for consonants:
- **Pre-utterance:** The duration of the consonant attack before the note onset.
- **Overlap:** The duration that the consonant blends with the previous vowel.

If a synthesizer file starts with a sung note at tick 0, rendering from tick 0 cuts off the initial consonant attack. The audio file starts abruptly at full amplitude.

### The solution: lead padding
Render with a mandatory lead-in silence (default: 4 beats, or one musical bar):

```bash
dotnet run --project tools/ou-render -c Release -- \
  --singers path/to/voicebanks \
  --out generated/renders \
  --fallback-singer DefaultVoiceBank \
  --lead-beats 4 \
  user_input/ust/*.ust
```

This writes audio files where:
- Sample 0 is completely silent.
- The consonant attack begins naturally before nominal tick 0.
- `generated/renders/index.json` records `leadSamples`. Sample index `leadSamples` marks exact UST tick 0.

---

## 3. Stage 2: Beat Grid Anchoring

DAW renders maintain a constant tempo. Beat trackers often wander by 20 to 80 milliseconds across dense mixes. This drift causes false tempo warnings and breaks visual grid alignment.

Lock the beat grid to the musical structure in `user_input/prompt.yaml`:
1. Set `first_downbeat_s: 0` (or the measured start of bar 1).
2. Set `beat_pins` at major section boundaries (verse starts, chorus starts, bridge starts).
3. Compute the time for each pin with the mathematical formula:
   $$\text{time} = \text{beat} \times \frac{60}{\text{BPM}}$$

When the beat tracker runs with these pins, output beat $k$ matches song beat $k$ throughout the track.

---

## 4. Stage 3: Multi-Vocal Lanes and Clip Chopping

Open the song in the Lyric-Sync web editor (`bun run dev --songs <dir>`). The editor loads all rendered files into the WebAudio mixer.

### Placement schema (`user_input/placements.json`)
The placement file records where each render sits on the song timeline:

```json
{
  "v": 2,
  "lanes": [
    {
      "id": "te_0#1",
      "ust": "te_0.ust",
      "block": "ashita no koto wa shitteiru",
      "clips": [
        { "id": "te_0#1/1", "atBeat": 60, "from": -1920, "to": 1425.6 },
        { "id": "te_0#1/2", "atBeat": 60.5, "from": 1425.6, "to": 32695 }
      ]
    }
  ]
}
```

### Clip properties
- `atBeat`: The song beat where UST tick 0 lands. When `atBeat` is `null`, the clip is parked and silent.
- `from` and `to`: The trim bounds in UST ticks. Ticks start negative to preserve the lead-in consonant attack (`-leadSamples / samplesPerTick`).
- `block`: The label of the lyric section (the first line of the block), or empty for instrumental and choir tracks.

### Editing interactions
- **Move:** Drag a clip body horizontally. The clip moves independently of other clips in the lane.
- **Snapping:** Snaps to beats by default. Hold `Shift` for bar snapping. Hold `Alt` for free placement without snapping.
- **Magnetic clip snapping:** Dragging near any clip edge across all lanes snaps to that edge (marked with the `CLIP` guide).
- **The anchor rule:**
  - A clip containing tick 0 snaps by its tick 0 anchor. This keeps `atBeat` as an integer on the beat grid.
  - A chopped sub-clip starting after tick 0 snaps by its left cut boundary.
- **The razor tool:** Press `R` to toggle the razor tool. Hover over a placed clip to see a red cut preview line at the snapped position. Click to split the clip into two contiguous clips. Both halves keep their exact position without silence or audio gaps.

---

## 5. Stage 4: Multi-Singer Calibration Architecture

Single-stream calibration files (`lyrics.calibrated.json`) require non-overlapping, strictly increasing line intervals. Songs with concurrent vocals violate this rule.

### The singer manifest (`user_input/singers.json`)
Declare the singers in `user_input/singers.json`:

```json
{
  "v": 1,
  "singers": [
    { "id": "te", "voiceDir": "重音テト音声ライブラリー", "lead": true },
    { "id": "ca", "voiceDir": "CACTLOID VCV" },
    { "id": "ko", "voiceDir": "koronba_04c" }
  ]
}
```

### Storage rules
- Exactly one singer must have `lead: true`.
- The lead singer saves to `user_input/lyrics.calibrated.json`.
- Each secondary singer saves to `user_input/lyrics.calibrated.<id>.json`.
- The lead singer reads lyrics from `user_input/lyrics.txt`.
- Secondary singers read lyrics from `user_input/lyrics.<id>.txt`.

---

## 6. Stage 5: Syllabified Romaji and the ust.map.json Contract

Do not use automated aligners to map phonetic synthesizer notes to display lyrics. Hand-author the companion files with explicit validation.

### Display lyrics (`lyrics.txt`, `lyrics.<id>.txt`)
Format lyrics in syllabified romaji:
- Separate words with spaces.
- Separate syllables with pipes (`|`): `na|n|ne|n`.
- Join visual digraphs and diphthongs with plus signs (`+`): `na+n|ne+n`.

### The mapping contract (`user_input/ust.map.json`)
Map every lyric lane to the line indices of that singer's lyric file:

```json
{
  "v": 1,
  "sections": [
    { "name": "Intro", "bar": 1 },
    { "name": "Verse 1", "bar": 9 },
    { "name": "Chorus 1", "bar": 17 }
  ],
  "lanes": {
    "te_a_1#1": [
      {
        "line": 0,
        "notes": [
          ["な", "na"],
          ["ん", "n"],
          ["ね", "ne"],
          ["ん", "n"]
        ]
      }
    ]
  }
}
```

### Note mapping symbols
- `[ustKana, syllable]`: Assigns the note to the next syllable of the line.
- `[ustKana, "~"]`: Extends the duration of the previous syllable (held vowel or melisma).
- `[ustKana, "_"]`: Marks a non-lexical vocal sound (pickup vowel or breath).

### The D29 rule for shared notes
Synthesizers often lack dedicated notes for double consonants (small *tsu*, `っ`) or vowel closures. One note sings two morae:
- Syntax: `["ぎ", "gi", "t"]`
- Behavior: The note duration splits evenly across the target syllables.
- Calibration state: These split syllables export as `sylCalibrated: false`. They appear unpinned in the editor so human operators can calibrate the boundary by ear. All other syllables export as pinned (`sylCalibrated: true`).

---

## 7. Stage 6: Validation and Import

Run the import tool to build the calibration documents:

```bash
# 1. Validate every mapping without writing files
lyricsync import ust <song-dir> --dry

# 2. Write the calibrated lyric files
lyricsync import ust <song-dir>
```

### Validation checks
The importer checks that:
1. Every note kana matches the original synthesizer file.
2. Every syllable in the lyrics file appears in order without omission.
3. Every sung note in the synthesizer file appears in the mapping.
4. Every lyric line has exactly one mapping entry.

When all checks pass, the tool writes the calibration documents with syllable boundaries locked to the beat grid.

---

## 8. Stage 7: Note Event Extraction for Video Animation

Video renderers need note-level pitch and timing data to animate character mouth flaps, bouncing indicators, and reactive backgrounds.

Generate the complete note event database:

```bash
lyricsync notes <song-dir>
```

This writes `generated/notes.json`:

```json
{
  "v": 1,
  "notes": [
    {
      "lane": "te_0#1",
      "clip": "te_0#1/1",
      "ust": "te_0.ust",
      "singer": "te",
      "idx": 5,
      "kana": "し",
      "pitch": 62,
      "beat": 60.5,
      "start": 26.889,
      "end": 27.111
    }
  ]
}
```

This export includes all tracks (lead vocals, doubles, counter-lines, and wordless choir lanes). The video engine reads this file directly to trigger visual effects on exact musical events.

---

## 9. Stage 8: Review in the Editor

Start the development editor:

```bash
bun run dev --songs <path-to-projects>
```

1. Open the song project.
2. Use the **Singer Selector** in the Lyrics lane header to switch between singers (`te`, `ca`, `ko`).
3. The active singer displays editable syllables. Inactive singers display as faint reference rows underneath.
4. Review syllables marked unpinned (from the D29 shared-note rule). Nudge boundaries by ear where consonants require more or less time.
5. Press `Ctrl+S` to save all modified singer documents.

---

## 10. Human-Agent Collaborative Protocol

This workflow is not a standard or simple procedure. It addresses rare, highly complex songs (such as Koronba's UTAU works). In these tracks, producers combine dense synthesizer fragments, counter-melodies, and post-synthesis DAW cuts.

Standard songs are much simpler. For normal songs, neural vocal separation produces clean stems, and the automated solver completes alignment in one pass.

Because of this complexity, this workflow cannot fit into an automatic one-click wizard. It operates as a structured collaboration between a human operator and an automated AI agent.

### The core operational principle: audio first, lyrics second

Do not attempt to synchronize lyrics and audio at the same time. Doing both at once causes confusion and compounding errors.

Follow this strict sequence:
1. Complete all audio placement, clipping, and track syncing first.
2. Introduce the lyrics and note mappings only after the audio timeline is locked.

### Division of responsibilities

| Phase | Task | Performed by | Why |
|---|---|---|---|
| **Phase 1** | Voicebank setup, headless audio render, beat grid pins | **Agent** | Mechanical execution: running compiler tasks, extracting Shift_JIS archives, and computing lead-padded render manifests. |
| **Phase 2** | Audio placement, clip chopping, and block labelling | **Human** | Perceptual judgment: synthesizer clips lack global song timestamps and contain post-DAW cuts that require listening by ear. |
| **Phase 3** | Multi-singer schema, syllabification, and `ust.map.json` authoring | **Agent** | Semantic code synthesis: pairing hundreds of notes to lyrics syllables, validating order, and applying the D29 shared-note rules. |
| **Phase 4** | Import verification, calibration export, and note event extraction | **Agent** | Strict validation: executing mathematical integrity checks, writing calibration files, and emitting note databases. |
| **Phase 5** | Ear calibration of unpinned syllables and final review | **Human** | Perceptual refinement: listening to unpinned mora splits in the editor and nudging boundaries by ear. |

### Step-by-step collaboration procedure

#### Step 1: Agent scaffolds project and renders stems
The agent prepares the environment without requiring manual user commands:
1. Inspects the synthesizer project files, voicebanks, and master audio.
2. Extracts voicebanks with Shift_JIS filename decoding.
3. Renders all synthesizer files headlessly with `--lead-beats 4` padding.
4. Generates `generated/renders/index.json`.
5. Pins the nominal beat grid in `user_input/prompt.yaml` to eliminate tracker drift.
6. Launches the editor development server.

#### Step 2: Agent prompts human to sync audio by ear
The agent stops and prompts the human user to align the audio tracks in the editor. The human operator:
1. Opens the song in the web editor.
2. Drags each vocal lane onto the beat grid to match the master mix.
3. Uses the razor tool (`R`) to chop clips where the DAW producer split or rearranged phrases.
4. Enters the first lyric line (in romaji) into the `Lyric block` field for lanes that sing lyrics.
5. Leaves the `Lyric block` field empty for instrumental, choir, or backing fill lanes.
6. Saves the placement data (`Ctrl+S`, writing `user_input/placements.json`).
7. Informs the agent that audio synchronization is complete.

#### Step 3: Agent structures lyrics and writes mapping
Once the human locks the audio placement, the agent resumes work:
1. Reads `user_input/placements.json` to identify which lanes carry lyrics.
2. Defines `user_input/singers.json` (one lead singer and secondary singers).
3. Creates syllabified romaji files (`lyrics.txt`, `lyrics.<id>.txt`) matching the human's block order.
4. Authors `user_input/ust.map.json`. The agent maps every sung note to target syllables:
- Sets `~` for sustained vowel notes.
- Sets `_` for non-lexical filler vowels.
- Applies the D29 rule for shared notes: notes singing two morae (such as small *tsu* or long vowels) map to multiple target syllables.
- Sets musical section markers based on downbeat bars.

#### Step 4: Agent validates and imports calibration
The agent validates the data and writes the song assets:
1. Executes `lyricsync import ust <song-dir> --dry` to check that every note and syllable matches.
2. Executes `lyricsync import ust <song-dir>` to write `lyrics.calibrated.json` and all `lyrics.calibrated.<id>.json` files.
3. Executes `lyricsync notes <song-dir>` to export `generated/notes.json` for video engine reactivity.

#### Step 5: Human performs final ear calibration
The human operator returns to the editor for final inspection:
1. Selects each singer using the singer dropdown in the Lyrics lane header.
2. Observes the multi-singer karaoke stage (active singer large on top, secondary singers singing in real time below).
3. Locates unpinned syllables (generated by the D29 shared-note rule).
4. Listens to these syllables and nudges their boundaries by ear if necessary.
5. Saves the final calibration documents.
