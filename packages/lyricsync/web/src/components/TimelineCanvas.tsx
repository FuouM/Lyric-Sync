// packages/lyricsync/web/src/components/TimelineCanvas.tsx
// Multi-track NLE-style timeline: track headers, ruler (time + bars), section markers, mix and vocal waveforms with pitch,
// vocal lanes (clips of rendered vocal tracks: drag a clip on the beat grid, cut it with the razor), lyric clips with editable syllable
// edges, the other singers' lyrics (faint, read-only), overview scrollbar.
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { theme } from "../stores/theme";
import { isSylPinned, type CalibrationDoc } from "../../../src/calibration-doc";
import { floorIndex, rollPartner, sameSyl, type SylRef } from "../lib/doc-edit";
import type { TempoMap } from "../lib/tempo-grid";
import type { TrackMix } from "../lib/audio-player";
import { anchorTick, atBeatForTick, laneSnapMode, snapClipTime, type SnapResult } from "../lib/lanes";

export type MonitorTrack = "vocal" | "mix";

export interface TimelineHotspot {
  time: number;
  expectedErrorMs: number;
}

/** A clip of a vocal lane as the timeline shows it. Times in song seconds. */
export interface TimelineClip {
  id: string;
  atBeat: number | null;
  /** UST tick range [from, to) of the render that the clip plays. */
  from: number;
  to: number;
  /** UST tick 0, the clip start and the clip end; null while the clip is parked. */
  tick0: number | null;
  start: number | null;
  end: number | null;
  /** Seconds from the first wav sample to the clip's first sample. */
  offset: number;
  /** Clip length in seconds. */
  duration: number;
  /** Tempo mismatch between the UST and the grid under the clip, or null. */
  warning: string | null;
}

/** A vocal lane as the timeline shows it. */
export interface TimelineLane {
  id: string;
  ust: string;
  /** The lyric block the lane sings (first romaji line of the block, D24); empty = no lyrics. */
  block: string;
  /** Seconds per UST tick of the render (fixed render tempo). */
  secPerTick: number;
  clips: TimelineClip[];
  /** Peaks of the whole wav; index 0 is wav sample 0. */
  peaks?: Float32Array;
  mix: TrackMix;
  audible: boolean;
  /** The first clip warning, or null. */
  warning: string | null;
  /** Another lane plays the same UST, so this one can be removed. */
  removable: boolean;
  /** The wav cannot be read or decoded. */
  problem: string | null;
}

/** A clip in the live view: a placed clip at its times, a parked clip after the lane's other parked clips from the view's left edge. */
interface ClipSpan {
  clip: TimelineClip;
  start: number;
  end: number;
  parked: boolean;
}

export interface TimelineCanvasProps {
  doc: CalibrationDoc | null;
  duration: number;
  currentTime: number;
  viewStart: number;
  viewDuration: number;
  beats?: number[];
  downbeats?: number[];
  /** Index in `downbeats` of bar 1 (set with "Bar 1 here"). */
  bar1Index: number;
  mixPeaks?: Float32Array;
  vocalPeaks?: Float32Array;
  /** Peaks per second of both peak arrays. */
  peaksPerSec: number;
  /** f0 in Hz at 100 fps. */
  pitchContour?: number[];
  showPitch: boolean;
  snapEnabled: boolean;
  selectedSyl: SylRef | null;
  hotspots: TimelineHotspot[];
  monitor: MonitorTrack;
  onMonitor: (track: MonitorTrack) => void;
  onTogglePitch: () => void;
  onAddSection: () => void;
  onViewChange: (start: number, duration: number) => void;
  /** The user started dragging the view (pan). */
  onUserPan: () => void;
  onSeek: (t: number) => void;
  onSelectSyllable: (ref: SylRef) => void;
  onPlayRange: (start: number, end: number) => void;
  /** Called once before a syllable or section drag starts (undo snapshot of the calibration). */
  onEditBegin: () => void;
  /** Called once before the first move of a clip drag (undo snapshot of the placements). */
  onClipDragBegin: () => void;
  /** `partner`: the touching syllable that moves along (roll edit), chosen when the drag starts; null to move this edge alone. */
  onBoundaryDrag: (ref: SylRef, edge: "start" | "end", t: number, partner: SylRef | null) => void;
  onSectionDrag: (sectionIdx: number, t: number) => void;
  /** The song's tempo map from the dev server, or null when the song is not open through it. */
  tempo: TempoMap | null;
  /** A re-fit of the beats is running; the tempo changes cannot be dragged meanwhile. */
  tempoBusy: boolean;
  onAddTempo: () => void;
  /** Moves tempo change `idx` to `t` (live while dragging). */
  onTempoDrag: (idx: number, t: number) => void;
  /** A drag of a tempo change ended: apply it. */
  onTempoDrop: () => void;
  /** A bar line was dragged to `t`: fix that bar's beat there (`idx` indexes `downbeats`). */
  onBarDrop: (idx: number, t: number) => void;
  /** Alt+click on a bar line: free its beat again. */
  onBarUnpin: (idx: number) => void;
  /** Gain, mute and solo of the mix and the vocal stem ("mix", "vocal"). */
  trackMix: Record<"mix" | "vocal", TrackMix>;
  /** What plays now (mute and solo applied), keyed like `trackMix`. */
  audible: Record<"mix" | "vocal", boolean>;
  hasVocal: boolean;
  onTrackMix: (id: "mix" | "vocal", patch: Partial<TrackMix>) => void;
  /** The vocal lanes, in placements order. Empty when the song has no renders. */
  lanes: TimelineLane[];
  /** Lyric blocks offered in the lane's Lyric block field. */
  blockOptions: string[];
  onLaneMix: (id: string, patch: Partial<TrackMix>) => void;
  /** Razor tool: a click on a placed clip splits it; clip drags are off. */
  razor: boolean;
  /** Moves a clip while it is dragged (no undo step; `onClipDragBegin` ran before the first move). */
  onClipMove: (laneId: string, clipId: string, atBeat: number) => void;
  /** Splits a clip at UST tick `atTick` (may be fractional). */
  onClipSplit: (laneId: string, clipId: string, atTick: number) => void;
  onLaneBlock: (id: string, block: string) => void;
  onLaneDuplicate: (id: string) => void;
  onLaneRemove: (id: string) => void;
  /** The song's singers, lead first (user_input/singers.json); empty when the song has no singers file. */
  singers: { id: string; lead: boolean }[];
  /** The singer whose calibration `doc` is; null without a singers file. */
  activeSinger: string | null;
  onSinger: (id: string) => void;
  /** The other singers' calibrations that exist, drawn faint under the Lyrics lane (no hit testing). */
  faint: { id: string; doc: CalibrationDoc }[];
}

const HEADER_W = 210;
const RULER_H = 30;
const TEMPO_H = 22;
const MARKERS_H = 22;
const MIX_H = 46;
const LYRICS_H = 60;
const LINES_H = 20;
/** Height of one faint singer row under the Lyrics lane. */
const FAINT_H = 16;
const OVERVIEW_H = 18;
const MIN_VOCAL_H = 64;
/** The vocal lane height when the song has no vocal stem. */
const NO_VOCAL_H = 28;
/** Height of one vocal lane (two header rows). */
const LANE_H = 46;
const EDGE_HIT_PX = 6;
/** Snap targets pull within this distance. */
const SNAP_PX = 8;
/** The razor's cut preview line. */
const RAZOR_COLOR = "#ff4d6d";
/** The top strip of the ruler holds the bar lines you can drag. */
const BAR_GRIP_H = 12;
const PITCH_FPS = 100;

interface Lane {
  id: "ruler" | "tempo" | "markers" | "mix" | "vocal" | "renders" | "lyrics" | "faint" | "lines";
  y: number;
  h: number;
}

/**
 * `renders` is the scrolling area of the vocal lanes (height 0 without lanes). The vocal waveform takes the spare height; without a
 * vocal stem the lanes take it. `faint` holds one row per other singer (height 0 without).
 */
function layoutLanes(
  height: number,
  laneCount: number,
  hasVocal: boolean,
  faintCount: number
): { lanes: Record<Lane["id"], Lane>; overviewY: number } {
  const faintH = faintCount * FAINT_H;
  const free = height - RULER_H - TEMPO_H - MARKERS_H - MIX_H - LYRICS_H - faintH - LINES_H - OVERVIEW_H;
  const vocalMin = hasVocal ? MIN_VOCAL_H : NO_VOCAL_H;
  const room = Math.max(LANE_H, free - vocalMin);
  const rendersH = laneCount === 0 ? 0 : hasVocal ? Math.min(laneCount * LANE_H, room) : room;
  const vocalH = Math.max(vocalMin, free - rendersH);
  let y = 0;
  const lane = (id: Lane["id"], h: number): Lane => {
    const l = { id, y, h };
    y += h;
    return l;
  };
  const lanes = {
    ruler: lane("ruler", RULER_H),
    tempo: lane("tempo", TEMPO_H),
    markers: lane("markers", MARKERS_H),
    mix: lane("mix", MIX_H),
    vocal: lane("vocal", vocalH),
    renders: lane("renders", rendersH),
    lyrics: lane("lyrics", LYRICS_H),
    faint: lane("faint", faintH),
    lines: lane("lines", LINES_H),
  };
  return { lanes, overviewY: y };
}

