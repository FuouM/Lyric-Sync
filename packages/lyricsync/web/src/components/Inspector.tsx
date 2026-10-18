// packages/lyricsync/web/src/components/Inspector.tsx
// NLE-style inspector: properties of the selected syllable and its line, with nudge and pin controls.
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { isSylPinned, type CalibrationDoc } from "../lib/calibration-doc";
import { calibrationStats, formatTimecode, type SylRef } from "../lib/doc-edit";

export interface InspectorProps {
  doc: CalibrationDoc | null;
  selected: SylRef | null;
  bpm: number | null;
  bar1Time: number | null;
  onSetBar1: () => void;
  onSetEdge: (edge: "start" | "end", t: number) => void;
  onEdgeToPlayhead: (edge: "start" | "end") => void;
  onTogglePin: () => void;
  onToggleLinePin: () => void;
  onPinLineEdges: () => void;
  onPlaySyllable: () => void;
  onPlayLine: () => void;
  onStep: (dir: -1 | 1) => void;
  /** The selected word's syllables in the song's analysis (null when unknown). */
  analysedSplit: string[] | null;
  /** Re-splits the selected word from "syl|la|bles"; returns an error to show, or null when applied. */
  onResplit: (text: string) => string | null;
}

const NUDGE = 0.01;

function TimeField(p: { label: string; value: number; onChange: (t: number) => void; onPlayhead: () => void; hotkey: string }) {
  const [draft, setDraft] = createSignal<string | null>(null);
  const commit = () => {
    const v = Number(draft());
    if (draft() !== null && Number.isFinite(v)) p.onChange(v);
    setDraft(null);
  };
  return (
    <div class="daw-prop-row">
      <span class="daw-prop-label">{p.label}</span>
      <button class="daw-icon-btn" title={`Nudge ${p.label.toLowerCase()} −10 ms`} onClick={() => p.onChange(p.value - NUDGE)}>
        <i class="bi bi-chevron-left" />
      </button>
      <input
        class="daw-num"
        value={draft() ?? p.value.toFixed(3)}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <button class="daw-icon-btn" title={`Nudge ${p.label.toLowerCase()} +10 ms`} onClick={() => p.onChange(p.value + NUDGE)}>
        <i class="bi bi-chevron-right" />
      </button>
      <button class="daw-btn daw-btn-sm" title={`Set ${p.label.toLowerCase()} to playhead (${p.hotkey})`} onClick={() => p.onPlayhead()}>
        <i class="bi bi-cursor-text" /> {p.hotkey}
      </button>
    </div>
  );
}

/**
 * The selected word's syllables as "syl|la|bles". Enter applies, Escape or leaving the field reverts: a blur also happens
 * when another syllable gets selected, so applying on blur could re-split the wrong word.
 */
function SplitField(p: { wordKey: string; split: string[]; analysed: string[] | null; onResplit: (text: string) => string | null }) {
  const [draft, setDraft] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => p.wordKey, () => {
    setDraft(null);
    setError(null);
  }));
  const analysedOther = () => (p.analysed !== null && p.analysed.join("|") !== p.split.join("|") ? p.analysed.join("|") : null);
  return (
    <>
      <div class="daw-prop-row">
        <span class="daw-prop-label">Split</span>
        <input
          id="daw-split-input"
          class="daw-num daw-split-input"
          classList={{ "daw-input-error": error() !== null }}
          spellcheck={false}
          title="The word's syllables separated by | (e.g. re|con|cile). Enter applies, Escape reverts. Shortcut: E"
          value={draft() ?? p.split.join("|")}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            setError(null);
          }}
          onBlur={() => {
            setDraft(null);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const d = draft();
              const err = d === null ? null : p.onResplit(d);
              setError(err);
              if (err === null) {
                setDraft(null);
                e.currentTarget.blur();
              }
            }
            if (e.key === "Escape") e.currentTarget.blur();
          }}
        />
      </div>
      <Show when={error()}>{(m) => <div class="daw-field-error">{m()}</div>}</Show>
      <Show when={analysedOther()}>
        {(a) => <div class="daw-field-note">Analysed as {a()}: Re-analyze to use this split.</div>}
      </Show>
    </>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["Space", "Play / pause"],
  ["Enter", "Play selected syllable"],
  ["P", "Play selected line"],
  [", / .", "Previous / next syllable"],
  ["[ / ]", "Set start / end to playhead"],
  ["C", "Pin / unpin syllable"],
  ["Shift+C", "Pin / unpin whole line"],
  ["Tab", "Next unpinned line"],
  ["M", "Add section marker"],
  ["E", "Edit the word's syllable split"],
  ["B", "Bar 1 at playhead"],
  ["S", "Toggle snap"],
  ["F", "Toggle follow playhead"],
  ["+ / −", "Zoom in / out"],
  ["Ctrl+Wheel", "Zoom at cursor"],
  ["Drag empty space", "Scroll the timeline"],
  ["Ctrl+S", "Save"],
  ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
];

