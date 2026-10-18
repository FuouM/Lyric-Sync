// packages/lyricsync/web/src/components/TransportBar.tsx
// DAW transport: playback controls, timecode + bar/beat counter, monitor source, snap/click/follow, zoom, save and solve.
import { Show } from "solid-js";
import { formatTimecode } from "../lib/doc-edit";
import type { MonitorTrack } from "./TimelineCanvas";

export interface TransportBarProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  barBeat: { bar: number; beat: number } | null;
  bpm: number | null;
  /** Time of bar 1 of the beat grid, or null without a grid. */
  bar1Time: number | null;
  onSetBar1: () => void;
  onPlayPause: () => void;
  onToStart: () => void;
  onPrevLine: () => void;
  onNextLine: () => void;
  monitor: MonitorTrack;
  hasMix: boolean;
  hasVocal: boolean;
  onMonitor: (t: MonitorTrack) => void;
  snap: boolean;
  onSnap: () => void;
  metronome: boolean;
  onMetronome: () => void;
  follow: boolean;
  onFollow: () => void;
  onZoom: (factor: number) => void;
  onZoomFit: () => void;
  dirty: boolean;
  canSave: boolean;
  onSave: () => void;
  solving: boolean;
  canSolve: boolean;
  onSolve: () => void;
  /** Words whose syllables differ from the analysed ones; with `stale` evidence, a re-analysis is needed before auto-timing. */
  resplitWords: number;
  analysisStale: boolean;
  analysing: boolean;
  onReanalyze: () => void;
}

export function TransportBar(props: TransportBarProps) {
  return (
    <div class="daw-transport">
      <div class="daw-transport-group">
        <button class="daw-tbtn" title="Go to start (Home)" onClick={() => props.onToStart()}>
          <i class="bi bi-skip-start-fill" />
        </button>
        <button class="daw-tbtn" title="Previous line" onClick={() => props.onPrevLine()}>
          <i class="bi bi-rewind-fill" />
        </button>
        <button class="daw-tbtn daw-tbtn-play" classList={{ "daw-on": props.isPlaying }} title="Play / pause (Space)" onClick={() => props.onPlayPause()}>
          <i class={`bi bi-${props.isPlaying ? "pause-fill" : "play-fill"}`} />
        </button>
        <button class="daw-tbtn" title="Next line" onClick={() => props.onNextLine()}>
          <i class="bi bi-fast-forward-fill" />
        </button>
      </div>

      <div class="daw-lcd" title="Position">
        <div class="daw-lcd-main">{formatTimecode(props.currentTime)}</div>
        <div class="daw-lcd-sub">
          <span>{props.barBeat ? `${props.barBeat.bar}.${props.barBeat.beat}` : "—.—"}</span>
          <span>{props.bpm ? `${props.bpm.toFixed(1)} BPM` : "— BPM"}</span>
          <span>/ {formatTimecode(props.duration)}</span>
        </div>
      </div>

      <div class="daw-transport-group daw-bar1" title="Bar 1 of the beat grid (beat 1 of the first full bar)">
        <span class="daw-bar1-label">
          <i class="bi bi-flag-fill" /> BAR 1
        </span>
        <span class="daw-bar1-time">{props.bar1Time === null ? "—" : formatTimecode(props.bar1Time)}</span>
        <button class="daw-btn daw-btn-sm" disabled={props.bar1Time === null} title="Make the beat nearest the playhead bar 1 (B)" onClick={() => props.onSetBar1()}>
          Set here (B)
        </button>
      </div>

      <div class="daw-transport-group daw-seg" title="Which audio you hear">
        <button class="daw-seg-btn" classList={{ "daw-on": props.monitor === "vocal" }} disabled={!props.hasVocal} onClick={() => props.onMonitor("vocal")}>
          <i class="bi bi-mic-fill" /> Vocal
        </button>
        <button class="daw-seg-btn" classList={{ "daw-on": props.monitor === "mix" }} disabled={!props.hasMix} onClick={() => props.onMonitor("mix")}>
          <i class="bi bi-music-note-beamed" /> Mix
        </button>
      </div>

      <div class="daw-transport-group">
        <button class="daw-toggle" classList={{ "daw-on": props.snap }} title="Snap edges to beats, bars, syllables and playhead (S)" onClick={() => props.onSnap()}>
          <i class="bi bi-magnet-fill" /> Snap
        </button>
        <button class="daw-toggle" classList={{ "daw-on": props.metronome }} title="Metronome click on beats" onClick={() => props.onMetronome()}>
          <i class="bi bi-bell-fill" /> Click
        </button>
        <button class="daw-toggle" classList={{ "daw-on": props.follow }} title="Scroll timeline with playhead (F)" onClick={() => props.onFollow()}>
          <i class="bi bi-arrow-right-square-fill" /> Follow
        </button>
      </div>

      <div class="daw-transport-group">
        <button class="daw-tbtn" title="Zoom out (−)" onClick={() => props.onZoom(1.5)}>
          <i class="bi bi-zoom-out" />
        </button>
        <button class="daw-tbtn" title="Zoom in (+)" onClick={() => props.onZoom(1 / 1.5)}>
          <i class="bi bi-zoom-in" />
        </button>
        <button class="daw-tbtn" title="Zoom to whole song" onClick={() => props.onZoomFit()}>
          <i class="bi bi-arrows-angle-expand" />
        </button>
      </div>

      <div class="daw-transport-spacer" />

      <Show when={props.resplitWords > 0 || props.analysisStale || props.analysing}>
        <button
          class="daw-btn daw-btn-warn"
          disabled={props.analysing || props.solving}
          title="Save, write the new syllable splits to the lyrics and re-analyse the audio (about 2 minutes); needed before auto-timing"
          onClick={() => props.onReanalyze()}
        >
          <i class={`bi bi-${props.analysing ? "hourglass-split" : "arrow-repeat"}`} />{" "}
          {props.analysing ? "Re-analysing…" : props.resplitWords > 0 ? `Re-analyze (${props.resplitWords} re-split)` : "Re-analyze"}
        </button>
      </Show>
      <button
        class="daw-btn daw-btn-accent"
        disabled={!props.canSolve || props.solving || props.analysing || props.resplitWords > 0 || props.analysisStale}
        title={props.resplitWords > 0 || props.analysisStale ? "Re-analyze first: the analysis does not match the syllables" : "Re-time every unpinned syllable around your pins"}
        onClick={() => props.onSolve()}
      >
        <i class={`bi bi-${props.solving ? "hourglass-split" : "magic"}`} /> {props.solving ? "Solving…" : "Auto-time unpinned"}
      </button>
      <button class="daw-btn" classList={{ "daw-btn-dirty": props.dirty }} disabled={!props.canSave} title="Save lyrics.calibrated.json (Ctrl+S)" onClick={() => props.onSave()}>
        <i class="bi bi-floppy-fill" /> Save
        <Show when={props.dirty}>
          <span class="daw-dirty-dot" />
        </Show>
      </button>
    </div>
  );
}
