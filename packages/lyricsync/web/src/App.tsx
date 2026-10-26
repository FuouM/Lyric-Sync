// packages/lyricsync/web/src/App.tsx
// Lyrics timing editor laid out like a DAW / NLE: menu bar, transport, project dock,
// program monitor, inspector and a multi-track timeline.
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { MenuBar, type MenuDef } from "./components/MenuBar";
import { TransportBar } from "./components/TransportBar";
import { ProjectPanel, type ProjectTab } from "./components/ProjectPanel";
import { ProgramMonitor } from "./components/ProgramMonitor";
import { Inspector } from "./components/Inspector";
import { TimelineCanvas, type MonitorTrack } from "./components/TimelineCanvas";
import { NewSongWizard } from "./components/NewSongWizard";
import { EditLyricsModal } from "./components/EditLyricsModal";
import { Logo } from "./components/Logo";
import type { LineReview } from "../../src/types";
import { isRecord, isStringArray } from "../../src/guards";
import { AudioPlayer, extractPeaks } from "./lib/audio-player";
import { storeLibraryHandle, getStoredLibraryHandle, clearStoredLibraryHandle } from "./lib/idb-storage";
import { CALIBRATED_PATH, errorMessage, handleStore, isAbort, loadReview, loadSongFiles, serverStore, type SongStore } from "./lib/song-files";
import { isSylPinned, parseCalibrationDoc, type CalibrationDoc, type CalLine } from "../../src/calibration-doc";
import { gridFromBar1, nearestBeatIndex, PROMPT_PATH, writeFirstDownbeat } from "./lib/beat-grid";
import { persistedSignal } from "./lib/persisted-signal";
import { theme, setTheme } from "./stores/theme";
import {
  addSectionAt,
  barBeatAt,
  flattenSyllables,
  formatTimecode,
  lineAt,
  moveEdge,
  moveSectionStart,
  rollPartner,
  pinLineEdges,
  parseSplit,
  resplitWord,
  removeSection,
  sameSyl,
  setLinePinned,
  setPinned,
  splitText,
  sylPair,
  switchSolvedTimes,
  tempoBpm,
  barTempoBpm,
  type SylRef,
} from "./lib/doc-edit";

const PEAKS_PER_SEC = 200;
const HISTORY_LIMIT = 100;

interface OpenSong {
  name: string;
  store: SongStore;
}

/** Lines with unpinned boundaries, most uncertain first. */
const sortReview = (review: LineReview[]) =>
  review.filter((r) => r.uncertain.length > 0).sort((a, b) => b.meanExpectedErrorMs - a.meanExpectedErrorMs);

