// packages/lyricsync/web/src/components/wizard/LyricsStep.tsx
// Lyrics entry for the new-song wizard: a full-featured CodeMirror 6 text editor that highlights
// section headers, syllable separators, unknown dictionary words, and issues directly in the text,
// alongside syllable autocompletion, quick edit tools (copy/select all, clear, split word), and a dictionary panel.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionKeymap,
  completionStatus,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { isRecord } from "../../../../src/guards.ts";
import { stripPunctuation } from "../../../../src/lyrics/clean.ts";

export interface LyricsIssue {
  line: number;
  word: string;
  message: string;
  unknown: boolean;
}

export interface LyricsCheck {
  ok: boolean;
  issues: LyricsIssue[];
  lines: number;
  syllables: number;
  sections: Array<{ name: string; lines: number }>;
  autoSplit: Array<{ line: number; word: string; syllables: string[] }>;
  error?: string;
}

export type Pronunciations = Record<string, string[]>;

export interface LyricsStepProps {
  text: string;
  language?: "en" | "ja";
  initialLine?: number | null;
  onText: (text: string) => void;
  check: LyricsCheck | null;
  checking: boolean;
  pronunciations: Pronunciations;
  /** Resolves `input` ("sounds like" words or phones) and stores it for `word`; returns an error message or null. */
  onAddPronunciation: (word: string, input: string) => Promise<string | null>;
  onRemovePronunciation: (key: string) => void;
}
/** Same key the server uses (pronunciationKey): lowercase, surrounding punctuation trimmed. */
export const pronunciationKey = (word: string) => stripPunctuation(word.toLowerCase());

const PLACEHOLDER = `[Verse 1]
one sung line per line, in order
split syllables yourself with bars: re|con|cil|i|a|tion
(oh) in parentheses marks a backing-vocal word
# comment lines and blank lines are ignored`;

interface LyricsMeta {
  issuesByLine: Map<number, Map<string, LyricsIssue>>;
  pronunciations: Pronunciations;
  hoveredAutoSplit: { line: number; word: string } | null;
  /** Japanese: "+" joins two syllables into one shown unit (ko+n), so it is marked apart from "|". */
  joinMark: boolean;
}

const setLyricsMeta = StateEffect.define<LyricsMeta>();

