// packages/lyricsync/web/src/components/ProjectPanel.tsx
// Left dock: song browser (library mode), line list, review queue and section markers.
import { createEffect, For, Show } from "solid-js";
import { isSylPinned, type CalibrationDoc } from "../../../src/calibration-doc";
import type { LineReview } from "../../../src/types";
import { formatTimecode } from "../lib/doc-edit";

export type ProjectTab = "songs" | "lines" | "review" | "sections";

export interface ProjectPanelProps {
  tab: ProjectTab;
  onTab: (tab: ProjectTab) => void;
  songs: string[];
  activeSong: string | null;
  onOpenSong: (name: string) => void;
  doc: CalibrationDoc | null;
  reviewLines: LineReview[];
  selectedLine: number | null;
  playingLine: number;
  onSelectLine: (lineIdx: number) => void;
  onSeek: (t: number) => void;
  onRenameSection: (idx: number, name: string) => void;
  /** Moves a section's start (the previous section's end follows). */
  onSetSectionStart: (idx: number, t: number) => void;
  currentTime: number;
  onRemoveSection: (idx: number) => void;
  onAddSection: () => void;
  onEditLyrics?: (lineIdx?: number) => void;
}

export function ProjectPanel(props: ProjectPanelProps) {
  let listEl: HTMLDivElement | undefined;

  createEffect(() => {
    const li = props.selectedLine;
    if (props.tab !== "lines" || li === null || !listEl) return;
    listEl.querySelector(`[data-line="${li}"]`)?.scrollIntoView({ block: "nearest" });
  });

  const tabs = (): Array<{ id: ProjectTab; label: string; count?: number }> => [
    ...(props.songs.length > 0 ? [{ id: "songs" as const, label: "Songs", count: props.songs.length }] : []),
    { id: "lines", label: "Lines", count: props.doc?.lines.length },
    { id: "review", label: "Review", count: props.reviewLines.length },
    { id: "sections", label: "Sections", count: props.doc?.sections.length },
  ];

  return (
    <div class="daw-panel">
      <div class="daw-tabs">
        <For each={tabs()}>
          {(t) => (
            <button class="daw-tab" classList={{ "daw-tab--active": props.tab === t.id }} onClick={() => props.onTab(t.id)}>
              {t.label}
              <Show when={t.count !== undefined}>
                <span class="daw-tab-count">{t.count}</span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <div class="daw-panel-body" ref={listEl}>
        <Show when={props.tab === "songs"}>
          <For each={props.songs}>
            {(s) => (
              <div class="daw-row" classList={{ "daw-row--selected": s === props.activeSong }} onClick={() => props.onOpenSong(s)}>
                <i class="bi bi-folder2" />
                <span class="daw-row-text">{s}</span>
              </div>
            )}
          </For>
        </Show>

        <Show when={props.tab === "lines"}>
          <Show when={props.doc} fallback={<div class="daw-empty-note">No lyrics loaded.</div>}>
            <div class="daw-lines-toolbar">
              <span class="daw-lines-count">{props.doc!.lines.length} lines</span>
              <button
                type="button"
                class="daw-btn daw-btn-sm"
                onClick={() => props.onEditLyrics?.()}
                title="Edit lyrics in full text editor"
              >
                <i class="bi bi-pencil" /> Edit Lyrics
              </button>
            </div>
            <For each={props.doc!.lines}>
              {(l, idx) => {
                const pinned = () => l.words.reduce((n, w) => n + w.syl.filter((_, si) => isSylPinned(l, w, si)).length, 0);
                const total = () => l.words.reduce((n, w) => n + w.syl.length, 0);
                return (
                  <div
                    class="daw-row daw-line-row"
                    data-line={idx()}
                    classList={{
                      "daw-row--selected": props.selectedLine === idx(),
                      "daw-row--playing": props.playingLine === idx(),
                    }}
                    onClick={() => props.onSelectLine(idx())}
                    onDblClick={() => props.onEditLyrics?.(idx())}
                    title={`${l.text} (double-click to edit)`}
                  >
                    <span class="daw-line-num">{l.i}</span>
                    <span class="daw-line-tc">{formatTimecode(l.start)}</span>
                    <span class="daw-row-text">{l.text}</span>
                    <span
                      class="daw-pin-badge"
                      classList={{ "daw-pin-badge--full": l.calibrated, "daw-pin-badge--part": !l.calibrated && pinned() > 0 }}
                      title={`${pinned()} / ${total()} syllables pinned`}
                    >
                      {l.calibrated ? <i class="bi bi-lock-fill" /> : pinned() > 0 ? `${pinned()}/${total()}` : ""}
                    </span>
                  </div>
                );
              }}
            </For>
          </Show>
        </Show>

        <Show when={props.tab === "review"}>
          <Show
            when={props.reviewLines.length > 0}
            fallback={<div class="daw-empty-note">No review data. Run the solver to rank uncertain boundaries.</div>}
          >
            <For each={props.reviewLines}>
              {(r) => {
                const line = () => props.doc?.lines.findIndex((l) => l.i === r.line) ?? -1;
                return (
                  <div class="daw-review-item">
                    <div class="daw-row" onClick={() => line() >= 0 && props.onSelectLine(line())}>
                      <span class="daw-line-num">{r.line}</span>
                      <span class="daw-row-text">{props.doc?.lines[line()]?.text ?? ""}</span>
                      <span class="daw-err" classList={{ "daw-err--high": r.meanExpectedErrorMs > 30 }}>
                        ±{r.meanExpectedErrorMs.toFixed(0)} ms
                      </span>
                    </div>
                    <div class="daw-chip-row">
                      <For each={r.uncertain.slice(0, 4)}>
                        {(u) => (
                          <button
                            class="daw-chip"
                            title={`Expected error ±${u.expectedErrorMs.toFixed(1)} ms`}
                            onClick={() => props.onSeek(Math.max(0, u.time - 0.3))}
                          >
                            {u.syllable || `#${u.boundary}`} <span>{u.time.toFixed(2)}s</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                );
              }}
            </For>
          </Show>
        </Show>

        <Show when={props.tab === "sections"}>
          <Show when={props.doc} fallback={<div class="daw-empty-note">No song loaded.</div>}>
            <For each={props.doc!.sections}>
              {(sec, idx) => (
                <div class="daw-section-item">
                  <div class="daw-row daw-section-row">
                    <span class="daw-section-swatch" style={{ background: `hsl(${(idx() * 67 + 200) % 360}, 60%, 62%)` }} />
                    <input class="daw-text-input" value={sec.name} onChange={(e) => props.onRenameSection(idx(), e.currentTarget.value)} />
                    <button class="daw-icon-btn" title="Delete section" onClick={() => props.onRemoveSection(idx())}>
                      <i class="bi bi-trash" />
                    </button>
                  </div>
                  <div class="daw-section-times">
                    <button class="daw-chip" title="Go to the section start" onClick={() => props.onSeek(sec.start)}>
                      <i class="bi bi-play-fill" />
                    </button>
                    <input
                      class="daw-num"
                      title="Start (s); the previous section ends here"
                      value={sec.start.toFixed(3)}
                      disabled={idx() === 0}
                      onChange={(e) => {
                        const v = Number(e.currentTarget.value);
                        if (Number.isFinite(v)) props.onSetSectionStart(idx(), v);
                        else e.currentTarget.value = sec.start.toFixed(3);
                      }}
                    />
                    <button class="daw-btn daw-btn-sm" disabled={idx() === 0} title="Start this section at the playhead" onClick={() => props.onSetSectionStart(idx(), props.currentTime)}>
                      <i class="bi bi-cursor-text" /> Start here
                    </button>
                    <span class="daw-muted">→ {formatTimecode(sec.end)}</span>
                  </div>
                </div>
              )}
            </For>
            <button class="daw-btn daw-btn-block" onClick={() => props.onAddSection()}>
              <i class="bi bi-plus-lg" /> Add section at playhead (M)
            </button>
          </Show>
        </Show>
      </div>
    </div>
  );
}
