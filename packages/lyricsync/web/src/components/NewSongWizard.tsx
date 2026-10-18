// packages/lyricsync/web/src/components/NewSongWizard.tsx
// Step-by-step setup of a new song from raw inputs: id and language, mix and vocal stem, lyrics (with pronunciations for
// words the dictionary lacks), tempo and first downbeat, then the build (beats, evidence, first solve) on the local dev
// server. When the build is done the song opens in the editor.
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { isRecord } from "../../../src/guards";
import { extractPeaks } from "../lib/audio-player";
import { errorMessage } from "../lib/song-files";
import { LyricsStep, pronunciationKey, type LyricsCheck, type Pronunciations } from "./wizard/LyricsStep";
import { TEMPO_PEAKS_PER_SEC, TempoStep } from "./wizard/TempoStep";

export interface NewSongWizardProps {
  onClose: () => void;
  onOpen: (id: string) => void;
}

interface Job {
  project: string;
  state: "running" | "done" | "error";
  log: string[];
  error?: string;
}

const STEPS = ["Song", "Audio", "Lyrics", "Tempo", "Build"] as const;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const CHECK_DELAY_MS = 160;

function isJob(v: unknown): v is Job {
  return isRecord(v) && typeof v.project === "string" && (v.state === "running" || v.state === "done" || v.state === "error") && Array.isArray(v.log);
}

function isLyricsCheck(v: unknown): v is LyricsCheck {
  return (
    isRecord(v) &&
    typeof v.ok === "boolean" &&
    Array.isArray(v.issues) &&
    typeof v.lines === "number" &&
    typeof v.syllables === "number" &&
    Array.isArray(v.sections)
  );
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data: unknown = await res.json();
  if (!res.ok) throw new Error(isRecord(data) && typeof data.message === "string" ? data.message : `HTTP ${res.status}`);
  return data;
}

