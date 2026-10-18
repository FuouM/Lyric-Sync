// packages/lyricsync/web/src/lib/audio-player.ts
// Audio playback and waveform peak extraction helper.
export interface AudioPlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
}

export class AudioPlayer {
  private audioEl: HTMLAudioElement;
  private onStateChange: (state: AudioPlayerState) => void;
  private animFrameId = 0;

  constructor(onStateChange: (state: AudioPlayerState) => void) {
    this.audioEl = new Audio();
    this.onStateChange = onStateChange;

    this.audioEl.addEventListener("play", () => this.startTick());
    this.audioEl.addEventListener("pause", () => this.stopTick());
    this.audioEl.addEventListener("ended", () => this.stopTick());
    this.audioEl.addEventListener("loadedmetadata", () => {
      this.notify();
    });
  }

  loadSource(url: string) {
    this.audioEl.src = url;
    this.audioEl.load();
  }

  play() {
    this.audioEl.play().catch(() => {});
  }

  pause() {
    this.audioEl.pause();
  }

  togglePlay() {
    if (this.audioEl.paused) this.play();
    else this.pause();
  }

  seek(timeSec: number) {
    this.audioEl.currentTime = Math.max(0, Math.min(this.audioEl.duration || Infinity, timeSec));
    this.notify();
  }

  getCurrentTime(): number {
    return this.audioEl.currentTime;
  }

  getDuration(): number {
    return this.audioEl.duration || 0;
  }

  private notify() {
    this.onStateChange({
      isPlaying: !this.audioEl.paused,
      currentTime: this.audioEl.currentTime,
      duration: this.audioEl.duration || 0,
    });
  }

  private startTick() {
    const tick = () => {
      this.notify();
      if (!this.audioEl.paused) {
        this.animFrameId = requestAnimationFrame(tick);
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  private stopTick() {
    cancelAnimationFrame(this.animFrameId);
    this.notify();
  }

  dispose() {
    this.pause();
    cancelAnimationFrame(this.animFrameId);
    this.audioEl.src = "";
  }
}

/**
 * Decodes audio and returns peak-normalized absolute peaks at `peaksPerSec`.
 */
export async function extractPeaks(
  audioBytes: ArrayBuffer,
  peaksPerSec = 200
): Promise<{ peaks: Float32Array; durationSec: number }> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audioBuf = await ctx.decodeAudioData(audioBytes.slice(0));
  const numChannels = audioBuf.numberOfChannels;
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(audioBuf.getChannelData(c));
  const durationSec = audioBuf.duration;

  const totalPeaks = Math.ceil(durationSec * peaksPerSec);
  const peaks = new Float32Array(totalPeaks);
  const sr = audioBuf.sampleRate;
  const totalSamples = audioBuf.length;

  let globalMax = 0;
  for (let i = 0; i < totalPeaks; i++) {
    const start = Math.floor((i * sr) / peaksPerSec);
    const end = Math.min(totalSamples, Math.floor(((i + 1) * sr) / peaksPerSec));
    let max = 0;
    for (let c = 0; c < numChannels; c++) {
      const ch = channels[c]!;
      for (let s = start; s < end; s++) {
        const v = Math.abs(ch[s]!);
        if (v > max) max = v;
      }
    }
    peaks[i] = max;
    if (max > globalMax) globalMax = max;
  }
  // Peak normalize to [0..1]
  if (globalMax > 1e-5) {
    for (let i = 0; i < totalPeaks; i++) {
      peaks[i] /= globalMax;
    }
  }

  return { peaks, durationSec };
}
