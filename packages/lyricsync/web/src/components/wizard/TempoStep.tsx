// packages/lyricsync/web/src/components/wizard/TempoStep.tsx
// Tempo, tempo changes and first downbeat for the new-song wizard: the mix's waveform with the beat grid the current values give, a
// tap pad (Space) that measures the tempo, tempo changes put at the play position, and the first downbeat ("1" of the first bar) set
// by double-click, drag or the D key.
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { floorIndex, formatTimecode } from "../../lib/doc-edit";
import { MAX_BPM, MIN_BPM, parseTempoRows, tempoAt, tempoGrid, type TempoRow } from "../../lib/tempo-grid";
import { LcdDigits } from "../LcdDigits";
import { persistedSignal } from "../../lib/persisted-signal";
import { addTap, fitTaps, type Tap } from "../../lib/tap-tempo";
import { theme } from "../../stores/theme";

export interface TempoStepProps {
  mixUrl: string | null;
  /** Mix peaks at PEAKS_PER_SEC, or undefined while decoding. */
  peaks: Float32Array | undefined;
  bpm: string;
  onBpm: (v: string) => void;
  downbeat: string;
  onDownbeat: (v: string) => void;
  /** Tempo changes after the start of the song, as typed. */
  changes: TempoRow[];
  onChanges: (rows: TempoRow[]) => void;
}

export const TEMPO_PEAKS_PER_SEC = 100;
const VIEW_SEC = 8;
/** A tap more than this after the previous one starts a new measurement (on the song clock, only before the 4th tap). */
const TAP_RESET_MS = 2000;
/** Interval bars shown under the tap readout. */
const TAP_DOTS = 24;

/** One tap measurement: its taps, the clock they are on (the song's while the mix plays, else the wall clock) and the tempo it sets. */
interface TapRun {
  clock: "song" | "wall";
  /** tapTarget() when the measurement started. */
  target: number;
  taps: Tap[];
}

