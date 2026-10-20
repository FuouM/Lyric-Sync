// packages/lyricsync/web/src/components/wizard/TempoStep.tsx
// Tempo and first downbeat for the new-song wizard: the mix's waveform with the beat grid the current values give, a tap
// pad (Space) that measures the tempo, and the first downbeat ("1" of the first bar) set by double-click, drag or the D key.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatTimecode } from "../../lib/doc-edit";
import { LcdDigits } from "../LcdDigits";
import { persistedSignal } from "../../lib/persisted-signal";
import { theme } from "../../stores/theme";

export interface TempoStepProps {
  mixUrl: string | null;
  /** Mix peaks at PEAKS_PER_SEC, or undefined while decoding. */
  peaks: Float32Array | undefined;
  bpm: string;
  onBpm: (v: string) => void;
  downbeat: string;
  onDownbeat: (v: string) => void;
}

export const TEMPO_PEAKS_PER_SEC = 100;
const VIEW_SEC = 8;
/** A tap more than this after the previous one starts a new measurement. */
const TAP_RESET_MS = 2000;
const MAX_TAPS = 16;

export function TempoStep(props: TempoStepProps) {
  let audio!: HTMLAudioElement;
  let canvas!: HTMLCanvasElement;
  let overview!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  let audioCtx: AudioContext | null = null;
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [taps, setTaps] = createSignal<number[]>([]);
  const [flash, setFlash] = createSignal(0);
  const [click, setClick] = persistedSignal("lyricsync.wizard.metronomeClick", true);
  const [width, setWidth] = createSignal(600);

  const bpmNum = () => Number(props.bpm);
  const period = () => (bpmNum() >= 40 && bpmNum() <= 260 ? 60 / bpmNum() : null);
  const downbeatNum = () => (props.downbeat.trim() === "" ? null : Number(props.downbeat));

  /** Beat index at t from the grid (0 = the first downbeat), or null without a grid. */
  const beatAt = (t: number) => {
    const p = period();
    const d = downbeatNum();
    return p === null || d === null ? null : Math.floor((t - d) / p + 1e-6);
  };

  const tapStats = createMemo(() => {
    const t = taps();
    if (t.length < 2) return null;
    const d = t.slice(1).map((x, i) => x - t[i]!);
    const sorted = [...d].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1]!;
    const mean = d.reduce((s, x) => s + x, 0) / d.length;
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / d.length);
    return { bpm: 60000 / med, spread: sd / mean };
  });

  const tap = () => {
    const now = performance.now();
    const prev = taps();
    const next = prev.length > 0 && now - prev[prev.length - 1]! > TAP_RESET_MS ? [now] : [...prev, now].slice(-MAX_TAPS);
    setTaps(next);
    setFlash(flash() + 1);
    const s = tapStats();
    if (next.length >= 4 && s) props.onBpm(s.bpm.toFixed(1));
  };

  const togglePlay = () => (audio.paused ? void audio.play() : audio.pause());
  const seek = (t: number) => {
    audio.currentTime = Math.max(0, Math.min(duration() || Infinity, t));
    setTime(audio.currentTime);
  };
  const markDownbeat = (t: number) => props.onDownbeat(Math.max(0, t).toFixed(3));

  // Metronome on the grid while playing: tick when the play position crosses a beat.
  let lastBeat: number | null = null;
  const tick = (accent: boolean) => {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = accent ? 1600 : 1050;
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.05);
  };

  let raf = 0;
  const frame = () => {
    setTime(audio.currentTime);
    const b = beatAt(audio.currentTime);
    if (click() && b !== null && lastBeat !== null && b !== lastBeat && b >= 0) tick(b % 4 === 0);
    lastBeat = b;
    raf = requestAnimationFrame(frame);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if (k === " ") tap();
    else if (k === "p") togglePlay();
    else if (k === "d") markDownbeat(audio.currentTime);
    else if (k === "r") setTaps([]);
    else if (k === "arrowleft") seek(audio.currentTime - 1);
    else if (k === "arrowright") seek(audio.currentTime + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    const ro = new ResizeObserver(() => setWidth(wrap.clientWidth));
    ro.observe(wrap);
    onCleanup(() => ro.disconnect());
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    cancelAnimationFrame(raf);
    audio.pause();
    void audioCtx?.close();
  });

  // ── Drawing ─────────────────────────────────────────────────────────────
  const DETAIL_H = 130;
  const OVER_H = 26;

  createEffect(() => {
    const w = width();
    const t = time();
    const peaks = props.peaks;
    const p = period();
    const d = downbeatNum();
    const dpr = window.devicePixelRatio || 1;
    for (const [c, h] of [[canvas, DETAIL_H], [overview, OVER_H]] as const) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }

    // Detail: VIEW_SEC around the play position
    const isDark = theme() !== "light";
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = isDark ? "#0d0f12" : "#ffffff";
    ctx.fillRect(0, 0, w, DETAIL_H);
    const v0 = t - VIEW_SEC / 2;
    const x = (s: number) => ((s - v0) / VIEW_SEC) * w;
    if (peaks) {
      ctx.fillStyle = isDark ? "#6b7a90" : "#475569";
      const mid = DETAIL_H / 2 + 8;
      for (let px = 0; px < w; px++) {
        const t0 = v0 + (px / w) * VIEW_SEC;
        const t1 = v0 + ((px + 1) / w) * VIEW_SEC;
        if (t1 <= 0 || t0 * TEMPO_PEAKS_PER_SEC >= peaks.length) continue;
        const a = Math.max(0, Math.floor(t0 * TEMPO_PEAKS_PER_SEC));
        const b = Math.min(peaks.length, Math.max(a + 1, Math.floor(t1 * TEMPO_PEAKS_PER_SEC)));
        let m = 0;
        for (let i = a; i < b; i++) if (peaks[i]! > m) m = peaks[i]!;
        const h = m * (DETAIL_H / 2 - 14);
        ctx.fillRect(px, mid - h, 1, h * 2);
      }
    }
    if (p !== null && d !== null) {
      const first = Math.ceil((v0 - d) / p);
      for (let k = first; d + k * p <= v0 + VIEW_SEC; k++) {
        const bx = Math.round(x(d + k * p)) + 0.5;
        const bar = ((k % 4) + 4) % 4 === 0;
        ctx.strokeStyle = bar ? "rgba(255,195,90,0.9)" : "rgba(111,182,255,0.45)";
        ctx.lineWidth = bar ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(bx, 16);
        ctx.lineTo(bx, DETAIL_H);
        ctx.stroke();
        if (bar && k >= 0) {
          ctx.fillStyle = "#ffc35a";
          ctx.font = "600 10px 'Segoe UI', sans-serif";
          ctx.fillText(String(k / 4 + 1), bx + 3, 12);
        }
      }
    }
    if (d !== null) {
      const fx = x(d);
      ctx.fillStyle = "#ffb703";
      ctx.fillRect(fx - 1, 0, 3, DETAIL_H);
      ctx.beginPath();
      ctx.moveTo(fx + 2, 0);
      ctx.lineTo(fx + 16, 7);
      ctx.lineTo(fx + 2, 14);
      ctx.fill();
    }
    ctx.fillStyle = "#ff3b30";
    ctx.fillRect(Math.round(w / 2), 0, 1.5, DETAIL_H);

    // Overview: whole song, the detail window, the play position
    const o = overview.getContext("2d")!;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.fillStyle = isDark ? "#101216" : "#f1f3f6";
    o.fillRect(0, 0, w, OVER_H);
    const total = duration() || (peaks ? peaks.length / TEMPO_PEAKS_PER_SEC : 0);
    if (peaks && total > 0) {
      o.fillStyle = isDark ? "#3b4658" : "#94a3b8";
      for (let px = 0; px < w; px++) {
        const a = Math.floor((px / w) * peaks.length);
        const b = Math.max(a + 1, Math.floor(((px + 1) / w) * peaks.length));
        let m = 0;
        for (let i = a; i < b; i++) if (peaks[i]! > m) m = peaks[i]!;
        o.fillRect(px, OVER_H / 2 - m * 11, 1, m * 22);
      }
      o.fillStyle = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,120,215,0.15)";
      o.fillRect((v0 / total) * w, 0, (VIEW_SEC / total) * w, OVER_H);
      o.fillStyle = "#ff3b30";
      o.fillRect((t / total) * w, 0, 1.5, OVER_H);
      if (d !== null) {
        o.fillStyle = "#ffb703";
        o.fillRect((d / total) * w, 0, 2, OVER_H);
      }
    }
  });

  // ── Detail interaction: drag = scroll, click = go there, double-click = downbeat, drag the flag = move downbeat ──
  let drag: { kind: "pan" | "flag"; x0: number; t0: number; moved: boolean } | null = null;
  const tAtX = (px: number) => time() - VIEW_SEC / 2 + (px / width()) * VIEW_SEC;
  const onDown = (e: PointerEvent) => {
    const px = e.offsetX;
    const d = downbeatNum();
    const onFlag = d !== null && Math.abs(((d - (time() - VIEW_SEC / 2)) / VIEW_SEC) * width() - px) < 8;
    drag = { kind: onFlag ? "flag" : "pan", x0: e.clientX, t0: time(), moved: false };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const d = downbeatNum();
    const onFlag = d !== null && Math.abs(((d - (time() - VIEW_SEC / 2)) / VIEW_SEC) * width() - e.offsetX) < 8;
    canvas.style.cursor = drag?.kind === "pan" ? "grabbing" : onFlag || drag?.kind === "flag" ? "ew-resize" : "grab";
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (Math.abs(dx) > 2) drag.moved = true;
    if (drag.kind === "pan") seek(drag.t0 - (dx / width()) * VIEW_SEC);
    else markDownbeat(tAtX(e.offsetX));
  };
  const onUp = (e: PointerEvent) => {
    if (drag && !drag.moved && drag.kind === "pan") seek(tAtX(e.offsetX));
    drag = null;
  };

  const lightBeat = () => {
    const b = beatAt(time());
    return b === null || b < 0 ? -1 : b % 4;
  };

  return (
    <div class="daw-tempo">
      <audio
        ref={audio}
        src={props.mixUrl ?? undefined}
        onPlay={() => {
          setPlaying(true);
          raf = requestAnimationFrame(frame);
        }}
        onPause={() => {
          setPlaying(false);
          cancelAnimationFrame(raf);
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />

      <div class="daw-tempo-wave" ref={wrap}>
        <canvas ref={canvas} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDblClick={(e) => markDownbeat(tAtX(e.offsetX))} />
        <canvas ref={overview} class="daw-tempo-overview" onPointerDown={(e) => seek((e.offsetX / width()) * (duration() || 0))} />
        <Show when={!props.peaks}>
          <div class="daw-tempo-loading">Reading the mix…</div>
        </Show>
      </div>

      <div class="daw-tempo-transport">
        <button class="daw-tbtn daw-tbtn-play" classList={{ "daw-on": playing() }} title="Play / pause (P)" onClick={(e) => { togglePlay(); e.currentTarget.blur(); }}>
          <i class={`bi bi-${playing() ? "pause-fill" : "play-fill"}`} />
        </button>
        <span class="daw-lcd daw-wizard-time">
          <span class="daw-lcd-glass">
            <LcdDigits class="daw-lcd-main" text={formatTimecode(time())} />
          </span>
        </span>
        <div class="daw-beat-lights">
          <For each={[0, 1, 2, 3]}>{(i) => <span class="daw-beat-light" classList={{ "daw-beat-light--on": lightBeat() === i, "daw-beat-light--one": i === 0 }}>{i + 1}</span>}</For>
        </div>
        <button class="daw-toggle" classList={{ "daw-on": click() }} title="Click on the grid while playing" onClick={(e) => { setClick(!click()); e.currentTarget.blur(); }}>
          <i class="bi bi-bell-fill" /> Click
        </button>
        <span class="daw-wizard-note daw-tempo-hint">Drag the waveform to scroll · click to jump · double-click to put beat 1 there</span>
      </div>

      <div class="daw-tempo-cards">
        <section class="daw-tempo-card">
          <header class="daw-section-title">Tempo</header>
          <button class="daw-tap-pad" classList={{ "daw-tap-pad--flash": flash() % 2 === 1, "daw-tap-pad--flash2": flash() > 0 && flash() % 2 === 0 }} onPointerDown={(e) => { e.preventDefault(); tap(); }}>
            <span class="daw-tap-label">TAP</span>
            <span class="daw-tap-key">Space</span>
          </button>
          <div class="daw-tap-readout">
            <div class="daw-tap-bpm">{tapStats() ? tapStats()!.bpm.toFixed(1) : "—"}</div>
            <div class="daw-tap-meta">
              {taps().length} tap{taps().length === 1 ? "" : "s"}
              <Show when={tapStats() && taps().length >= 4}>
                <span classList={{ "daw-ok": tapStats()!.spread < 0.04, "daw-warn": tapStats()!.spread >= 0.04 }}>
                  {tapStats()!.spread < 0.04 ? " · steady" : " · keep tapping"}
                </span>
              </Show>
            </div>
            <div class="daw-tap-dots" title="Each bar is one tap interval; even bars mean steady tapping">
              <For each={taps().slice(1).map((t, i) => t - taps()[i]!)}>
                {(d) => {
                  const med = tapStats() ? 60000 / tapStats()!.bpm : d;
                  return <span class="daw-tap-dot" style={{ height: `${Math.min(30, Math.max(3, (d / med) * 15))}px` }} />;
                }}
              </For>
            </div>
          </div>
          <div class="daw-field">
            <span>BPM</span>
            <input class="daw-num" value={props.bpm} onInput={(e) => props.onBpm(e.currentTarget.value)} />
            <button class="daw-btn daw-btn-sm" title="Half tempo" onClick={() => bpmNum() > 0 && props.onBpm((bpmNum() / 2).toFixed(1))}>×½</button>
            <button class="daw-btn daw-btn-sm" title="Double tempo" onClick={() => bpmNum() > 0 && props.onBpm((bpmNum() * 2).toFixed(1))}>×2</button>
            <button class="daw-btn daw-btn-sm" title="Clear the taps (R)" onClick={() => setTaps([])}>Reset</button>
          </div>
          <p class="daw-wizard-note">Tap along with the beat while the song plays. The beat tracker needs the tempo within about ±12 %.</p>
        </section>

        <section class="daw-tempo-card">
          <header class="daw-section-title">First downbeat (optional)</header>
          <p class="daw-wizard-note">
            Beat <b>1</b> of the first full bar. It decides which beat counts as "1"; without it the tracker guesses. Play, and press <kbd>D</kbd> on the
            first strong beat, or double-click the waveform there; drag the gold flag to fine-tune.
          </p>
          <div class="daw-btn-row">
            <button class="daw-btn daw-btn-accent" onClick={(e) => { markDownbeat(time()); e.currentTarget.blur(); }}>
              <i class="bi bi-flag-fill" /> Beat 1 here (D)
            </button>
            <button class="daw-btn" disabled={downbeatNum() === null} onClick={() => seek((downbeatNum() ?? 0) - 1)}>
              <i class="bi bi-skip-backward-fill" /> Go to it
            </button>
          </div>
          <div class="daw-field">
            <span>Time (s)</span>
            <button class="daw-icon-btn" title="−10 ms" disabled={downbeatNum() === null} onClick={() => markDownbeat((downbeatNum() ?? 0) - 0.01)}>
              <i class="bi bi-chevron-left" />
            </button>
            <input class="daw-num" placeholder="not set" value={props.downbeat} onInput={(e) => props.onDownbeat(e.currentTarget.value)} />
            <button class="daw-icon-btn" title="+10 ms" disabled={downbeatNum() === null} onClick={() => markDownbeat((downbeatNum() ?? 0) + 0.01)}>
              <i class="bi bi-chevron-right" />
            </button>
            <button class="daw-btn daw-btn-sm" disabled={downbeatNum() === null} onClick={() => props.onDownbeat("")}>Clear</button>
          </div>
          <p class="daw-wizard-note">With both set, the gold bar lines and the click should land on the music. If they drift, the tempo is off.</p>
        </section>
      </div>
      <div class="daw-wizard-note daw-tempo-keys">
        <kbd>Space</kbd> tap · <kbd>P</kbd> play/pause · <kbd>D</kbd> beat 1 here · <kbd>←</kbd><kbd>→</kbd> ±1 s · <kbd>R</kbd> reset taps
      </div>
    </div>
  );
}
