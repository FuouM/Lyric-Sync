# The simple solver (`--method simple`)

The smallest training-free solver that is still competitive. It was built by starting from a plain vote count and adding one rule at a time, keeping a rule only when the error against the calibrated labels went down. Nothing is fitted: every constant in `SIMPLE_DESIGN` (`src/engine/simple.ts`) is a hand-set design value.

## The model

A line's interior boundaries are one chain of candidate times (the candidates the other solvers use). The chain with the highest total score wins (Viterbi), then boundaries close to a beat are snapped onto it.

**Per candidate**, one vote for every independent source that has an event within 35 ms:

| Source | Votes | Note |
|---|---|---|
| Phoneme-boundary peaks (base model, probability 0.4 or more) | 3 | the best single source |
| RMVPE note starts | 1 | shifted by -12 ms (the tracker reports late) |
| HarmoF0 note starts | 1 | shifted by +15 ms (reports early) |
| Swift note starts | 1 | |
| Beat | 1 | |
| Eighth-note grid | 1 (15 ms window) | shifted by the song's own measured lag, see below |
| Each forced-aligner boundary | 0.5 | covers fewer than half the labels and runs early |

minus 0.3 per sixteenth note of distance from the consensus estimate (at most 3 sixteenths). The consensus gets no vote of its own, only this weak pull.

**Per syllable** (pair of neighbouring boundaries):

