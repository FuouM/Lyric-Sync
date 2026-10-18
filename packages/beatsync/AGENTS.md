# AGENTS.md

# Agent Guidance: `beatsync`

This document provides quick reference instructions for automated agents interacting with `beatsync`.

## Purpose
`beatsync` performs end-to-end beat and downbeat tracking from audio files or in-memory PCM buffers using the Beat This! RoFormer ONNX model.

## CLI Usage

### Run Beat Tracking on an Audio File
```bash
# --bpm is required: the song's approximate tempo (a wrong value yields wrong beats)
beatsync path/to/audio.wav --bpm 120

# With a first downbeat alignment hint
beatsync path/to/audio.wav --bpm 120 --first-downbeat 0.32

# Output machine-readable JSON to stdout
beatsync path/to/audio.wav --bpm 120 --json

# Save JSON directly to disk
beatsync path/to/audio.wav --bpm 120 --out timing.json
```

### JSON Output Contract
When executed with `--json` or written with `--out`, the JSON contract is:
```json
{
  "v": 1,
  "model": "beat_this",
  "duration": 194.261,
  "bpm": 200.0,
  "beat_period": 0.30000,
  "beats": [0.000, 0.320, 0.620, 0.920, 1.220],
  "downbeats": [0.320, 1.500, 2.700, 3.920, 5.120]
}
```
All timestamps are in seconds and rounded to 3 decimal places.

## Programmatic API Usage

```typescript
import { trackBeats, BeatTracker } from 'beatsync';

// 1. Convenience one-shot function from audio file path
const analysis = await trackBeats('path/to/audio.wav', {
  targetBpm: 120,       // Required: the song's approximate tempo; beats are confined to about +/-12% of it
  firstDownbeat: 0.32,   // Optional: seconds; aligns downbeat phase to the beat nearest this time
});

console.log(analysis.bpm);         // e.g. 120.0
console.log(analysis.beatPeriod);  // e.g. 0.50000
console.log(analysis.beats);       // number[] of beat timestamps in seconds
console.log(analysis.downbeats);   // number[] of downbeat timestamps in seconds

// 2. From in-memory PCM audio (Float32Array)
const analysisFromPcm = await trackBeats({
  samples: myFloat32Array,
  sampleRate: 44100,
  channels: 2,
}, { targetBpm: 120 });

// 3. Stateful reusable class instance
const tracker = new BeatTracker({
  targetBpm: 120,
  executionProvider: 'cpu', // 'cpu' | 'cuda' | 'webgpu'
});
await tracker.init();
const result = await tracker.trackFile('path/to/audio.wav', 0.32);
```

## Running Tests
```bash
bun test tests/unit     # Fast unit tests (WAV parsing, resample, mono mix, spectrogram, postprocess)
bun test tests/e2e      # E2E inference test on a synthesized click track
```
