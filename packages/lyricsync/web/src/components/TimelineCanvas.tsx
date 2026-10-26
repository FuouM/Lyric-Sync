// packages/lyricsync/web/src/components/TimelineCanvas.tsx
// Multi-track NLE-style timeline: track headers, ruler (time + bars), section markers,
// mix and vocal waveforms with pitch, lyric clips with editable syllable edges, overview scrollbar.
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { theme } from "../stores/theme";
import { isSylPinned, type CalibrationDoc } from "../../../src/calibration-doc";
import { floorIndex, rollPartner, sameSyl, type SylRef } from "../lib/doc-edit";
import type { TempoMap } from "../lib/tempo-grid";

export type MonitorTrack = "vocal" | "mix";

export interface TimelineHotspot {
  time: number;
  expectedErrorMs: number;
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
  /** Called once before a drag edit starts (undo snapshot). */
  onEditBegin: () => void;
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
}

const HEADER_W = 148;
const RULER_H = 30;
const TEMPO_H = 22;
const MARKERS_H = 22;
const MIX_H = 46;
const LYRICS_H = 60;
const LINES_H = 20;
const OVERVIEW_H = 18;
const MIN_VOCAL_H = 64;
const EDGE_HIT_PX = 6;
const PITCH_FPS = 100;

interface Lane {
  id: "ruler" | "tempo" | "markers" | "mix" | "vocal" | "lyrics" | "lines";
  y: number;
  h: number;
}