const RULER_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];

const C_DARK = {
  bg: "#16181d",
  laneAlt: "#1a1d23",
  laneBorder: "#262a33",
  ruler: "#1f232b",
  rulerText: "#9aa3b2",
  beat: "rgba(255,255,255,0.05)",
  downbeat: "rgba(255,190,80,0.22)",
  mixWave: "#6b7a90",
  vocalWave: "#2bb3a3",
  pitch: "#ffd166",
  clipFree: "#2d5f9a",
  clipFreeAlt: "#356bab",
  clipFreeHead: "#22476f",
  clipPinned: "#2f7d4f",
  clipPinnedHead: "#235c3b",
  clipSel: "#d9822b",
  clipText: "#f1f5f9",
  playhead: "#ff3b30",
  snap: "#00e5ff",
  edgeHover: "#ffffff",
  hotspot: "#ff5d5d",
  overviewBg: "#101216",
  overviewBorder: "rgba(255,255,255,0.7)",
  snapText: "#001318",
  wordHeadText: "#cfd8e3",
};

const C_LIGHT = {
  bg: "#ffffff",
  laneAlt: "#f8f9fa",
  laneBorder: "#e2e8f0",
  ruler: "#f1f3f6",
  rulerText: "#4b5563",
  beat: "rgba(0,0,0,0.06)",
  downbeat: "rgba(217,119,6,0.35)",
  mixWave: "#475569",
  vocalWave: "#0d9488",
  pitch: "#b45309",
  clipFree: "#3b82f6",
  clipFreeAlt: "#2563eb",
  clipFreeHead: "#1d4ed8",
  clipPinned: "#16a34a",
  clipPinnedHead: "#15803d",
  clipSel: "#d97706",
  clipText: "#ffffff",
  playhead: "#dc2626",
  snap: "#0284c7",
  edgeHover: "#000000",
  hotspot: "#ef4444",
  overviewBg: "#f1f3f6",
  overviewBorder: "rgba(0,0,0,0.6)",
  snapText: "#ffffff",
  wordHeadText: "#ffffff",
};

let isDarkCurrent = true;
let C = C_DARK;