export function TempoStep(props: TempoStepProps) {
  let audio!: HTMLAudioElement;
  let canvas!: HTMLCanvasElement;
  let overview!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  let audioCtx: AudioContext | null = null;
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [tapRun, setTapRun] = createSignal<TapRun>({ clock: "wall", target: -1, taps: [] });
  const [flash, setFlash] = createSignal(0);
  const [click, setClick] = persistedSignal("lyricsync.wizard.metronomeClick", true);
  const [width, setWidth] = createSignal(600);

  const bpmNum = () => Number(props.bpm);
  const downbeatNum = () => (props.downbeat.trim() === "" ? null : Number(props.downbeat));

  const parsed = createMemo(() => parseTempoRows(props.changes));
  const songEnd = createMemo(() => duration() || (props.peaks ? props.peaks.length / TEMPO_PEAKS_PER_SEC : 0));
  /** The beat grid of the tempo, its changes and the first downbeat, or null while one of them is missing or invalid. */
  const grid = createMemo(() => {
    const d = downbeatNum();
    const b = bpmNum();
    const { changes, error } = parsed();
    if (d === null || !(d >= 0) || !(b >= MIN_BPM && b <= MAX_BPM) || error !== null || songEnd() === 0) return null;
    return tempoGrid(d, b, changes, songEnd());
  });

  /** Beat index at t from the grid (0 = the first downbeat), or null without a grid. */
  const beatAt = (t: number) => {
    const g = grid();
    return g === null ? null : floorIndex(g.times, t + 1e-6) - g.first;
  };

  const setRow = (i: number, patch: Partial<TempoRow>) => props.onChanges(props.changes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addChange = () => {
    const current = tempoAt(time(), bpmNum(), parsed().changes);
    props.onChanges([...props.changes, { at: time().toFixed(3), bpm: current >= MIN_BPM ? String(current) : "" }]);
  };
  /** Index of the change in force at the play position, or -1 while the starting tempo is. */
  const tapTarget = () => {
    let best = -1;
    for (const [i, r] of props.changes.entries()) {
      const at = r.at.trim() === "" ? NaN : Number(r.at);
      if (at > 0 && at <= time() && (best < 0 || at > Number(props.changes[best]!.at))) best = i;
    }
    return best;
  };
  const tapTargetLabel = () => (tapTarget() < 0 ? "the starting tempo" : `the tempo change at ${props.changes[tapTarget()]!.at} s`);

  const tapFit = createMemo(() => fitTaps(tapRun().taps));
  const resetTaps = () => setTapRun({ ...tapRun(), taps: [] });

  // Song clock for taps: the play position extrapolated with the wall clock from the last play/seek, so taps are not
  // quantized to the media element's currentTime updates.
  let clockAt = { perf: 0, song: 0 };
  const anchorClock = () => (clockAt = { perf: performance.now(), song: audio.currentTime });
  const songNow = () => clockAt.song + ((performance.now() - clockAt.perf) / 1000) * audio.playbackRate;

  let lastTapWall = 0;
  const tap = () => {
    const wall = performance.now();
    const clock = playing() ? "song" : "wall";
    const target = tapTarget();
    const run = tapRun();
    const gap = wall - lastTapWall > TAP_RESET_MS && (clock === "wall" || run.taps.length < 4);
    const prev = run.clock !== clock || run.target !== target || gap ? [] : run.taps;
    lastTapWall = wall;
    const taps = addTap(prev, clock === "song" ? songNow() : wall / 1000);
    setTapRun({ clock, target, taps });
    setFlash(flash() + 1);
    const fit = fitTaps(taps);
    if (taps.length >= 4 && fit) {
      if (target < 0) props.onBpm(fit.bpm.toFixed(2));
      else setRow(target, { bpm: fit.bpm.toFixed(2) });
    }
  };
  /** The last taps' intervals relative to the fitted beat (1 = on tempo), for the bars under the readout. */
  const tapDots = createMemo(() => {
    const fit = tapFit();
    const t = tapRun().taps.slice(-TAP_DOTS - 1);
    if (!fit) return [];
    return t.slice(1).flatMap((p, i) => (p.beat === t[i]!.beat ? [] : [(p.t - t[i]!.t) / (fit.period * (p.beat - t[i]!.beat))]));
  });

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
    else if (k === "r") resetTaps();
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
    const g = grid();
    const ch = parsed().changes;
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
    if (g !== null) {
      for (let i = Math.max(0, floorIndex(g.times, v0)); i < g.times.length && g.times[i]! <= v0 + VIEW_SEC; i++) {
        const k = i - g.first;
        const bx = Math.round(x(g.times[i]!)) + 0.5;
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
    // The grid the taps give (song clock only), every 4th beat from the first tap heavier, and the taps themselves
    const run = tapRun();
    const tf = tapFit();
    if (run.clock === "song") {
      const green = isDark ? "74,222,128" : "22,163,74";
      if (tf !== null && tf.period > 60 / (MAX_BPM * 2)) {
        ctx.setLineDash([3, 3]);
        for (let k = Math.ceil((v0 - tf.origin) / tf.period); tf.origin + k * tf.period <= v0 + VIEW_SEC; k++) {
          const bx = Math.round(x(tf.origin + k * tf.period)) + 0.5;
          const bar = ((k % 4) + 4) % 4 === 0;
          ctx.strokeStyle = `rgba(${green},${bar ? 0.95 : 0.55})`;
          ctx.lineWidth = bar ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(bx, 16);
          ctx.lineTo(bx, DETAIL_H);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      ctx.fillStyle = `rgb(${green})`;
      for (const p of run.taps) {
        const px = x(p.t);
        if (px < -6 || px > w + 6) continue;
        ctx.beginPath();
        ctx.moveTo(px, DETAIL_H - 9);
        ctx.lineTo(px - 5, DETAIL_H);
        ctx.lineTo(px + 5, DETAIL_H);
        ctx.fill();
      }
    }
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#e879f9";
    ctx.fillStyle = "#e879f9";
    ctx.lineWidth = 1.5;
    ctx.font = "600 10px 'Segoe UI', sans-serif";
    for (const c of ch) {
      const cx = Math.round(x(c.at)) + 0.5;
      if (cx < -60 || cx > w) continue;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, DETAIL_H);
      ctx.stroke();
      ctx.fillText(`${c.bpm} BPM`, cx + 3, DETAIL_H - 4);
    }
    ctx.setLineDash([]);
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
    const total = songEnd();
    if (peaks && total > 0) {
      o.fillStyle = isDark ? "#3b4658" : "#94a3b8";
      for (let px = 0; px < w; px++) {
        const a = Math.floor((px / w) * peaks.length);
        const b = Math.max(a + 1, Math.floor(((px + 1) / w) * peaks.length));
        let m = 0;
        for (let i = a; i < b; i++) if (peaks[i]! > m) m = peaks[i]!;
        o.fillRect(px, OVER_H / 2 - m * 11, 1, m * 22);
      }
      const vx = (v0 / total) * w;
      const vw = Math.max(6, (VIEW_SEC / total) * w);
      o.fillStyle = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,120,215,0.15)";
      o.fillRect(vx, 0, vw, OVER_H);
      o.strokeStyle = isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.6)";
      o.lineWidth = 1;
      o.strokeRect(vx + 0.5, 0.5, vw - 1, OVER_H - 1);
      o.fillStyle = "#ff3b30";
      o.fillRect((t / total) * w, 0, 1.5, OVER_H);
      if (d !== null) {
        o.fillStyle = "#ffb703";
        o.fillRect((d / total) * w, 0, 2, OVER_H);
      }
      o.fillStyle = "#e879f9";
      for (const c of ch) o.fillRect((c.at / total) * w, 0, 2, OVER_H);
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

  // ── Overview: press and drag like the editor's overview bar. Grabbing the view window keeps the grab point under the
  // pointer; pressing outside it centres the view (the play position) there.
  let overGrab: number | null = null;
  const overT = (e: PointerEvent) => (e.offsetX / width()) * songEnd();
  const onOverDown = (e: PointerEvent) => {
    if (e.button !== 0 || songEnd() === 0) return;
    const t = overT(e);
    overGrab = Math.abs(t - time()) <= VIEW_SEC / 2 ? t - time() : 0;
    overview.setPointerCapture(e.pointerId);
    overview.style.cursor = "grabbing";
    seek(t - overGrab);
  };
  const onOverMove = (e: PointerEvent) => {
    if (overGrab !== null) seek(overT(e) - overGrab);
  };
  const onOverUp = () => {
    overGrab = null;
    overview.style.cursor = "";
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
          anchorClock();
          raf = requestAnimationFrame(frame);
        }}
        onPlaying={anchorClock}
        onSeeked={anchorClock}
        onRateChange={anchorClock}
        onPause={() => {
          setPlaying(false);
          cancelAnimationFrame(raf);
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />

      <div class="daw-tempo-wave" ref={wrap}>
        <canvas ref={canvas} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDblClick={(e) => markDownbeat(tAtX(e.offsetX))} />
        <canvas ref={overview} class="daw-tempo-overview" onPointerDown={onOverDown} onPointerMove={onOverMove} onPointerUp={onOverUp} onPointerCancel={onOverUp} />
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
        <span class="daw-wizard-note daw-tempo-hint">Drag the waveform or the bar below it to scroll · click to jump · double-click to put beat 1 there</span>
      </div>

      <div class="daw-tempo-cards">
        <section class="daw-tempo-card">
          <header class="daw-section-title">Tempo</header>
          <button class="daw-tap-pad" classList={{ "daw-tap-pad--flash": flash() % 2 === 1, "daw-tap-pad--flash2": flash() > 0 && flash() % 2 === 0 }} onPointerDown={(e) => { e.preventDefault(); tap(); }}>
            <span class="daw-tap-label">TAP</span>
            <span class="daw-tap-key">Space</span>
          </button>
          <div class="daw-tap-readout">
            <div class="daw-tap-bpm">{tapFit() ? tapFit()!.bpm.toFixed(2) : "—"}</div>
            <div class="daw-tap-meta">
              {tapRun().taps.length} tap{tapRun().taps.length === 1 ? "" : "s"}
              <Show when={tapFit() && tapRun().taps.length >= 4}>
                {` · ±${tapFit()!.bpmError.toFixed(2)}`}
                <span classList={{ "daw-ok": tapFit()!.jitter < 0.04, "daw-warn": tapFit()!.jitter >= 0.04 }}>
                  {tapFit()!.jitter < 0.04 ? " · steady" : " · keep tapping"}
                </span>
              </Show>
            </div>
            <div class="daw-tap-dots" title="Each bar is one tap interval against the measured beat; even bars mean steady tapping">
              <For each={tapDots()}>{(r) => <span class="daw-tap-dot" style={{ height: `${Math.min(30, Math.max(3, r * 15))}px` }} />}</For>
            </div>
          </div>
          <div class="daw-field">
            <span>BPM</span>
            <input class="daw-num" value={props.bpm} onInput={(e) => props.onBpm(e.currentTarget.value)} />
            <button class="daw-btn daw-btn-sm" title="Half tempo" onClick={() => bpmNum() > 0 && props.onBpm((bpmNum() / 2).toFixed(2))}>×½</button>
            <button class="daw-btn daw-btn-sm" title="Double tempo" onClick={() => bpmNum() > 0 && props.onBpm((bpmNum() * 2).toFixed(2))}>×2</button>
            <button class="daw-btn daw-btn-sm" title="Clear the taps (R)" onClick={resetTaps}>Reset</button>
          </div>
          <p class="daw-wizard-note">
            Tap along with the beat while the song plays; every tap counts, so keep tapping until the ± is small. A skipped beat is fine. The green
            lines are the grid your taps give (heavier every 4th beat from your first tap). The beat tracker needs the tempo within about ±12 %.
            Tapping sets {tapTargetLabel()}.
          </p>
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

        <section class="daw-tempo-card">
          <header class="daw-section-title">Tempo changes (optional)</header>
          <p class="daw-wizard-note">
            If the song changes tempo (a bridge in double time, a slower outro), play to the first beat of the new tempo and add a change there. The grid
            then follows it, and the beat tracker expects that tempo from then on. Tap along to set a change's tempo.
          </p>
          <div class="daw-btn-row">
            <button class="daw-btn daw-btn-accent" onClick={(e) => { addChange(); e.currentTarget.blur(); }}>
              <i class="bi bi-plus-lg" /> Tempo change here
            </button>
          </div>
          <Index each={props.changes}>
            {(r, i) => (
              <div class="daw-field">
                <span>At (s)</span>
                <input class="daw-num" value={r().at} onInput={(e) => setRow(i, { at: e.currentTarget.value })} />
                <span>BPM</span>
                <input class="daw-num" value={r().bpm} onInput={(e) => setRow(i, { bpm: e.currentTarget.value })} />
                <button class="daw-icon-btn" title="Go there" disabled={!(Number(r().at) > 0)} onClick={() => seek(Number(r().at))}>
                  <i class="bi bi-skip-backward-fill" />
                </button>
                <button class="daw-icon-btn" title="Remove" onClick={() => props.onChanges(props.changes.filter((_, j) => j !== i))}>
                  <i class="bi bi-x-lg" />
                </button>
              </div>
            )}
          </Index>
          <Show when={parsed().error}>
            <p class="daw-wizard-note daw-warn">{parsed().error}</p>
          </Show>
        </section>
      </div>
      <div class="daw-wizard-note daw-tempo-keys">
        <kbd>Space</kbd> tap · <kbd>P</kbd> play/pause · <kbd>D</kbd> beat 1 here · <kbd>←</kbd><kbd>→</kbd> ±1 s · <kbd>R</kbd> reset taps
      </div>
    </div>
  );
}