export function Inspector(props: InspectorProps) {
  const sel = () => {
    const s = props.selected;
    const line = s ? props.doc?.lines[s.lineIdx] : undefined;
    const word = s ? line?.words[s.wordIdx] : undefined;
    const pair = s ? word?.syl[s.sylIdx] : undefined;
    return s && line && word && pair ? { s, line, word, pair, pinned: isSylPinned(line, word, s.sylIdx) } : null;
  };

  return (
    <div class="daw-inspector">
      <Show when={props.doc} fallback={<div class="daw-empty-note">Open a song to inspect timings.</div>}>
        {(doc) => {
          const stats = () => calibrationStats(doc());
          return (
            <>
              <section class="daw-section">
                <header class="daw-section-title">Song</header>
                <div class="daw-progress" title="Pinned syllables">
                  <div class="daw-progress-fill" style={{ width: `${(stats().pinned / Math.max(1, stats().total)) * 100}%` }} />
                </div>
                <div class="daw-kv"><span>Pinned syllables</span><b>{stats().pinned} / {stats().total}</b></div>
                <div class="daw-kv"><span>Frozen lines</span><b>{stats().linesDone} / {doc().lines.length}</b></div>
                <div class="daw-kv"><span>Tempo</span><b>{props.bpm ? `${props.bpm.toFixed(1)} BPM` : "—"}</b></div>
                <div class="daw-kv">
                  <span>Bar 1</span>
                  <b>
                    {props.bar1Time === null ? "—" : formatTimecode(props.bar1Time)}{" "}
                    <button class="daw-btn daw-btn-sm" disabled={props.bar1Time === null} title="Make the beat nearest the playhead bar 1 (B)" onClick={() => props.onSetBar1()}>
                      <i class="bi bi-flag-fill" /> Set here
                    </button>
                  </b>
                </div>
              </section>

              <Show
                when={sel()}
                fallback={<div class="daw-empty-note">Click a syllable in the Lyrics track to edit it.</div>}
              >
                {(x) => (
                  <>
                    <section class="daw-section">
                      <header class="daw-section-title">
                        Syllable
                        <span class="daw-section-actions">
                          <button class="daw-icon-btn" title="Previous syllable (,)" onClick={() => props.onStep(-1)}>
                            <i class="bi bi-skip-start-fill" />
                          </button>
                          <button class="daw-icon-btn" title="Next syllable (.)" onClick={() => props.onStep(1)}>
                            <i class="bi bi-skip-end-fill" />
                          </button>
                        </span>
                      </header>
                      <div class="daw-syl-name">
                        <span class="daw-syl-text">{x().word.sylText[x().s.sylIdx]}</span>
                        <span class="daw-syl-word">in “{x().word.w}”</span>
                      </div>
                      <SplitField
                        wordKey={`${x().s.lineIdx}:${x().s.wordIdx}`}
                        split={x().word.sylText}
                        analysed={props.analysedSplit}
                        onResplit={props.onResplit}
                      />
                      <TimeField label="Start" hotkey="[" value={x().pair[0]} onChange={(t) => props.onSetEdge("start", t)} onPlayhead={() => props.onEdgeToPlayhead("start")} />
                      <TimeField label="End" hotkey="]" value={x().pair[1]} onChange={(t) => props.onSetEdge("end", t)} onPlayhead={() => props.onEdgeToPlayhead("end")} />
                      <div class="daw-kv"><span>Duration</span><b>{((x().pair[1] - x().pair[0]) * 1000).toFixed(0)} ms</b></div>
                      <div class="daw-btn-row">
                        <button class="daw-btn" classList={{ "daw-btn-pinned": x().pinned }} title="Pin / unpin this syllable (C)" onClick={() => props.onTogglePin()}>
                          <i class={`bi bi-${x().pinned ? "pin-fill" : "pin"}`} /> {x().pinned ? "Pinned" : "Pin"}
                        </button>
                        <button class="daw-btn" title="Play this syllable (Enter)" onClick={() => props.onPlaySyllable()}>
                          <i class="bi bi-play-fill" /> Play
                        </button>
                      </div>
                    </section>

                    <section class="daw-section">
                      <header class="daw-section-title">Line {x().line.i}</header>
                      <div class="daw-line-text">{x().line.text}</div>
                      <div class="daw-kv"><span>Span</span><b>{formatTimecode(x().line.start)} – {formatTimecode(x().line.end)}</b></div>
                      <div class="daw-kv"><span>Status</span><b class={x().line.calibrated ? "daw-ok" : ""}>{x().line.calibrated ? "Frozen (all pinned)" : "Solver may move it"}</b></div>
                      <div class="daw-btn-row">
                        <button class="daw-btn" title="Play this line (P)" onClick={() => props.onPlayLine()}>
                          <i class="bi bi-play-fill" /> Play line
                        </button>
                        <button class="daw-btn" title="Pin first start and last end only" onClick={() => props.onPinLineEdges()}>
                          <i class="bi bi-arrows" /> Pin edges
                        </button>
                        <button class="daw-btn" classList={{ "daw-btn-pinned": x().line.calibrated }} title="Pin / unpin every syllable (Shift+C)" onClick={() => props.onToggleLinePin()}>
                          <i class="bi bi-lock" /> {x().line.calibrated ? "Unfreeze" : "Freeze"}
                        </button>
                      </div>
                    </section>
                  </>
                )}
              </Show>
            </>
          );
        }}
      </Show>

      <section class="daw-section">
        <header class="daw-section-title">Shortcuts</header>
        <For each={SHORTCUTS}>
          {([k, v]) => (
            <div class="daw-kv daw-shortcut"><kbd>{k}</kbd><span>{v}</span></div>
          )}
        </For>
      </section>
    </div>
  );
}