- minus 1.5 x \|log(duration / the line's mean syllable duration)\|
- minus 2 per sixteenth note that the duration is off a whole number of sixteenths
- minus 1 per RMVPE or HarmoF0 note start inside the syllable (more than 30 ms from both edges, at most 3): a note the syllable does not explain
- plus 12 x the mean posterior of the syllable's own vowel inside it, minus 1 x that of silence

**After decoding**, every boundary within 60 ms of a beat moves onto the candidate that sits on the beat (if both neighbouring syllables stay long enough). A line's first and last boundary count too; pinned boundaries have a single candidate and never move. The annotation tool snaps a dragged boundary within 25 ms of a beat; decoded boundaries are less exact than a dragged one, so the window is wider (50 to 100 ms measure the same, beyond that it gets worse).

**Line ends** (no effect when the end is pinned): labelled lines tile, and 80% of the labelled gaps between a line's end and the next line's start are exactly zero. A line end less than 0.4 s before the next line's start is moved onto that start. A line's first and last boundary also get the same evidence votes as interior ones (their distance from the consensus keeps full weight and no cap).

**The eighth-grid lag** is measured per song without labels: the median signed distance, over off-beat positions where an RMVPE start and a HarmoF0 start agree within 40 ms, to the nearest midpoint between beats. Singers attack a little before the grid; the lag is a property of the performance.

## Accuracy

Mean syllable-edge error against the calibrated labels, in ms (`bun scripts/lyricsync_bench.ts`, about 2 s). **These are in-sample**: the constants were set by hand while looking at these three songs. Anchored means the line start and end are pinned to the labels; free means no anchors.

| | breaked | breaked_retro | suika_retro | mean |
|---|---|---|---|---|
| Anchored | 22.8 | 21.8 | 24.5 | **23.1** |
| Free | 29.3 | 28.9 | 34.2 | **30.8** |

For reference, the trained method's held-out numbers are 22.9 anchored and 33.3 free, and `--method analytic` gives 26.5 and 38.4. A held-out figure for this method needs more annotated songs than three.

## How it was built

Each row is one kept step; anchored / free mean error in ms.

| Step | Anchored | Free |
|---|---|---|
| Vote count within 35 ms, consensus distance, duration regularity, Viterbi | 42.7 | 51.0 |
| + penalty for unexplained note starts inside a syllable | 36.2 | 44.5 |
| + phoneme-boundary votes count 3 | 32.3 | 43.5 |
| + forced-aligner votes count 0.5 | 30.1 | 42.3 |
| + sixteenth-phase term | 29.3 | 43.7 |
| + eighth-grid vote with the song's measured lag | 28.4 | 42.6 |
| + vowel and silence posteriors | 28.2 | 40.1 |
| + snap onto beats after decoding | 24.5 | 36.7 |
| - remove the consensus vote | 23.1 | 34.2 |
| + join a line end to the next start within 0.4 s (free mode only) | 23.1 | 32.6 |
| + evidence votes on a line's first and last boundary (free mode only) | 23.1 | 31.2 |
| + beat snap on a line's first and last boundary (free mode only) | 23.1 | 30.8 |

## What did not help

Each of these was tried against the labels and left out:

- soft (triangular) instead of hard vote windows
- a second phoneme-boundary model as an extra voter
- note-end votes from the pitch trackers
- a short-syllable penalty
- the odd-sixteenth grid as a voter, and snapping onto the eighth grid after decoding
- gating the beat vote by other evidence, and a snap that depends on the candidate's score
- an exact second-order decode with a "neighbouring syllables last alike" term (neighbours often differ in length)
- deciding word boundaries first and syllables inside them (it halves the accuracy on Japanese, where words have many moras)
- votes for a time one consonant-length before a pitch onset
- the same vote window or aligner weight for boundaries inside a word versus between words (the optimum is exactly "equal")
- extra votes for a very tight (8 to 20 ms) coincidence of events
- minimum-expected-error decoding over the chain posteriors instead of the best chain (the vote sums are not calibrated probabilities)
- note-end votes at a line's last boundary, and placing the shared boundary of two joined lines between this line's end and the next start (the next line's start is the reliable side)

## Are the constants fitted to one song?

The constants were set by hand on these three songs, so the question is whether one song drives any of them. Anchored error per song (breaked / breaked_retro / suika_retro) with one constant changed at a time:

| Constant | Value | breaked | breaked_retro | suika_retro |
|---|---|---|---|---|
| RMVPE lag | -30 ms | 26.4 | 23.3 | 26.0 |
| | -20 ms | 21.5 | 22.9 | 24.8 |
| | **-12 ms** | **22.8** | **21.8** | **24.6** |
| | 0 | 30.2 | 25.4 | 28.9 |
| HarmoF0 lag | 5 ms | 24.7 | 23.6 | 26.1 |
| | **15 ms** | **22.8** | **21.8** | **24.6** |
| | 25 ms | 23.6 | 25.0 | 27.6 |
| Beat snap window | 35 / 50 / **60** / 85 ms | 22.9 / 22.7 / **22.8** / 22.6 | 21.9 / 21.8 / **21.8** / 22.0 | 25.2 / 24.9 / **24.6** / 24.1 |
| Vote window | 30 / **35** / 40 / 45 ms | 28.1 / **22.8** / 22.6 / 22.2 | 22.5 / **21.8** / 21.8 / 22.6 | 24.6 / **24.6** / 25.8 / 25.0 |
| Vowel weight | 6 / **12** / 24 | 24.7 / **22.8** / 23.0 | 22.2 / **21.8** / 22.0 | 25.1 / **24.6** / 25.6 |

All three songs prefer the same region for every constant, so none of the values is a one-song accident. That says the constants are not fitted to a single song; it is not a held-out result, which still needs songs the constants were never set on.

## Where the error is left

Boundaries the label puts exactly on a beat average 13.5 ms of error; the rest average 35 ms, with 20% over 50 ms. In 64 off-beat boundaries that the solver puts onto a beat by mistake, the pitch trackers do show a note start on that beat, and the label is a median 75 ms earlier (72% of them are syllables that open with a consonant, against 62% of all syllables). A rule that favours a phoneme-boundary peak in front of a pitch onset made things worse, because that pattern is every consonant. In free mode a line's first and last boundary are still the weakest: 43 ms and 61 ms mean error (median 10 ms for both, 15% and 24% over 100 ms), against 27 ms for interior boundaries. Before the line-end rules they were 53 ms and 104 ms.