function buildDecorations(state: EditorState, meta: LyricsMeta): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let lyricLine = -1;

  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    const text = line.text;
    const trimmed = text.trim();

    if (trimmed === "") continue;
    if (/^#?\s*@pron\b/i.test(trimmed)) {
      builder.add(line.from, line.from, Decoration.line({ class: "daw-cm-pron-line" }));
      continue;
    }

    if (trimmed.startsWith("#")) {
      builder.add(line.from, line.from, Decoration.line({ class: "daw-cm-comment-line" }));
      continue;
    }

    if (/^\[.+\]$/.test(trimmed)) {
      builder.add(line.from, line.from, Decoration.line({ class: "daw-cm-section-line" }));
      continue;
    }

    lyricLine++;
    const lineIssues = meta.issuesByLine.get(lyricLine);

    // Parse tokens on the line protecting {...}
    let match: RegExpExecArray | null;
    const tokenRe = /(?:[^\s{]|\{[^}]*\})+/g;
    while ((match = tokenRe.exec(text)) !== null) {
      const tok = match[0];
      const tokStart = line.from + match.index;

      let wordPart = tok;
      let phonesPart: string | null = null;
      let phonesStart = -1;

      const braceMatch = /^([^{]+)(\{[^}]*\})$/.exec(tok);
      if (braceMatch) {
        wordPart = braceMatch[1]!;
        phonesPart = braceMatch[2]!;
        phonesStart = tokStart + wordPart.length;
      }

      const sepGlobal = meta.joinMark ? /[|+]/g : /\|/g;
      const seps = wordPart.match(sepGlobal) ?? [];
      const cleanWord = wordPart.replace(sepGlobal, "");
      const issue = lineIssues?.get(cleanWord);
      const custom = !issue && (phonesPart !== null || meta.pronunciations[pronunciationKey(cleanWord)] !== undefined);

      let wordClass = "";
      const isAutoSplitHovered =
        meta.hoveredAutoSplit !== null &&
        lyricLine === meta.hoveredAutoSplit.line &&
        cleanWord.toLowerCase() === meta.hoveredAutoSplit.word.toLowerCase();

      if (isAutoSplitHovered) {
        wordClass = "daw-cm-hovered-autofix";
      } else if (issue?.unknown === true) {
        wordClass = "daw-cm-unknown";
      } else if (issue !== undefined && !issue.unknown) {
        wordClass = "daw-cm-issue";
      } else if (custom) {
        wordClass = "daw-cm-custom";
      }
      const wordParts = seps.length > 0 ? wordPart.split(meta.joinMark ? /[|+]/ : "|") : null;
      const innerPhones = phonesPart && phonesPart.startsWith("{") && phonesPart.endsWith("}") ? phonesPart.slice(1, -1) : null;
      const phoneChunks = innerPhones && innerPhones.includes("|") ? innerPhones.split("|") : null;
      const linked = wordParts !== null && phoneChunks !== null && wordParts.length === phoneChunks.length;

      if (wordParts) {
        let cur = tokStart;
        for (let pi = 0; pi < wordParts.length; pi++) {
          const part = wordParts[pi]!;
          const linkId = linked ? `syl_${line.from}_${match.index}_${pi}` : undefined;
          if (part.length > 0) {
            const cls = [wordClass, linked ? "daw-cm-syl" : "", seps[pi - 1] === "+" || seps[pi] === "+" ? "daw-cm-joined" : ""].filter(Boolean).join(" ");
            builder.add(
              cur,
              cur + part.length,
              Decoration.mark({ class: cls.trim(), attributes: linkId ? { "data-syl-link": linkId } : undefined })
            );
            cur += part.length;
          }
          if (pi < wordParts.length - 1) {
            builder.add(cur, cur + 1, Decoration.mark({ class: seps[pi] === "+" ? "daw-cm-join" : "daw-cm-pipe" }));
            cur += 1;
          }
        }
      } else if (wordClass) {
        builder.add(tokStart, tokStart + wordPart.length, Decoration.mark({ class: wordClass }));
      }

      if (phonesPart !== null) {
        if (linked && phoneChunks) {
          let pCur = phonesStart;
          builder.add(pCur, pCur + 1, Decoration.mark({ class: "daw-cm-inline-brace" }));
          pCur += 1;

          for (let ci = 0; ci < phoneChunks.length; ci++) {
            const chunk = phoneChunks[ci]!;
            const linkId = `syl_${line.from}_${match.index}_${ci}`;
            if (chunk.length > 0) {
              builder.add(
                pCur,
                pCur + chunk.length,
                Decoration.mark({ class: "daw-cm-phone-chunk", attributes: { "data-syl-link": linkId } })
              );
              pCur += chunk.length;
            }
            if (ci < phoneChunks.length - 1) {
              builder.add(pCur, pCur + 1, Decoration.mark({ class: "daw-cm-pipe" }));
              pCur += 1;
            }
          }

          if (pCur < phonesStart + phonesPart.length) {
            builder.add(pCur, pCur + 1, Decoration.mark({ class: "daw-cm-inline-brace" }));
          }
        } else {
          builder.add(phonesStart, phonesStart + phonesPart.length, Decoration.mark({ class: "daw-cm-inline-phones" }));
        }
      }
    }
  }

  return builder.finish();
}

const lyricsMetaField = StateField.define<LyricsMeta>({
  create() {
    return { issuesByLine: new Map(), pronunciations: {}, hoveredAutoSplit: null, joinMark: false };
  },
  update(meta, tr) {
    for (const e of tr.effects) {
      if (e.is(setLyricsMeta)) return e.value;
    }
    return meta;
  },
});