export function App() {
  // Library / song
  const [libraryHandle, setLibraryHandle] = createSignal<FileSystemDirectoryHandle | null>(null);
  const [songs, setSongs] = createSignal<string[]>([]);
  const [song, setSong] = createSignal<OpenSong | null>(null);

  // Document + history
  const [calDoc, setCalDoc] = createSignal<CalibrationDoc | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [history, setHistory] = createSignal<CalibrationDoc[]>([]);
  const [future, setFuture] = createSignal<CalibrationDoc[]>([]);
  const [selectedSyl, setSelectedSyl] = createSignal<SylRef | null>(null);

  // Analysis data
  const [vocalPeaks, setVocalPeaks] = createSignal<Float32Array | undefined>();
  const [mixPeaks, setMixPeaks] = createSignal<Float32Array | undefined>();
  const [pitchContour, setPitchContour] = createSignal<number[] | undefined>();
  const [beats, setBeats] = createSignal<number[] | undefined>();
  const [downbeats, setDownbeats] = createSignal<number[] | undefined>();
  const [bar1Index, setBar1Index] = createSignal(0);
  const [reviewLines, setReviewLines] = createSignal<LineReview[]>([]);

  // Playback
  const [currentTime, setCurrentTime] = createSignal(0);
  const [isPlaying, setIsPlaying] = createSignal(false);
  const [audioDuration, setAudioDuration] = createSignal(0);
  const [monitor, setMonitor] = persistedSignal<MonitorTrack>("lyricsync.editor.monitor", "vocal", {
    deserialize: (raw) => (raw === '"mix"' || raw === '"vocal"' ? JSON.parse(raw) : "vocal"),
  });
  const [vocalUrl, setVocalUrl] = createSignal<string | null>(null);
  const [mixUrl, setMixUrl] = createSignal<string | null>(null);

  // View
  const [viewStart, setViewStart] = createSignal(0);
  const [viewDuration, setViewDuration] = createSignal(12);
  const [snap, setSnap] = persistedSignal("lyricsync.editor.snap", true);
  const [metronome, setMetronome] = persistedSignal("lyricsync.editor.metronome", false);
  const [follow, setFollow] = persistedSignal("lyricsync.editor.follow", true);
  const [showPitch, setShowPitch] = persistedSignal("lyricsync.editor.showPitch", true);
  /** Auto-time moves solved boundaries near a beat onto it (how hand-calibrated lyrics look); off keeps the acoustic times. */
  const [solveSnap, setSolveSnap] = persistedSignal("lyricsync.editor.solveSnap", true);
  /** The last Auto-time of the open song in both snap settings, so switching the setting re-times unpinned syllables at once. */
  const [solvedModes, setSolvedModes] = createSignal<{ song: string; snapped: CalLine[]; natural: CalLine[] } | null>(null);
  const [panelTab, setPanelTab] = persistedSignal<ProjectTab>("lyricsync.editor.panelTab", "lines", {
    deserialize: (raw) => (raw === '"sections"' || raw === '"review"' || raw === '"songs"' ? JSON.parse(raw) : "lines"),
  });
  const [timelineH, setTimelineH] = persistedSignal<number>("lyricsync.editor.timelineH", 380, {
    deserialize: (raw) => {
      const n = Number(JSON.parse(raw));
      return Number.isFinite(n) && n >= 220 ? n : 380;
    },
  });
  const [status, setStatus] = createSignal("Open a song folder to start.");
  /**
   * Where the editor server runs the models (GET/POST /api/config, server/device.ts). "gpu" uses `gpuProvider`; when it is null the
   * machine has no GPU provider and "gpu" runs on the CPU. null: no server answered (Solve features need it anyway).
   */
  const [modelDevice, setModelDevice] = createSignal<{ device: "gpu" | "cpu"; gpuProvider: string | null } | null>(null);
  const applyDeviceConfig = (data: unknown): void => {
    if (isRecord(data) && (data.device === "gpu" || data.device === "cpu")) {
      setModelDevice({ device: data.device, gpuProvider: typeof data.gpuProvider === "string" ? data.gpuProvider : null });
    }
  };
  void fetch("/api/config")
    .then((r) => r.json())
    .then(applyDeviceConfig)
    .catch(() => setModelDevice(null));
  const gpuName = (provider: string | null): string => (provider === "dml" ? "DirectML" : provider === "cuda" ? "CUDA" : "none found");
  const toggleModelDevice = async () => {
    const current = modelDevice();
    if (!current) return;
    const device = current.device === "gpu" ? "cpu" : "gpu";
    try {
      const res = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device }) });
      const data: unknown = await res.json();
      if (!res.ok) throw new Error(isRecord(data) && typeof data.message === "string" ? data.message : `HTTP ${res.status}`);
      applyDeviceConfig(data);
      setStatus(
        device === "gpu"
          ? `Models run on the GPU (${gpuName(current.gpuProvider)}).`
          : "Models run on the CPU: analysis takes about 4x longer; the results are the same."
      );
    } catch (e: unknown) {
      setStatus(`Could not change where the models run: ${errorMessage(e)}`);
    }
  };
  const [solving, setSolving] = createSignal(false);
  const [showWizard, setShowWizard] = createSignal(false);
  const [showEditLyrics, setShowEditLyrics] = createSignal(false);
  const [editLyricsText, setEditLyricsText] = createSignal("");
  const [editLyricsInitialLine, setEditLyricsInitialLine] = createSignal<number | null>(null);
  // Syllables per editor line and word that the song's analysis (lyricsync workspace) was made for; null until known.
  const [analysed, setAnalysed] = createSignal<{ lines: string[][][]; fresh: boolean } | null>(null);
  const [analysing, setAnalysing] = createSignal(false);
  let player: AudioPlayer | null = null;
  let stopAt: number | null = null;
  let lastMtime = 0;

  const duration = createMemo(() => Math.max(audioDuration(), calDoc()?.lines.at(-1)?.end ?? 0));
  const bpm = createMemo(() => tempoBpm(beats()));
  const barBpm = createMemo(() => barTempoBpm(currentTime(), beats(), downbeats()));
  const barBeat = createMemo(() => barBeatAt(currentTime(), beats(), downbeats(), bar1Index()));
  const bar1Time = () => downbeats()?.[bar1Index()] ?? null;
  const playingLine = createMemo(() => {
    const doc = calDoc();
    if (!doc) return -1;
    const li = lineAt(doc, currentTime());
    return li >= 0 && currentTime() <= doc.lines[li]!.end ? li : -1;
  });
  const hotspots = createMemo(() =>
    reviewLines().flatMap((r) => r.uncertain.map((u) => ({ time: u.time, expectedErrorMs: u.expectedErrorMs })))
  );

  /** Words whose syllables in the document differ from the analysed ones. */
  const resplitWords = createMemo(() => {
    const a = analysed();
    const doc = calDoc();
    if (!a || !doc) return [];
    return doc.lines.flatMap((l, li) =>
      l.words.flatMap((w, wi) => (a.lines[li]?.[wi]?.join("|") === w.sylText.join("|") ? [] : [{ lineIdx: li, wordIdx: wi }]))
    );
  });
  const analysisStale = () => analysed()?.fresh === false;
  const selectedAnalysedSplit = () => {
    const s = selectedSyl();
    return s ? (analysed()?.lines[s.lineIdx]?.[s.wordIdx] ?? null) : null;
  };

  // ── Editing ──────────────────────────────────────────────────────────────

  const snapshot = () => {
    const cur = calDoc();
    if (!cur) return;
    setHistory([...history().slice(-(HISTORY_LIMIT - 1)), cur]);
    setFuture([]);
  };

  /** Apply a mutation to a copy of the document. `undoable=false` is used while a drag is in progress. */
  const edit = (fn: (doc: CalibrationDoc) => void, message: string, undoable = true) => {
    const cur = calDoc();
    if (!cur) return;
    if (undoable) snapshot();
    const next = structuredClone(cur);
    fn(next);
    setCalDoc(next);
    setDirty(true);
    setStatus(message);
  };

  const undo = () => {
    const prev = history().at(-1);
    const cur = calDoc();
    if (!prev || !cur) return;
    setFuture([cur, ...future()]);
    setHistory(history().slice(0, -1));
    setCalDoc(prev);
    setDirty(true);
    setStatus("Undo");
  };

  const redo = () => {
    const next = future()[0];
    const cur = calDoc();
    if (!next || !cur) return;
    setHistory([...history(), cur]);
    setFuture(future().slice(1));
    setCalDoc(next);
    setDirty(true);
    setStatus("Redo");
  };

  const selInfo = () => {
    const doc = calDoc();
    const sel = selectedSyl();
    if (!doc || !sel) return null;
    const pair = sylPair(doc, sel);
    const word = doc.lines[sel.lineIdx]?.words[sel.wordIdx];
    return pair && word ? { doc, sel, pair, word, text: word.sylText[sel.sylIdx] ?? "" } : null;
  };

  const setEdge = (edge: "start" | "end", t: number) => {
    const s = selInfo();
    if (!s) return;
    edit((d) => moveEdge(d, s.sel, edge, t, rollPartner(d, s.sel, edge)), `“${s.text}” ${edge} → ${t.toFixed(3)} s`);
  };

  const togglePin = () => {
    const s = selInfo();
    if (!s) return;
    const next = !isSylPinned(s.doc.lines[s.sel.lineIdx]!, s.word, s.sel.sylIdx);
    edit((d) => setPinned(d, s.sel, next), `“${s.text}” ${next ? "pinned" : "unpinned"}`);
  };

  const toggleLinePin = () => {
    const s = selInfo();
    if (!s) return;
    const line = s.doc.lines[s.sel.lineIdx]!;
    const next = !line.calibrated;
    edit((d) => setLinePinned(d, s.sel.lineIdx, next), `Line ${line.i} ${next ? "frozen" : "unfrozen"}`);
  };

  /** Re-splits the selected word from "syl|la|bles" text. Returns an error message for the input, or null when applied. */
  const resplitSelected = (text: string): string | null => {
    const s = selInfo();
    if (!s) return null;
    let parts: string[];
    try {
      parts = parseSplit(text);
    } catch (e: unknown) {
      return errorMessage(e);
    }
    if (parts.join("|") === s.word.sylText.join("|")) return null;
    const recount = parts.length !== s.word.syl.length;
    edit(
      (d) => resplitWord(d, s.sel.lineIdx, s.sel.wordIdx, parts),
      `“${s.word.w}” split as ${parts.join("|")}${recount ? " (its syllables are unpinned; Re-analyze, then auto-time or set them)" : ""}`
    );
    setSelectedSyl({ ...s.sel, sylIdx: Math.min(s.sel.sylIdx, parts.length - 1) });
    return null;
  };

  const focusSplit = () => {
    const el = document.getElementById("daw-split-input");
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    }
  };

  const getProjectPath = (name: string): string => {
    const direct = localStorage.getItem(`lyricsync.songPath.${name}`);
    if (direct) return direct;
    const lib = libraryHandle();
    if (lib) {
      const libPath = localStorage.getItem(`lyricsync.libraryPath.${lib.name}`);
      if (libPath) return `${libPath.replace(/[/\\]+$/, "")}/${name}`;
    }
    return name;
  };
  const loadAnalysed = async (name: string) => {
    setAnalysed(null);
    try {
      const target = getProjectPath(name);
      const res = await fetch(`/api/lyrics/${encodeURIComponent(target)}/splits`);
      if (!res.ok) return;
      const body: unknown = await res.json();
      if (!isRecord(body) || body.found === false) return;
      const lines = body.lines;
      const valid = Array.isArray(lines) && lines.every((l): l is string[][] => Array.isArray(l) && l.every(isStringArray));
      if (!valid || typeof body.fresh !== "boolean") return;
      setAnalysed({ lines, fresh: body.fresh });
    } catch (e: unknown) {
      console.warn(`Could not read analysed syllables of ${name}:`, e);
    }
  };

  const [copiedStatus, setCopiedStatus] = createSignal(false);
  const copyStatus = async () => {
    const text = status();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedStatus(true);
      setTimeout(() => setCopiedStatus(false), 1500);
    } catch {}
  };

  /** Saves, writes the document's syllable splits to the lyrics and re-runs the analysis on the dev server, then reloads its state. */
  const reanalyze = async () => {
    const s = song();
    const doc = calDoc();
    if (!s || !doc || analysing()) return;
    if (dirty()) {
      await save();
      if (dirty()) return;
    }
    setAnalysing(true);
    let target = getProjectPath(s.name);
    try {
      let res = await fetch(`/api/lyrics/${encodeURIComponent(target)}/reanalyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: doc.lines.map((l) => ({ words: l.words.map((w) => ({ w: w.w, sylText: w.sylText })) })) }),
      });
      if (res.status === 404) {
        const input = window.prompt(
          `Re-analysis needs the song folder's path on your computer.\n\nEnter path for "${s.name}":`,
          target !== s.name ? target : ""
        );
        if (!input || !input.trim()) {
          setStatus("Re-analysis cancelled (song folder path needed).");
          return;
        }
        target = input.trim();
        localStorage.setItem(`lyricsync.songPath.${s.name}`, target);
        res = await fetch(`/api/lyrics/${encodeURIComponent(target)}/reanalyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines: doc.lines.map((l) => ({ words: l.words.map((w) => ({ w: w.w, sylText: w.sylText })) })) }),
        });
      }
      const started: unknown = await res.json();
      if (!res.ok) throw new Error(isRecord(started) && typeof started.message === "string" ? started.message : `HTTP ${res.status}`);
      for (;;) {
        const tick = Promise.withResolvers<void>();
        setTimeout(tick.resolve, 1500);
        await tick.promise;
        const body: unknown = await (await fetch("/api/lyrics/job")).json();
        const job = isRecord(body) && isRecord(body.job) ? body.job : null;
        if (!job || !Array.isArray(job.log)) throw new Error("The re-analysis job disappeared.");
        const last = job.log.at(-1);
        if (typeof last === "string") setStatus(`Re-analysing: ${last.trim()}`);
        if (job.state === "error") throw new Error(typeof job.error === "string" ? job.error : "failed");
        if (job.state === "done") break;
      }
      await loadAnalysed(s.name);
      setStatus("Re-analysis done. Auto-time to re-solve with the new syllables.");
    } catch (e: unknown) {
      setStatus(`Re-analysis failed: ${errorMessage(e)}`);
      await loadAnalysed(s.name);
    } finally {
      setAnalysing(false);
    }
  };

  const reconstructLyricsText = (doc: CalibrationDoc): string => {
    const out: string[] = [];
    let curSection: string | null = null;
    for (const l of doc.lines) {
      const sec = doc.sections.find(
        (s) => Math.abs(s.start - l.start) < 0.05 || (l.start >= s.start && l.start < s.end && s.name !== curSection)
      );
      if (sec && sec.name !== curSection) {
        curSection = sec.name;
        out.push(`[${sec.name}]`);
      }
      const words = l.words.map((w) => (w.sylText && w.sylText.length > 1 ? splitText(w) : w.w)).join(" ");
      out.push(words);
    }
    return out.join("\n");
  };

  const openEditLyrics = async (lineIdx: number | null = null) => {
    const s = song();
    const doc = calDoc();
    if (!s || !doc) return;
    setEditLyricsInitialLine(lineIdx);
    let text = "";
    try {
      const blob = await s.store.read("user_input/lyrics.txt");
      if (blob) text = await blob.text();
    } catch {}
    if (!text.trim()) {
      text = reconstructLyricsText(doc);
    }
    setEditLyricsText(text);
    setShowEditLyrics(true);
  };

  const handleLyricsApplied = async () => {
    const s = song();
    if (!s) return;
    try {
      setStatus("Reloading updated song files…");
      const files = await loadSongFiles(s.store);
      setCalDoc(files.doc);
      setReviewLines(sortReview(await loadReview(s.store)));
      await loadAnalysed(s.name);
      setDirty(false);
      setHistory([]);
      setFuture([]);
      setStatus("Lyrics updated and re-timed successfully.");
      setShowEditLyrics(false);
    } catch (e: unknown) {
      setStatus(`Failed to reload song files: ${errorMessage(e)}`);
    }
  };

  /** Makes the beat nearest the playhead bar 1 (the beats themselves stay) and saves it as first_downbeat_s in prompt.yaml. */
  const setBar1Here = async () => {
    const s = song();
    const b = beats();
    if (!s || !b || b.length === 0) return;
    const idx = nearestBeatIndex(b, currentTime());
    const grid = gridFromBar1(b, idx);
    setDownbeats(grid.downbeats);
    setBar1Index(grid.bar1Index);
    try {
      const prompt = await s.store.read(PROMPT_PATH);
      if (!prompt) throw new Error(`${PROMPT_PATH} is missing.`);
      await s.store.write(PROMPT_PATH, writeFirstDownbeat(await prompt.text(), b[idx]!));
      setStatus(`Bar 1 is now the beat at ${formatTimecode(b[idx]!)} (saved as first_downbeat_s in ${PROMPT_PATH}).`);
    } catch (e: unknown) {
      setStatus(`Bar 1 moved, but saving it failed: ${errorMessage(e)}`);
    }
  };

  const addSection = () => {
    if (!calDoc()) return;
    const t = currentTime();
    edit((d) => addSectionAt(d, t, duration()), `Section marker added at ${t.toFixed(2)} s`);
    setPanelTab("sections");
  };

  const stepSyllable = (dir: -1 | 1) => {
    const doc = calDoc();
    if (!doc) return;
    const flat = flattenSyllables(doc);
    const cur = selectedSyl();
    const idx = cur ? flat.findIndex((r) => sameSyl(r, cur)) : -1;
    const next = flat[Math.max(0, Math.min(flat.length - 1, idx + dir))];
    if (!next) return;
    setSelectedSyl(next);
    seek(sylPair(doc, next)![0]);
  };

  // ── Playback ─────────────────────────────────────────────────────────────

  const ensureVisible = (t: number) => {
    const vs = viewStart();
    const vd = viewDuration();
    if (t < vs || t > vs + vd) setViewStart(Math.max(0, t - vd * 0.25));
  };

  const seek = (t: number) => {
    const target = Math.max(0, t);
    stopAt = null;
    player?.seek(target);
    setCurrentTime(target);
    ensureVisible(target);
  };

  const togglePlay = () => {
    stopAt = null;
    player?.togglePlay();
  };

  const playRange = (start: number, end: number) => {
    seek(start);
    stopAt = end;
    player?.play();
  };

  const playLine = () => {
    const doc = calDoc();
    const li = selectedSyl()?.lineIdx ?? playingLine();
    const line = doc?.lines[li];
    if (line) playRange(line.start, line.end);
  };

  const playSyllable = () => {
    const s = selInfo();
    if (s) playRange(s.pair[0], s.pair[1]);
  };

  const gotoLine = (li: number) => {
    const doc = calDoc();
    const line = doc?.lines[li];
    if (!line) return;
    setSelectedSyl({ lineIdx: li, wordIdx: 0, sylIdx: 0 });
    seek(line.start);
    const vs = viewStart();
    if (line.start < vs || line.end > vs + viewDuration()) setViewStart(Math.max(0, line.start - 1));
  };

  const stepLine = (dir: -1 | 1) => {
    const doc = calDoc();
    if (!doc) return;
    const cur = lineAt(doc, currentTime() - (dir < 0 ? 0.05 : 0));
    gotoLine(Math.max(0, Math.min(doc.lines.length - 1, dir < 0 && currentTime() - (doc.lines[cur]?.start ?? 0) > 0.5 ? cur : cur + dir)));
  };

  const nextUnpinnedLine = (dir: -1 | 1) => {
    const doc = calDoc();
    if (!doc) return;
    const n = doc.lines.length;
    const from = selectedSyl()?.lineIdx ?? -1;
    for (let k = 1; k <= n; k++) {
      const li = (((from + dir * k) % n) + n) % n;
      if (!doc.lines[li]!.calibrated) {
        gotoLine(li);
        setStatus(`Line ${doc.lines[li]!.i} is not frozen yet`);
        return;
      }
    }
    setStatus("Every line is frozen.");
  };

  const zoom = (factor: number, anchor = currentTime()) => {
    const vd = viewDuration();
    const nd = Math.max(0.5, Math.min(duration() + 5, vd * factor));
    const rel = (anchor - viewStart()) / vd;
    setViewDuration(nd);
    setViewStart(Math.max(0, anchor - Math.max(0, Math.min(1, rel)) * nd));
  };

  const zoomFit = () => {
    setViewStart(0);
    setViewDuration(Math.max(5, duration() + 1));
  };

  const switchMonitor = (track: MonitorTrack) => {
    setMonitor(track);
    const url = track === "vocal" ? vocalUrl() : mixUrl();
    if (!url || !player) return;
    const wasPlaying = isPlaying();
    const t = currentTime();
    player.loadSource(url);
    player.seek(t);
    if (wasPlaying) player.play();
    setStatus(`Listening to ${track}`);
  };

  // Follow playhead: while playing, the view scrolls so the playhead stays in the middle.
  createEffect(() => {
    const t = currentTime();
    if (!follow() || !isPlaying()) return;
    setViewStart(Math.max(0, t - viewDuration() / 2));
  });

  // ── Files ────────────────────────────────────────────────────────────────

  const confirmDiscard = () => !dirty() || window.confirm("Discard unsaved timing changes?");

  /** Opens a song the wizard just built, through the dev server (it lives in the server's songs folder; no folder picker needed). */
  const openCreated = async (id: string) => {
    setShowWizard(false);
    const lib = libraryHandle();
    if (lib) await refreshSongs(lib);
    await loadSong(serverStore(id));
  };

  const openByPath = async () => {
    if (!confirmDiscard()) return;
    const input = window.prompt("Enter or paste the song folder's path on your computer (e.g. K:\\Music\\MySong):");
    if (!input || !input.trim()) return;
    const trimmed = input.trim();
    try {
      const res = await fetch(`/api/project/verify?path=${encodeURIComponent(trimmed)}`);
      const body: unknown = await res.json();
      if (!res.ok || !isRecord(body) || typeof body.dir !== "string") {
        throw new Error(isRecord(body) && typeof body.message === "string" ? body.message : `HTTP ${res.status}`);
      }
      setLibraryHandle(null);
      setSongs([]);
      await loadSong(serverStore(body.dir));
    } catch (e: unknown) {
      setStatus(`Could not open "${trimmed}": ${errorMessage(e)}`);
    }
  };
  const pickSingleSong = async () => {
    if (!confirmDiscard()) return;
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      setLibraryHandle(null);
      setSongs([]);

      // Ask for the full path immediately after picking the folder
      const prevPath = localStorage.getItem(`lyricsync.songPath.${handle.name}`) ?? "";
      const input = window.prompt(
        `Enter the full path of "${handle.name}" on your computer:\n(The server uses this path for Auto-time and Re-analysis)`,
        prevPath
      );
      if (input && input.trim()) {
        const fullPath = input.trim();
        localStorage.setItem(`lyricsync.songPath.${handle.name}`, fullPath);
        void fetch(`/api/project/verify?path=${encodeURIComponent(fullPath)}`).catch(() => {});
      }

      await loadSong(handleStore(handle));
    } catch (e: unknown) {
      if (!isAbort(e)) setStatus(`Could not open song folder: ${errorMessage(e)}`);
    }
  };

  const pickLibrary = async () => {
    if (!confirmDiscard()) return;
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      setLibraryHandle(handle);
      await storeLibraryHandle(handle);

      const prevPath = localStorage.getItem(`lyricsync.libraryPath.${handle.name}`) ?? "";
      const input = window.prompt(
        `Enter the full path of the library folder "${handle.name}":\n(All songs in this library will be registered with the server)`,
        prevPath
      );
      if (input && input.trim()) {
        const libPath = input.trim();
        localStorage.setItem(`lyricsync.libraryPath.${handle.name}`, libPath);
        void fetch("/api/library/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: libPath }),
        }).catch(() => {});
      }

      await refreshSongs(handle);
    } catch (e: unknown) {
      if (!isAbort(e)) setStatus(`Could not open library: ${errorMessage(e)}`);
    }
  };

  const closeLibrary = async () => {
    await clearStoredLibraryHandle();
    setLibraryHandle(null);
    setSongs([]);
    setPanelTab("lines");
    setStatus("Library closed.");
  };

  const refreshSongs = async (root: FileSystemDirectoryHandle) => {
    const list: string[] = [];
    for await (const [name, h] of root.entries()) if (h.kind === "directory" && !name.startsWith(".")) list.push(name);
    list.sort();
    setSongs(list);
    setPanelTab("songs");
    setStatus(`Library ${root.name}: ${list.length} folders`);
  };

  const openLibrarySong = async (name: string) => {
    const root = libraryHandle();
    if (!root || !confirmDiscard()) return;
    await loadSong(handleStore(await root.getDirectoryHandle(name)));
  };

  const loadSong = async (store: SongStore) => {
    const name = store.name;
    setStatus(`Opening ${name}…`);
    player?.pause();
    try {
      const files = await loadSongFiles(store);
      for (const u of [vocalUrl(), mixUrl()]) if (u) URL.revokeObjectURL(u);
      const vUrl = URL.createObjectURL(files.vocal.blob);
      const mUrl = URL.createObjectURL(files.mix.blob);
      setSong({ name, store });
      lastMtime = files.calMtime;
      setCalDoc(files.doc);
      setDirty(false);
      setHistory([]);
      setFuture([]);
      setBeats(files.beats);
      setDownbeats(files.downbeats);
      setBar1Index(files.bar1Index);
      setPitchContour(files.f0Hz);
      setReviewLines(sortReview(files.review));
      void loadAnalysed(name);
      setVocalUrl(vUrl);
      setMixUrl(mUrl);
      setVocalPeaks(undefined);
      setMixPeaks(undefined);
      player?.loadSource(monitor() === "vocal" ? vUrl : mUrl);
      for (const [file, set] of [[files.vocal, setVocalPeaks], [files.mix, setMixPeaks]] as const) {
        file.blob.arrayBuffer().then((b) => extractPeaks(b, PEAKS_PER_SEC)).then(
          (r) => set(r.peaks),
          (err: unknown) => setStatus(`Cannot decode ${file.name}: ${errorMessage(err)}`)
        );
      }

      const first = files.doc.lines[0];
      setSelectedSyl(first ? { lineIdx: 0, wordIdx: 0, sylIdx: 0 } : null);
      setViewDuration(12);
      setViewStart(Math.max(0, (first?.start ?? 0) - 1));
      seek(first?.start ?? 0);
      if (panelTab() === "songs") setPanelTab("lines");
      setStatus(`Opened ${name}: ${files.doc.lines.length} lines`);
    } catch (e: unknown) {
      setStatus(`Cannot open ${name}: ${errorMessage(e)}`);
    }
  };

  const save = async () => {
    const doc = calDoc();
    const s = song();
    if (!doc || !s) return;
    try {
      lastMtime = await s.store.write(CALIBRATED_PATH, `${JSON.stringify(doc, null, 2)}\n`);
      setDirty(false);
      setStatus(`Saved ${CALIBRATED_PATH}`);
    } catch (e: unknown) {
      setStatus(`Save failed: ${errorMessage(e)}`);
    }
  };

  const exportCopy = async () => {
    const doc = calDoc();
    if (!doc) return;
    try {
      const fh = await window.showSaveFilePicker({
        suggestedName: "lyrics.calibrated.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      const w = await fh.createWritable();
      await w.write(`${JSON.stringify(doc, null, 2)}\n`);
      await w.close();
      setStatus(`Exported a copy to ${fh.name}`);
    } catch (e: unknown) {
      if (!isAbort(e)) setStatus(`Export failed: ${errorMessage(e)}`);
    }
  };

  /** Re-time every unpinned syllable around the pins with the local solve endpoint (dev server). */
  const solve = async () => {
    const s = song();
    const doc = calDoc();
    if (!s || !doc) return;
    if (resplitWords().length > 0 || analysisStale()) {
      setStatus("Re-analyze first: the song's analysis does not match the syllables.");
      return;
    }
    setSolving(true);
    setStatus("Auto-timing unpinned syllables…");
    let project = getProjectPath(s.name);
    try {
      let res = await fetch("/api/realign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, lines: doc.lines, snapToBeats: solveSnap() }),
      });
      if (res.status === 404) {
        const input = window.prompt(
          `Auto-time needs the song folder's path on your computer.\n\nEnter path for "${s.name}":`,
          project !== s.name ? project : ""
        );
        if (!input || !input.trim()) {
          setStatus("Auto-timing cancelled (song folder path needed).");
          return;
        }
        project = input.trim();
        localStorage.setItem(`lyricsync.songPath.${s.name}`, project);
        res = await fetch("/api/realign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project, lines: doc.lines, snapToBeats: solveSnap() }),
        });
      }
      const body: unknown = await res.json();
      if (!isRecord(body)) throw new Error(`Solve endpoint returned HTTP ${res.status} without a JSON object.`);
      if (!res.ok) throw new Error(typeof body.message === "string" ? body.message : `HTTP ${res.status}`);
      // Re-validate: the solved lines replace the document's lines.
      const solved = parseCalibrationDoc({ ...doc, lines: body.lines });
      const alternate = parseCalibrationDoc({ ...doc, lines: body.alternate });
      if (calDoc() !== doc) {
        setStatus("Auto-timing finished, but you edited meanwhile; result discarded. Run it again.");
        return;
      }
      const snapped = body.snapToBeats !== false;
      const [snappedLines, naturalLines] = snapped ? [solved.lines, alternate.lines] : [alternate.lines, solved.lines];
      setSolvedModes({ song: s.name, snapped: structuredClone(snappedLines), natural: structuredClone(naturalLines) });
      edit((d) => {
        d.lines = solved.lines;
      }, "Auto-timing done: unpinned syllables follow the solver. Save (Ctrl+S) to keep it.");
      setReviewLines(sortReview(await loadReview(s.store)));
    } catch (e: unknown) {
      setStatus(`Auto-timing failed: ${errorMessage(e)}`);
    } finally {
      setSolving(false);
    }
  };

  /**
   * Switches "Snap Auto-timing to Beats". After an Auto-time of this song the unpinned syllables move to the other setting's times
   * right away (one undoable edit); pinned syllables and syllables moved by hand since then stay.
   */
  const toggleSolveSnap = () => {
    const on = !solveSnap();
    setSolveSnap(on);
    const modes = solvedModes();
    const s = song();
    const doc = calDoc();
    const label = `Snap Auto-timing to Beats ${on ? "on" : "off"}`;
    if (!modes || !s || !doc || modes.song !== s.name) {
      setStatus(`${label}: applies from the next Auto-time.`);
      return;
    }
    const [from, to] = on ? [modes.natural, modes.snapped] : [modes.snapped, modes.natural];
    const moved = switchSolvedTimes(structuredClone(doc), from, to);
    if (moved === 0) {
      setStatus(`${label}: no unpinned syllable changes.`);
      return;
    }
    edit((d) => void switchSolvedTimes(d, from, to), `${label}: ${moved} unpinned syllable${moved === 1 ? "" : "s"} re-timed; pinned ones stay.`);
  };

  // ── Keyboard ─────────────────────────────────────────────────────────────

  const onKeyDown = (e: KeyboardEvent) => {
    if (showWizard() || showEditLyrics() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const handled = () => e.preventDefault();

    if (ctrl) {
      if (e.shiftKey && (k === "l" || k === "L")) void openEditLyrics();
      else if (k === "z" || k === "Z") (e.shiftKey ? redo : undo)();
      else if (k === "y" || k === "Y") redo();
      else if (k === "s" || k === "S") void save();
      else if (k === "o" || k === "O") void pickSingleSong();
      else return;
      return handled();
    }
    switch (k) {
      case " ": togglePlay(); break;
      case "Enter": playSyllable(); break;
      case "p": case "P": playLine(); break;
      case ",": stepSyllable(-1); break;
      case ".": stepSyllable(1); break;
      case "[": setEdge("start", currentTime()); break;
      case "]": setEdge("end", currentTime()); break;
      case "c": case "C": (e.shiftKey ? toggleLinePin : togglePin)(); break;
      case "Tab": nextUnpinnedLine(e.shiftKey ? -1 : 1); break;
      case "m": case "M": addSection(); break;
      case "e": case "E": focusSplit(); break;
      case "b": case "B": void setBar1Here(); break;
      case "s": case "S": setSnap(!snap()); setStatus(`Snap ${snap() ? "on" : "off"}`); break;
      case "f": case "F": setFollow(!follow()); setStatus(`Follow playhead ${follow() ? "on" : "off"}`); break;
      case "+": case "=": zoom(1 / 1.5); break;
      case "-": case "_": zoom(1.5); break;
      case "Home": seek(0); break;
      case "End": seek(duration()); break;
      case "ArrowLeft": seek(currentTime() - (e.shiftKey ? 2 : 0.5)); break;
      case "ArrowRight": seek(currentTime() + (e.shiftKey ? 2 : 0.5)); break;
      case "ArrowUp": stepLine(-1); break;
      case "ArrowDown": stepLine(1); break;
      default: return;
    }
    handled();
  };

  // ── Lifecycle ────────────────────────────────────────────────────────────

  onMount(() => {
    player = new AudioPlayer((st) => {
      setIsPlaying(st.isPlaying);
      setAudioDuration(st.duration);
      if (stopAt !== null && st.isPlaying && st.currentTime >= stopAt) {
        stopAt = null;
        player?.pause();
      }
      setCurrentTime(st.currentTime);
    });
    // Reload lyrics.calibrated.json when another tool (CLI, agent) rewrites it.
    const poll = window.setInterval(async () => {
      const s = song();
      if (!s || solving()) return;
      const mtime = await s.store.mtime(CALIBRATED_PATH);
      if (mtime === null || mtime <= lastMtime) return;
      lastMtime = mtime;
      if (dirty()) {
        setStatus(`${CALIBRATED_PATH} changed on disk, but you have unsaved edits. Save to overwrite it, or File › Reload to take the disk version.`);
        return;
      }
      try {
        const blob = await s.store.read(CALIBRATED_PATH);
        if (!blob) return;
        setCalDoc(parseCalibrationDoc(JSON.parse(await blob.text())));
        setStatus(`${CALIBRATED_PATH} changed on disk; reloaded.`);
      } catch (err: unknown) {
        setStatus(`${CALIBRATED_PATH} changed on disk but cannot be read: ${errorMessage(err)}`);
      }
    }, 2000);

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty()) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", beforeUnload);
    onCleanup(() => {
      clearInterval(poll);
      player?.dispose();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", beforeUnload);
    });

    // Test seam: headless browser runs cannot use the folder picker, so they open a song folder copied into OPFS.
    Object.assign(window, { __openSong: (handle: FileSystemDirectoryHandle) => loadSong(handleStore(handle)), __openProject: (id: string) => loadSong(serverStore(id)) });

    void getStoredLibraryHandle().then(async (handle) => {
      if (!handle || (await handle.queryPermission({ mode: "readwrite" })) !== "granted") return;
      setLibraryHandle(handle);
      await refreshSongs(handle);
    });

    void getStoredLibraryHandle().then(async (handle) => {
      if (!handle) return;
      const perm = await (handle as unknown as { queryPermission(o: { mode: string }): Promise<string> }).queryPermission({ mode: "readwrite" });
      if (perm !== "granted") return;
      setLibraryHandle(handle);
      await refreshSongs(handle);
    });
  });

  // ── Splitter ─────────────────────────────────────────────────────────────

  const startSplitDrag = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = timelineH();
    const move = (ev: PointerEvent) => setTimelineH(Math.max(220, Math.min(window.innerHeight - 260, startH - (ev.clientY - startY))));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // ── Menus ────────────────────────────────────────────────────────────────

  const menus = (): MenuDef[] => {
    const hasDoc = !!calDoc();
    const hasSel = !!selectedSyl();
    return [
      {
        label: "File",
        items: [
          { label: "Open Song Folder…", shortcut: "Ctrl+O", action: () => void pickSingleSong() },
          { label: "Open Song by Path…", action: () => void openByPath() },
          { label: "New Song…", action: () => confirmDiscard() && setShowWizard(true) },
          { label: "Open Library Folder…", action: () => void pickLibrary() },
          { label: "Close Library", action: () => void closeLibrary(), disabled: !libraryHandle() },
          "separator",
          { label: "Save", shortcut: "Ctrl+S", action: () => void save(), disabled: !song() },
          { label: "Export Copy…", action: () => void exportCopy(), disabled: !hasDoc },
          { label: "Reload From Disk", action: () => { const s = song(); if (s && confirmDiscard()) void loadSong(s.store); }, disabled: !song() },
        ],
      },
      {
        label: "Edit",
        items: [
          { label: "Undo", shortcut: "Ctrl+Z", action: undo, disabled: history().length === 0 },
          { label: "Redo", shortcut: "Ctrl+Y", action: redo, disabled: future().length === 0 },
          "separator",
          { label: "Edit Lyrics...", shortcut: "Ctrl+Shift+L", action: () => void openEditLyrics(), disabled: !hasDoc || analysing() },
          "separator",
          { label: "Set Start to Playhead", shortcut: "[", action: () => setEdge("start", currentTime()), disabled: !hasSel },
          { label: "Set End to Playhead", shortcut: "]", action: () => setEdge("end", currentTime()), disabled: !hasSel },
          { label: "Pin / Unpin Syllable", shortcut: "C", action: togglePin, disabled: !hasSel },
          { label: "Freeze / Unfreeze Line", shortcut: "Shift+C", action: toggleLinePin, disabled: !hasSel },
          { label: "Pin Line Edges", action: () => { const s = selectedSyl(); if (s) edit((d) => pinLineEdges(d, s.lineIdx), "Line edges pinned"); }, disabled: !hasSel },
          { label: "Edit Syllable Split", shortcut: "E", action: focusSplit, disabled: !hasSel },
          { label: "Add Section Marker at Playhead", shortcut: "M", action: addSection, disabled: !hasDoc },
          { label: "Set Bar 1 at Playhead", shortcut: "B", action: () => void setBar1Here(), disabled: !beats() },
        ],
      },
      {
        label: "Playback",
        items: [
          { label: isPlaying() ? "Pause" : "Play", shortcut: "Space", action: togglePlay },
          { label: "Play Selected Syllable", shortcut: "Enter", action: playSyllable, disabled: !hasSel },
          { label: "Play Selected Line", shortcut: "P", action: playLine, disabled: !hasDoc },
          "separator",
          { label: "Previous Line", shortcut: "↑", action: () => stepLine(-1), disabled: !hasDoc },
          { label: "Next Line", shortcut: "↓", action: () => stepLine(1), disabled: !hasDoc },
          { label: "Next Unfrozen Line", shortcut: "Tab", action: () => nextUnpinnedLine(1), disabled: !hasDoc },
          "separator",
          { label: "Listen: Vocal", action: () => switchMonitor("vocal"), checked: monitor() === "vocal", disabled: !vocalUrl() },
          { label: "Listen: Mix", action: () => switchMonitor("mix"), checked: monitor() === "mix", disabled: !mixUrl() },
          { label: "Metronome Click", action: () => setMetronome(!metronome()), checked: metronome() },
        ],
      },
      {
        label: "View",
        items: [
          { label: "Zoom In", shortcut: "+", action: () => zoom(1 / 1.5) },
          { label: "Zoom Out", shortcut: "−", action: () => zoom(1.5) },
          { label: "Zoom to Song", action: zoomFit },
          "separator",
          { label: "Follow Playhead", shortcut: "F", action: () => setFollow(!follow()), checked: follow() },
          { label: "Snap", shortcut: "S", action: () => setSnap(!snap()), checked: snap() },
          { label: "Pitch Contour", action: () => setShowPitch(!showPitch()), checked: showPitch() },
          "separator",
          { label: "Theme: Light", action: () => setTheme("light"), checked: theme() === "light" },
          { label: "Theme: Dark", action: () => setTheme("dark"), checked: theme() === "dark" },
          { label: "Theme: High Contrast", action: () => setTheme("high-contrast"), checked: theme() === "high-contrast" },
        ],
      },
      {
        label: "Solve",
        items: [
          { label: "Auto-time Unpinned Syllables", action: solve, disabled: !hasDoc || solving() || analysing() || resplitWords().length > 0 || analysisStale() },
          { label: "Re-analyze (apply syllable splits)", action: () => void reanalyze(), disabled: !hasDoc || analysing() || solving() },
          { label: "Edit Lyrics and Retime...", action: () => void openEditLyrics(), disabled: !hasDoc || analysing() },
          "separator",
          { label: "Snap Auto-timing to Beats", action: toggleSolveSnap, checked: solveSnap(), disabled: solving() },
          {
            label: `Run Models on GPU (${modelDevice() ? gpuName(modelDevice()!.gpuProvider) : "no server"})`,
            action: () => void toggleModelDevice(),
            checked: modelDevice()?.device === "gpu",
            disabled: !modelDevice() || solving() || analysing(),
          },
        ],
      },
    ];
  };
  // ── Layout ───────────────────────────────────────────────────────────────

  const welcome = (
    <div class="daw-welcome">
      <Logo width={80} height={80} class="daw-welcome-logo" />
      <h1>lyricsync</h1>
      <p>Time lyrics to the syllable, like editing clips in a video editor.</p>
      <div class="daw-welcome-actions">
        <button class="daw-btn daw-btn-accent daw-btn-lg" onClick={() => setShowWizard(true)}>
          <i class="bi bi-magic" /> New Song…
        </button>
        <button class="daw-btn daw-btn-lg" onClick={() => void pickSingleSong()}>
          <i class="bi bi-folder2-open" /> Open Song Folder…
        </button>
        <button class="daw-btn daw-btn-lg" onClick={() => void openByPath()}>
          <i class="bi bi-folder-symlink" /> Open by Path…
        </button>
        <button class="daw-btn daw-btn-lg" onClick={() => void pickLibrary()}>
          <i class="bi bi-collection" /> Open Library Folder…
        </button>
      </div>
      <p class="daw-welcome-hint">
        New Song builds a song folder from a mix, a vocal stem and the lyrics. A song folder holds project.json, {CALIBRATED_PATH} and a
        prepared lyricsync/ workspace; a library folder holds many song folders.
      </p>
    </div>
  );

  return (
    <div class="daw-app">
      <MenuBar menus={menus()}>
        <Show when={song()}>
          <span class="daw-doc-title" title={song()!.name}>
            {(() => {
              const n = song()!.name.replace(/\\/g, "/");
              return n.includes("/") ? n.split("/").filter(Boolean).at(-1)! : song()!.name;
            })()}
            <span class="daw-doc-path"> — {CALIBRATED_PATH}</span>
            <Show when={dirty()}>
              <span class="daw-dirty-dot" title="Unsaved changes" />
            </Show>
          </span>
        </Show>
      </MenuBar>

      <TransportBar
        isPlaying={isPlaying()}
        currentTime={currentTime()}
        duration={duration()}
        barBeat={barBeat()}
        bpm={bpm()}
        barBpm={barBpm()}
        bar1Time={bar1Time()}
        onSetBar1={() => void setBar1Here()}
        onPlayPause={togglePlay}
        onToStart={() => seek(0)}
        onPrevLine={() => stepLine(-1)}
        onNextLine={() => stepLine(1)}
        monitor={monitor()}
        hasMix={!!mixUrl()}
        hasVocal={!!vocalUrl()}
        onMonitor={switchMonitor}
        snap={snap()}
        onSnap={() => setSnap(!snap())}
        metronome={metronome()}
        onMetronome={() => setMetronome(!metronome())}
        follow={follow()}
        onFollow={() => setFollow(!follow())}
        onZoom={(f) => zoom(f)}
        onZoomFit={zoomFit}
        dirty={dirty()}
        canSave={!!song()}
        onSave={() => void save()}
        solving={solving()}
        canSolve={!!song()}
        onSolve={solve}
        resplitWords={resplitWords().length}
        analysisStale={analysisStale()}
        analysing={analysing()}
        onReanalyze={() => void reanalyze()}
        onEditLyrics={() => void openEditLyrics()}
      />

      <div class="daw-upper">
        <div class="daw-dock daw-dock-left">
          <ProjectPanel
            tab={panelTab()}
            onTab={setPanelTab}
            songs={songs()}
            activeSong={song()?.name ?? null}
            onOpenSong={(n) => void openLibrarySong(n)}
            doc={calDoc()}
            reviewLines={reviewLines()}
            selectedLine={selectedSyl()?.lineIdx ?? null}
            playingLine={playingLine()}
            onSelectLine={gotoLine}
            onSeek={seek}
            onRenameSection={(i, n) => edit((d) => { d.sections[i]!.name = n; }, `Section renamed to ${n}`)}
            onSetSectionStart={(i, t) => edit((d) => moveSectionStart(d, i, t), `Section start → ${t.toFixed(2)} s`)}
            currentTime={currentTime()}
            onRemoveSection={(i) => edit((d) => removeSection(d, i), "Section removed")}
            onAddSection={addSection}
            onEditLyrics={(lineIdx) => void openEditLyrics(lineIdx ?? null)}
          />
        </div>

        <div class="daw-center">
          <div class="daw-panel-title">
            <i class="bi bi-display" /> Program
          </div>
          <ProgramMonitor
            doc={calDoc()}
            currentTime={currentTime()}
            beats={beats()}
            downbeats={downbeats()}
            bar1Index={bar1Index()}
            isPlaying={isPlaying()}
            metronome={metronome()}
            empty={welcome}
          />
        </div>

        <div class="daw-dock daw-dock-right">
          <div class="daw-panel-title">
            <i class="bi bi-sliders" /> Inspector
          </div>
          <Inspector
            doc={calDoc()}
            selected={selectedSyl()}
            bpm={bpm()}
            bar1Time={bar1Time()}
            onSetBar1={() => void setBar1Here()}
            onSetEdge={setEdge}
            onEdgeToPlayhead={(edge) => setEdge(edge, currentTime())}
            onTogglePin={togglePin}
            onToggleLinePin={toggleLinePin}
            onPinLineEdges={() => { const s = selectedSyl(); if (s) edit((d) => pinLineEdges(d, s.lineIdx), "Line edges pinned"); }}
            onPlaySyllable={playSyllable}
            onPlayLine={playLine}
            onStep={stepSyllable}
            analysedSplit={selectedAnalysedSplit()}
            onResplit={resplitSelected}
          />
        </div>
      </div>

      <div class="daw-splitter" onPointerDown={startSplitDrag} title="Drag to resize the timeline" />

      <div class="daw-timeline-panel" style={{ height: `${timelineH()}px` }}>
        <TimelineCanvas
          doc={calDoc()}
          duration={duration()}
          currentTime={currentTime()}
          viewStart={viewStart()}
          viewDuration={viewDuration()}
          beats={beats()}
          downbeats={downbeats()}
          bar1Index={bar1Index()}
          mixPeaks={mixPeaks()}
          vocalPeaks={vocalPeaks()}
          peaksPerSec={PEAKS_PER_SEC}
          pitchContour={pitchContour()}
          showPitch={showPitch()}
          snapEnabled={snap()}
          selectedSyl={selectedSyl()}
          hotspots={hotspots()}
          monitor={monitor()}
          onMonitor={switchMonitor}
          onTogglePitch={() => setShowPitch(!showPitch())}
          onAddSection={addSection}
          onViewChange={(s, d) => {
            setViewStart(s);
            setViewDuration(d);
          }}
          onUserPan={() => {
            if (follow() && isPlaying()) {
              setFollow(false);
              setStatus("Follow playhead off while you look around (F turns it back on).");
            }
          }}
          onSeek={(t) => {
            stopAt = null;
            player?.seek(t);
            setCurrentTime(t);
          }}
          onSelectSyllable={setSelectedSyl}
          onPlayRange={playRange}
          onEditBegin={snapshot}
          onBoundaryDrag={(ref, edge, t, partner) => {
            edit((d) => moveEdge(d, ref, edge, t, partner), `${edge === "start" ? "Start" : "End"} → ${t.toFixed(3)} s${partner ? "" : " (alone)"}`, false);
          }}
          onSectionDrag={(si, t) => edit((d) => moveSectionStart(d, si, t), `Section start → ${t.toFixed(2)} s`, false)}
        />
      </div>

      <Show when={showWizard()}>
        <NewSongWizard onClose={() => setShowWizard(false)} onOpen={(id) => void openCreated(id)} />
      </Show>
      <Show when={showEditLyrics()}>
        <EditLyricsModal
          songName={song()?.name ?? ""}
          initialText={editLyricsText()}
          initialLine={editLyricsInitialLine()}
          onClose={() => setShowEditLyrics(false)}
          onApplied={() => void handleLyricsApplied()}
        />
      </Show>

      <footer class="status-strip">
        <div class="status-cell" style={{ flex: "1", "min-width": "0" }}>
          <div
            class="status-dot"
            classList={{
              busy: solving() || analysing(),
              offline: status().toLowerCase().includes("fail") || status().toLowerCase().includes("error"),
            }}
          />
          <button
            class="daw-status-copy-btn"
            classList={{ "daw-status-copy-btn--copied": copiedStatus() }}
            title={copiedStatus() ? "Copied!" : "Copy status message to clipboard"}
            onClick={copyStatus}
          >
            <i class={`bi bi-${copiedStatus() ? "check-lg" : "clipboard"}`} />
          </button>
          <span class="daw-status-msg" title={status()}>{status()}</span>
        </div>
        <div class="status-cell">
          <i class="bi bi-clock" />
          <span>{formatTimecode(currentTime())} / {formatTimecode(duration())}</span>
        </div>
        <Show when={barBeat()}>
          {(bb) => (
            <div class="status-cell">
              <i class="bi bi-music-note" />
              <span>Bar {bb().bar}.{bb().beat}</span>
            </div>
          )}
        </Show>
        <div class="status-cell">
          <i class="bi bi-cpu" />
          <span>{modelDevice() ? `${modelDevice()!.device.toUpperCase()}: ${gpuName(modelDevice()!.gpuProvider)}` : "No server"}</span>
        </div>
        <div class="status-cell" style={{ "border-right": "none" }}>
          <span class="daw-status-hint">Space: play · C: pin · [: start · ]: end · Ctrl+S: save</span>
        </div>
      </footer>
    </div>
  );
}