function layoutLanes(height: number): { lanes: Record<Lane["id"], Lane>; overviewY: number } {
  const vocalH = Math.max(MIN_VOCAL_H, height - RULER_H - TEMPO_H - MARKERS_H - MIX_H - LYRICS_H - LINES_H - OVERVIEW_H);
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
    lyrics: lane("lyrics", LYRICS_H),
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
  const layout = createMemo(() => layoutLanes(size().h));

  let drag:
    | { kind: "boundary"; ref: SylRef; edge: "start" | "end"; partner: SylRef | null }
    | { kind: "section"; idx: number }
    | { kind: "tempo"; idx: number }
    | { kind: "scrub" }
    | { kind: "overview"; grabOffset: number }
    /** Press on empty space: a drag pans the view; a release without moving is a click (`click` runs then). */
    | { kind: "pan"; x0: number; view0: number; moved: boolean; click: () => void }
    | null = null;
  let hoverEdge: { ref: SylRef; edge: "start" | "end" } | null = null;
  let snapGuide: { time: number; label: string } | null = null;
  let frame = 0;

  const canvasW = () => size().w - HEADER_W;
  const tToX = (t: number) => ((t - props.viewStart) / props.viewDuration) * canvasW();
  const xToT = (x: number) => props.viewStart + (x / canvasW()) * props.viewDuration;
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
    const tolPx = 8;
    const tol = (tolPx / canvasW()) * props.viewDuration;
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

  const draw = () => {
    frame = 0;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvasW();
    const H = size().h;
    isDarkCurrent = theme() !== "light";
    C = isDarkCurrent ? C_DARK : C_LIGHT;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    const { lanes, overviewY } = layout();
    const v0 = props.viewStart;
    const v1 = props.viewStart + props.viewDuration;
    const contentTop = lanes.markers.y;
    const contentBottom = overviewY;

    // Lane backgrounds
    for (const l of [lanes.mix, lanes.lyrics]) {
      ctx.fillStyle = C.laneAlt;
      ctx.fillRect(0, l.y, W, l.h);
    }
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
    const pxPerBeat = beats.length > 1 ? (W / props.viewDuration) * (beats[1]! - beats[0]!) : 0;
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
    drawWave(ctx, lanes.mix, props.mixPeaks, C.mixWave, props.monitor === "mix");
    drawWave(ctx, lanes.vocal, props.vocalPeaks, C.vocalWave, props.monitor === "vocal");
    if (props.showPitch) drawPitch(ctx, lanes.vocal);
    drawLyrics(ctx, lanes.lyrics);
    drawLines(ctx, lanes.lines);
    drawOverview(ctx, W, overviewY);

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
    const pxPerSec = W / props.viewDuration;
    const step = RULER_STEPS.find((s) => s * pxPerSec >= 70) ?? 300;
    const minor = step / 5;
    ctx.strokeStyle = "#4a5160";
    ctx.beginPath();
    const first = Math.floor(props.viewStart / minor) * minor;
    for (let t = first; t <= props.viewStart + props.viewDuration; t += minor) {
      const x = Math.round(tToX(t)) + 0.5;
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, lane.y + lane.h - (isMajor ? 12 : 5));
      ctx.lineTo(x, lane.y + lane.h);
    }
    ctx.stroke();
    ctx.fillStyle = C.rulerText;
    ctx.font = "10px 'Cascadia Mono', Consolas, monospace";
    const firstMajor = Math.ceil(props.viewStart / step) * step;
    for (let t = firstMajor; t <= props.viewStart + props.viewDuration; t += step) {
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
      for (let i = Math.max(0, floorIndex(downs, props.viewStart)); i < downs.length && downs[i]! <= props.viewStart + props.viewDuration; i++) {
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
    const W = canvasW();
    const mid = lane.y + lane.h / 2;
    const half = lane.h / 2 - 3;
    const pps = props.peaksPerSec;
    ctx.fillStyle = color;
    ctx.globalAlpha = active ? 0.95 : 0.45;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const t0 = xToT(x);
      const t1 = xToT(x + 1);
      if (t1 <= 0 || t0 * pps >= peaks.length) continue;
      const a = Math.max(0, Math.floor(t0 * pps));
      const b = Math.min(peaks.length, Math.max(a + 1, Math.floor(t1 * pps)));
      let p = 0;
      for (let i = a; i < b; i++) if (peaks[i]! > p) p = peaks[i]!;
      const h = Math.max(0.5, p * half);
      ctx.rect(x, mid - h, 1, h * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  const drawPitch = (ctx: CanvasRenderingContext2D, lane: Lane) => {
    const f0 = props.pitchContour;
    const range = pitchRange();
    if (!f0 || !range) return;
    const a = Math.max(0, Math.floor(props.viewStart * PITCH_FPS));
    const b = Math.min(f0.length, Math.ceil((props.viewStart + props.viewDuration) * PITCH_FPS) + 1);
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
      if (line.end < props.viewStart || line.start > props.viewStart + props.viewDuration) return;
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

    // Hovered / dragged edge
    const he = drag?.kind === "boundary" ? drag : hoverEdge;
    const hp = he ? doc.lines[he.ref.lineIdx]?.words[he.ref.wordIdx]?.syl[he.ref.sylIdx] : undefined;
    if (he && hp) {
      const x = tToX(he.edge === "start" ? hp[0] : hp[1]);
      ctx.fillStyle = C.edgeHover;
      ctx.fillRect(Math.round(x) - 1, lane.y + 1, 3, lane.h - 2);
    }

    // Uncertainty hotspots
    for (const hs of props.hotspots) {
      if (hs.time < props.viewStart || hs.time > props.viewStart + props.viewDuration) continue;
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

  const drawLines = (ctx: CanvasRenderingContext2D, lane: Lane) => {
    const doc = props.doc;
    if (!doc) return;
    const selLine = props.selectedSyl?.lineIdx;
    doc.lines.forEach((line, li) => {
      if (line.end < props.viewStart || line.start > props.viewStart + props.viewDuration) return;
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

  createEffect(() => {
    // Track every prop that affects pixels.
    void [theme(), props.doc, props.currentTime, props.viewStart, props.viewDuration, props.beats, props.downbeats, props.bar1Index,
      props.mixPeaks, props.vocalPeaks, props.pitchContour, props.showPitch, props.selectedSyl,
      props.hotspots, props.monitor, props.duration, props.tempo, size()];
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

  /** Index of the tempo change whose grip is under x, or null. */
  const tempoGripAt = (x: number): number | null => {
    const i = (props.tempo?.tempoChanges ?? []).findIndex((c) => Math.abs(tToX(c.at) - x) <= EDGE_HIT_PX);
    return i < 0 ? null : i;
  };

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
      canvas.style.cursor = hoverEdge || onSection || onTempo ? "ew-resize" : lane === "ruler" ? "text" : lane === "overview" ? "pointer" : "grab";
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
    } else if (drag.kind === "section") {
      const s = findSnap(t);
      snapGuide = s.label ? s : null;
      props.onSectionDrag(drag.idx, s.time);
    } else {
      const s = findSnap(t, drag.ref);
      snapGuide = s.label ? s : null;
      props.onBoundaryDrag(drag.ref, drag.edge, Math.max(0, s.time), drag.partner);
    }
    requestDraw();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (drag?.kind === "pan" && !drag.moved) drag.click();
    if (drag?.kind === "tempo") props.onTempoDrop();
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
        </Header>
        <Header lane={layout().lanes.vocal} title="Vocal" icon="mic-fill">
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
        </Header>
        <Header lane={layout().lanes.lyrics} title="Lyrics" icon="fonts" />
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