const lyricsField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state, state.field(lyricsMetaField));
  },
  update(decorations, tr) {
    const metaChanged = tr.effects.some((e) => e.is(setLyricsMeta));
    if (metaChanged || tr.docChanged) {
      return buildDecorations(tr.state, tr.state.field(lyricsMetaField));
    }
    return decorations.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const wrapCompartment = new Compartment();

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--sys-window-bg, #ffffff)",
    color: "var(--sys-window-text, #000000)",
    fontSize: "13px",
  },
  ".cm-scroller": {
    overflow: "auto",
    lineHeight: "1.45",
  },
  ".cm-content": {
    padding: "8px 0",
    caretColor: "var(--sys-window-text, #000000)",
  },
  ".cm-line": {
    padding: "0 10px",
    lineHeight: "1.45",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--sys-window-text, #000000)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(0, 120, 215, 0.25)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--sys-control-bg, #f3f3f3)",
    color: "var(--sys-text-secondary, #666666)",
    borderRight: "1px solid var(--sys-border-medium, #cccccc)",
    paddingRight: "2px",
  },
  ".cm-gutterElement": {
    padding: "0 8px 0 6px",
    fontSize: "11px",
    lineHeight: "1.45",
    userSelect: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(0, 120, 215, 0.05)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(0, 120, 215, 0.12)",
    color: "var(--sys-highlight-bg, #0078d7)",
    fontWeight: "700",
  },
  ".cm-placeholder": {
    color: "var(--sys-text-muted, #888888)",
    fontStyle: "italic",
    padding: "0 10px",
  },
});

function getDynamicSectionTemplates(docText: string) {
  const getNextNum = (base: string) => {
    const re = new RegExp(`^\\[${base}(?:\\s+(\\d+))?\\]`, "gim");
    let count = 0;
    let maxNum = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(docText)) !== null) {
      count++;
      if (m[1]) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    return Math.max(count + 1, maxNum + 1);
  };

  const hasSection = (name: string) => new RegExp(`^\\[${name}\\]`, "gim").test(docText);

  const nextVerse = getNextNum("Verse");
  const nextChorus = getNextNum("Chorus");
  const nextPreChorus = getNextNum("Pre-Chorus");
  const nextBridge = getNextNum("Bridge");

  const templates: Array<{ label: string; apply: string; detail: string; boost?: number }> = [];

  if (!hasSection("Intro")) {
    templates.push({ label: "[Intro]", apply: "[Intro]\n", detail: "section", boost: 14 });
  }

  templates.push({
    label: `[Verse ${nextVerse}]`,
    apply: `[Verse ${nextVerse}]\n`,
    detail: "section",
    boost: 12,
  });

  templates.push({
    label: `[Pre-Chorus ${nextPreChorus}]`,
    apply: `[Pre-Chorus ${nextPreChorus}]\n`,
    detail: "section",
    boost: 11,
  });

  templates.push({
    label: `[Chorus ${nextChorus}]`,
    apply: `[Chorus ${nextChorus}]\n`,
    detail: "section",
    boost: 10,
  });

  const bridgeLabel = nextBridge === 1 ? "[Bridge]" : `[Bridge ${nextBridge}]`;
  templates.push({
    label: bridgeLabel,
    apply: `${bridgeLabel}\n`,
    detail: "section",
    boost: 9,
  });

  if (!hasSection("Outro")) {
    templates.push({ label: "[Outro]", apply: "[Outro]\n", detail: "section", boost: 8 });
  }

  templates.push({ label: "[Instrumental]", apply: "[Instrumental]\n", detail: "section", boost: 7 });

  return templates;
}

const suggestCache = new Map<string, Array<{ label: string; apply: string; detail?: string; boost?: number }>>();

