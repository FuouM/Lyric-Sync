// packages/lyricsync/web/src/components/Inspector.tsx
// NLE-style inspector: properties of the selected syllable and its line, with nudge and pin controls.
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { isSylPinned, type CalibrationDoc } from "../../../src/calibration-doc";
import { calibrationStats, formatTimecode, type SylRef } from "../lib/doc-edit";
import type { TempoMap } from "../lib/tempo-grid";
import { GroupBox } from "./GroupBox";

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
  /** The song's tempo map from the dev server, or null when the song is not open through it. */
  tempo: TempoMap | null;
  tempoBusy: boolean;
  /** Applies an edited tempo map (the server re-fits the beats). */
  onTempoEdit: (map: TempoMap) => void;
  onAddTempo: () => void;
  onSeek: (t: number) => void;
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
        Set ({p.hotkey})
      </button>
    </div>
  );
}

/** One row of the tempo map: where it starts (null for the start of the song) and its BPM. Enter, or leaving the row, applies an edit. */
function TempoRow(p: {
  label: string;
  at: number | null;
  bpm: number;
  disabled: boolean;
  onChange: (at: number, bpm: number) => void;
  onGo?: () => void;
  onRemove?: () => void;
}) {
  const [atDraft, setAtDraft] = createSignal<string | null>(null);
  const [bpmDraft, setBpmDraft] = createSignal<string | null>(null);
  const commit = () => {
    const at = atDraft() === null ? p.at : Number(atDraft());
    const bpm = bpmDraft() === null ? p.bpm : Number(bpmDraft());
    setAtDraft(null);
    setBpmDraft(null);
    if (at === null || !Number.isFinite(at) || !Number.isFinite(bpm)) return;
    if (at !== p.at || bpm !== p.bpm) p.onChange(at, bpm);
  };
  const keys = (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      setAtDraft(null);
      setBpmDraft(null);
      e.currentTarget.blur();
    }
  };
  return (
    <div class="daw-prop-row" onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && commit()}>
      <span class="daw-prop-label">{p.label}</span>
      <Show when={p.at !== null}>
        <input class="daw-num" title="Starts at (seconds)" disabled={p.disabled} value={atDraft() ?? p.at!.toFixed(3)} onInput={(e) => setAtDraft(e.currentTarget.value)} onKeyDown={keys} />
      </Show>
      <input class="daw-num" title="Tempo (BPM)" disabled={p.disabled} value={bpmDraft() ?? String(p.bpm)} onInput={(e) => setBpmDraft(e.currentTarget.value)} onKeyDown={keys} />
      <span class="daw-muted">BPM</span>
      <Show when={p.onGo}>
        <button class="daw-icon-btn" title="Go to this change" onClick={() => p.onGo!()}>
          <i class="bi bi-skip-backward-fill" />
        </button>
      </Show>
      <Show when={p.onRemove}>
        <button class="daw-icon-btn" title="Remove this change" disabled={p.disabled} onClick={() => p.onRemove!()}>
          <i class="bi bi-x-lg" />
        </button>
      </Show>
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
              <GroupBox title="Song Details">
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
              </GroupBox>

              <GroupBox
                title="Tempo Map"
                actions={
                  <button class="daw-icon-btn" title="Add a tempo change at the playhead (T)" disabled={!props.tempo || props.tempoBusy} onClick={() => props.onAddTempo()}>
                    <i class="bi bi-plus-lg" />
                  </button>
                }
              >
                <Show when={props.tempo} fallback={<div class="daw-empty-note">Open the song through the dev server to edit its tempo.</div>}>
                  {(map) => (
                    <>
                      <TempoRow label="Start" at={null} bpm={map().nearestBpm} disabled={props.tempoBusy} onChange={(_, bpm) => props.onTempoEdit({ ...map(), nearestBpm: bpm })} />
                      <For each={map().tempoChanges}>
                        {(c, i) => (
                          <TempoRow
                            label={`Change ${i() + 1}`}
                            at={c.at}
                            bpm={c.bpm}
                            disabled={props.tempoBusy}
                            onChange={(at, bpm) =>
                              props.onTempoEdit({ ...map(), tempoChanges: map().tempoChanges.map((x, j) => (j === i() ? { at, bpm } : x)).sort((a, b) => a.at - b.at) })
                            }
                            onGo={() => props.onSeek(c.at)}
                            onRemove={() => props.onTempoEdit({ ...map(), tempoChanges: map().tempoChanges.filter((_, j) => j !== i()) })}
                          />
                        )}
                      </For>
                      <p class="daw-wizard-note">
                        Drag a grip in the Tempo track, or type here. Put a change on the first beat of the new tempo. The beats follow at once; Re-analyze, then Auto-time, re-fits the lyric timing to them.
                      </p>
                    </>
                  )}
                </Show>
              </GroupBox>

              <Show
                when={sel()}
                fallback={<div class="daw-empty-note">Click a syllable in the Lyrics track to edit it.</div>}
              >
                {(x) => (
                  <>
                    <GroupBox
                      title="Selected Syllable"
                      actions={
                        <>
                          <button class="daw-icon-btn" title="Previous syllable (,)" onClick={() => props.onStep(-1)}>
                            <i class="bi bi-skip-start-fill" />
                          </button>
                          <button class="daw-icon-btn" title="Next syllable (.)" onClick={() => props.onStep(1)}>
                            <i class="bi bi-skip-end-fill" />
                          </button>
                        </>
                      }
                    >
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
                    </GroupBox>

                    <GroupBox title={`Line ${x().line.i}`}>
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
                    </GroupBox>
                  </>
                )}
              </Show>
            </>
          );
        }}
      </Show>

      <GroupBox title="Keyboard Shortcuts" collapsible defaultCollapsed={false}>
        <For each={SHORTCUTS}>
          {([k, v]) => (
            <div class="daw-kv daw-shortcut"><kbd>{k}</kbd><span>{v}</span></div>
          )}
        </For>
      </GroupBox>
    </div>
  );
}
