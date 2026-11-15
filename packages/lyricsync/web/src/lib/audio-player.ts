// packages/lyricsync/web/src/lib/audio-player.ts
// WebAudio mixer (playback of the mix, the vocal stem and the vocal lanes together, sample-exact) and waveform peak extraction.
// The transport runs on AudioContext.currentTime. Every track is an AudioBuffer with a list of clips: a clip plays `duration` seconds
// of the buffer from `offset`, starting at song time `start` (may be negative). Play schedules one source per clip from one common
// context time, so their offsets stay exact. The mix and the vocal stem are one clip of their whole buffer at song time 0.
export interface AudioPlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
}

export interface TrackMix {
  gain: number;
  mute: boolean;
  solo: boolean;
}

export const UNITY_MIX: TrackMix = { gain: 1, mute: false, solo: false };

/** One piece of a track's buffer on the song timeline. */
export interface TrackClip {
  id: string;
  /** Song time where the clip starts. */
  start: number;
  /** Seconds into the buffer of the clip's first sample. */
  offset: number;
  /** Clip length in seconds. */
  duration: number;
}

/**
 * The tracks of `ids` that sound: not muted, and soloed when any of them is soloed. `ids` lists only tracks that can play (a lane
 * without a placed clip is left out, so its solo does not silence the others).
 */
export function audibleTracks(mixes: Record<string, TrackMix>, ids: readonly string[]): Set<string> {
  const m = (id: string) => mixes[id] ?? UNITY_MIX;
  const anySolo = ids.some((id) => m(id).solo && !m(id).mute);
  return new Set(ids.filter((id) => !m(id).mute && (!anySolo || m(id).solo)));
}

/**
 * A scheduled source, for tests: song time = `songAt + (contextTime - when0)`. The buffer of track `id` plays from `offset` for
 * `duration` seconds from context time `when`; clip `clip` starts at song time `start` and plays the buffer from `clipOffset`.
 */
export interface ScheduledSource {
  id: string;
  clip: string;
  start: number;
  clipOffset: number;
  when: number;
  offset: number;
  duration: number;
  when0: number;
  songAt: number;
  sampleRate: number;
}

interface Track {
  buffer: AudioBuffer;
  /** The placed clips (a parked clip is not listed: it never plays). */
  clips: TrackClip[];
  /** Counts toward the song duration (the mix and the vocal stem). */
  main: boolean;
  gain: GainNode;
  sources: { node: AudioBufferSourceNode; scheduled: ScheduledSource }[];
}

/** Scheduling lead: sources start this far ahead of "now", so every track of one play starts in step. */
const START_LEAD_S = 0.03;

const sameClips = (a: readonly TrackClip[], b: readonly TrackClip[]): boolean =>
  a.length === b.length && a.every((c, i) => c.id === b[i]!.id && c.start === b[i]!.start && c.offset === b[i]!.offset && c.duration === b[i]!.duration);

/** The whole buffer as one clip at song time 0 (the mix and the vocal stem). */
export const wholeBuffer = (id: string, buffer: AudioBuffer): TrackClip[] => [{ id, start: 0, offset: 0, duration: buffer.duration }];

export class AudioPlayer {
  readonly ctx = new AudioContext();
  private master = this.ctx.createGain();
  private tracks = new Map<string, Track>();
  private mixes: Record<string, TrackMix> = {};
  private onStateChange: (state: AudioPlayerState) => void;
  private animFrameId = 0;
  private playing = false;
  /** Song time at context time `when0` while playing; the paused position otherwise. */
  private songAt = 0;
  private when0 = 0;

  constructor(onStateChange: (state: AudioPlayerState) => void) {
    this.onStateChange = onStateChange;
    this.master.connect(this.ctx.destination);
  }

