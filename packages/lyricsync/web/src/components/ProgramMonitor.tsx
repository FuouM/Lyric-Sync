// packages/lyricsync/web/src/components/ProgramMonitor.tsx
// NLE "program monitor": a karaoke stage in the style of the video editor's placeholder scene. Sung syllables turn cyan,
// the syllable being sung glows amber, coming ones stay dim, and a progress bar under every syllable fills as it is sung.
// A pill names the word and syllable being sung; the next line is previewed. Timecode, section, bar and beat overlays,
// and a metronome click.
import { createEffect, createMemo, For, onCleanup, Show, type JSX } from "solid-js";
import { isSylPinned, type CalibrationDoc, type CalLine, type CalWord } from "../lib/calibration-doc";
import { barBeatAt, floorIndex, formatTimecode, lineAt } from "../lib/doc-edit";

export interface ProgramMonitorProps {
  doc: CalibrationDoc | null;
  currentTime: number;
  beats?: number[];
  downbeats?: number[];
  /** Index in `downbeats` of bar 1. */
  bar1Index: number;
  isPlaying: boolean;
  metronome: boolean;
  /** Shown instead of the stage when no song is loaded. */
  empty?: JSX.Element;
}

/** Show the next line this long before it starts, and keep the last one this long after it ends. */
const LEAD_SEC = 0.6;
const HOLD_SEC = 2.0;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function ProgramMonitor(props: ProgramMonitorProps) {
  let audioCtx: AudioContext | null = null;
  let prevTime = 0;

  const click = (accent: boolean) => {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.05);
  };

  // Click when the playhead crosses a beat during playback.
  createEffect(() => {
    const t = props.currentTime;
    const beats = props.beats ?? [];
    if (props.metronome && props.isPlaying && t > prevTime && t - prevTime < 0.25) {
      const i = floorIndex(beats, t);
      if (i >= 0 && beats[i]! > prevTime) {
        const isDown = (props.downbeats ?? []).some((d) => Math.abs(d - beats[i]!) < 0.03);
        click(isDown);
      }
    }
    prevTime = t;
  });
  onCleanup(() => void audioCtx?.close());

  /** The line on stage (sung, about to start, or just ended) and the one after it. */
  const stage = createMemo(() => {
    const doc = props.doc;
    if (!doc) return null;
    const t = props.currentTime;
    const li = lineAt(doc, t);
    const cur = li >= 0 ? doc.lines[li] : undefined;
    const next = doc.lines[li + 1];
    let idx = -1;
    if (cur && t <= cur.end) idx = li;
    else if (next && next.start - t <= LEAD_SEC) idx = li + 1;
    else if (cur && t - cur.end < HOLD_SEC) idx = li;
    return { idx, line: idx >= 0 ? doc.lines[idx] : undefined, next: doc.lines[idx >= 0 ? idx + 1 : li + 1], total: doc.lines.length };
  });

  /** The word being sung and where in it. */
  const singing = createMemo(() => {
    const line = stage()?.line;
    const t = props.currentTime;
    const w = line?.words.find((x) => t >= x.start && t < x.end);
    if (!w) return null;
    const si = Math.max(0, w.syl.findIndex(([s0, s1]) => t >= s0 && t < s1));
    const [s0, s1] = w.syl[si]!;
    return { w, si, p: clamp01((t - s0) / Math.max(1e-3, s1 - s0)) };
  });

  const section = () => props.doc?.sections.find((s) => props.currentTime >= s.start && props.currentTime < s.end);
  const pos = () => barBeatAt(props.currentTime, props.beats, props.downbeats, props.bar1Index);

  const Syllable = (p: { line: CalLine; w: CalWord; si: number }) => {
    const pair = () => p.w.syl[p.si]!;
    const state = () => (props.currentTime >= pair()[1] ? "past" : props.currentTime >= pair()[0] ? "active" : "future");
    const fill = () => (state() === "past" ? 1 : state() === "active" ? clamp01((props.currentTime - pair()[0]) / Math.max(1e-3, pair()[1] - pair()[0])) : 0);
    return (
      <span class={`kara-syl kara-syl--${state()}`} classList={{ "kara-syl--pinned": isSylPinned(p.line, p.w, p.si) }}>
        <span class="kara-syl-text">{p.w.sylText[p.si]}</span>
        <span class="kara-syl-bar">
          <span class="kara-syl-fill" style={{ width: `${fill() * 100}%` }} />
        </span>
      </span>
    );
  };

  return (
    <div class="daw-monitor">
      <div class="daw-monitor-stage">
        <Show when={props.doc} fallback={props.empty}>
          <div class="daw-monitor-overlay-tl">{formatTimecode(props.currentTime)}</div>
          <div class="daw-monitor-overlay-tr">{section()?.name ?? ""}</div>

          <div class="kara-card">
            <div class="kara-head">
              <span class="kara-title">KARAOKE STAGE</span>
              <Show when={stage()?.line}>
                {(line) => (
                  <span class="kara-line-info">
                    LINE {stage()!.idx + 1} OF {stage()!.total} · [{line().start.toFixed(2)}s – {line().end.toFixed(2)}s]
                  </span>
                )}
              </Show>
            </div>

            <div class="kara-line">
              <Show when={stage()?.line} fallback={<span class="kara-rest">♪</span>}>
                {(line) => (
                  <For each={line().words}>
                    {(w) => (
                      <span class="kara-word">
                        <For each={w.syl}>{(_, si) => <Syllable line={line()} w={w} si={si()} />}</For>
                      </span>
                    )}
                  </For>
                )}
              </Show>
            </div>

            <div class="kara-pill-row">
              <Show when={singing()}>
                {(s) => (
                  <span class="kara-pill">
                    SINGING: “{s().w.w.toUpperCase()}”
                    <Show when={s().w.syl.length > 1}>
                      {" "}· SYL {s().si + 1}/{s().w.syl.length} [{(s().w.sylText[s().si] ?? "").toUpperCase()}]
                    </Show>{" "}
                    ({Math.round(s().p * 100)}%)
                  </span>
                )}
              </Show>
            </div>

            <div class="kara-next">
              <Show when={stage()?.next}>{(n) => <>NEXT: {n().text}</>}</Show>
            </div>
          </div>

          <Show when={pos()}>
            {(bp) => (
              <div class="daw-monitor-beats">
                <span class="daw-monitor-bar">BAR {bp().bar}</span>
                <For each={[1, 2, 3, 4]}>
                  {(b) => <span class="daw-beat-dot" classList={{ "daw-beat-dot--on": bp().beat === b, "daw-beat-dot--down": b === 1 }} />}
                </For>
              </div>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
