// packages/lyricsync/web/src/components/ProgramMonitor.tsx
// NLE "program monitor": a karaoke stage in a WinForms look. Sung syllables turn blue, the syllable being sung is shown selected
// (a highlight block), coming ones stay gray, and a progress bar under every syllable fills as it is sung. A status strip names the
// word and syllable being sung; the next line is previewed. Timecode, section, bar and beat overlays, and a metronome click.
// Per frame only what moves is touched: the line, word, syllable and state memos change at boundaries, the fill of the syllable being
// sung is a transform, and the percentage changes at most 100 times per syllable.
import { createEffect, createMemo, For, onCleanup, Show, type JSX } from "solid-js";
import { isSylPinned, type CalibrationDoc, type CalLine, type CalWord } from "../../../src/calibration-doc";
import { barBeatAt, floorIndex, formatTimecode, lineAt, sylUnits } from "../lib/doc-edit";

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

  /** The line on stage (sung, about to start, or just ended) and the one after it, as indices: they change a few times a line, not per frame. */
  const nav = createMemo(
    () => {
      const doc = props.doc;
      if (!doc) return { idx: -1, next: -1 };
      const t = props.currentTime;
      const li = lineAt(doc, t);
      const cur = doc.lines[li];
      const nxt = doc.lines[li + 1];
      let idx = -1;
      if (cur && t <= cur.end) idx = li;
      else if (nxt && nxt.start - t <= LEAD_SEC) idx = li + 1;
      else if (cur && t - cur.end < HOLD_SEC) idx = li;
      return { idx, next: idx >= 0 ? idx + 1 : li + 1 };
    },
    undefined,
    { equals: (a, b) => a.idx === b.idx && a.next === b.next },
  );
  const line = createMemo(() => props.doc?.lines[nav().idx]);
  const nextLine = () => props.doc?.lines[nav().next];

  /** The word being sung and its syllable; it changes per syllable, the percentage in it is `pct`. */
  const singing = createMemo(
    () => {
      const t = props.currentTime;
      const w = line()?.words.find((x) => t >= x.start && t < x.end);
      if (!w) return null;
      return { w, si: Math.max(0, w.syl.findIndex(([s0, s1]) => t >= s0 && t < s1)) };
    },
    undefined,
    { equals: (a, b) => a?.w === b?.w && a?.si === b?.si },
  );
  const pct = createMemo(() => {
    const s = singing();
    if (!s) return 0;
    const [s0, s1] = s.w.syl[s.si]!;
    return Math.round(clamp01((props.currentTime - s0) / Math.max(1e-3, s1 - s0)) * 100);
  });

  const section = createMemo(() => props.doc?.sections.find((s) => props.currentTime >= s.start && props.currentTime < s.end));
  const pos = createMemo(() => barBeatAt(props.currentTime, props.beats, props.downbeats, props.bar1Index), undefined, {
    equals: (a, b) => a?.bar === b?.bar && a?.beat === b?.beat,
  });

  /** One unit of a word: syllables `from`..`to` (more than one when the lyrics join them with "+"). It fills over their whole span. */
  const Syllable = (p: { line: CalLine; w: CalWord; from: number; to: number }) => {
    const start = () => p.w.syl[p.from]![0];
    const end = () => p.w.syl[p.to]![1];
    const state = createMemo(() => (props.currentTime >= end() ? "past" : props.currentTime >= start() ? "active" : "future"));
    const pinned = () => Array.from({ length: p.to - p.from + 1 }, (_, k) => isSylPinned(p.line, p.w, p.from + k)).every(Boolean);
    let fill!: HTMLSpanElement;
    // Only the syllable being sung follows the clock (this effect reads it only then); past and future fills are set by their class.
    createEffect(() => {
      if (state() === "active") {
        fill.style.transform = `scaleX(${clamp01((props.currentTime - start()) / Math.max(1e-3, end() - start())).toFixed(3)})`;
      } else {
        fill.style.removeProperty("transform");
      }
    });
    return (
      <span class={`kara-syl kara-syl--${state()}${pinned() ? " kara-syl--pinned" : ""}`}>
        <span class="kara-syl-text">{p.w.sylText.slice(p.from, p.to + 1).join("")}</span>
        <span class="kara-syl-bar">
          <span class="kara-syl-fill" ref={fill} />
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
            <span class="kara-title">Karaoke stage</span>
            <div class="kara-head">
              <Show when={line()}>
                {(l) => (
                  <span class="kara-line-info">
                    Line {nav().idx + 1} of {props.doc!.lines.length} · [{l().start.toFixed(2)}s – {l().end.toFixed(2)}s]
                  </span>
                )}
              </Show>
            </div>

            <div class="kara-line">
              <Show when={line()} fallback={<span class="kara-rest">♪</span>}>
                {(l) => (
                  <For each={l().words}>
                    {(w) => (
                      <span class="kara-word">
                        <For each={sylUnits(w)}>{([from, to]) => <Syllable line={l()} w={w} from={from} to={to} />}</For>
                      </span>
                    )}
                  </For>
                )}
              </Show>
            </div>

            <div class="kara-status">
              <Show when={singing()}>
                {(s) => (
                  <>
                    <span class="kara-status-text">
                      Singing “{s().w.w}”
                      <Show when={s().w.syl.length > 1}>
                        {" "}· syllable {s().si + 1}/{s().w.syl.length} [{s().w.sylText[s().si] ?? ""}]
                      </Show>
                    </span>
                    <span class="kara-pct">{pct()}%</span>
                  </>
                )}
              </Show>
            </div>

            <div class="kara-next">
              <Show when={nextLine()}>{(n) => <>Next: {n().text}</>}</Show>
            </div>
          </div>

          <Show when={pos()}>
            {(bp) => (
              <div class="daw-monitor-beats">
                <span class="daw-monitor-bar">Bar {bp().bar}</span>
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