export function TimelineCanvas(props: TimelineCanvasProps) {
  let container!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [size, setSize] = createSignal({ w: 800, h: 320 });
  const layout = createMemo(() => layoutLanes(size().h, props.lanes.length, props.hasVocal, props.faint.length));
  /** Vertical scroll of the vocal lanes area, in px. */
  const [laneScroll, setLaneScroll] = createSignal(0);
  const maxLaneScroll = () => Math.max(0, props.lanes.length * LANE_H - layout().lanes.renders.h);
  const scrollLanes = (px: number) => setLaneScroll(Math.max(0, Math.min(maxLaneScroll(), px)));
  createEffect(() => {
    if (laneScroll() > maxLaneScroll()) setLaneScroll(maxLaneScroll());
  });
  const laneY = (i: number) => layout().lanes.renders.y + i * LANE_H - laneScroll();
  /** Index of the vocal lane at canvas y (inside the lanes area), or -1. */
  const laneRowAt = (y: number): number => {
    const r = layout().lanes.renders;
    if (y < r.y || y >= r.y + r.h) return -1;
    const i = Math.floor((y - r.y + laneScroll()) / LANE_H);
    return i < props.lanes.length ? i : -1;
  };

  let drag:
    | { kind: "boundary"; ref: SylRef; edge: "start" | "end"; partner: SylRef | null }
    | { kind: "section"; idx: number }
    | { kind: "tempo"; idx: number }
    | { kind: "bar"; idx: number; lo: number; hi: number }
    | { kind: "scrub" }
    | { kind: "overview"; grabOffset: number }
    /** Press on empty space: a drag pans the view; a release without moving is a click (`click` runs then). */
    | { kind: "pan"; x0: number; view0: number; moved: boolean; click: () => void }
    /** A vocal lane clip: `grab` = pointer time minus the time of the clip's anchor (`anchorTick`); a release without moving is a click. */
    | { kind: "clip"; lane: string; clip: string; grab: number; x0: number; moved: boolean; begun: boolean; click: () => void }
    | null = null;
  let hoverEdge: { ref: SylRef; edge: "start" | "end" } | null = null;
  let snapGuide: { time: number; label: string } | null = null;
  /** The razor's cut preview: lane id and the snapped cut time. */
  let razorHover: { lane: string; time: number } | null = null;
  let barGhost: { idx: number; t: number } | null = null;
  let frame = 0;

  /** The view a paint pass renders; null is the live view. The cached scene is painted over a wider span (see `paintScene`). */
  let rv: { start: number; dur: number; w: number } | null = null;
  const vStart = () => rv?.start ?? props.viewStart;
  const vDur = () => rv?.dur ?? props.viewDuration;
  const canvasW = () => rv?.w ?? size().w - HEADER_W;
  const tToX = (t: number) => ((t - vStart()) / vDur()) * canvasW();
  const xToT = (x: number) => vStart() + (x / canvasW()) * vDur();
  const total = () => Math.max(props.duration, props.doc?.lines.at(-1)?.end ?? 0, 1);

  /** Song-level pitch display range (log Hz), from voiced-frame percentiles padded by 3 semitones. */
  const pitchRange = createMemo(() => {
    const f0 = props.pitchContour;
    if (!f0) return null;
    const voiced = f0.filter((hz) => hz > 40).sort((a, b) => a - b);
    if (voiced.length < 10) return null;
    const lo = Math.log2(voiced[Math.floor(voiced.length * 0.03)]!) - 0.25;
    const hi = Math.log2(voiced[Math.floor(voiced.length * 0.97)]!) + 0.25;
    return { lo, hi };
  });

  const findSnap = (raw: number, exclude?: SylRef): { time: number; label: string } => {
    if (!props.snapEnabled) return { time: raw, label: "" };
    const tol = (SNAP_PX / canvasW()) * props.viewDuration;
    let best = { time: raw, label: "", d: tol };
    const consider = (t: number, label: string) => {
      const d = Math.abs(t - raw);
      if (d < best.d) best = { time: t, label, d };
    };
    for (const db of props.downbeats ?? []) consider(db, "BAR");
    for (const b of props.beats ?? []) consider(b, "BEAT");
    consider(props.currentTime, "PLAYHEAD");
    const doc = props.doc;
    if (doc) {
      doc.lines.forEach((line, li) => {
        if (line.end < raw - 1 || line.start > raw + 1) return;
        line.words.forEach((w, wi) =>
          w.syl.forEach((pair, si) => {
            if (exclude && exclude.lineIdx === li && exclude.wordIdx === wi && exclude.sylIdx === si) return;
            consider(pair[0], "SYLLABLE");
            consider(pair[1], "SYLLABLE");
          })
        );
      });
    }
    return { time: best.time, label: best.label };
  };

  const clipSpans = (lane: TimelineLane): ClipSpan[] => {
    let parkedAt = props.viewStart;
    return lane.clips.map((clip) => {
      if (clip.start !== null && clip.end !== null) return { clip, start: clip.start, end: clip.end, parked: false };
      const start = parkedAt;
      parkedAt += clip.duration;
      return { clip, start, end: start + clip.duration, parked: true };
    });
  };

  /**
   * A clip move or a razor cut at `raw`: beat (Shift = bar, Alt = free, see `laneSnapMode`), or the start or end of a placed clip of
   * any lane within SNAP_PX when nearer. The clip `exclude` (being moved or cut) is not a target.
   */
  const snapClip = (raw: number, e: { shiftKey: boolean; altKey: boolean }, exclude: { lane: string; clip: string }): SnapResult => {
    const edges = props.lanes.flatMap((l) =>
      l.clips.flatMap((c) => (c.start === null || c.end === null || (l.id === exclude.lane && c.id === exclude.clip) ? [] : [c.start, c.end]))
    );
    return snapClipTime(props.beats ?? [], props.downbeats ?? [], raw, laneSnapMode(e), edges, (SNAP_PX / canvasW()) * props.viewDuration);
  };

  /** Syllable edge under x in the lyrics lane; prefers the selected syllable on ties. */
  const edgeAt = (x: number): { ref: SylRef; edge: "start" | "end" } | null => {
    const doc = props.doc;
    if (!doc) return null;
    let best: { ref: SylRef; edge: "start" | "end"; d: number } | null = null;
    doc.lines.forEach((line, li) => {
      if (line.end < props.viewStart || line.start > props.viewStart + props.viewDuration) return;
      line.words.forEach((w, wi) =>
        w.syl.forEach(([s0, s1], si) => {
          const ref = { lineIdx: li, wordIdx: wi, sylIdx: si };
          const bias = sameSyl(ref, props.selectedSyl) ? -0.5 : 0;
          for (const [edge, t] of [["start", s0], ["end", s1]] as const) {
            const ex = tToX(t);
            // Where two edges meet, the pointer's side picks: left of the point the end before it, right of it the start after it.
            const side = (edge === "end" && x > ex) || (edge === "start" && x < ex) ? 0.75 : 0;
            const d = Math.abs(ex - x) + bias + side;
            if (d <= EDGE_HIT_PX && (!best || d < best.d)) best = { ref, edge, d };
          }
        })
      );
    });
    return best;
  };

  const sylAt = (x: number): { ref: SylRef; pair: [number, number] } | null => {
    const doc = props.doc;
    if (!doc) return null;
    const t = xToT(x);
    for (let li = 0; li < doc.lines.length; li++) {
      const line = doc.lines[li]!;
      if (t < line.start || t > line.end) continue;
      for (let wi = 0; wi < line.words.length; wi++) {
        const w = line.words[wi]!;
        for (let si = 0; si < w.syl.length; si++) {
          const pair = w.syl[si]!;
          if (t >= pair[0] && t <= pair[1]) return { ref: { lineIdx: li, wordIdx: wi, sylIdx: si }, pair };
        }
      }
    }
    return null;
  };

  // ── Drawing ──────────────────────────────────────────────────────────────

  // What stays put while the playhead moves (lanes, grid, ruler, waves, clips) is painted into `scene`, a canvas about twice as wide as
  // the view, and blitted per frame at the current scroll offset; the playhead, guides and overview are drawn live over it. A frame so
  // costs one drawImage however far the view is zoomed out. The scene is repainted when its data change or the view leaves it.
  const SCENE_MAX_DEVICE_PX = 8192;
  let scene: HTMLCanvasElement | null = null;
  let sceneSpan: { start: number; pps: number; w: number; dpr: number; h: number } | null = null;
  let sceneDirty = true;

  const sceneCovers = (W: number, H: number, dpr: number) => {
    const s = sceneSpan;
    if (!s || sceneDirty || s.dpr !== dpr || s.h !== H || s.w < W) return false;
    const pps = W / props.viewDuration;
    return Math.abs(s.pps - pps) <= 1e-9 * pps && props.viewStart >= s.start - 1e-9 && props.viewStart + props.viewDuration <= s.start + s.w / s.pps + 1e-9;
  };

  const paintScene = (W: number, H: number, dpr: number) => {
    const pps = W / props.viewDuration;
    const sceneW = Math.max(W, Math.min(W * 2, Math.floor(SCENE_MAX_DEVICE_PX / dpr)));
    // Spare room: a quarter behind the view, three quarters ahead (the playhead mostly moves forward).
    const start = Math.max(0, props.viewStart - ((sceneW - W) / pps) * 0.25);
    scene ??= document.createElement("canvas");
    const dw = Math.max(1, Math.floor(sceneW * dpr));
    const dh = Math.max(1, Math.floor(H * dpr));
    if (scene.width !== dw || scene.height !== dh) {
      scene.width = dw;
      scene.height = dh;
    }
    const ctx = scene.getContext("2d");
    if (!ctx) return;
    rv = { start, dur: sceneW / pps, w: sceneW };
    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintLanes(ctx, sceneW, H);
    } finally {
      rv = null;
    }
    sceneSpan = { start, pps, w: sceneW, dpr, h: H };
    sceneDirty = false;
  };

  const draw = () => {
    frame = 0;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvasW();
    const H = size().h;
    isDarkCurrent = theme() !== "light";
    C = isDarkCurrent ? C_DARK : C_LIGHT;
    if (!sceneCovers(W, H, dpr)) paintScene(W, H, dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = sceneSpan;
    if (scene && s) {
      const x0 = Math.min(scene.width - canvas.width, Math.max(0, Math.round((props.viewStart - s.start) * s.pps * dpr)));
      ctx.drawImage(scene, x0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintOverlay(ctx, W);
  };

  /** The scrolling content, painted over the span of the current paint view (`rv`). */
  const paintLanes = (ctx: CanvasRenderingContext2D, W: number, H: number) => {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    const { lanes, overviewY } = layout();
    const v0 = vStart();
    const v1 = vStart() + vDur();
    const contentTop = lanes.markers.y;
    const contentBottom = overviewY;

    // Lane backgrounds
    for (const l of [lanes.mix, lanes.lyrics, lanes.faint]) {
      ctx.fillStyle = C.laneAlt;
      ctx.fillRect(0, l.y, W, l.h);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, lanes.renders.y, W, lanes.renders.h);
    ctx.clip();
    ctx.strokeStyle = C.laneBorder;
    props.lanes.forEach((_, i) => {
      const y = laneY(i);
      ctx.fillStyle = i % 2 === 0 ? C.bg : C.laneAlt;
      ctx.fillRect(0, y, W, LANE_H);
      ctx.beginPath();
      ctx.moveTo(0, y + LANE_H - 0.5);
      ctx.lineTo(W, y + LANE_H - 0.5);
      ctx.stroke();
    });
    ctx.restore();
    ctx.strokeStyle = C.laneBorder;
    ctx.lineWidth = 1;
    for (const l of Object.values(lanes)) {
      ctx.beginPath();
      ctx.moveTo(0, l.y + l.h - 0.5);
      ctx.lineTo(W, l.y + l.h - 0.5);
      ctx.stroke();
    }

    // Song end shading
    const endX = tToX(total());
    if (props.doc && endX < W) {
      ctx.fillStyle = isDarkCurrent ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.06)";
      ctx.fillRect(Math.max(0, endX), contentTop, W - endX, contentBottom - contentTop);
    }

    // Beat grid
    const beats = props.beats ?? [];
    const downs = props.downbeats ?? [];
    const pxPerBeat = beats.length > 1 ? (W / vDur()) * (beats[1]! - beats[0]!) : 0;
    if (pxPerBeat > 6) {
      ctx.strokeStyle = C.beat;
      ctx.beginPath();
      for (let i = Math.max(0, floorIndex(beats, v0)); i < beats.length && beats[i]! <= v1; i++) {
        const x = Math.round(tToX(beats[i]!)) + 0.5;
        ctx.moveTo(x, contentTop);
        ctx.lineTo(x, contentBottom);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = C.downbeat;
    ctx.beginPath();
    for (let i = Math.max(0, floorIndex(downs, v0)); i < downs.length && downs[i]! <= v1; i++) {
      const x = Math.round(tToX(downs[i]!)) + 0.5;
      ctx.moveTo(x, contentTop);
      ctx.lineTo(x, contentBottom);
    }
    ctx.stroke();

    drawRuler(ctx, W, lanes.ruler, downs);
    drawMarkers(ctx, W, lanes.markers);
    drawTempo(ctx, W, lanes.tempo);
    drawWave(ctx, lanes.mix, props.mixPeaks, C.mixWave, props.audible.mix);
    drawWave(ctx, lanes.vocal, props.vocalPeaks, C.vocalWave, props.audible.vocal);
    drawVocalLanes(ctx, W, false);
    if (props.showPitch) drawPitch(ctx, lanes.vocal);
    drawLyrics(ctx, lanes.lyrics);
    drawFaint(ctx, lanes.faint);
    drawLines(ctx, lanes.lines);
  };

  /** What moves with the pointer or the playhead, drawn over the blitted scene in the live view. */
  const paintOverlay = (ctx: CanvasRenderingContext2D, W: number) => {
    const { lanes, overviewY } = layout();
    const contentTop = lanes.markers.y;
    const contentBottom = overviewY;
    drawOverview(ctx, W, overviewY);
    drawVocalLanes(ctx, W, true);

    // Hovered / dragged syllable edge
    const doc = props.doc;
    const he = drag?.kind === "boundary" ? drag : hoverEdge;
    const hp = he ? doc?.lines[he.ref.lineIdx]?.words[he.ref.wordIdx]?.syl[he.ref.sylIdx] : undefined;
    if (he && hp) {
      const x = tToX(he.edge === "start" ? hp[0] : hp[1]);
      ctx.fillStyle = C.edgeHover;
      ctx.fillRect(Math.round(x) - 1, lanes.lyrics.y + 1, 3, lanes.lyrics.h - 2);
    }

    // The bar line being dragged
    if (barGhost) {
      const gx = Math.round(tToX(barGhost.t)) + 0.5;
      ctx.strokeStyle = "#e879f9";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gx, lanes.ruler.y);
      ctx.lineTo(gx, contentBottom);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Razor cut preview: a line across the clip's lane at the snapped cut time
    if (razorHover) {
      const i = props.lanes.findIndex((l) => l.id === razorHover!.lane);
      const r = lanes.renders;
      if (i >= 0) {
        const rx = Math.round(tToX(razorHover.time)) + 0.5;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, r.y, W, r.h);
        ctx.clip();
        ctx.strokeStyle = RAZOR_COLOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(rx, laneY(i) + 1);
        ctx.lineTo(rx, laneY(i) + LANE_H - 1);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Snap guide
    if (snapGuide && snapGuide.label) {
      const sx = Math.round(tToX(snapGuide.time)) + 0.5;
      ctx.strokeStyle = C.snap;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, contentTop);
      ctx.lineTo(sx, contentBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "600 9px 'Segoe UI', sans-serif";
      const tw = ctx.measureText(snapGuide.label).width + 8;
      ctx.fillStyle = C.snap;
      ctx.fillRect(sx + 3, contentTop + 2, tw, 13);
      ctx.fillStyle = C.snapText;
      ctx.fillText(snapGuide.label, sx + 7, contentTop + 12);
    }

    // Playhead
    const px = Math.round(tToX(props.currentTime)) + 0.5;
    if (px >= -6 && px <= W + 6) {
      ctx.strokeStyle = C.playhead;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, lanes.ruler.y + 12);
      ctx.lineTo(px, contentBottom);
      ctx.stroke();
      ctx.fillStyle = C.playhead;
      ctx.beginPath();
      ctx.moveTo(px - 6, lanes.ruler.y + 2);
      ctx.lineTo(px + 6, lanes.ruler.y + 2);
      ctx.lineTo(px + 6, lanes.ruler.y + 9);
      ctx.lineTo(px, lanes.ruler.y + 15);
      ctx.lineTo(px - 6, lanes.ruler.y + 9);
      ctx.closePath();
      ctx.fill();
    }
  };

  const drawRuler = (ctx: CanvasRenderingContext2D, W: number, lane: Lane, downs: number[]) => {
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, lane.y, W, lane.h);
    const pxPerSec = W / vDur();
    const step = RULER_STEPS.find((s) => s * pxPerSec >= 70) ?? 300;
    const minor = step / 5;
    ctx.strokeStyle = "#4a5160";
    ctx.beginPath();
    const first = Math.floor(vStart() / minor) * minor;
    for (let t = first; t <= vStart() + vDur(); t += minor) {
      const x = Math.round(tToX(t)) + 0.5;
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, lane.y + lane.h - (isMajor ? 12 : 5));
      ctx.lineTo(x, lane.y + lane.h);
    }
    ctx.stroke();
    ctx.fillStyle = C.rulerText;
    ctx.font = "10px 'Cascadia Mono', Consolas, monospace";
    const firstMajor = Math.ceil(vStart() / step) * step;
    for (let t = firstMajor; t <= vStart() + vDur(); t += step) {
      const m = Math.floor(t / 60);
      const s = t - m * 60;
      const label = step < 1 ? `${m}:${s.toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, "0")}` : `${m}:${String(Math.round(s)).padStart(2, "0")}`;
      ctx.fillText(label, tToX(t) + 3, lane.y + lane.h - 4);
    }
    // Bar numbers along the top of the ruler
    if (downs.length > 1) {
      const pxPerBar = pxPerSec * (downs[1]! - downs[0]!);
      const every = pxPerBar >= 28 ? 1 : pxPerBar >= 14 ? 2 : pxPerBar >= 7 ? 4 : 8;
      ctx.fillStyle = "#e0b45c";
      ctx.font = "600 9px 'Segoe UI', sans-serif";
      for (let i = Math.max(0, floorIndex(downs, vStart())); i < downs.length && downs[i]! <= vStart() + vDur(); i++) {
        const bar = i + 1 - props.bar1Index;
        const x = tToX(downs[i]!);
        if (bar === 1) {
          // Bar 1 flag
          ctx.fillStyle = "#ffb703";
          ctx.fillRect(x, lane.y, 2, lane.h);
          ctx.beginPath();
          ctx.moveTo(x + 2, lane.y);
          ctx.lineTo(x + 14, lane.y + 5);
          ctx.lineTo(x + 2, lane.y + 10);
          ctx.fill();
          ctx.fillStyle = "#e0b45c";
          continue;
        }
        if (((bar % every) + every) % every !== 1 % every) continue;
        ctx.fillRect(x, lane.y, 1, 6);
        ctx.fillText(String(bar), x + 3, lane.y + 9);
      }
    }
    // Fixed (pinned) bars: a diamond on the bar line
    const beatTimes = props.beats ?? [];
    const pinned = new Set((props.tempo?.beatPins ?? []).map((p) => beatTimes[p.beat]));
    if (pinned.size > 0) {
      ctx.fillStyle = "#e879f9";
      for (let i = Math.max(0, floorIndex(downs, vStart())); i < downs.length && downs[i]! <= vStart() + vDur(); i++) {
        if (!pinned.has(downs[i]!)) continue;
        const x = Math.round(tToX(downs[i]!)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, lane.y + 1);
        ctx.lineTo(x + 5, lane.y + 6);
        ctx.lineTo(x, lane.y + 11);
        ctx.lineTo(x - 5, lane.y + 6);
        ctx.closePath();
        ctx.fill();
      }
    }
  };

  /** The tempo map as blocks (the starting tempo, then each change) with a grip on every change; a grip drags. */
  const drawTempo = (ctx: CanvasRenderingContext2D, W: number, lane: Lane) => {
    const tempo = props.tempo;
    ctx.font = "600 11px 'Segoe UI', sans-serif";
    if (!tempo) {
      ctx.fillStyle = C.rulerText;
      ctx.fillText("Open the song through the dev server to edit its tempo", 8, lane.y + 15);
      return;
    }
    const starts = [0, ...tempo.tempoChanges.map((c) => c.at)];
    const ends = [...tempo.tempoChanges.map((c) => c.at), total()];
    const bpms = [tempo.nearestBpm, ...tempo.tempoChanges.map((c) => c.bpm)];
    bpms.forEach((bpm, i) => {
      const x1 = tToX(starts[i]!);
      const x2 = tToX(ends[i]!);
      if (x2 < 0 || x1 > W) return;
      const hue = 295 + (i % 2) * 35;
      ctx.fillStyle = `hsla(${hue}, 45%, 45%, 0.3)`;
      ctx.fillRect(x1, lane.y + 2, x2 - x1, lane.h - 4);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, lane.y, x2 - x1, lane.h);
      ctx.clip();
      ctx.fillStyle = C.rulerText;
      ctx.fillText(`${bpm} BPM`, Math.max(x1, 0) + 9, lane.y + 15);
      ctx.restore();
    });
    for (const c of tempo.tempoChanges) {
      const x = tToX(c.at);
      if (x < -8 || x > W + 8) continue;
      ctx.fillStyle = "#e879f9";
      ctx.beginPath();
      ctx.roundRect(x - 4, lane.y + 3, 8, lane.h - 6, 2);
      ctx.fill();
      ctx.fillStyle = "hsl(300, 40%, 30%)";
      ctx.fillRect(x - 2, lane.y + 7, 1, lane.h - 14);
      ctx.fillRect(x + 1, lane.y + 7, 1, lane.h - 14);
    }
  };

  const drawMarkers = (ctx: CanvasRenderingContext2D, W: number, lane: Lane) => {
    const secs = props.doc?.sections ?? [];
    secs.forEach((sec, si) => {
      const x1 = tToX(sec.start);
      const x2 = tToX(sec.end);
      if (x2 < 0 || x1 > W) return;
      const hue = (si * 67 + 200) % 360;
      ctx.fillStyle = `hsla(${hue}, 45%, 45%, 0.35)`;
      ctx.fillRect(x1, lane.y + 2, x2 - x1, lane.h - 4);
      ctx.fillStyle = `hsl(${hue}, 60%, 62%)`;
      ctx.fillRect(x1, lane.y + 2, 3, lane.h - 4);
      if (si > 0) {
        // Grip: drag to move the section start (the previous section's end follows).
        ctx.fillStyle = "#e8edf5";
        ctx.beginPath();
        ctx.roundRect(x1 - 4, lane.y + 3, 8, lane.h - 6, 2);
        ctx.fill();
        ctx.fillStyle = `hsl(${hue}, 40%, 35%)`;
        ctx.fillRect(x1 - 2, lane.y + 7, 1, lane.h - 14);
        ctx.fillRect(x1 + 1, lane.y + 7, 1, lane.h - 14);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, lane.y, x2 - x1, lane.h);
      ctx.clip();
      ctx.fillStyle = "#eef2f7";
      ctx.font = "600 11px 'Segoe UI', sans-serif";
      ctx.fillText(sec.name, Math.max(x1, 0) + 7, lane.y + 15);
      ctx.restore();
    });
  };

  const drawWave = (ctx: CanvasRenderingContext2D, lane: Lane, peaks: Float32Array | undefined, color: string, active: boolean) => {
    if (!peaks || peaks.length === 0) return;
    drawPeaks(ctx, lane.y + lane.h / 2, lane.h / 2 - 3, peaks, 0, color, active ? 0.95 : 0.45, 0, canvasW());
  };

  /** Peaks whose first value is at song time `t0`, centred on `mid`, between canvas x `xFrom` and `xTo`. */
  const drawPeaks = (
    ctx: CanvasRenderingContext2D,
    mid: number,
    half: number,
    peaks: Float32Array,
    t0: number,
    color: string,
    alpha: number,
    xFrom: number,
    xTo: number
  ) => {
    const pps = props.peaksPerSec;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let x = Math.max(0, Math.floor(xFrom)); x < xTo; x++) {
      const p0 = (xToT(x) - t0) * pps;
      const p1 = (xToT(x + 1) - t0) * pps;
      if (p1 <= 0 || p0 >= peaks.length) continue;
      const a = Math.max(0, Math.floor(p0));
      const b = Math.min(peaks.length, Math.max(a + 1, Math.floor(p1)));
      let p = 0;
      for (let i = a; i < b; i++) if (peaks[i]! > p) p = peaks[i]!;
      const h = Math.max(0.5, p * half);
      ctx.rect(x, mid - h, 1, h * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  /**
   * The clips of the vocal lanes: the placed ones (`parked` false, in the scene) at their times, or the parked ones (`parked` true, in
   * the overlay) from the left edge of the view, grey and dashed. Each clip shows the peaks of its own wav range; a gap marks where
   * two clips touch. A solid line marks UST tick 0 when it is inside the clip.
   */
  const drawVocalLanes = (ctx: CanvasRenderingContext2D, W: number, parked: boolean) => {
    const r = layout().lanes.renders;
    if (r.h === 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, r.y, W, r.h);
    ctx.clip();
    props.lanes.forEach((lane, i) => {
      const y = laneY(i);
      if (y + LANE_H <= r.y || y >= r.y + r.h) return;
      const top = y + 3;
      const h = LANE_H - 6;
      let hue = 210;
      for (const ch of lane.block) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
      const sat = parked ? 0 : lane.block ? 50 : 25;
      const alpha = parked ? 0.55 : lane.audible ? 1 : 0.45;
      for (const span of clipSpans(lane)) {
        if (span.parked !== parked) continue;
        const { clip } = span;
        const x1 = tToX(span.start);
        const x2 = Math.max(x1 + 2, tToX(span.end));
        if (x2 < 0 || x1 > W) continue;
        ctx.globalAlpha = alpha;
        roundRect(ctx, x1 + 1, top, Math.max(1, x2 - x1 - 2), h, 3);
        ctx.fillStyle = `hsla(${hue}, ${sat}%, 45%, 0.3)`;
        ctx.fill();
        ctx.strokeStyle = clip.warning && !parked ? "#f59e0b" : `hsl(${hue}, ${sat}%, 58%)`;
        if (parked) ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (lane.peaks) {
          const color = parked ? C.rulerText : `hsl(${hue}, ${sat + 15}%, 62%)`;
          drawPeaks(ctx, top + 8 + (h - 8) / 2, (h - 8) / 2 - 1, lane.peaks, span.start - clip.offset, color, alpha * 0.9, x1 + 1, Math.min(W, x2 - 1));
        }
        ctx.globalAlpha = alpha;
        if (clip.tick0 !== null && clip.tick0 >= span.start && clip.tick0 <= span.end) {
          const tx = Math.round(tToX(clip.tick0)) + 0.5;
          ctx.strokeStyle = `hsl(${hue}, ${sat + 20}%, 70%)`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(tx, top);
          ctx.lineTo(tx, top + h);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(x1 + 1, top, Math.max(1, x2 - x1 - 2), h);
        ctx.clip();
        ctx.fillStyle = C.rulerText;
        ctx.font = "600 10px 'Segoe UI', sans-serif";
        const where = clip.atBeat === null ? "not placed: drag it onto the timeline" : `beat ${Number(clip.atBeat.toFixed(3))}`;
        ctx.fillText(lane.problem ?? `${clip.id}${lane.block ? ` · ${lane.block}` : ""} · ${where}`, Math.max(x1, 0) + 5, top + 10);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    });
    ctx.restore();
  };

  const drawPitch = (ctx: CanvasRenderingContext2D, lane: Lane) => {
    const f0 = props.pitchContour;
    const range = pitchRange();
    if (!f0 || !range) return;
    const a = Math.max(0, Math.floor(vStart() * PITCH_FPS));
    const b = Math.min(f0.length, Math.ceil((vStart() + vDur()) * PITCH_FPS) + 1);
    ctx.strokeStyle = C.pitch;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let pen = false;
    for (let f = a; f < b; f++) {
      const hz = f0[f]!;
      if (hz <= 40) {
        pen = false;
        continue;
      }
      const n = (Math.log2(hz) - range.lo) / (range.hi - range.lo);
      const y = lane.y + lane.h - 4 - Math.max(0, Math.min(1, n)) * (lane.h - 8);
      const x = tToX(f / PITCH_FPS);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  };

  const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(r, w / 2));
  };

  const drawLyrics = (ctx: CanvasRenderingContext2D, lane: Lane) => {
    const doc = props.doc;
    if (!doc) return;
    const top = lane.y + 4;
    const h = lane.h - 8;
    const headH = 14;
    doc.lines.forEach((line, li) => {
      if (line.end < vStart() || line.start > vStart() + vDur()) return;
      line.words.forEach((w, wi) => {
        if (w.syl.length === 0) return;
        const wx1 = tToX(w.syl[0]![0]);
        const wx2 = tToX(w.syl[w.syl.length - 1]![1]);
        const ww = Math.max(2, wx2 - wx1);
        const allPinned = w.syl.every((_, si) => isSylPinned(line, w, si));

        ctx.save();
        roundRect(ctx, wx1, top, ww, h, 3);
        ctx.clip();
        // Word header strip
        ctx.fillStyle = allPinned ? C.clipPinnedHead : C.clipFreeHead;
        ctx.fillRect(wx1, top, ww, headH);
        if (ww > 16) {
          ctx.fillStyle = C.wordHeadText;
          ctx.font = "10px 'Segoe UI', sans-serif";
          ctx.fillText(w.w, wx1 + 4, top + 10);
        }
        // Syllable bodies
        w.syl.forEach(([s0, s1], si) => {
          const x1 = tToX(s0);
          const x2 = tToX(s1);
          const ref = { lineIdx: li, wordIdx: wi, sylIdx: si };
          const sel = sameSyl(ref, props.selectedSyl);
          const pinned = isSylPinned(line, w, si);
          ctx.fillStyle = sel ? C.clipSel : pinned ? C.clipPinned : si % 2 === 0 ? C.clipFree : C.clipFreeAlt;
          ctx.fillRect(x1, top + headH, Math.max(1, x2 - x1), h - headH);
          if (x2 - x1 > 12) {
            ctx.fillStyle = C.clipText;
            ctx.font = `${sel ? "700" : "600"} 12px 'Segoe UI', sans-serif`;
            const txt = w.sylText[si] ?? "";
            const tw = ctx.measureText(txt).width;
            ctx.fillText(txt, x1 + Math.max(3, (x2 - x1 - tw) / 2), top + headH + (h - headH) / 2 + 4);
          }
          if (pinned && x2 - x1 > 10) {
            // pin dot
            ctx.fillStyle = "#b6f5c8";
            ctx.beginPath();
            ctx.arc(x2 - 5, top + headH + 5, 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
          if (si > 0) {
            ctx.fillStyle = "rgba(0,0,0,0.45)";
            ctx.fillRect(Math.round(x1), top + headH, 1, h - headH);
          }
        });
        ctx.restore();

        // Clip outline
        roundRect(ctx, wx1 + 0.5, top + 0.5, ww - 1, h - 1, 3);
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.stroke();
      });
    });

    // Selected syllable outline on top
    const sel = props.selectedSyl;
    const sp = sel ? doc.lines[sel.lineIdx]?.words[sel.wordIdx]?.syl[sel.sylIdx] : undefined;
    if (sp) {
      const x1 = tToX(sp[0]);
      const x2 = tToX(sp[1]);
      ctx.strokeStyle = "#ffd29a";
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, top, Math.max(2, x2 - x1), h);
      ctx.lineWidth = 1;
    }

    // Uncertainty hotspots
    for (const hs of props.hotspots) {
      if (hs.time < vStart() || hs.time > vStart() + vDur()) continue;
      const x = tToX(hs.time);
      ctx.globalAlpha = Math.min(1, 0.35 + hs.expectedErrorMs / 60);
      ctx.fillStyle = C.hotspot;
      ctx.beginPath();
      ctx.moveTo(x - 4, lane.y);
      ctx.lineTo(x + 4, lane.y);
      ctx.lineTo(x, lane.y + 6);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  };

  /** The other singers' syllables, one faint row per singer (read-only: no selection, no edge hits). */
  const drawFaint = (ctx: CanvasRenderingContext2D, lane: Lane) => {
    props.faint.forEach(({ doc }, row) => {
      const top = lane.y + row * FAINT_H + 2;
      const h = FAINT_H - 4;
      ctx.globalAlpha = 0.4;
      for (const line of doc.lines) {
        if (line.end < vStart() || line.start > vStart() + vDur()) continue;
        for (const w of line.words) {
          w.syl.forEach(([s0, s1], si) => {
            const x1 = tToX(s0);
            const x2 = tToX(s1);
            ctx.fillStyle = si % 2 === 0 ? C.clipFree : C.clipFreeAlt;
            ctx.fillRect(x1, top, Math.max(1, x2 - x1 - 1), h);
            if (x2 - x1 > 12) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(x1, top, x2 - x1, h);
              ctx.clip();
              ctx.fillStyle = C.clipText;
              ctx.font = "10px 'Segoe UI', sans-serif";
              ctx.fillText(w.sylText[si] ?? "", x1 + 2, top + h - 3);
              ctx.restore();
            }
          });
        }
      }
      ctx.globalAlpha = 1;
    });
  };

  const drawLines = (ctx: CanvasRenderingContext2D, lane: Lane) => {
    const doc = props.doc;
    if (!doc) return;
    const selLine = props.selectedSyl?.lineIdx;
    doc.lines.forEach((line, li) => {
      if (line.end < vStart() || line.start > vStart() + vDur()) return;
      const x1 = tToX(line.start);
      const w = Math.max(2, tToX(line.end) - x1);
      ctx.fillStyle = li === selLine ? (isDarkCurrent ? "#8a5a22" : "#f59e0b") : line.calibrated ? (isDarkCurrent ? "#2a5a3c" : "#86efac") : (isDarkCurrent ? "#2a3a52" : "#bfdbfe");
      roundRect(ctx, x1, lane.y + 3, w, lane.h - 6, 2);
      ctx.fill();
      if (w > 22) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x1, lane.y, w, lane.h);
        ctx.clip();
        ctx.fillStyle = isDarkCurrent ? "#d6dde7" : "#1f2937";
        ctx.font = "10px 'Segoe UI', sans-serif";
        ctx.fillText(`L${line.i}  ${line.text}`, x1 + 4, lane.y + 14);
        ctx.restore();
      }
    });
  };

  const drawOverview = (ctx: CanvasRenderingContext2D, W: number, y: number) => {
    ctx.fillStyle = C.overviewBg;
    ctx.fillRect(0, y, W, OVERVIEW_H);
    const T = total();
    const sx = (t: number) => (t / T) * W;
    for (const line of props.doc?.lines ?? []) {
      ctx.fillStyle = line.calibrated ? (isDarkCurrent ? "#3f9a62" : "#16a34a") : (isDarkCurrent ? "#3b5f8f" : "#2563eb");
      ctx.fillRect(sx(line.start), y + 6, Math.max(1, sx(line.end) - sx(line.start)), OVERVIEW_H - 12);
    }
    const vx = sx(props.viewStart);
    const vw = Math.max(6, sx(props.viewStart + props.viewDuration) - vx);
    ctx.fillStyle = isDarkCurrent ? "rgba(255,255,255,0.10)" : "rgba(0,120,215,0.12)";
    ctx.fillRect(vx, y + 2, vw, OVERVIEW_H - 4);
    ctx.strokeStyle = C.overviewBorder;
    ctx.strokeRect(vx + 0.5, y + 2.5, vw - 1, OVERVIEW_H - 5);
    ctx.fillStyle = C.playhead;
    ctx.fillRect(sx(props.currentTime), y, 1.5, OVERVIEW_H);
  };

  const requestDraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  // Scene data: anything that changes the painted lanes (not the playhead or the scroll, which only move the blit).
  createEffect(() => {
    void [theme(), props.doc, props.viewDuration, props.beats, props.downbeats, props.bar1Index, props.mixPeaks, props.vocalPeaks,
      props.peaksPerSec, props.pitchContour, props.showPitch, props.selectedSyl, props.hotspots, props.audible, props.duration, props.tempo,
      props.lanes, props.faint, laneScroll(), size()];
    sceneDirty = true;
    requestDraw();
  });

  createEffect(() => {
    void [props.currentTime, props.viewStart];
    requestDraw();
  });

  onMount(() => {
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor((w - HEADER_W) * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w - HEADER_W}px`;
      canvas.style.height = `${h}px`;
      setSize({ w, h });
      draw();
    });
    ro.observe(container);
    onCleanup(() => ro.disconnect());
  });
  onCleanup(() => cancelAnimationFrame(frame));

  // ── Interaction ──────────────────────────────────────────────────────────

  const local = (e: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const laneAt = (y: number): Lane["id"] | "overview" | null => {
    const { lanes, overviewY } = layout();
    if (y >= overviewY) return "overview";
    for (const l of Object.values(lanes)) if (y >= l.y && y < l.y + l.h) return l.id;
    return null;
  };

  const overviewScroll = (x: number, grabOffset: number) => {
    const t = (x / canvasW()) * total() - grabOffset;
    props.onViewChange(Math.max(0, Math.min(total() - props.viewDuration * 0.5, t)), props.viewDuration);
  };

  /** Index in `downbeats` of the bar line under x, or null. */
  const barAt = (x: number): number | null => {
    const downs = props.downbeats ?? [];
    const i = floorIndex(downs, xToT(x));
    let best: number | null = null;
    for (const k of [i, i + 1]) {
      const d = downs[k];
      if (d !== undefined && Math.abs(tToX(d) - x) <= EDGE_HIT_PX && (best === null || Math.abs(tToX(d) - x) < Math.abs(tToX(downs[best]!) - x))) best = k;
    }
    return best;
  };

  /** Index of the tempo change whose grip is under x, or null. */
  const tempoGripAt = (x: number): number | null => {
    const i = (props.tempo?.tempoChanges ?? []).findIndex((c) => Math.abs(tToX(c.at) - x) <= EDGE_HIT_PX);
    return i < 0 ? null : i;
  };

  /** The vocal lane clip under (x, y) in the live view. Parked clips lie over the placed ones, so they are hit first. */
  const clipAt = (x: number, y: number): { lane: TimelineLane; span: ClipSpan } | null => {
    const lane = props.lanes[laneRowAt(y)];
    if (!lane) return null;
    const spans = clipSpans(lane).sort((a, b) => Number(b.parked) - Number(a.parked));
    for (const span of spans) {
      const x1 = tToX(span.start);
      if (x >= x1 && x <= Math.max(x1 + 2, tToX(span.end))) return { lane, span };
    }
    return null;
  };

  /** The razor cut at (x, y): a placed clip and the snapped cut time strictly inside it, or null. */
  const razorCut = (x: number, y: number, e: { shiftKey: boolean; altKey: boolean }): { lane: TimelineLane; clip: TimelineClip; time: number; label: string } | null => {
    const hit = clipAt(x, y);
    if (!hit || hit.span.parked) return null;
    const s = snapClip(xToT(x), e, { lane: hit.lane.id, clip: hit.span.clip.id });
    if (s.time <= hit.span.start || s.time >= hit.span.end) return null;
    return { lane: hit.lane, clip: hit.span.clip, time: s.time, label: s.label };
  };

  /** Hover feedback of the razor: the cut preview and its snap guide. */
  const updateRazorHover = (x: number, y: number, e: { shiftKey: boolean; altKey: boolean }) => {
    const cut = props.razor && laneAt(y) === "renders" ? razorCut(x, y, e) : null;
    razorHover = cut ? { lane: cut.lane.id, time: cut.time } : null;
    snapGuide = cut?.label ? { time: cut.time, label: cut.label } : null;
  };

  createEffect(() => {
    if (props.razor || drag) return;
    razorHover = null;
    snapGuide = null;
    requestDraw();
  });

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    const lane = laneAt(y);
    const t = xToT(x);

    if (lane === "overview") {
      const vx0 = props.viewStart;
      const tAtX = (x / canvasW()) * total();
      const inside = tAtX >= vx0 && tAtX <= vx0 + props.viewDuration;
      const grabOffset = inside ? tAtX - vx0 : props.viewDuration / 2;
      drag = { kind: "overview", grabOffset };
      overviewScroll(x, grabOffset);
    } else if (lane === "ruler" && y <= BAR_GRIP_H && !props.tempoBusy && props.tempo && barAt(x) !== null) {
      // The top of the ruler holds the bar lines: drag one onto the music to fix that beat (Alt+click unpins it).
      const idx = barAt(x)!;
      if (e.altKey) props.onBarUnpin(idx);
      else {
        const downs = props.downbeats ?? [];
        const beats = props.beats ?? [];
        const bi = floorIndex(beats, downs[idx]! + 1e-4);
        drag = { kind: "bar", idx, lo: (beats[bi - 1] ?? 0) + 0.05, hi: (beats[bi + 1] ?? total()) - 0.05 };
        barGhost = { idx, t: downs[idx]! };
      }
    } else if (lane === "ruler") {
      drag = { kind: "scrub" };
      props.onSeek(Math.max(0, t));
    } else if (lane === "tempo" && !props.tempoBusy && tempoGripAt(x) !== null) {
      drag = { kind: "tempo", idx: tempoGripAt(x)! };
    } else if (lane === "markers" && (props.doc?.sections ?? []).some((s, i) => i > 0 && Math.abs(tToX(s.start) - x) <= EDGE_HIT_PX)) {
      const idx = (props.doc?.sections ?? []).findIndex((s, i) => i > 0 && Math.abs(tToX(s.start) - x) <= EDGE_HIT_PX);
      props.onEditBegin();
      drag = { kind: "section", idx };
    } else if (lane === "lyrics" && edgeAt(x)) {
      const edge = edgeAt(x)!;
      props.onEditBegin();
      props.onSelectSyllable(edge.ref);
      // Touching syllables of the same line move together; hold Alt to move this edge alone (opens a gap).
      drag = { kind: "boundary", ref: edge.ref, edge: edge.edge, partner: e.altKey || !props.doc ? null : rollPartner(props.doc, edge.ref, edge.edge) };
    } else if (lane === "renders" && props.razor && clipAt(x, y)) {
      // Razor: a click on a placed clip splits it at the snapped time (beat; Shift = bar; Alt = free; clip edges pull).
      const cut = razorCut(x, y, e);
      if (cut && cut.clip.tick0 !== null) props.onClipSplit(cut.lane.id, cut.clip.id, (cut.time - cut.clip.tick0) / cut.lane.secPerTick);
      updateRazorHover(x, y, e);
    } else if (lane === "renders" && clipAt(x, y)) {
      // A clip: drag it along the beat grid (its start snaps: beat; Shift = bar; Alt = free; clip edges pull). A click moves the playhead.
      const hit = clipAt(x, y)!;
      drag = {
        kind: "clip",
        lane: hit.lane.id,
        clip: hit.span.clip.id,
        grab: t - (hit.span.start + (anchorTick(hit.span.clip) - hit.span.clip.from) * hit.lane.secPerTick),
        x0: e.clientX,
        moved: false,
        begun: false,
        click: () => props.onSeek(Math.max(0, t)),
      };
    } else {
      // Everything else: drag pans the view, a plain click selects what is under it and moves the playhead there.
      const click = () => {
        const doc = props.doc;
        if (lane === "lyrics") {
          const hit = sylAt(x);
          if (hit) props.onSelectSyllable(hit.ref);
        } else if (lane === "lines" && doc) {
          const li = doc.lines.findIndex((l) => t >= l.start && t <= l.end);
          if (li >= 0) {
            props.onSelectSyllable({ lineIdx: li, wordIdx: 0, sylIdx: 0 });
            props.onSeek(doc.lines[li]!.start);
            return;
          }
        }
        props.onSeek(Math.max(0, t));
      };
      drag = { kind: "pan", x0: e.clientX, view0: props.viewStart, moved: false, click };
    }
    if (drag) canvas.setPointerCapture(e.pointerId);
    requestDraw();
  };

  const onPointerMove = (e: PointerEvent) => {
    const { x, y } = local(e);
    const t = xToT(x);
    if (!drag) {
      const lane = laneAt(y);
      hoverEdge = lane === "lyrics" ? edgeAt(x) : null;
      const onSection =
        lane === "markers" && (props.doc?.sections ?? []).some((s, i) => i > 0 && Math.abs(tToX(s.start) - x) <= EDGE_HIT_PX);
      const onTempo = lane === "tempo" && tempoGripAt(x) !== null;
      const onBar = lane === "ruler" && y <= BAR_GRIP_H && !!props.tempo && barAt(x) !== null;
      const onClip = !props.razor && lane === "renders" && clipAt(x, y) !== null;
      updateRazorHover(x, y, e);
      canvas.style.cursor =
        props.razor && lane === "renders"
          ? "crosshair"
          : hoverEdge || onSection || onTempo || onBar || onClip
            ? "ew-resize"
            : lane === "ruler"
              ? "text"
              : lane === "overview"
                ? "pointer"
                : "grab";
      requestDraw();
      return;
    }
    if (drag.kind === "pan") {
      const dx = e.clientX - drag.x0;
      if (!drag.moved && Math.abs(dx) > 3) {
        drag.moved = true;
        props.onUserPan();
      }
      if (drag.moved) {
        canvas.style.cursor = "grabbing";
        props.onViewChange(Math.max(0, Math.min(total(), drag.view0 - (dx / canvasW()) * props.viewDuration)), props.viewDuration);
      }
    } else if (drag.kind === "scrub") {
      props.onSeek(Math.max(0, Math.min(total(), t)));
    } else if (drag.kind === "overview") {
      overviewScroll(x, drag.grabOffset);
    } else if (drag.kind === "tempo") {
      props.onTempoDrag(drag.idx, Math.max(0, t));
    } else if (drag.kind === "bar") {
      barGhost = { idx: drag.idx, t: Math.max(drag.lo, Math.min(drag.hi, t)) };
    } else if (drag.kind === "section") {
      const s = findSnap(t);
      snapGuide = s.label ? s : null;
      props.onSectionDrag(drag.idx, s.time);
    } else if (drag.kind === "clip") {
      if (!drag.moved && Math.abs(e.clientX - drag.x0) <= 3) return;
      drag.moved = true;
      const d = drag;
      const lane = props.lanes.find((l) => l.id === d.lane);
      const clip = lane?.clips.find((c) => c.id === d.clip);
      if (!lane || !clip) return;
      // The anchor (tick 0, or the cut of a clip that starts after it) snaps, so tick 0 lands on the beat, not the silent lead-in.
      const s = snapClip(t - d.grab, e, d);
      snapGuide = s.label ? s : null;
      // 1e-6 beat (under one sample) keeps beat and bar snaps integer despite float round trips through the grid.
      const atBeat = Math.round(atBeatForTick(props.beats ?? [], s.time, anchorTick(clip), lane.secPerTick) * 1e6) / 1e6;
      if (clip.atBeat !== atBeat) {
        if (!d.begun) {
          props.onClipDragBegin();
          d.begun = true;
        }
        props.onClipMove(d.lane, d.clip, atBeat);
      }
    } else {
      const s = findSnap(t, drag.ref);
      snapGuide = s.label ? s : null;
      props.onBoundaryDrag(drag.ref, drag.edge, Math.max(0, s.time), drag.partner);
    }
    requestDraw();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if ((drag?.kind === "pan" || drag?.kind === "clip") && !drag.moved) drag.click();
    if (drag?.kind === "tempo") props.onTempoDrop();
    if (drag?.kind === "bar" && barGhost && Math.abs(barGhost.t - (props.downbeats?.[drag.idx] ?? barGhost.t)) > 0.003) props.onBarDrop(drag.idx, barGhost.t);
    barGhost = null;
    drag = null;
    snapGuide = null;
    requestDraw();
  };

  const onDblClick = (e: MouseEvent) => {
    const { x, y } = local(e);
    if (laneAt(y) !== "lyrics") return;
    const hit = sylAt(x);
    if (hit) props.onPlayRange(hit.pair[0], hit.pair[1]);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const { x } = local(e);
      const anchor = xToT(x);
      const dur = Math.max(0.5, Math.min(total() + 5, props.viewDuration * (e.deltaY < 0 ? 0.8 : 1.25)));
      props.onViewChange(Math.max(0, anchor - (x / canvasW()) * dur), dur);
    } else if (laneAt(local(e).y) === "renders" && maxLaneScroll() > 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
      // Over the vocal lanes the wheel scrolls them up and down; Shift+wheel pans the view.
      scrollLanes(laneScroll() + e.deltaY);
    } else {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const start = props.viewStart + (delta / canvasW()) * props.viewDuration;
      props.onViewChange(Math.max(0, Math.min(total(), start)), props.viewDuration);
    }
  };

  // ── Track headers ────────────────────────────────────────────────────────

  const Header = (p: { lane: Lane; title: string; icon: string; children?: unknown }) => (
    <div class="daw-track-header" style={{ top: `${p.lane.y}px`, height: `${p.lane.h}px` }}>
      <i class={`bi bi-${p.icon} daw-track-icon`} />
      <span class="daw-track-title">{p.title}</span>
      <div class="daw-track-tools">{p.children as never}</div>
    </div>
  );

  /** Gain slider, mute and solo of one track. The controls do not take the keyboard focus (Space stays play/pause). */
  const MixControls = (p: { mix: TrackMix; onMix: (patch: Partial<TrackMix>) => void; disabled?: boolean }) => (
    <>
      <input
        class="daw-gain"
        type="range"
        min="0"
        max="1.5"
        step="0.05"
        value={p.mix.gain}
        disabled={p.disabled}
        title={`Gain ${Math.round(p.mix.gain * 100)} %`}
        onInput={(e) => p.onMix({ gain: Number(e.currentTarget.value) })}
        onChange={(e) => e.currentTarget.blur()}
      />
      <button
        class="daw-icon-btn daw-ms-btn"
        classList={{ "daw-mute-on": p.mix.mute }}
        disabled={p.disabled}
        title="Mute"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => p.onMix({ mute: !p.mix.mute })}
      >
        M
      </button>
      <button
        class="daw-icon-btn daw-ms-btn"
        classList={{ "daw-solo-on": p.mix.solo }}
        disabled={p.disabled}
        title="Solo"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => p.onMix({ solo: !p.mix.solo })}
      >
        S
      </button>
    </>
  );

  return (
    <div ref={container} class="daw-timeline">
      <div class="daw-track-headers" style={{ width: `${HEADER_W}px` }}>
        <div class="daw-track-header daw-ruler-header" style={{ top: "0px", height: `${RULER_H}px` }}>
          <span class="daw-track-title">Bars · Time</span>
        </div>
        <Header lane={layout().lanes.tempo} title="Tempo" icon="speedometer2">
          <button class="daw-icon-btn" title="Add tempo change at playhead (T)" disabled={!props.tempo || props.tempoBusy} onClick={() => props.onAddTempo()}>
            <i class="bi bi-plus-lg" />
          </button>
        </Header>
        <Header lane={layout().lanes.markers} title="Sections" icon="bookmark-fill">
          <button class="daw-icon-btn" title="Add section marker at playhead (M)" onClick={() => props.onAddSection()}>
            <i class="bi bi-plus-lg" />
          </button>
        </Header>
        <Header lane={layout().lanes.mix} title="Mix" icon="music-note-beamed">
          <button
            class="daw-icon-btn"
            classList={{ "daw-on": props.monitor === "mix" }}
            title="Listen to the full mix"
            onClick={() => props.onMonitor("mix")}
          >
            <i class="bi bi-volume-up-fill" />
          </button>
          <MixControls mix={props.trackMix.mix} onMix={(patch) => props.onTrackMix("mix", patch)} />
        </Header>
        <Header lane={layout().lanes.vocal} title={props.hasVocal ? "Vocal" : "No vocal stem"} icon="mic-fill">
          <Show when={props.hasVocal}>
            <button
              class="daw-icon-btn"
              classList={{ "daw-on": props.showPitch }}
              title="Show pitch contour"
              onClick={() => props.onTogglePitch()}
            >
              <i class="bi bi-graph-up" />
            </button>
            <button
              class="daw-icon-btn"
              classList={{ "daw-on": props.monitor === "vocal" }}
              title="Listen to the isolated vocal"
              onClick={() => props.onMonitor("vocal")}
            >
              <i class="bi bi-volume-up-fill" />
            </button>
            <MixControls mix={props.trackMix.vocal} onMix={(patch) => props.onTrackMix("vocal", patch)} />
          </Show>
        </Header>
        <Show when={props.lanes.length > 0}>
          <div
            class="daw-lane-headers"
            style={{ top: `${layout().lanes.renders.y}px`, height: `${layout().lanes.renders.h}px` }}
            onWheel={(e) => {
              e.preventDefault();
              scrollLanes(laneScroll() + e.deltaY);
            }}
          >
            <div style={{ transform: `translateY(${-laneScroll()}px)` }}>
              <Index each={props.lanes}>
                {(lane) => (
                  <div
                    class="daw-lane-header"
                    classList={{ "daw-lane-parked": lane().clips.every((c) => c.atBeat === null) }}
                    style={{ height: `${LANE_H}px` }}
                  >
                    <div class="daw-lane-row">
                      <span class="daw-lane-label" title={`${lane().id}: ${lane().ust}${lane().problem ? ` (${lane().problem})` : ""}`}>
                        {lane().id}
                      </span>
                      <Show when={lane().warning}>
                        <i class="bi bi-exclamation-triangle-fill daw-lane-warn" title={lane().warning!} />
                      </Show>
                      <button
                        class="daw-icon-btn"
                        title="Duplicate lane (the copy starts unplaced)"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => props.onLaneDuplicate(lane().id)}
                      >
                        <i class="bi bi-copy" />
                      </button>
                      <Show when={lane().removable}>
                        <button
                          class="daw-icon-btn"
                          title="Remove this lane (another lane plays the same UST)"
                          onPointerDown={(e) => e.preventDefault()}
                          onClick={() => props.onLaneRemove(lane().id)}
                        >
                          <i class="bi bi-x-lg" />
                        </button>
                      </Show>
                    </div>
                    <div class="daw-lane-row">
                      <input
                        class="daw-lane-block"
                        list="daw-lane-blocks"
                        placeholder="Lyric block"
                        aria-label="Lyric block"
                        title="Lyric block: the first line (romaji) of the lyric block this lane sings; empty = no lyrics"
                        value={lane().block}
                        onChange={(e) => {
                          props.onLaneBlock(lane().id, e.currentTarget.value.trim());
                          e.currentTarget.blur();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                        }}
                      />
                      <MixControls mix={lane().mix} onMix={(patch) => props.onLaneMix(lane().id, patch)} />
                    </div>
                  </div>
                )}
              </Index>
            </div>
            <datalist id="daw-lane-blocks">
              <For each={props.blockOptions}>{(p) => <option value={p} />}</For>
            </datalist>
          </div>
        </Show>
        <Header lane={layout().lanes.lyrics} title="Lyrics" icon="fonts">
          <Show when={props.singers.length > 0}>
            <select
              class="daw-singer-select"
              title="Singer: whose calibration file the Lyrics and Lines lanes edit (the other singers show faint underneath)"
              onChange={(e) => {
                props.onSinger(e.currentTarget.value);
                e.currentTarget.blur();
              }}
            >
              <For each={props.singers}>
                {(s) => (
                  <option value={s.id} selected={s.id === props.activeSinger}>
                    {s.lead ? `${s.id} (lead)` : s.id}
                  </option>
                )}
              </For>
            </select>
          </Show>
        </Header>
        <Show when={props.faint.length > 0}>
          <div
            class="daw-track-header daw-faint-header"
            style={{ top: `${layout().lanes.faint.y}px`, height: `${layout().lanes.faint.h}px` }}
            title="Other singers (read-only; pick one in the Lyrics lane to edit it)"
          >
            <For each={props.faint}>{(f) => <span class="daw-faint-row">{f.id}</span>}</For>
          </div>
        </Show>
        <Header lane={layout().lanes.lines} title="Lines" icon="list" />
        <div class="daw-track-header daw-overview-header" style={{ top: `${layout().overviewY}px`, height: `${OVERVIEW_H}px` }}>
          <span class="daw-track-title">Overview</span>
        </div>
      </div>
      <canvas
        ref={canvas}
        class="daw-timeline-canvas"
        style={{ left: `${HEADER_W}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          hoverEdge = null;
          razorHover = null;
          if (!drag) snapGuide = null;
          requestDraw();
        }}
        onDblClick={onDblClick}
        onWheel={onWheel}
      />
      <Show when={!props.doc}>
        <div class="daw-timeline-empty" style={{ left: `${HEADER_W}px` }}>No song loaded</div>
      </Show>
    </div>
  );
}
