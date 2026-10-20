# beatsync

Fast, robust beat and downbeat tracking for music audio using the **Beat This!** RoFormer model running locally via ONNX Runtime.

## Features

- **Local Inference**: Bundles the CPJKU Beat This! RoFormer ONNX model (~79 MB) and precomputed Slaney Mel filterbank (`mel_fb_513x128.bin`). No Python runtime, external API, or cloud service needed.
- **Accurate Rhythmic Tracking**: Extracts framewise beat and downbeat probabilities at 50 fps (20 ms resolution) and regularizes them with Viterbi Dynamic Programming tempo priors to prevent octave-jumps and skipped syncopations.
- **Dual Support**: Works out of the box in both Node.js (>=20) and Bun.
- **Flexible Audio Loading**: Directly parses 16/24/32-bit PCM integer and 32-bit float WAV files with built-in mono downmixing and polyphase resampling; every other audio format is decoded through `ffmpeg`, which must then be installed (a clear error otherwise).

## Installation

```bash
npm install beatsync
```

## CLI Usage

```bash
# --bpm is required: the song's approximate tempo
beatsync song.wav --bpm 120

# With a first downbeat hint
beatsync song.wav --bpm 120 --first-downbeat 0.32

# Output machine-readable JSON to stdout
beatsync song.wav --bpm 120 --json

# Output to JSON file
beatsync song.wav --bpm 120 --out timing.json
```

### CLI JSON Contract

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

## Programmatic API

```typescript
import {
  trackBeats,
  BeatTracker,
  parseWav,
  loadAudioFile,
  postprocessBeats,
  type BeatAnalysis,
} from 'beatsync';

// 1. One-shot tracking from audio path
const analysis: BeatAnalysis = await trackBeats('song.wav', {
  targetBpm: 120,
  firstDownbeat: 0.32,
});

console.log(analysis.bpm);         // e.g. 120.0
console.log(analysis.beatPeriod);  // e.g. 0.50000
console.log(analysis.beats);       // number[] in seconds
console.log(analysis.downbeats);   // number[] in seconds
console.log(analysis.durationSec); // Audio duration in seconds

// 2. From in-memory PCM audio
const analysisFromPcm = await trackBeats({
  samples: myFloat32Array,
  sampleRate: 44100,
  channels: 2,
}, { targetBpm: 120 });

// 3. Stateful BeatTracker class
const tracker = new BeatTracker({
  targetBpm: 120,
  device: 'gpu', // 'gpu' (default; DirectML on Windows, CPU where no GPU provider exists) | 'cpu'
});
await tracker.init();
const result = await tracker.trackFile('song.wav', 0.32);
```

## Model Details

- **Model**: Beat This! (RoFormer architecture for music beat and downbeat tracking) developed by CPJKU.
- **Format**: ONNX Runtime model export (`beat_this.onnx`, ~79 MB) with Slaney 128-bin log-mel filterbank (`mel_fb_513x128.bin`).
- **Location**: the models ship inside the package (`models/` next to `dist/`) and are resolved relative to the package root. There is no download step, environment variable or model-path option.
- **Source**: weights are the published Beat This! checkpoint converted to ONNX; see the upstream project for the model card and its license terms before redistributing.

## Parameters

- `--bpm` / `targetBpm` (required): the song's approximate tempo. It is a tight prior: beat spacing is confined to about +/-12% of it, so a wrong value yields wrong beats. There is deliberately no default.
- `--first-downbeat` / `firstDownbeat` (optional): seconds; aligns downbeat phase to the beat nearest this time. Beat times are unchanged.
- `--device` / `device` (optional): `gpu` (default) or `cpu`. `gpu` uses the GPU provider of the platform's onnxruntime-node build (DirectML on Windows; CUDA where the build has it) and runs on the CPU where there is none. Beat and downbeat times are the same on both (checked on a 194 s song).

## Verified behaviour

Against the reference implementation this package was extracted from, beat and downbeat counts are identical on three full songs (648, 357 and 457 beats) and every beat agrees within one tracker frame (20 ms); 2-5% of beats sit exactly one frame away. The difference is deliberate: WAV input is always decoded and resampled natively, so results never depend on which tools are installed (the reference resampled through ffmpeg when it happened to be present). Non-WAV input requires `ffmpeg` and fails with its own error message otherwise. Run the tests:

```bash
bun test tests/unit     # WAV parsing, resample, spectrogram, postprocess
bun test tests/e2e      # real-model inference on a synthesized 120 BPM click track
```