function lyricsCompletionSource(lang: "en" | "ja") {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    // 1. Check for section header trigger '['
    const line = context.state.doc.lineAt(context.pos);
    const lineBefore = line.text.slice(0, context.pos - line.from);
    const sectionMatch = /\[([A-Za-z0-9 -]*)$/.exec(lineBefore);
    if (sectionMatch) {
      const from = context.pos - sectionMatch[1]!.length - 1;
      const docText = context.state.doc.toString();
      return {
        from,
        options: getDynamicSectionTemplates(docText),
        validFor: /^\[[A-Za-z0-9 -]*$/,
      };
    }

    // Japanese words are split into morae automatically (the "split automatically" pills), so the pipe suggestions are English-only.
    // A popup would also take Enter and Tab away from the text.
    if (lang === "ja") return null;

    // 2. Word matching
    const wordMatch = context.matchBefore(/[A-Za-z|']+/);
    if (!wordMatch || wordMatch.text.length < 2) return null;

    const raw = wordMatch.text;
    const clean = raw.replace(/\|/g, "").toLowerCase();

    // Check words already in document with syllables
    const docText = context.state.doc.toString();
    const docPipes = new Map<string, string>();
    const pipeRe = /\b([a-zA-Z]+(?:\|[a-zA-Z]+)+)\b/g;
    let pm: RegExpExecArray | null;
    while ((pm = pipeRe.exec(docText)) !== null) {
      const full = pm[1]!;
      const c = full.replace(/\|/g, "").toLowerCase();
      if (!docPipes.has(c)) docPipes.set(c, full);
    }

    const options: Array<{ label: string; apply: string; detail?: string; boost?: number }> = [];

    // Prioritize existing split from the current song
    if (docPipes.has(clean)) {
      const split = docPipes.get(clean)!;
      options.push({ label: split, apply: split, detail: "from song", boost: 20 });
    }

    for (const [c, split] of docPipes.entries()) {
      if (c !== clean && c.startsWith(clean)) {
        options.push({ label: split, apply: split, detail: "from song", boost: 15 });
      }
    }

    // For 2-letter tokens, only search dictionary if user explicitly triggered completion
    if (clean.length >= 3 || context.explicit) {
      const cached = suggestCache.get(clean);
      if (cached) {
        for (const o of cached) {
          if (!options.some((x) => x.apply === o.apply)) options.push(o);
        }
      } else {
        try {
          const res = await fetch(`/api/wizard/suggest?q=${encodeURIComponent(clean)}&lang=${lang}`);
          if (res.ok) {
            const data: unknown = await res.json();
            if (isRecord(data) && Array.isArray(data.suggestions)) {
              const fetched: Array<{ label: string; apply: string; detail?: string; boost?: number }> = [];
              const list = data.suggestions;
              for (const s of list) {
                if (isRecord(s) && typeof s.word === "string" && typeof s.split === "string") {
                  const isAddPhones = s.detail === "add phonemes";
                  const item = {
                    label: s.split,
                    apply: s.split,
                    detail: typeof s.detail === "string" ? s.detail : s.word === clean ? "split word" : "dictionary",
                    boost: isAddPhones ? 30 : s.word === clean ? 18 : 5,
                  };
                  fetched.push(item);
                  if (!options.some((o) => o.apply === s.split)) options.push(item);
                }
              }
              suggestCache.set(clean, fetched);
            }
          }
        } catch {}
      }
    }

    if (options.length === 0) return null;

    return {
      from: wordMatch.from,
      options,
    };
  };
}

export function LyricsStep(props: LyricsStepProps) {
  let editorContainer!: HTMLDivElement;
  let view: EditorView | null = null;
  const [wordWrap, setWordWrap] = createSignal(true);
  const [copied, setCopied] = createSignal(false);
  const [hoveredAutoSplit, setHoveredAutoSplit] = createSignal<{ line: number; word: string } | null>(null);
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

  const checkStatusText = createMemo(() => {
    const c = props.check;
    if (!c) return props.checking ? "Checking…" : "Type or paste the lyrics.";
    if (c.ok) return "Lyrics are ready.";
    const count = c.issues?.length || 1;
    return `${count} problem${count === 1 ? "" : "s"} to fix`;
  });
  onMount(() => {
    const lang = props.language ?? "en";
    const state = EditorState.create({
      doc: props.text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        keymap.of([
          { key: "Tab", run: acceptCompletion },
          {
            key: "]",
            run: (cmView) => {
              const sel = cmView.state.selection.main;
              const line = cmView.state.doc.lineAt(sel.from);
              const beforeCursor = line.text.slice(0, sel.from - line.from);
              const m = /^\[(Chorus|Verse|Pre-Chorus|Bridge)$/i.exec(beforeCursor.trim());
              if (m) {
                const base = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase().replace(/-chorus/i, "-Chorus");
                let count = 0;
                for (let i = 1; i < line.number; i++) {
                  const prev = cmView.state.doc.line(i).text.trim();
                  if (new RegExp(`^\\[${base}(?:\\s+\\d+)?\\]`, "i").test(prev)) count++;
                }
                const num = count + 1;
                const replacement = `[${base} ${num}]`;
                cmView.dispatch({
                  changes: { from: line.from, to: sel.from, insert: replacement },
                  selection: { anchor: line.from + replacement.length },
                });
                return true;
              }
              return false;
            },
          },
          {
            key: "Enter",
            run: (cmView) => {
              if (acceptCompletion(cmView)) return true;
              const sel = cmView.state.selection.main;
              const line = cmView.state.doc.lineAt(sel.from);
              const trimmed = line.text.trim();
              const m = /^\[(Chorus|Verse|Pre-Chorus|Bridge)\]$/i.exec(trimmed);
              if (m) {
                const base = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase().replace(/-chorus/i, "-Chorus");
                let count = 0;
                for (let i = 1; i < line.number; i++) {
                  const prev = cmView.state.doc.line(i).text.trim();
                  if (new RegExp(`^\\[${base}(?:\\s+\\d+)?\\]`, "i").test(prev)) count++;
                }
                const num = count + 1;
                const replacement = `[${base} ${num}]\n`;
                cmView.dispatch({
                  changes: { from: line.from, to: line.to, insert: replacement },
                  selection: { anchor: line.from + replacement.length },
                });
                return true;
              }
              return false;
            },
          },
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        wrapCompartment.of(wordWrap() ? EditorView.lineWrapping : []),
        autocompletion({
          override: [lyricsCompletionSource(lang)],
          defaultKeymap: true,
          activateOnTyping: true,
          activateOnTypingDelay: 0,
          maxRenderedOptions: 30,
        }),
        EditorView.domEventHandlers({
          keydown(event, cmView) {
            if (event.key === "Escape") {
              if (completionStatus(cmView.state) !== null) {
                closeCompletion(cmView);
                event.preventDefault();
                event.stopPropagation();
                return true;
              }
              event.stopPropagation();
              return true;
            }
            return false;
          },
          mouseover(event, cmView) {
            const target = event.target as HTMLElement | null;
            const match = target?.closest("[data-syl-link]");
            if (match) {
              const linkId = match.getAttribute("data-syl-link");
              if (linkId) {
                cmView.dom.querySelectorAll(`[data-syl-link="${linkId}"]`).forEach((el) => {
                  el.classList.add("daw-cm-hovered");
                });
              }
            }
            return false;
          },
          mouseout(event, cmView) {
            const target = event.target as HTMLElement | null;
            const match = target?.closest("[data-syl-link]");
            if (match) {
              const linkId = match.getAttribute("data-syl-link");
              if (linkId) {
                cmView.dom.querySelectorAll(`[data-syl-link="${linkId}"]`).forEach((el) => {
                  el.classList.remove("daw-cm-hovered");
                });
              }
            }
            return false;
          },
        }),
        editorTheme,
        lyricsMetaField,
        lyricsField,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            props.onText(update.state.doc.toString());
          }
        }),
      ],
    });

    view = new EditorView({
      state,
      parent: editorContainer,
    });
    (editorContainer as unknown as { __cmView?: EditorView }).__cmView = view;

    if (props.initialLine !== undefined && props.initialLine !== null && view) {
      let lyricLine = -1;
      for (let i = 1; i <= view.state.doc.lines; i++) {
        const line = view.state.doc.line(i);
        const trimmed = line.text.trim();
        if (trimmed === "" || trimmed.startsWith("#") || /^\[.+\]$/.test(trimmed)) continue;
        lyricLine++;
        if (lyricLine === props.initialLine) {
          view.dispatch({
            selection: { anchor: line.from },
            scrollIntoView: true,
          });
          break;
        }
      }
    }
  });
  onCleanup(() => {
    view?.destroy();
    view = null;
  });

  // Sync external text into editor if changed outside (e.g. template reset or paste)
  createEffect(() => {
    const text = props.text;
    if (view && view.state.doc.toString() !== text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    }
  });

  // Update decorations when check results, pronunciations, or hoveredAutoSplit change
  createEffect(() => {
    const issuesByLine = issueIndex();
    const pronunciations = props.pronunciations;
    const hovered = hoveredAutoSplit();
    if (view) {
      view.dispatch({
        effects: setLyricsMeta.of({ issuesByLine, pronunciations, hoveredAutoSplit: hovered, joinMark: props.language === "ja" }),
      });
    }
  });

  const applyAutoSplit = (a: { line: number; word: string; syllables: string[] }) => {
    if (!view) return;
    const doc = view.state.doc;
    let lyricLine = -1;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const text = line.text;
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith("#") || /^\[.+\]$/.test(trimmed) || /^#?\s*@pron\b/i.test(trimmed)) continue;
      lyricLine++;
      if (lyricLine === a.line) {
        const re = /\b[A-Za-z]+(?:\{[^}]*\})?\b/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const rawTok = m[0];
          const clean = rawTok.replace(/\{[^}]*\}/g, "");
          if (clean.toLowerCase() === a.word.toLowerCase()) {
            const wordFrom = line.from + m.index;
            const wordTo = wordFrom + clean.length;
            const replacement = a.syllables.join("|");
            view.focus();
            view.dispatch({
              changes: { from: wordFrom, to: wordTo, insert: replacement },
              selection: { anchor: wordFrom + replacement.length },
              userEvent: "input.type",
            });
            setHoveredAutoSplit(null);
            return;
          }
        }
      }
    }
  };

  // Toggle word wrap
  createEffect(() => {
    const wrap = wordWrap();
    if (view) {
      view.dispatch({
        effects: wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []),
      });
    }
  });

  const insertPipe = () => {
    if (!view) return;
    view.focus();
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "|" },
      selection: { anchor: sel.from + 1 },
    });
  };

  const copyAll = async () => {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(view.state.doc.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const selectAll = () => {
    if (!view) return;
    view.focus();
    view.dispatch({
      selection: { anchor: 0, head: view.state.doc.length },
    });
  };

  const clearAll = () => {
    if (!view) return;
    if (view.state.doc.length > 0) {
      if (!window.confirm("Clear all lyrics?")) return;
      view.focus();
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
      });
    }
  };

  const splitWordAtCursor = async () => {
    if (!view) return;
    const sel = view.state.selection.main;
    const doc = view.state.doc;
    const line = doc.lineAt(sel.from);
    const lineOffset = sel.from - line.from;

    // Find the word under or preceding the cursor
    const text = line.text;
    let wordStart = lineOffset;
    let wordEnd = lineOffset;

    if (sel.from === sel.to) {
      while (wordStart > 0 && /[A-Za-z|']/.test(text[wordStart - 1]!)) wordStart--;
      while (wordEnd < text.length && /[A-Za-z|']/.test(text[wordEnd]!)) wordEnd++;
    } else {
      wordStart = sel.from - line.from;
      wordEnd = sel.to - line.from;
    }

    if (wordStart >= wordEnd) return;

    const rawWord = text.slice(wordStart, wordEnd);
    const cleanWord = rawWord.replace(/\|/g, "").toLowerCase();
    const lang = props.language ?? "en";

    try {
      const res = await fetch(`/api/wizard/suggest?q=${encodeURIComponent(cleanWord)}&lang=${lang}`);
      if (res.ok) {
        const data: unknown = await res.json();
        if (isRecord(data) && Array.isArray(data.suggestions)) {
          const list = data.suggestions;
          for (const s of list) {
            if (isRecord(s) && typeof s.word === "string" && typeof s.split === "string" && s.word === cleanWord) {
              view.focus();
              view.dispatch({
                changes: { from: line.from + wordStart, to: line.from + wordEnd, insert: s.split },
                selection: { anchor: line.from + wordStart + s.split.length },
              });
              break;
            }
          }
        }
      }
    } catch {}
  };

  const add = async (key: string, word: string) => {
    const input = (drafts()[key] ?? "").trim();
    const err = await props.onAddPronunciation(word, input);
    setErrors({ ...errors(), [key]: err ?? "" });
    if (!err) setDrafts({ ...drafts(), [key]: "" });
  };

  return (
    <div class="daw-wizard-lyrics">
      <div class="daw-cm-editor-card">
        <header class="daw-cm-toolbar">
          <div class="daw-cm-toolbar-left">
            <span class="daw-cm-toolbar-title">
              <i class="bi bi-file-earmark-text" /> Lyrics
            </span>
          </div>
          <div class="daw-cm-toolbar-right">
            <button class="daw-btn daw-btn-xs" title="Select all text (Ctrl+A)" onClick={selectAll}>
              <i class="bi bi-check2-all" /> Select All
            </button>
            <button class="daw-btn daw-btn-xs" title="Copy all lyrics to clipboard" onClick={copyAll}>
              <i class={`bi bi-${copied() ? "check-lg" : "clipboard"}`} /> {copied() ? "Copied!" : "Copy All"}
            </button>
            <button class="daw-btn daw-btn-xs" title="Split syllables in word at cursor" onClick={splitWordAtCursor}>
              <i class="bi bi-scissors" /> Split Word
            </button>
            <button class="daw-btn daw-btn-xs" title="Insert syllable divider (|) at cursor" onClick={insertPipe}>
              <b>|</b> Pipe
            </button>
            <button
              class="daw-btn daw-btn-xs"
              classList={{ "daw-btn-accent": wordWrap() }}
              title={wordWrap() ? "Line wrapping enabled (click to disable)" : "Line wrapping disabled (click to enable)"}
              onClick={() => setWordWrap(!wordWrap())}
            >
              <i class="bi bi-text-wrap" /> Wrap
            </button>
            <button class="daw-btn daw-btn-xs daw-btn-danger-ghost" title="Clear lyrics text" onClick={clearAll}>
              <i class="bi bi-trash3" />
            </button>
          </div>
        </header>

        <div class="daw-cm-host" ref={editorContainer} />
      </div>

      <aside class="daw-wizard-check">
        <div class="daw-check-status" classList={{ "daw-check-ok": props.check?.ok === true, "daw-check-bad": props.check?.ok === false }}>
          <i class={`bi bi-${!props.check && props.checking ? "hourglass-split" : props.check?.ok ? "check-circle-fill" : props.check ? "exclamation-triangle-fill" : "pencil"}`} />
          {checkStatusText()}
        </div>

        <Show when={props.check && !props.check.ok && props.check.error}>
          <div class="daw-wizard-error">{props.check?.error ?? ""}</div>
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

        <Show when={props.check}>
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
                  Split automatically. Click a pill to apply the split:
                </p>
                <div class="daw-chip-row daw-chip-row-flush">
                  <For each={c().autoSplit}>
                    {(a) => (
                      <button
                        type="button"
                        class="daw-chip daw-chip-clickable"
                        title={`Click to split "${a.word}" on line ${a.line + 1} into "${a.syllables.join("|")}"`}
                        onClick={() => applyAutoSplit(a)}
                        onMouseEnter={() => setHoveredAutoSplit({ line: a.line, word: a.word })}
                        onMouseLeave={() => setHoveredAutoSplit(null)}
                      >
                        {a.syllables.join("|")}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </aside>
    </div>
  );
}
