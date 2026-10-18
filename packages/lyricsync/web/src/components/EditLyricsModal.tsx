// packages/lyricsync/web/src/components/EditLyricsModal.tsx
// Full-featured lyrics editor modal for an existing song project:
// Re-opens CodeMirror with syllable splits, phoneme syntax, live validation, and dictionary suggestions,
// then applies changes, re-runs forced alignment/evidence preparation and solves timing around pins.
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { LyricsStep, type LyricsCheck, type Pronunciations } from "./wizard/LyricsStep";
import { errorMessage } from "../lib/song-files";
import { isRecord } from "../../../src/guards";

export interface EditLyricsModalProps {
  songName: string;
  initialText: string;
  initialLine?: number | null;
  language?: "en" | "ja";
  onClose: () => void;
  onApplied: () => void;
}

interface ReanalyzeJob {
  project: string;
  state: "running" | "done" | "error";
  log: string[];
  error?: string;
}

export function EditLyricsModal(props: EditLyricsModalProps) {
  const [text, setText] = createSignal(props.initialText);
  const [pronunciations, setPronunciations] = createSignal<Pronunciations>({});
  const [check, setCheck] = createSignal<{ text: string; result: LyricsCheck } | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [job, setJob] = createSignal<ReanalyzeJob | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);

  const lang = () => props.language ?? "en";
  const currentCheck = () => check()?.result ?? null;

  // Debounced live linter check with stale-while-revalidate
  createEffect(() => {
    const t = text();
    const p = pronunciations();
    const l = lang();
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/wizard/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: t, language: l, pronunciations: p }),
        });
        const data: unknown = await res.json();
        if (isRecord(data) && typeof data.ok === "boolean") {
          setCheck({ text: t, result: data as unknown as LyricsCheck });
        }
      } catch {
        // Keep previous check on network blip
      } finally {
        setChecking(false);
      }
    }, 200);

    onCleanup(() => clearTimeout(timer));
  });

  const addPronunciation = async (word: string, input: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/wizard/pronounce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: lang(), input }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        return isRecord(data) && typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
      }
      if (isRecord(data) && Array.isArray(data.phones)) {
        setPronunciations({ ...pronunciations(), [word]: data.phones as string[] });
        return null;
      }
      return "Malformed pronunciation response";
    } catch (e: unknown) {
      return errorMessage(e);
    }
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const stopPolling = () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  onCleanup(stopPolling);

  const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch("/api/lyrics/job");
        const data: unknown = await res.json();
        if (isRecord(data) && isRecord(data.job)) {
          const j = data.job as unknown as ReanalyzeJob;
          setJob(j);
          if (j.state === "done") {
            stopPolling();
            setTimeout(() => {
              props.onApplied();
            }, 800);
          } else if (j.state === "error") {
            stopPolling();
          }
        }
      } catch {
        // Keep trying
      }
    }, 500);
  };

  const apply = async () => {
    setSubmitError(null);
    try {
      const res = await fetch(`/api/lyrics/${encodeURIComponent(props.songName)}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text(),
          pronunciations: pronunciations(),
        }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        setSubmitError(isRecord(data) && typeof data.message === "string" ? data.message : `HTTP ${res.status}`);
        return;
      }
      if (isRecord(data) && isRecord(data.job)) {
        setJob(data.job as unknown as ReanalyzeJob);
        startPolling();
      }
    } catch (e: unknown) {
      setSubmitError(errorMessage(e));
    }
  };

  const isBusy = () => job()?.state === "running";
  const hasChanges = () =>
    text().replace(/\r\n/g, "\n").trim() !== props.initialText.replace(/\r\n/g, "\n").trim() ||
    Object.keys(pronunciations()).length > 0;

  const tryClose = () => {
    if (isBusy()) return;
    if (hasChanges()) {
      if (!window.confirm("Discard your lyric edits?")) return;
    }
    props.onClose();
  };

  return (
    <div
      class="daw-wizard-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isBusy()) tryClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !isBusy()) {
          const target = e.target as HTMLElement | null;
          if (target?.closest(".cm-editor") || target?.tagName === "INPUT") return;
          e.stopPropagation();
          tryClose();
        }
      }}
    >
      <div class="daw-wizard" role="dialog" aria-modal="true">
        <header class="daw-wizard-head">
          <span>
            <i class="bi bi-pencil-square" style={{ color: "var(--daw-accent)", "font-size": "15px" }} />
            <b>Edit Lyrics</b> — {props.songName}
          </span>
          <button class="daw-icon-btn" onClick={tryClose} disabled={isBusy()} title="Close">
            <i class="bi bi-x-lg" />
          </button>
        </header>

        <section class="daw-wizard-body" style={{ padding: "0", display: "flex", "flex-direction": "column", overflow: "hidden" }}>
          <Show
            when={job() && job()!.state !== "done"}
            fallback={
              <Show
                when={job()?.state === "done"}
                fallback={
                  <div style={{ flex: "1", "min-height": "0", display: "flex", "flex-direction": "column" }}>
                    <div style={{ padding: "10px 16px 0 16px", "font-size": "12px", color: "var(--daw-muted)" }}>
                      Edit the lyrics below. Syllable splits, phoneme syntax <code>{"{phones}"}</code>, additions, and deletions are supported. When applied, timings will automatically re-solve around preserved anchors.
                    </div>
                    <div style={{ flex: "1", "min-height": "0", padding: "10px 16px", display: "flex", "flex-direction": "column" }}>
                      <LyricsStep
                        text={text()}
                        language={lang()}
                        initialLine={props.initialLine}
                        onText={setText}
                        check={currentCheck()}
                        checking={checking()}
                        pronunciations={pronunciations()}
                        onAddPronunciation={addPronunciation}
                        onRemovePronunciation={(key) => {
                          const next = { ...pronunciations() };
                          delete next[key];
                          setPronunciations(next);
                        }}
                      />
                    </div>
                  </div>
                }
              >
                <div style={{ padding: "40px", "text-align": "center", display: "flex", "flex-direction": "column", "align-items": "center", gap: "16px" }}>
                  <i class="bi bi-check-circle-fill" style={{ "font-size": "48px", color: "var(--daw-ok)" }} />
                  <h3 style={{ margin: "0", color: "#fff" }}>Lyrics Updated and Re-timed</h3>
                  <p style={{ margin: "0", color: "var(--daw-muted)" }}>Updating editor timeline with new timings…</p>
                </div>
              </Show>
            }
          >
            <div style={{ padding: "20px", display: "flex", "flex-direction": "column", flex: "1", "min-height": "0", gap: "12px" }}>
              <div class="daw-wizard-state" classList={{ "daw-wizard-state--error": job()?.state === "error" }}>
                <i class={`bi bi-${job()?.state === "running" ? "hourglass-split" : "exclamation-triangle-fill"}`} />
                {job()?.state === "running" ? "Updating evidence and re-timing lyrics…" : `Re-timing failed: ${job()?.error}`}
              </div>
              <pre class="daw-wizard-log">{job()?.log.join("\n")}</pre>
              <Show when={job()?.state === "error"}>
                <button
                  class="daw-btn"
                  style={{ "align-self": "flex-start" }}
                  onClick={() => setJob(null)}
                >
                  <i class="bi bi-arrow-left" /> Back to editing
                </button>
              </Show>
            </div>
          </Show>
        </section>

        <footer class="daw-wizard-foot">
          <span class="daw-wizard-error-inline">
            <Show when={submitError()} fallback={currentCheck()?.ok ? `${currentCheck()?.lines ?? 0} lines · ${currentCheck()?.syllables ?? 0} syllables` : (currentCheck()?.issues?.[0]?.message ?? "")}>
              {submitError()}
            </Show>
          </span>
          <button class="daw-btn" onClick={tryClose} disabled={isBusy()}>
            Cancel
          </button>
          <button
            class="daw-btn daw-btn-accent"
            disabled={isBusy() || checking() || !currentCheck()?.ok}
            onClick={() => void apply()}
          >
            <i class="bi bi-arrow-repeat" /> Apply & Retime
          </button>
        </footer>
      </div>
    </div>
  );
}
