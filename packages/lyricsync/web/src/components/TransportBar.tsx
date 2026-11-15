// packages/lyricsync/web/src/components/TransportBar.tsx
// DAW transport: playback controls, timecode + bar/beat counter, monitor source, snap/click/follow/razor, zoom, save and solve.
import { Show } from "solid-js";
import { formatTimecode } from "../lib/doc-edit";
import { LcdDigits } from "soulwindow/solid/pro";
import type { MonitorTrack } from "./TimelineCanvas";

export interface TransportBarProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  barBeat: { bar: number; beat: number } | null;
  /** Whole-song tempo (median beat interval). */
  bpm: number | null;
  /** Average tempo of the bar under the playhead. */
  barBpm: number | null;
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
  /** Razor tool for the vocal lane clips. */
  razor: boolean;
  onRazor: () => void;
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
  onEditLyrics?: () => void;
  /** The selected singer is not the lead: Auto-time, Re-analyze and Edit Lyrics (they run the solver on the lead's workspace) are off. */
  notLead: boolean;
}

/** Tooltip of the solver actions while another singer than the lead is selected. */
export const LEAD_ONLY = "lead singer only for now";

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
        <div class="daw-lcd-glass">
          <i class="bi bi-play-fill daw-lcd-ann" classList={{ "daw-lcd-ann--on": props.isPlaying }} />
          <LcdDigits class="daw-lcd-main" text={formatTimecode(props.currentTime)} />
          <div class="daw-lcd-sub">
            <span class="daw-lcd-label">BAR</span>
            <LcdDigits text={props.barBeat ? `${String(props.barBeat.bar).padStart(3, " ")}.${props.barBeat.beat}` : "---.-"} />
            <span class="daw-lcd-label">BPM</span>
            <span class="daw-lcd-bpm" title="Tempo of this bar / whole-song tempo">
              <LcdDigits text={props.barBpm ? props.barBpm.toFixed(1).padStart(5, " ") : "---.-"} />
              <span class="daw-lcd-slash" />
              <LcdDigits class="daw-lcd-amber" text={props.bpm ? props.bpm.toFixed(1).padStart(5, " ") : "---.-"} />
            </span>
            <span class="daw-lcd-label">TOT</span>
            <LcdDigits text={formatTimecode(props.duration)} />
          </div>
        </div>
      </div>

      <div class="daw-transport-group daw-bar1" title="Bar 1 of the beat grid (beat 1 of the first full bar)">
        <span class="daw-bar1-label">
          <i class="bi bi-flag-fill" /> BAR 1
        </span>
        <span class="daw-bar1-time">{props.bar1Time === null ? "—" : formatTimecode(props.bar1Time)}</span>
        <button class="win-button ds-btn-sm" disabled={props.bar1Time === null} title="Make the beat nearest the playhead bar 1 (B)" onClick={() => props.onSetBar1()}>
          Set here (B)
        </button>
      </div>

      <div class="ds-segmented-switch daw-transport-seg" title="Which audio you hear">
        <button class="ds-segmented-btn win-button" classList={{ active: props.monitor === "vocal" }} disabled={!props.hasVocal} onClick={() => props.onMonitor("vocal")}>
          <i class="bi bi-mic-fill" /> <span class="ds-btn-text">Vocal</span>
        </button>
        <button class="ds-segmented-btn win-button" classList={{ active: props.monitor === "mix" }} disabled={!props.hasMix} onClick={() => props.onMonitor("mix")}>
          <i class="bi bi-music-note-beamed" /> <span class="ds-btn-text">Mix</span>
        </button>
      </div>

      <div class="daw-transport-group">
        <button class="win-button" classList={{ active: props.snap }} title="Snap edges to beats, bars, syllables and playhead (S)" onClick={() => props.onSnap()}>
          <i class="bi bi-magnet-fill" /> Snap
        </button>
        <button class="win-button" classList={{ active: props.metronome }} title="Metronome click on beats" onClick={() => props.onMetronome()}>
          <i class="bi bi-bell-fill" /> Click
        </button>
        <button class="win-button" classList={{ active: props.follow }} title="Scroll timeline with playhead (F)" onClick={() => props.onFollow()}>
          <i class="bi bi-arrow-right-square-fill" /> Follow
        </button>
        <button class="win-button" classList={{ active: props.razor }} title="Razor: click a vocal lane clip to split it (R; Escape leaves)" onClick={() => props.onRazor()}>
          <i class="bi bi-scissors" /> Razor
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

      <Show when={!props.notLead && (props.resplitWords > 0 || props.analysisStale || props.analysing)}>
        <button
          class="win-button daw-btn-warn"
          disabled={props.analysing || props.solving}
          title="Save, write the new syllable splits to the lyrics and re-analyse the audio (about 2 minutes); needed before auto-timing"
          onClick={() => props.onReanalyze()}
        >
          <i class={`bi bi-${props.analysing ? "hourglass-split" : "arrow-repeat"}`} />{" "}
          {props.analysing ? "Re-analysing…" : props.resplitWords > 0 ? `Re-analyze (${props.resplitWords} re-split)` : "Re-analyze"}
        </button>
      </Show>
      <button
        type="button"
        class="win-button"
        disabled={!props.canSolve || props.solving || props.analysing || props.notLead}
        title={props.notLead ? LEAD_ONLY : "Edit lyrics in full text editor, add or delete words/syllables, and re-time"}
        onClick={() => props.onEditLyrics?.()}
      >
        <i class="bi bi-pencil" /> Edit Lyrics
      </button>
      <button
        class="win-button primary"
        disabled={!props.canSolve || props.solving || props.analysing || props.resplitWords > 0 || props.analysisStale || props.notLead}
        title={
          props.notLead
            ? LEAD_ONLY
            : props.resplitWords > 0 || props.analysisStale
              ? "Re-analyze first: the analysis does not match the syllables"
              : "Re-time every unpinned syllable around your pins"
        }
        onClick={() => props.onSolve()}
      >
        <i class={`bi bi-${props.solving ? "hourglass-split" : "magic"}`} /> {props.solving ? "Solving…" : "Auto-time unpinned"}
      </button>
      <button class="win-button" classList={{ "daw-btn-dirty": props.dirty }} disabled={!props.canSave} title="Save every changed calibration file and the placements (Ctrl+S)" onClick={() => props.onSave()}>
        <i class="bi bi-floppy-fill" /> Save
        <Show when={props.dirty}>
          <span class="daw-dirty-dot" />
        </Show>
      </button>
    </div>
  );
}