export function NewSongWizard(props: NewSongWizardProps) {
  const [step, setStep] = createSignal(0);
  const [id, setId] = createSignal("");
  const [language, setLanguage] = createSignal<"en" | "ja">("en");
  const [mix, setMix] = createSignal<File | null>(null);
  const [mixUrl, setMixUrl] = createSignal<string | null>(null);
  const [mixPeaks, setMixPeaks] = createSignal<Float32Array | undefined>();
  const [vocal, setVocal] = createSignal<File | null>(null);
  const [lyrics, setLyrics] = createSignal("");
  const [pronunciations, setPronunciations] = createSignal<Pronunciations>({});
  const [check, setCheck] = createSignal<{ key: string; result: LyricsCheck } | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [bpm, setBpm] = createSignal("");
  const [downbeat, setDownbeat] = createSignal("");
  const [job, setJob] = createSignal<Job | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  let idInput: HTMLInputElement | undefined;
  let poll = 0;
  let checkTimer = 0;

  const checkKey = () => JSON.stringify([language(), lyrics(), pronunciations()]);
  const currentCheck = () => check()?.result ?? null;
  const readyLyrics = () => {
    const c = currentCheck();
    return c?.ok ? c : null;
  };

  // Lint the lyrics shortly after every change.
  createEffect(
    on([lyrics, pronunciations, language], () => {
      clearTimeout(checkTimer);
      if (lyrics().trim() === "") {
        setCheck(null);
        return;
      }
      const key = checkKey();
      const body = { text: lyrics(), language: language(), pronunciations: pronunciations() };
      setChecking(true);
      checkTimer = window.setTimeout(async () => {
        try {
          const r = await postJson("/api/wizard/check", body);
          if (!isLyricsCheck(r)) throw new Error("Unexpected answer from /api/wizard/check.");
          if (key === checkKey()) setCheck({ key, result: r });
        } catch (e: unknown) {
          if (key === checkKey()) setCheck({ key, result: { ok: false, issues: [], lines: 0, syllables: 0, sections: [], autoSplit: [], error: errorMessage(e) } });
        } finally {
          if (key === checkKey()) setChecking(false);
        }
      }, CHECK_DELAY_MS);
    })
  );

  const startPolling = () => {
    clearInterval(poll);
    poll = window.setInterval(async () => {
      const data: unknown = await (await fetch("/api/wizard/job")).json();
      const j = isRecord(data) ? data.job : null;
      if (!isJob(j)) return;
      setJob(j);
      if (j.state === "running") return;
      clearInterval(poll);
      if (j.state === "done") props.onOpen(j.project);
    }, 1000);
  };

  onMount(() => idInput?.focus());
  onCleanup(() => {
    clearInterval(poll);
    clearTimeout(checkTimer);
    const u = mixUrl();
    if (u) URL.revokeObjectURL(u);
  });

  // A build already running (e.g. the wizard was closed during it) is shown again.
  void fetch("/api/wizard/job")
    .then((r) => r.json())
    .then((data: unknown) => {
      const j = isRecord(data) ? data.job : null;
      if (isJob(j) && j.state === "running") {
        setJob(j);
        setId(j.project);
        setStep(4);
        startPolling();
      }
    });

  // Where the dev server creates song folders (dev.ts --songs).
  const [songsDir, setSongsDir] = createSignal("the songs folder");
  void fetch("/api/config")
    .then((r) => r.json())
    .then((data: unknown) => {
      if (isRecord(data) && typeof data.songsDir === "string") setSongsDir(data.songsDir);
    });
  const songFolder = (id: string) => `${songsDir()}/${id}`;

  const pickMix = (f: File | null) => {
    setMix(f);
    const old = mixUrl();
    if (old) URL.revokeObjectURL(old);
    setMixUrl(f ? URL.createObjectURL(f) : null);
    setMixPeaks(undefined);
    if (f) {
      f.arrayBuffer()
        .then((b) => extractPeaks(b, TEMPO_PEAKS_PER_SEC))
        .then(
          (r) => mix() === f && setMixPeaks(r.peaks),
          (e: unknown) => setSubmitError(`Cannot decode ${f.name}: ${errorMessage(e)}`)
        );
    }
  };

  const addPronunciation = async (word: string, input: string): Promise<string | null> => {
    try {
      const r = await postJson("/api/wizard/pronounce", { language: language(), input });
      if (!isRecord(r) || typeof r.ok !== "boolean") return "Unexpected answer from /api/wizard/pronounce.";
      if (!r.ok) return typeof r.error === "string" ? r.error : "Not a pronunciation.";
      if (!Array.isArray(r.phones) || !r.phones.every((p) => typeof p === "string")) return "Unexpected answer from /api/wizard/pronounce.";
      setPronunciations({ ...pronunciations(), [pronunciationKey(word)]: r.phones });
      return null;
    } catch (e: unknown) {
      return errorMessage(e);
    }
  };

  const valid = (s: number): string | null => {
    if (s === 0) {
      if (!ID_RE.test(id())) return "Song id: lowercase letters, digits, - or _.";
    } else if (s === 1) {
      if (!mix() || !vocal()) return "Choose the mix and the vocal stem.";
      if (![mix()!, vocal()!].every((f) => /\.wav$/i.test(f.name))) return "Both files must be .wav.";
    } else if (s === 2) {
      const c = currentCheck();
      if (!c) return checking() ? "Checking the lyrics…" : "Type the lyrics.";
      if (!c.ok) return "Fix the highlighted words first.";
    } else if (s === 3) {
      const b = Number(bpm());
      if (!(b >= 40 && b <= 260)) return "Tempo: 40–260 BPM (type it, or tap along).";
      if (downbeat().trim() !== "" && !(Number(downbeat()) >= 0)) return "First downbeat: seconds, or leave empty.";
    }
    return null;
  };

  const isStepDone = (s: number): boolean => {
    if (s < 4) return valid(s) === null;
    return job()?.state === "done";
  };
  const submit = async () => {
    setSubmitError(null);
    const form = new FormData();
    form.set("id", id());
    form.set("language", language());
    form.set("bpm", bpm());
    form.set("firstDownbeat", downbeat());
    form.set("lyrics", lyrics());
    form.set("pronunciations", JSON.stringify(pronunciations()));
    form.set("mix", mix()!);
    form.set("vocal", vocal()!);
    const res = await fetch("/api/wizard/create", { method: "POST", body: form });
    const data: unknown = await res.json();
    if (!res.ok) {
      setSubmitError(isRecord(data) && typeof data.message === "string" ? data.message : `HTTP ${res.status}`);
      return;
    }
    if (isRecord(data) && isJob(data.job)) setJob(data.job);
    startPolling();
  };

  const resume = async () => {
    setSubmitError(null);
    try {
      const data = await postJson("/api/wizard/resume", { id: id() });
      if (isRecord(data) && isJob(data.job)) setJob(data.job);
      startPolling();
    } catch (e: unknown) {
      setSubmitError(errorMessage(e));
    }
  };

  const busy = () => job()?.state === "running";

  const hasUnsavedWork = () =>
    step() > 0 ||
    id().trim().length > 0 ||
    mix() !== null ||
    vocal() !== null ||
    lyrics().trim().length > 0 ||
    Object.keys(pronunciations()).length > 0;

  const requestClose = () => {
    if (busy()) return;
    if (hasUnsavedWork()) {
      if (!window.confirm("Discard unsaved song setup?")) return;
    }
    props.onClose();
  };

  return (
    <div
      class="daw-wizard-backdrop"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || busy()) return;
        if (e.target instanceof HTMLElement && e.target.closest(".cm-editor, .cm-tooltip, input, textarea, select")) {
          return;
        }
        requestClose();
      }}
    >
      <div class="daw-wizard" role="dialog" aria-modal="true">
        <header class="daw-wizard-head">
          <span>
            <img src="/favicon.svg" class="daw-wizard-head-icon" alt="" /> New Song
          </span>
          <button class="daw-icon-btn" title="Close" disabled={busy()} onClick={requestClose}>
            <i class="bi bi-x-lg" />
          </button>
        </header>

        <div class="daw-wizard-main">
          <nav class="daw-wizard-steps">
            <For each={STEPS}>
              {(name, i) => {
                const done = () => isStepDone(i());
                return (
                  <button
                    type="button"
                    class="daw-wizard-step"
                    classList={{
                      "daw-wizard-step--active": step() === i(),
                      "daw-wizard-step--done": done(),
                      "daw-wizard-step--clickable": !busy(),
                    }}
                    disabled={busy()}
                    onClick={() => {
                      if (!busy()) {
                        if (job()?.state === "error") setJob(null);
                        setStep(i());
                      }
                    }}
                  >
                    <span class="daw-wizard-step-num">{done() ? <i class="bi bi-check2" /> : i() + 1}</span>
                    {name}
                  </button>
                );
              }}
            </For>
          </nav>

          <section class="daw-wizard-body" classList={{ "daw-wizard-body--no-overflow": step() === 2 }}>
            <Show when={step() === 0}>
              <h2>Name the song</h2>
              <p class="daw-wizard-note">The id is the folder name: the song is created in <code>{songFolder("<id>")}</code>.</p>
              <label class="daw-field">
                <span>Song id</span>
                <input ref={idInput} class="daw-text-input" placeholder="my_song" value={id()} onInput={(e) => setId(e.currentTarget.value.toLowerCase())} />
              </label>
              <label class="daw-field">
                <span>Language</span>
                <select class="daw-text-input" value={language()} onChange={(e) => setLanguage(e.currentTarget.value === "ja" ? "ja" : "en")}>
                  <option value="en">English</option>
                  <option value="ja">Japanese</option>
                </select>
              </label>
            </Show>

            <Show when={step() === 1}>
              <h2>Audio</h2>
              <p class="daw-wizard-note">The full mix gives the beat grid and what you hear; the isolated vocal stem is what the lyrics are aligned to. Both as WAV.</p>
              <label class="daw-field">
                <span>Full mix</span>
                <input type="file" accept=".wav,audio/wav" onChange={(e) => pickMix(e.currentTarget.files?.[0] ?? null)} />
              </label>
              <Show when={mix()}>
                <div class="daw-wizard-file"><i class="bi bi-music-note-beamed" /> {mix()!.name} · {(mix()!.size / 1e6).toFixed(1)} MB</div>
              </Show>
              <label class="daw-field">
                <span>Vocal stem</span>
                <input type="file" accept=".wav,audio/wav" onChange={(e) => setVocal(e.currentTarget.files?.[0] ?? null)} />
              </label>
              <Show when={vocal()}>
                <div class="daw-wizard-file"><i class="bi bi-mic-fill" /> {vocal()!.name} · {(vocal()!.size / 1e6).toFixed(1)} MB</div>
              </Show>
            </Show>

            <Show when={step() === 2}>
              <h2>Lyrics</h2>
              <p class="daw-wizard-note">Every sung line, in order, as sung (repeat choruses in full). Words the dictionary does not know turn red.</p>
              <LyricsStep
                text={lyrics()}
                language={language()}
                onText={setLyrics}
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
            </Show>

            <Show when={step() === 3}>
              <h2>Tempo and first beat</h2>
              <TempoStep mixUrl={mixUrl()} peaks={mixPeaks()} bpm={bpm()} onBpm={setBpm} downbeat={downbeat()} onDownbeat={setDownbeat} />
            </Show>

            <Show when={step() === 4}>
              <h2>Build</h2>
              <Show
                when={job()}
                fallback={
                  <>
                    <div class="daw-kv"><span>Folder</span><b>{songFolder(id())}</b></div>
                    <div class="daw-kv"><span>Language</span><b>{language()}</b></div>
                    <div class="daw-kv"><span>Mix</span><b>{mix()?.name}</b></div>
                    <div class="daw-kv"><span>Vocal</span><b>{vocal()?.name}</b></div>
                    <div class="daw-kv"><span>Lyrics</span><b>{readyLyrics() ? `${readyLyrics()!.lines} lines` : "—"}</b></div>
                    <div class="daw-kv"><span>Added pronunciations</span><b>{Object.keys(pronunciations()).length}</b></div>
                    <div class="daw-kv"><span>Tempo</span><b>{bpm()} BPM{downbeat() ? `, beat 1 at ${downbeat()} s` : ""}</b></div>
                    <p class="daw-wizard-note">
                      The build tracks the beats, extracts the audio evidence (a few minutes) and makes a first timing with nothing pinned. The song then opens in the editor.
                    </p>
                  </>
                }
              >
                {(j) => (
                  <>
                    <div class="daw-wizard-state" classList={{ "daw-wizard-state--error": j().state === "error", "daw-wizard-state--done": j().state === "done" }}>
                      <i class={`bi bi-${j().state === "running" ? "hourglass-split" : j().state === "done" ? "check-circle-fill" : "exclamation-triangle-fill"}`} />
                      {j().state === "running" ? `Building ${songFolder(j().project)}…` : j().state === "done" ? "Ready. Opening the song…" : `Build failed: ${j().error}`}
                    </div>
                    <pre class="daw-wizard-log">{j().log.join("\n")}</pre>
                  </>
                )}
              </Show>
              <Show when={submitError()}>
                <div class="daw-wizard-error">{submitError()}</div>
              </Show>
            </Show>
          </section>
        </div>

        <footer class="daw-wizard-foot">
          <span class="daw-wizard-error-inline">{step() < 4 ? (valid(step()) ?? "") : ""}</span>
          <button
            class="daw-btn"
            disabled={step() === 0 || busy() || job()?.state === "done"}
            onClick={() => {
              if (job()?.state === "error") setJob(null);
              setStep(step() - 1);
            }}
          >
            <i class="bi bi-chevron-left" /> Back
          </button>
          <Show when={step() < 4}>
            <button class="daw-btn daw-btn-accent" disabled={valid(step()) !== null} onClick={() => setStep(step() + 1)}>
              Next <i class="bi bi-chevron-right" />
            </button>
          </Show>
          <Show when={step() === 4 && job() === null}>
            <button class="daw-btn daw-btn-accent" onClick={() => void submit()}>
              <i class="bi bi-hammer" /> Create and build
            </button>
          </Show>
          <Show when={job()?.state === "error"}>
            <button
              class="daw-btn"
              onClick={() => {
                setJob(null);
                setStep(2);
              }}
            >
              <i class="bi bi-pencil" /> Edit Lyrics
            </button>
            <button class="daw-btn daw-btn-accent" onClick={() => void resume()}>
              <i class="bi bi-arrow-repeat" /> Resume build
            </button>
          </Show>
        </footer>
      </div>
    </div>
  );
}
