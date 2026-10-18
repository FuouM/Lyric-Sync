# The training-free method

`lyricsync solve <ws> --method analytic` (library: `session.solve({ method: 'analytic' })`, or `solveAnalytic` on in-memory evidence) times the lyrics without any learned weights. It starts from the same place as the `trained` method: the same `prepare` evidence, the same pins, the same consensus lines and the same candidate boundaries. Only the scoring of those candidates differs: an explicit model instead of about 3,500 learned weights. Nothing in it changes when you add annotated songs; the `trained` method is the one that learns from them.

Use it when you do not want a trained artifact in the loop, to get a baseline that you can read and reason about, or as a yardstick for the trained weights as you add songs.

## The model

A line's interior boundaries form one monotone chain of candidate times. The score of a chain is the sum of a **candidate score** for every boundary and a **pair score** for every syllable between two neighbouring boundaries. Pinned boundaries have a single candidate.

Candidate score (all constants are in `ANALYTIC_DESIGN`, `src/engine/analytic.ts`):

| Evidence | Contribution |
|---|---|
| Consensus estimate | minus 0.5 per sixteenth note of distance, capped at 3 sixteenths |
| Forced-aligner boundaries (each raw set) | 0.5 times an exponential kernel (15 ms) |
| Pitch-note onsets (RMVPE, HarmoF0, Swift-F0) | 1 each (offsets 0.5), kernel 15 ms, after correcting each tracker's latency (RMVPE onsets are about 12 ms late, HarmoF0 about 15 ms early relative to where annotators put the boundary) |
| Phoneme-boundary peaks (both HuBERT models) | 2.5 times the best peak's probability times a kernel (30 ms) |
| On a beat | 3 times a kernel (4 ms) |
| Energy rise across the boundary | 0.3 times the clipped log ratio |
| Previous syllable's phones fade / next one's rise | 0.5 each |

**Beat snapping.** The lyrics editor snaps a dragged boundary to a beat when it lands within 25 ms of it (`LyricsTimingEditor.findSnapTarget`), so about half of the annotated boundaries sit exactly on a beat. For a candidate on a beat, evidence within 25 ms of it counts as if it were at the beat.

Pair score (a syllable from candidate `a` to candidate `b`, duration `d`):

- minus 0.2 times the log ratio of `d` to the consensus duration, and minus 1.5 times the log ratio to the line's mean syllable duration;
- minus 2 times the distance of `d` (in sixteenths) to a whole number of sixteenths;
- minus 2 times the log shortfall of `d` below 120 ms;
- plus 2 times the mean posterior of the syllable's nucleus phone inside the syllable, minus 1 times the mean silence posterior;
- minus 1 per RMVPE or HarmoF0 note onset, 0.5 per Swift-F0 onset and 0.25 per strong phoneme-boundary peak that falls strictly inside the syllable (at most 3 of each). A syllable should not swallow notes that nothing explains.

Decoding is minimum-Bayes-risk, exactly as in the trained method: node posteriors of the chain at temperature 1, then the path with the least expected absolute error. The same posteriors give the `review` ranking (`expectedErrorMs`).

## How the constants were chosen

By hand, reading measurements on the three sample songs, not by an optimiser. What each measurement showed:

- Labels are on a beat 34 to 64 percent of the time (within 3 ms), and a boundary is within 25 ms of a beat in a large share of the rest. That is where the beat bonus and the snap window come from.
- Labelled syllable starts sit 10 to 20 ms before RMVPE onsets and 0 to 20 ms after HarmoF0 onsets (medians per song and onset class); the two latency constants, 12 and 15 ms, are round values inside those ranges.
- Phoneme-boundary peaks are the strongest single evidence once the kernel is wide enough to cover label jitter; forced-aligner boundaries tend to place singing boundaries early, so they get a low weight.
- A syllable that contains unexplained pitch-note onsets is usually wrong: the inside-onset penalty alone cut the anchored error from about 50 to 38 ms before the remaining constants were set.

Several constants were swept over a handful of values (by hand, one at a time) while watching the error. The three sample songs were used for this, so the numbers below are **design-time numbers, not held-out ones**. With more annotated songs, hold some out when you change a constant.

## Accuracy

Syllable-boundary error against hand-annotated timings (mean of start and end error, ms), the same three songs as the main table.

| Mode | Analytic | Trained, held-out | Trained, in-sample |
|---|---|---|---|
| Free | 38.4 (36.5 / 39.0 / 39.6) | 33.3 | 23.6 |
| Anchored (line start and end pinned) | 26.5 (26.2 / 26.4 / 26.8) | 22.9 | 14.2 |

The trained method is better in both modes, by about 5 ms (free) and 4 ms (anchored) against its held-out numbers. The analytic method is also 10 to 25 times faster per song after `prepare` (0.3 to 0.5 s against 5 to 11 s), because it never builds the thousands of per-candidate features the linear model needs.

Where its error is left: the end of a line in free mode (the consensus is 100 ms off on average and no voicing or energy rule beat it: the voiced run overshoots the labelled end by 470 ms on average), and syllable boundaries inside a word, where no evidence source separates the right note onset from its neighbours.

## Reproduce

```bash
bun src/cli.ts solve <ws> --method analytic --out analytic.json
bun scripts/lyricsync_eval.ts analytic.json <calibrated.json> [--skip-lines 37]   # from the repository root
```