  /** Decodes audio bytes with this context (resampled to its rate). */
  decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(bytes.slice(0));
  }

  /** Adds or replaces a track with its placed clips. */
  setTrack(id: string, buffer: AudioBuffer, clips: TrackClip[], main = false) {
    this.removeTrack(id);
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    this.tracks.set(id, { buffer, clips, main, gain, sources: [] });
    this.applyGains();
    if (this.playing) this.schedule(id);
    this.notify();
  }

  removeTrack(id: string) {
    const t = this.tracks.get(id);
    if (!t) return;
    this.stopSources(t);
    t.gain.disconnect();
    this.tracks.delete(id);
    this.applyGains();
  }

  /** Removes every track (a new song opens). */
  clear() {
    this.pause();
    for (const id of [...this.tracks.keys()]) this.removeTrack(id);
    this.songAt = 0;
    this.notify();
  }

  hasTrack(id: string): boolean {
    return this.tracks.has(id);
  }

  trackIds(): string[] {
    return [...this.tracks.keys()];
  }

  /** The placed clips of track `id` as the mixer plays them. */
  clips(id: string): readonly TrackClip[] {
    return this.tracks.get(id)?.clips ?? [];
  }

  /** Sets the placed clips of a track; a playing track restarts at once with the new clips. */
  setClips(id: string, clips: TrackClip[]) {
    const t = this.tracks.get(id);
    if (!t || sameClips(t.clips, clips)) return;
    t.clips = clips;
    this.applyGains();
    if (this.playing) this.schedule(id);
  }

  /** Gain, mute and solo by track id; a track not listed plays at unity. */
  setMix(mixes: Record<string, TrackMix>) {
    this.mixes = mixes;
    this.applyGains();
  }

  private applyGains() {
    const audible = audibleTracks(this.mixes, [...this.tracks].flatMap(([id, t]) => (t.clips.length === 0 ? [] : [id])));
    for (const [id, t] of this.tracks) t.gain.gain.value = audible.has(id) ? (this.mixes[id] ?? UNITY_MIX).gain : 0;
  }

  play() {
    if (this.playing) return;
    void this.ctx.resume();
    if (this.songAt >= this.getDuration()) this.songAt = 0;
    this.playing = true;
    this.when0 = this.ctx.currentTime + START_LEAD_S;
    for (const id of this.tracks.keys()) this.schedule(id);
    this.startTick();
  }

  pause() {
    if (!this.playing) return;
    this.songAt = this.getCurrentTime();
    this.playing = false;
    for (const t of this.tracks.values()) this.stopSources(t);
    this.stopTick();
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(timeSec: number) {
    const target = Math.max(0, Math.min(this.getDuration() || Infinity, timeSec));
    if (this.playing) {
      for (const t of this.tracks.values()) this.stopSources(t);
      this.songAt = target;
      this.when0 = this.ctx.currentTime + START_LEAD_S;
      for (const id of this.tracks.keys()) this.schedule(id);
    } else this.songAt = target;
    this.notify();
  }

  getCurrentTime(): number {
    if (!this.playing) return this.songAt;
    return Math.max(this.songAt, this.songAt + (this.ctx.currentTime - this.when0));
  }

  /** The longest of the mix and the vocal stem. */
  getDuration(): number {
    let d = 0;
    for (const t of this.tracks.values()) if (t.main) for (const c of t.clips) d = Math.max(d, c.start + c.duration);
    return d;
  }

  /** The sources that play now (tests check the clip offsets with it). */
  scheduled(): ScheduledSource[] {
    return [...this.tracks.values()].flatMap((t) => t.sources.map((s) => s.scheduled));
  }

  /** Starts the clips of track `id` in step with the transport (each from the right sample, also mid-clip), if it plays at all. */
  private schedule(id: string) {
    const t = this.tracks.get(id);
    if (!t) return;
    this.stopSources(t);
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    for (const c of t.clips) {
      // Song time `songAt` is at context time `when0`; the clip starts at song time `c.start`.
      const into = this.songAt - c.start;
      let when = this.when0;
      let skip = into;
      if (into < 0) {
        when = this.when0 - into;
        skip = 0;
      }
      // A move while playing: the part that should already sound starts now, from the matching sample.
      if (when < now) {
        skip += now - when;
        when = now;
      }
      const duration = Math.min(c.duration, t.buffer.duration - c.offset) - skip;
      if (duration <= 0) continue;
      // Tick-to-second rounding can put a clip at the very first sample a hair below 0 s; WebAudio rejects a negative offset.
      const offset = Math.max(0, c.offset + skip);
      const node = this.ctx.createBufferSource();
      node.buffer = t.buffer;
      node.connect(t.gain);
      node.start(when, offset, duration);
      t.sources.push({
        node,
        scheduled: { id, clip: c.id, start: c.start, clipOffset: c.offset, when, offset, duration, when0: this.when0, songAt: this.songAt, sampleRate: this.ctx.sampleRate },
      });
    }
  }

  private stopSources(t: Track) {
    for (const { node } of t.sources) {
      node.onended = null;
      try {
        node.stop();
      } catch {}
      node.disconnect();
    }
    t.sources = [];
  }

  private notify() {
    this.onStateChange({ isPlaying: this.playing, currentTime: this.getCurrentTime(), duration: this.getDuration() });
  }

  private startTick() {
    cancelAnimationFrame(this.animFrameId);
    const tick = () => {
      if (this.playing && this.getCurrentTime() >= this.getDuration()) {
        this.pause();
        this.songAt = this.getDuration();
      }
      this.notify();
      if (this.playing) this.animFrameId = requestAnimationFrame(tick);
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  private stopTick() {
    cancelAnimationFrame(this.animFrameId);
    this.notify();
  }

  dispose() {
    this.clear();
    cancelAnimationFrame(this.animFrameId);
    void this.ctx.close();
  }
}

/** Peak-normalized absolute peaks of a decoded buffer at `peaksPerSec`. */
export function bufferPeaks(audioBuf: AudioBuffer, peaksPerSec = 200): Float32Array {
  const numChannels = audioBuf.numberOfChannels;
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(audioBuf.getChannelData(c));
  const totalPeaks = Math.ceil(audioBuf.duration * peaksPerSec);
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
  return peaks;
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
  return { peaks: bufferPeaks(audioBuf, peaksPerSec), durationSec: audioBuf.duration };
}
