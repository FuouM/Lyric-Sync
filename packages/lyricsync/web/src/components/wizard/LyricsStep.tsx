// packages/lyricsync/web/src/components/wizard/LyricsStep.tsx
// Lyrics entry for the new-song wizard: a text editor that highlights words the dictionary does not know (and other word
// problems) as you type, and a dictionary panel to add pronunciations for them.
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";

export interface LyricsIssue {
  line: number;
  word: string;
  message: string;
  unknown: boolean;
}

export type LyricsCheck =
  | {
      ok: true;
      issues: LyricsIssue[];
      lines: number;
      syllables: number;
      sections: Array<{ name: string; lines: number }>;
      autoSplit: Array<{ line: number; word: string; syllables: string[] }>;
    }
  | { ok: false; issues: LyricsIssue[]; error?: string };

export type Pronunciations = Record<string, string[]>;

export interface LyricsStepProps {
  text: string;
  onText: (text: string) => void;
  check: LyricsCheck | null;
  checking: boolean;
  pronunciations: Pronunciations;
  /** Resolves `input` ("sounds like" words or phones) and stores it for `word`; returns an error message or null. */
  onAddPronunciation: (word: string, input: string) => Promise<string | null>;
  onRemovePronunciation: (key: string) => void;
}

/** Same key the server uses (pronunciationKey): lowercase, surrounding punctuation trimmed. */
export const pronunciationKey = (word: string) => word.toLowerCase().replace(/^[.,?!:;"'()\[\]{}]+|[.,?!:;"'()\[\]{}]+$/g, "");

const PLACEHOLDER = `[Verse 1]
one sung line per line, in order
split syllables yourself with bars: re|con|cil|i|a|tion
(oh) in parentheses marks a backing-vocal word
# comment lines and blank lines are ignored`;

export function LyricsStep(props: LyricsStepProps) {
  let mirror!: HTMLDivElement;
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});

  const issueIndex = createMemo(() => {
    const byLine = new Map<number, Map<string, LyricsIssue>>();
    for (const i of props.check?.issues ?? []) {
      const m = byLine.get(i.line) ?? new Map<string, LyricsIssue>();
      m.set(i.word, i);
      byLine.set(i.line, m);
    }
    return byLine;
  });

  const unknownWords = createMemo(() => {
    const seen = new Map<string, { word: string; count: number }>();
    for (const i of props.check?.issues ?? []) {
      if (!i.unknown) continue;
      const key = pronunciationKey(i.word);
      const e = seen.get(key);
      if (e) e.count++;
      else seen.set(key, { word: i.word, count: 1 });
    }
    return [...seen.entries()].map(([key, v]) => ({ key, ...v }));
  });

  /** Problems other than unknown words, one entry per distinct message (a repeated word is listed once, with its lines). */
  const otherIssues = createMemo(() => {
    const byMessage = new Map<string, { word: string; message: string; lines: number[] }>();
    for (const i of props.check?.issues ?? []) {
      if (i.unknown) continue;
      const e = byMessage.get(i.message);
      if (e) e.lines.push(i.line + 1);
      else byMessage.set(i.message, { word: i.word, message: i.message, lines: [i.line + 1] });
    }
    return [...byMessage.values()];
  });

  /** The text again, word by word, with problem words marked; drawn behind the transparent textarea. */
  const highlighted = createMemo((): JSX.Element[] => {
    let lyricLine = -1;
    return props.text.split("\n").map((raw) => {
      const trimmed = raw.trim();
      if (trimmed === "") return <div>{"\u200b"}</div>;
      if (trimmed.startsWith("#")) return <div class="daw-hl-comment">{raw}</div>;
      if (/^\[.+\]$/.test(trimmed)) return <div class="daw-hl-section">{raw}</div>;
      lyricLine++;
      const issues = issueIndex().get(lyricLine);
      return (
        <div>
          {raw.split(/(\s+)/).map((tok) => {
            if (tok === "" || /^\s+$/.test(tok)) return tok;
            const word = tok.replace(/\|/g, "");
            const issue = issues?.get(word);
            const custom = !issue && props.pronunciations[pronunciationKey(word)] !== undefined;
            return (
              <span
                classList={{
                  "daw-hl-unknown": issue?.unknown === true,
                  "daw-hl-issue": issue !== undefined && !issue.unknown,
                  "daw-hl-custom": custom,
                }}
              >
                {tok}
              </span>
            );
          })}
        </div>
      );
    });
  });

  const add = async (key: string, word: string) => {
    const input = (drafts()[key] ?? "").trim();
    const err = await props.onAddPronunciation(word, input);
    setErrors({ ...errors(), [key]: err ?? "" });
    if (!err) setDrafts({ ...drafts(), [key]: "" });
  };

  return (
    <div class="daw-wizard-lyrics">
      <div class="daw-hl-editor">
        <div class="daw-hl-mirror" ref={mirror} aria-hidden="true">
          {highlighted()}
        </div>
        <textarea
          class="daw-hl-input"
          spellcheck={false}
          placeholder={PLACEHOLDER}
          value={props.text}
          onInput={(e) => props.onText(e.currentTarget.value)}
          onScroll={(e) => (mirror.scrollTop = e.currentTarget.scrollTop)}
        />
      </div>

      <aside class="daw-wizard-check">
        <div class="daw-check-status" classList={{ "daw-check-ok": props.check?.ok === true, "daw-check-bad": props.check?.ok === false }}>
          <i class={`bi bi-${props.checking ? "hourglass-split" : props.check?.ok ? "check-circle-fill" : props.check ? "exclamation-triangle-fill" : "pencil"}`} />
          {props.checking
            ? "Checking…"
            : !props.check
              ? "Type or paste the lyrics."
              : props.check.ok
                ? "Lyrics are ready."
                : `${props.check.issues.length || 1} problem${props.check.issues.length === 1 ? "" : "s"} to fix`}
        </div>

        <Show when={props.check && !props.check.ok && props.check.error}>
          <div class="daw-wizard-error">{props.check && !props.check.ok ? props.check.error : ""}</div>
        </Show>

        <Show when={unknownWords().length > 0}>
          <header class="daw-section-title">Not in the dictionary</header>
          <p class="daw-wizard-note">
            Say how each one sounds: dictionary words that sound like it (<code>fay ding</code>) or its phones (<code>f ey d ih ng</code>).
          </p>
          <For each={unknownWords()}>
            {(u) => (
              <div class="daw-dict-row">
                <div class="daw-dict-word">
                  <span class="daw-hl-unknown">{u.word}</span>
                  <Show when={u.count > 1}>
                    <span class="daw-dict-count">×{u.count}</span>
                  </Show>
                </div>
                <div class="daw-dict-add">
                  <input
                    class="daw-text-input"
                    placeholder="sounds like…"
                    value={drafts()[u.key] ?? ""}
                    onInput={(e) => setDrafts({ ...drafts(), [u.key]: e.currentTarget.value })}
                    onKeyDown={(e) => e.key === "Enter" && void add(u.key, u.word)}
                  />
                  <button class="daw-btn daw-btn-sm daw-btn-accent" disabled={(drafts()[u.key] ?? "").trim() === ""} onClick={() => void add(u.key, u.word)}>
                    Add
                  </button>
                </div>
                <Show when={errors()[u.key]}>
                  <div class="daw-dict-error">{errors()[u.key]}</div>
                </Show>
              </div>
            )}
          </For>
        </Show>

        <Show when={otherIssues().length > 0}>
          <header class="daw-section-title">Other problems</header>
          <For each={otherIssues()}>
            {(i) => (
              <div class="daw-dict-issue">
                <b>
                  line{i.lines.length > 1 ? "s" : ""} {i.lines.join(", ")}, “{i.word}”
                </b>
                : {i.message}
              </div>
            )}
          </For>
        </Show>

        <Show when={Object.keys(props.pronunciations).length > 0}>
          <header class="daw-section-title">Added pronunciations</header>
          <For each={Object.entries(props.pronunciations)}>
            {([key, phones]) => (
              <div class="daw-dict-entry">
                <span class="daw-hl-custom">{key}</span>
                <code>{phones.join(" ")}</code>
                <button class="daw-icon-btn" title="Remove" onClick={() => props.onRemovePronunciation(key)}>
                  <i class="bi bi-x-lg" />
                </button>
              </div>
            )}
          </For>
        </Show>

        <Show when={props.check?.ok ? props.check : null}>
          {(c) => (
            <>
              <header class="daw-section-title">Summary</header>
              <div class="daw-kv"><span>Lines</span><b>{c().lines}</b></div>
              <div class="daw-kv"><span>Syllables</span><b>{c().syllables}</b></div>
              <div class="daw-kv daw-kv-top">
                <span>Sections</span>
                <b>
                  <Show when={c().sections.length > 0} fallback="none">
                    <For each={c().sections}>
                      {(s) => (
                        <div>
                          {s.name} <span class="daw-muted">{s.lines > 0 ? `${s.lines} line${s.lines === 1 ? "" : "s"}` : "instrumental"}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </b>
              </div>
              <Show when={c().autoSplit.length > 0}>
                <p class="daw-wizard-note">
                  Split automatically. If one is wrong, write it with bars (<code>loo|king</code>):
                </p>
                <div class="daw-chip-row daw-chip-row-flush">
                  <For each={c().autoSplit}>{(a) => <span class="daw-chip" title={`line ${a.line + 1}`}>{a.syllables.join("|")}</span>}</For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </aside>
    </div>
  );
}
