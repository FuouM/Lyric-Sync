// packages/lyricsync/web/src/App.tsx
// Lyrics timing editor laid out like a DAW / NLE: menu bar, transport, project dock,
// program monitor, inspector and a multi-track timeline.
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { MenuBar, type MenuDef } from "./components/MenuBar";
import { LEAD_ONLY, TransportBar } from "./components/TransportBar";
import { ProjectPanel, type ProjectTab } from "./components/ProjectPanel";
import { ProgramMonitor } from "./components/ProgramMonitor";
import { Inspector } from "./components/Inspector";
import { TimelineCanvas, type MonitorTrack, type TimelineLane } from "./components/TimelineCanvas";
import { NewSongWizard } from "./components/NewSongWizard";
import { EditLyricsModal } from "./components/EditLyricsModal";
import { Logo } from "./components/Logo";
import type { LineReview } from "../../src/types";
import { isNumber, isRecord, isStringArray } from "../../src/guards";
import { AudioPlayer, audibleTracks, bufferPeaks, UNITY_MIX, wholeBuffer, type TrackClip, type TrackMix } from "./lib/audio-player";
import { storeLibraryHandle, getStoredLibraryHandle, clearStoredLibraryHandle } from "./lib/idb-storage";
import {
  CALIBRATED_PATH,
  errorMessage,
  handleStore,
  isAbort,
  loadCalibration,
  loadRenders,
  loadReview,
  loadSingers,
  loadSongFiles,
  PLACEMENTS_PATH,
  readRenderWav,
  serverStore,
  type SongRenders,
  type SongStore,
} from "./lib/song-files";
import { isSylPinned, parseCalibrationDoc, type CalibrationDoc, type CalLine } from "../../src/calibration-doc";
import { clipTickRange, parsePlacements, splitClip, type Placements, type RenderEntry } from "../../src/placements";
import { calibratedFileFor, type Singer } from "../../src/singers";
import { blockNames, clipTime, isDuplicate, nextLaneId, renderOf, secPerTick, tempoWarning } from "./lib/lanes";
import { gridFromBar1, nearestBeatIndex, PROMPT_PATH, readFirstDownbeat, writeFirstDownbeat } from "./lib/beat-grid";
import { readTempoMap, tempoAt, type TempoMap } from "./lib/tempo-grid";
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

/** One undo step: the calibration or the lane placements as they were. */
type EditState = { doc: CalibrationDoc } | { placements: Placements | null };

/** The calibration of a singer that is not selected: kept with its own undo steps and unsaved state while another singer is edited. */
interface SingerState {
  doc: CalibrationDoc;
  history: EditState[];
  future: EditState[];
  dirty: boolean;
  /** The file exists (else the first save with lines or sections creates it). */
  exists: boolean;
  mtime: number;
}

/** The decoded wav of a render, or why there is none. */
interface LaneAudio {
  buffer?: AudioBuffer;
  peaks?: Float32Array;
  problem?: string;
}

/** Lines with unpinned boundaries, most uncertain first. */
const sortReview = (review: LineReview[]) =>
  review.filter((r) => r.uncertain.length > 0).sort((a, b) => b.meanExpectedErrorMs - a.meanExpectedErrorMs);

const hasContent = (doc: CalibrationDoc) => doc.lines.length > 0 || doc.sections.length > 0;

export function App() {
  // Library / song
  const [libraryHandle, setLibraryHandle] = createSignal<FileSystemDirectoryHandle | null>(null);
  const [songs, setSongs] = createSignal<string[]>([]);
  const [song, setSong] = createSignal<OpenSong | null>(null);

  // Document + history of the selected singer
  const [calDoc, setCalDoc] = createSignal<CalibrationDoc | null>(null);
  /** The selected singer's calibration has unsaved changes. */
  const [dirty, setDirty] = createSignal(false);
  /** The lane placements have unsaved changes. */
  const [placementsDirty, setPlacementsDirty] = createSignal(false);
  /** Undo steps of the selected singer: its calibration and the lane placements. */
  const [history, setHistory] = createSignal<EditState[]>([]);
  const [future, setFuture] = createSignal<EditState[]>([]);
  // Singers (user_input/singers.json, D28), lead first; null when the song has no singers file (one calibration file, the lead's).
  const [singers, setSingers] = createSignal<Singer[] | null>(null);
  const [activeSinger, setActiveSinger] = createSignal<string | null>(null);
  /** The singers that are not selected, by id. */
  const [otherSingers, setOtherSingers] = createSignal<Record<string, SingerState>>({});
  const [selectedSyl, setSelectedSyl] = createSignal<SylRef | null>(null);

  // Analysis data
  const [vocalPeaks, setVocalPeaks] = createSignal<Float32Array | undefined>();
  const [mixPeaks, setMixPeaks] = createSignal<Float32Array | undefined>();
  const [pitchContour, setPitchContour] = createSignal<number[] | undefined>();
  const [beats, setBeats] = createSignal<number[] | undefined>();
  const [downbeats, setDownbeats] = createSignal<number[] | undefined>();
  const [bar1Index, setBar1Index] = createSignal(0);
  const [reviewLines, setReviewLines] = createSignal<LineReview[]>([]);
  // Tempo map from the dev server (null when the song is not open through it) and the last one it confirmed
  const [tempoMap, setTempoMap] = createSignal<TempoMap | null>(null);
  const [tempoBusy, setTempoBusy] = createSignal(false);
  let appliedTempo: TempoMap | null = null;

  // Playback
  const [currentTime, setCurrentTime] = createSignal(0);
  const [isPlaying, setIsPlaying] = createSignal(false);
  const [audioDuration, setAudioDuration] = createSignal(0);
  const [monitor, setMonitor] = persistedSignal<MonitorTrack>("lyricsync.editor.monitor", "vocal", {
    deserialize: (raw) => (raw === '"mix"' || raw === '"vocal"' ? JSON.parse(raw) : "vocal"),
  });
  const [hasVocal, setHasVocal] = createSignal(false);
  /** Gain, mute and solo by mixer track id: "mix", "vocal", `lane:<lane id>`. Not saved. */
  const [trackMix, setTrackMix] = createSignal<Record<string, TrackMix>>({});

  // Vocal lanes: the renders of the song, their placements (undoable, saved to user_input/placements.json) and their decoded audio by UST
  const [renders, setRenders] = createSignal<SongRenders | null>(null);
  const [placements, setPlacements] = createSignal<Placements | null>(null);
  const [laneAudio, setLaneAudio] = createSignal<Record<string, LaneAudio>>({});
  /** Razor tool: a click on a placed clip splits it (R toggles, Escape leaves). Clip drags are off meanwhile. */
  const [razor, setRazor] = createSignal(false);

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
  /** The calibration file exists (else the first save after an edit creates it). */
  let calExists = true;
  /** Increments with every song load; a decode that finishes for an older load is dropped. */
  let loadToken = 0;

  const singerOf = (id: string | null) => singers()?.find((s) => s.id === id) ?? null;
  /** The calibration file the Lyrics and Lines lanes, the Inspector, undo and save act on. */
  const activePath = () => {
    const s = singerOf(activeSinger());
    return s ? calibratedFileFor(s) : CALIBRATED_PATH;
  };
  /** Auto-time, Re-analyze and Edit Lyrics run the solver on the lead's workspace, so they are for the lead only. */
  const isLead = () => {
    const s = singerOf(activeSinger());
    return s === null || s.lead === true;
  };
  const unsaved = () => dirty() || placementsDirty() || Object.values(otherSingers()).some((o) => o.dirty);
  /** The other singers whose calibration exists (or has content), in singer order: drawn faint under the Lyrics lane. */
  const faintSingers = createMemo(() => {
    const others = otherSingers();
    return (singers() ?? []).flatMap((s) => {
      const o = others[s.id];
      return o && (o.exists || hasContent(o.doc)) ? [{ id: s.id, doc: o.doc }] : [];
    });
  });
  /** All singers with their live documents, for the karaoke stage monitor. */
  const monitorSingers = createMemo(() => {
    const list = singers();
    if (!list || list.length <= 1) return [];
    const cur = activeSinger();
    const others = otherSingers();
    const activeDoc = calDoc();
    return list.map((s) => ({
      id: s.id,
      lead: s.lead === true,
      active: s.id === cur,
      doc: s.id === cur ? activeDoc : (others[s.id]?.doc ?? null),
    }));
  });

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
    isLead() ? reviewLines().flatMap((r) => r.uncertain.map((u) => ({ time: u.time, expectedErrorMs: u.expectedErrorMs }))) : []
  );

  /** Words whose syllables in the document differ from the analysed ones. */
  const resplitWords = createMemo(() => {
    const a = analysed();
    const doc = calDoc();
    if (!a || !doc || !isLead()) return [];
    return doc.lines.flatMap((l, li) =>
      l.words.flatMap((w, wi) => (a.lines[li]?.[wi]?.join("|") === w.sylText.join("|") ? [] : [{ lineIdx: li, wordIdx: wi }]))
    );
  });
  const analysisStale = () => isLead() && analysed()?.fresh === false;
  const selectedAnalysedSplit = () => {
    const s = selectedSyl();
    return s ? (analysed()?.lines[s.lineIdx]?.[s.wordIdx] ?? null) : null;
  };

  // ── Editing ──────────────────────────────────────────────────────────────

  const pushUndo = (step: EditState) => {
    setHistory([...history().slice(-(HISTORY_LIMIT - 1)), step]);
    setFuture([]);
  };

  /** Undo step before a calibration edit (the timeline calls it before a syllable or section drag). */
  const snapshot = () => {
    const cur = calDoc();
    if (cur) pushUndo({ doc: cur });
  };

  /**
   * Undo step before a placements edit (the timeline calls it before a clip drag). The other singers' placements steps are dropped:
   * undoing one of them later would also take back this edit.
   */
  const snapshotPlacements = () => {
    pushUndo({ placements: placements() });
    const others = otherSingers();
    const isDoc = (s: EditState) => "doc" in s;
    if (Object.values(others).every((o) => o.history.every(isDoc) && o.future.every(isDoc))) return;
    setOtherSingers(
      Object.fromEntries(Object.entries(others).map(([id, o]) => [id, { ...o, history: o.history.filter(isDoc), future: o.future.filter(isDoc) }]))
    );
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

  /** Apply a mutation to a copy of the lane placements. `undoable=false` is used while a lane is dragged. */
  const editPlacements = (fn: (p: Placements) => void, message: string, undoable = true) => {
    const cur = placements();
    if (!cur) return;
    if (undoable) snapshotPlacements();
    const next = structuredClone(cur);
    fn(next);
    setPlacements(next);
    setPlacementsDirty(true);
    setStatus(message);
  };

  /** Restores the state of `step` and returns the step that takes it back. */
  const applyStep = (step: EditState, cur: CalibrationDoc): EditState => {
    if ("doc" in step) {
      setCalDoc(step.doc);
      setDirty(true);
      return { doc: cur };
    }
    const was = placements();
    setPlacements(step.placements);
    setPlacementsDirty(true);
    return { placements: was };
  };

  const undo = () => {
    const prev = history().at(-1);
    const cur = calDoc();
    if (!prev || !cur) return;
    setHistory(history().slice(0, -1));
    setFuture([applyStep(prev, cur), ...future()]);
    setStatus("Undo");
  };

  const redo = () => {
    const next = future()[0];
    const cur = calDoc();
    if (!next || !cur) return;
    setFuture(future().slice(1));
    setHistory([...history(), applyStep(next, cur)]);
    setStatus("Redo");
  };

  /** Selects the singer whose calibration is edited. Each singer keeps its own undo steps and unsaved changes; Ctrl+S saves them all. */
  const switchSinger = (id: string) => {
    const cur = activeSinger();
    const target = otherSingers()[id];
    const doc = calDoc();
    if (cur === null || id === cur || !target || !doc) return;
    const others = { ...otherSingers() };
    delete others[id];
    others[cur] = { doc, history: history(), future: future(), dirty: dirty(), exists: calExists, mtime: lastMtime };
    setOtherSingers(others);
    setActiveSinger(id);
    setCalDoc(target.doc);
    setHistory(target.history);
    setFuture(target.future);
    setDirty(target.dirty);
    calExists = target.exists;
    lastMtime = target.mtime;
    setSelectedSyl(target.doc.lines[0] ? { lineIdx: 0, wordIdx: 0, sylIdx: 0 } : null);
    setStatus(`Editing ${id}: ${activePath()}${target.exists ? "" : " (new: written by the first save with lines or sections)"}`);
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
    if (!isLead()) {
      setStatus(`Re-analyze: ${LEAD_ONLY}.`);
      return;
    }
    if (unsaved()) {
      await save();
      if (unsaved()) return;
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
    if (!isLead()) {
      setStatus(`Edit Lyrics: ${LEAD_ONLY}.`);
      return;
    }
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
      calExists = files.calExists;
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

  // ── Tempo map (dev server): where the tempo changes and what the tempos are; the beats follow ──
  const tempoUrl = (name: string) => `/api/project/${encodeURIComponent(getProjectPath(name))}/tempo`;

  const loadTempo = async (name: string) => {
    setTempoMap(null);
    appliedTempo = null;
    try {
      const res = await fetch(tempoUrl(name));
      if (!res.ok) return;
      const body: unknown = await res.json();
      const map = readTempoMap(body);
      if (map) {
        appliedTempo = map;
        setTempoMap(map);
      }
    } catch (e: unknown) {
      console.warn(`Could not read the tempo map of ${name}:`, e);
    }
  };

  /** Moves tempo change `idx` while its grip is dragged (kept between its neighbours); `applyTempo` sends the result when it is dropped. */
  const dragTempoChange = (idx: number, t: number) => {
    const map = tempoMap();
    if (!map || tempoBusy()) return;
    const lo = (map.tempoChanges[idx - 1]?.at ?? 0) + 0.5;
    const hi = (map.tempoChanges[idx + 1]?.at ?? duration()) - 0.5;
    const at = Number(Math.max(lo, Math.min(hi, t)).toFixed(3));
    setTempoMap({ ...map, tempoChanges: map.tempoChanges.map((c, i) => (i === idx ? { ...c, at } : c)) });
  };

  /**
   * Sends a tempo map (the given one, else the one on screen) to the server, which re-fits the beats; the new beats replace the grid.
   * The lyric timing is not touched: Re-analyze (the beats are part of the analysis) and Auto-time re-time it to the new beats.
   */
  const applyTempo = async (next?: TempoMap) => {
    const s = song();
    const map = next ?? tempoMap();
    if (!s || !map || tempoBusy()) return;
    if (JSON.stringify(map) === JSON.stringify(appliedTempo)) {
      setTempoMap(map);
      return;
    }
    setTempoBusy(true);
    setTempoMap(map);
    setStatus("Re-fitting the beats to the tempo map…");
    try {
      const res = await fetch(tempoUrl(s.name), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(map) });
      const body: unknown = await res.json();
      if (!res.ok || !isRecord(body)) throw new Error(isRecord(body) && typeof body.message === "string" ? body.message : `HTTP ${res.status}`);
      const applied = readTempoMap(body.tempoMap);
      const doc = body.beats;
      if (!applied || !isRecord(doc) || !Array.isArray(doc.beats) || !doc.beats.every(isNumber) || !Array.isArray(doc.downbeats) || !doc.downbeats.every(isNumber)) {
        throw new Error("The tempo endpoint answered with an unexpected body.");
      }
      const prompt = await s.store.read(PROMPT_PATH);
      const first = prompt ? readFirstDownbeat(await prompt.text()) : null;
      const grid = first === null ? { downbeats: doc.downbeats, bar1Index: 0 } : gridFromBar1(doc.beats, nearestBeatIndex(doc.beats, first));
      setBeats(doc.beats);
      setDownbeats(grid.downbeats);
      setBar1Index(grid.bar1Index);
      appliedTempo = applied;
      setTempoMap(applied);
      // The beats are part of the analysis: it is stale now, which turns Auto-time off and shows Re-analyze.
      await loadAnalysed(s.name);
      setStatus(`Tempo map applied: ${doc.beats.length} beats. Re-analyze, then Auto-time, to re-fit the lyric timing to them.`);
    } catch (e: unknown) {
      setTempoMap(appliedTempo);
      setStatus(`Tempo map not applied: ${errorMessage(e)}`);
    } finally {
      setTempoBusy(false);
    }
  };

  /** A tempo change at the playhead (put it on the first beat of the new tempo), starting at the tempo in force there; then set its BPM. */
  const addTempoChange = () => {
    const map = tempoMap();
    if (!map || tempoBusy()) return;
    const at = Number(currentTime().toFixed(3));
    if (at < 0.5 || at > duration() - 0.5 || map.tempoChanges.some((c) => Math.abs(c.at - at) < 0.5)) {
      setStatus("Put the playhead on the first beat of the new tempo, away from the start, the end and other tempo changes.");
      return;
    }
    const bpm = Number(tempoAt(at, map.nearestBpm, map.tempoChanges).toFixed(1));
    void applyTempo({ ...map, tempoChanges: [...map.tempoChanges, { at, bpm }].sort((a, b) => a.at - b.at) });
  };

  /** The fixed beats with the bar each is on (the Inspector lists them). */
  const pinRows = createMemo(() => (tempoMap()?.beatPins ?? []).map((p) => ({ ...p, bar: barBeatAt(p.at, beats(), downbeats(), bar1Index())?.bar ?? null })));

  /** Bar line `idx` was dragged to `t`: its beat is fixed there (replacing an older pin on the same beat); the beats around it are re-fitted. */
  const pinBar = (idx: number, t: number) => {
    const map = tempoMap();
    const b = beats();
    const time = downbeats()?.[idx];
    if (!map || !b || time === undefined || tempoBusy()) return;
    const beat = nearestBeatIndex(b, time);
    const beatPins = [...map.beatPins.filter((p) => p.beat !== beat), { beat, at: Number(t.toFixed(3)) }].sort((x, y) => x.beat - y.beat);
    void applyTempo({ ...map, beatPins });
  };

  /** Frees the beat of bar line `idx` again. */
  const unpinBar = (idx: number) => {
    const map = tempoMap();
    const b = beats();
    const time = downbeats()?.[idx];
    if (!map || !b || time === undefined) return;
    const beat = nearestBeatIndex(b, time);
    if (!map.beatPins.some((p) => p.beat === beat)) return;
    void applyTempo({ ...map, beatPins: map.beatPins.filter((p) => p.beat !== beat) });
  };

  const removePin = (beat: number) => {
    const map = tempoMap();
    if (map) void applyTempo({ ...map, beatPins: map.beatPins.filter((p) => p.beat !== beat) });
  };

  const clearPins = () => {
    const map = tempoMap();
    if (map && map.beatPins.length > 0) void applyTempo({ ...map, beatPins: [] });
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

  /** The monitor presets: "vocal" mutes the mix, "mix" mutes the vocal stem (and clears their solo). The lanes keep their state. */
  const applyMonitor = (track: MonitorTrack) => {
    const m = trackMix();
    setTrackMix({
      ...m,
      mix: { ...(m.mix ?? UNITY_MIX), mute: track === "vocal", solo: false },
      vocal: { ...(m.vocal ?? UNITY_MIX), mute: track === "mix", solo: false },
    });
  };

  const switchMonitor = (track: MonitorTrack) => {
    setMonitor(track);
    applyMonitor(track);
    setStatus(`Listening to ${track}`);
  };

  const setMixOf = (id: string, patch: Partial<TrackMix>) => {
    const m = trackMix();
    setTrackMix({ ...m, [id]: { ...(m[id] ?? UNITY_MIX), ...patch } });
  };

  // ── Vocal lanes ──────────────────────────────────────────────────────────

  /** The mixer tracks that can play now: the mix, the vocal stem, and the lanes with a placed clip and decoded audio. */
  const playableIds = createMemo(() => {
    const audio = laneAudio();
    const lanes = (placements()?.lanes ?? []).filter((l) => l.clips.some((c) => c.atBeat !== null) && audio[l.ust]?.buffer);
    return ["mix", ...(hasVocal() ? ["vocal"] : []), ...lanes.map((l) => `lane:${l.id}`)];
  });
  const audible = createMemo(() => audibleTracks(trackMix(), playableIds()));

  const timelineLanes = createMemo((): TimelineLane[] => {
    const p = placements();
    const r = renders();
    if (!p || !r) return [];
    const b = beats() ?? [];
    const audio = laneAudio();
    const mixes = trackMix();
    const sounding = audible();
    return p.lanes.map((lane) => {
      // parsePlacements checked that every lane's UST is in the index.
      const render = renderOf(r.index, lane.ust)!;
      const a = audio[lane.ust];
      const clips = lane.clips.map((clip) => {
        // The wav range and the length do not depend on where the clip is (beat 0 stands in for a parked clip).
        const span = clipTime(b, clip.atBeat ?? 0, clip, render, r.index.sampleRate);
        const at = clip.atBeat === null ? null : span;
        return {
          id: clip.id,
          atBeat: clip.atBeat,
          from: clip.from,
          to: clip.to,
          tick0: at?.tick0 ?? null,
          start: at?.start ?? null,
          end: at?.end ?? null,
          offset: span.offset,
          duration: span.duration,
          warning: clip.atBeat === null ? null : tempoWarning(b, clip.atBeat, clip, render),
        };
      });
      return {
        id: lane.id,
        ust: lane.ust,
        block: lane.block,
        secPerTick: secPerTick(render),
        clips,
        peaks: a?.peaks,
        mix: mixes[`lane:${lane.id}`] ?? UNITY_MIX,
        audible: sounding.has(`lane:${lane.id}`),
        warning: clips.find((c) => c.warning)?.warning ?? null,
        removable: isDuplicate(p, lane),
        problem: a?.problem ?? null,
      };
    });
  });

  // The mixer follows the lanes: one track per lane with decoded audio, one source per placed clip (parked clips are silent).
  createEffect(() => {
    const lanes = timelineLanes();
    const audio = laneAudio();
    if (!player) return;
    const want = new Set<string>();
    for (const lane of lanes) {
      const buffer = audio[lane.ust]?.buffer;
      if (!buffer) continue;
      const id = `lane:${lane.id}`;
      want.add(id);
      const clips: TrackClip[] = lane.clips.flatMap((c) => (c.start === null ? [] : [{ id: c.id, start: c.start, offset: c.offset, duration: c.duration }]));
      if (player.hasTrack(id)) player.setClips(id, clips);
      else player.setTrack(id, buffer, clips);
    }
    for (const id of player.trackIds()) if (id.startsWith("lane:") && !want.has(id)) player.removeTrack(id);
  });

  createEffect(() => {
    const mixes = trackMix();
    player?.setMix(mixes);
  });

  /** Decodes the wav of one render for the lanes of song load `token`. */
  const loadLaneAudio = async (store: SongStore, render: RenderEntry, token: number) => {
    let entry: LaneAudio;
    try {
      const wav = await readRenderWav(store, render);
      const buffer = await player!.decode(await wav.blob.arrayBuffer());
      entry = { buffer, peaks: bufferPeaks(buffer, PEAKS_PER_SEC) };
    } catch (e: unknown) {
      entry = { problem: `${render.wav}: ${errorMessage(e)}` };
      setStatus(`Vocal lane ${render.ust} has no audio: ${errorMessage(e)}`);
    }
    if (token === loadToken) setLaneAudio({ ...laneAudio(), [render.ust]: entry });
  };

  const laneLabel = (id: string) => `Lane ${id}`;

  const moveClip = (laneId: string, clipId: string, atBeat: number) =>
    editPlacements(
      (p) => {
        const clip = p.lanes.find((l) => l.id === laneId)?.clips.find((c) => c.id === clipId);
        if (clip) clip.atBeat = atBeat;
      },
      `Clip ${clipId}: tick 0 at beat ${Number(atBeat.toFixed(3))}`,
      false
    );

  const splitLaneClip = (laneId: string, clipId: string, atTick: number) => {
    const lane = placements()?.lanes.find((l) => l.id === laneId);
    if (!lane) return;
    let next: typeof lane;
    try {
      // Cut ticks are kept to 1e-3 tick (far under one sample), so the file does not get float noise like 1425.6000000000004.
      next = splitClip(lane, clipId, Math.round(atTick * 1000) / 1000);
    } catch (e: unknown) {
      setStatus(`Cannot split ${clipId}: ${errorMessage(e)}`);
      return;
    }
    const added = next.clips.find((c) => !lane.clips.some((o) => o.id === c.id));
    editPlacements(
      (p) => void p.lanes.splice(p.lanes.findIndex((l) => l.id === laneId), 1, next),
      `Clip ${clipId} split at tick ${Number(atTick.toFixed(3))}${added ? `: new clip ${added.id}` : ""}`
    );
  };

  const setLaneBlock = (id: string, block: string) => {
    if (placements()?.lanes.find((l) => l.id === id)?.block === block) return;
    editPlacements(
      (p) => {
        const lane = p.lanes.find((l) => l.id === id);
        if (lane) lane.block = block;
      },
      block ? `${laneLabel(id)} lyric block: ${block}` : `${laneLabel(id)} has no lyric block`
    );
  };

  /** Adds a lane for the same UST under lane `id`: one parked clip of the whole render, like a new lane of `defaultPlacements`. */
  const duplicateLane = (id: string) => {
    const p = placements();
    const r = renders();
    const src = p?.lanes.find((l) => l.id === id);
    if (!p || !r || !src) return;
    const copy = nextLaneId(p, src);
    const range = clipTickRange(renderOf(r.index, src.ust)!, r.index.sampleRate);
    const lane = { id: copy, ust: src.ust, block: src.block, clips: [{ id: `${copy}/1`, atBeat: null, from: range.min, to: range.max }] };
    editPlacements(
      (d) => void d.lanes.splice(d.lanes.findIndex((l) => l.id === id) + 1, 0, lane),
      `${laneLabel(copy)} added (not placed: drag its clip onto the timeline)`
    );
  };

  const removeLane = (id: string) => {
    const p = placements();
    const lane = p?.lanes.find((l) => l.id === id);
    if (!p || !lane || !isDuplicate(p, lane)) return;
    editPlacements((d) => void d.lanes.splice(d.lanes.findIndex((l) => l.id === id), 1), `${laneLabel(id)} removed`);
  };

  const toggleRazor = (on = !razor()) => {
    setRazor(on);
    setStatus(on ? "Razor on: click a placed clip to split it (beat; Shift = bar; Alt = free). R or Escape leaves." : "Razor off");
  };

  // Follow playhead: while playing, the view scrolls so the playhead stays in the middle.
  createEffect(() => {
    const t = currentTime();
    if (!follow() || !isPlaying()) return;
    setViewStart(Math.max(0, t - viewDuration() / 2));
  });

  // ── Files ────────────────────────────────────────────────────────────────

  const confirmDiscard = () => !unsaved() || window.confirm("Discard unsaved timing changes?");

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
    const token = ++loadToken;
    setStatus(`Opening ${name}…`);
    player?.pause();
    try {
      const files = await loadSongFiles(store);
      const songRenders = await loadRenders(store);
      // The other singers' calibrations (the lead's is files.doc); a missing file is an empty document.
      const singerFile = await loadSingers(store);
      const ordered = singerFile ? [...singerFile.singers].sort((a, b) => Number(b.lead === true) - Number(a.lead === true)) : null;
      const others: Record<string, SingerState> = {};
      for (const singer of ordered ?? []) {
        if (singer.lead) continue;
        const cal = await loadCalibration(store, calibratedFileFor(singer));
        others[singer.id] = { doc: cal.doc, history: [], future: [], dirty: false, exists: cal.exists, mtime: cal.mtime };
      }
      if (token !== loadToken) return;
      player?.clear();
      setSong({ name, store });
      setSingers(ordered);
      setActiveSinger(ordered?.[0]?.id ?? null);
      setOtherSingers(others);
      lastMtime = files.calMtime;
      calExists = files.calExists;
      setCalDoc(files.doc);
      setDirty(false);
      setPlacementsDirty(false);
      setHistory([]);
      setFuture([]);
      setBeats(files.beats);
      setDownbeats(files.downbeats);
      setBar1Index(files.bar1Index);
      setPitchContour(files.f0Hz ?? undefined);
      setReviewLines(sortReview(files.review));
      if (files.vocal) void loadAnalysed(name);
      else setAnalysed(null);
      void loadTempo(name);
      setHasVocal(files.vocal !== null);
      setVocalPeaks(undefined);
      setMixPeaks(undefined);
      setRenders(songRenders);
      setPlacements(songRenders?.placements ?? null);
      setLaneAudio({});
      setTrackMix({});
      // Without a vocal stem only the mix preset makes sense; the saved preference stays for songs that have one.
      applyMonitor(files.vocal ? monitor() : "mix");
      const stems = [
        { id: "mix", file: files.mix, setPeaks: setMixPeaks },
        ...(files.vocal ? [{ id: "vocal", file: files.vocal, setPeaks: setVocalPeaks }] : []),
      ];
      for (const { id, file, setPeaks } of stems) {
        file.blob
          .arrayBuffer()
          .then((b) => player!.decode(b))
          .then(
            (buffer) => {
              if (token !== loadToken) return;
              player!.setTrack(id, buffer, wholeBuffer(id, buffer), true);
              setPeaks(bufferPeaks(buffer, PEAKS_PER_SEC));
            },
            (err: unknown) => setStatus(`Cannot decode ${file.name}: ${errorMessage(err)}`)
          );
      }
      for (const render of songRenders?.index.renders ?? []) void loadLaneAudio(store, render, token);

      const first = files.doc.lines[0];
      setSelectedSyl(first ? { lineIdx: 0, wordIdx: 0, sylIdx: 0 } : null);
      setViewDuration(12);
      setViewStart(Math.max(0, (first?.start ?? 0) - 1));
      seek(first?.start ?? 0);
      if (panelTab() === "songs") setPanelTab("lines");
      const lanes = songRenders ? `, ${songRenders.placements.lanes.length} vocal lanes` : "";
      const voices = ordered ? `, ${ordered.length} singers` : "";
      setStatus(`Opened ${name}: ${files.doc.lines.length} lines${lanes}${voices}`);
    } catch (e: unknown) {
      setStatus(`Cannot open ${name}: ${errorMessage(e)}`);
    }
  };

  /**
   * Saves the calibration files and the lane placements (when the song has renders). Without a singers file the one calibration is
   * written when it exists or holds something; with one, every changed singer file is written (a missing file only once it holds lines
   * or sections) and the others are left as they are.
   */
  const save = async () => {
    const doc = calDoc();
    const s = song();
    if (!doc || !s) return;
    const r = renders();
    const p = placements();
    try {
      // Validate the placements before anything is written.
      const placementsText = r && p ? `${JSON.stringify(parsePlacements(p, r.index), null, 2)}\n` : null;
      const saved: string[] = [];
      const path = activePath();
      if ((singers() === null || dirty()) && (calExists || hasContent(doc))) {
        lastMtime = await s.store.write(path, `${JSON.stringify(doc, null, 2)}\n`);
        calExists = true;
        saved.push(path);
      }
      setDirty(false);
      for (const singer of singers() ?? []) {
        const o = otherSingers()[singer.id];
        if (!o?.dirty) continue;
        let next: SingerState = { ...o, dirty: false };
        if (o.exists || hasContent(o.doc)) {
          const file = calibratedFileFor(singer);
          next = { ...next, exists: true, mtime: await s.store.write(file, `${JSON.stringify(o.doc, null, 2)}\n`) };
          saved.push(file);
        }
        // Keep edits made to that singer while the write ran (it cannot be selected and edited that fast, but stay safe).
        if (otherSingers()[singer.id] === o) setOtherSingers({ ...otherSingers(), [singer.id]: next });
      }
      if (placementsText !== null) {
        await s.store.write(PLACEMENTS_PATH, placementsText);
        saved.push(PLACEMENTS_PATH);
      }
      setPlacementsDirty(false);
      setStatus(saved.length > 0 ? `Saved ${saved.join(", ")}` : "Nothing to save");
    } catch (e: unknown) {
      setStatus(`Save failed: ${errorMessage(e)}`);
    }
  };

  const exportCopy = async () => {
    const doc = calDoc();
    if (!doc) return;
    try {
      const fh = await window.showSaveFilePicker({
        suggestedName: activePath().split("/").at(-1)!,
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
    if (!isLead()) {
      setStatus(`Auto-time: ${LEAD_ONLY}.`);
      return;
    }
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
    if (!modes || !s || !doc || modes.song !== s.name || !isLead()) {
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
      case "t": case "T": addTempoChange(); break;
      case "s": case "S": setSnap(!snap()); setStatus(`Snap ${snap() ? "on" : "off"}`); break;
      case "f": case "F": setFollow(!follow()); setStatus(`Follow playhead ${follow() ? "on" : "off"}`); break;
      case "r": case "R": toggleRazor(); break;
      case "Escape":
        if (!razor()) return;
        toggleRazor(false);
        break;
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
    player.setMix(trackMix());
    // Reload the calibration files when another tool (CLI, agent) rewrites them.
    const poll = window.setInterval(async () => {
      const s = song();
      if (!s || solving()) return;
      const path = activePath();
      const mtime = await s.store.mtime(path);
      if (mtime !== null && mtime > lastMtime && path === activePath()) {
        lastMtime = mtime;
        if (dirty()) {
          setStatus(`${path} changed on disk, but you have unsaved edits. Save to overwrite it, or File › Reload to take the disk version.`);
        } else {
          try {
            const cal = await loadCalibration(s.store, path);
            if (cal.exists && path === activePath()) {
              setCalDoc(cal.doc);
              calExists = true;
              setStatus(`${path} changed on disk; reloaded.`);
            }
          } catch (err: unknown) {
            setStatus(`${path} changed on disk but cannot be read: ${errorMessage(err)}`);
          }
        }
      }
      for (const singer of singers() ?? []) {
        const file = calibratedFileFor(singer);
        const o = otherSingers()[singer.id];
        if (!o) continue;
        const m = await s.store.mtime(file);
        if (m === null || m <= o.mtime || otherSingers()[singer.id] !== o) continue;
        if (o.dirty) {
          setOtherSingers({ ...otherSingers(), [singer.id]: { ...o, mtime: m } });
          setStatus(`${file} changed on disk, but you have unsaved edits for ${singer.id}. Save to overwrite it, or File › Reload to take the disk version.`);
          continue;
        }
        try {
          const cal = await loadCalibration(s.store, file);
          if (otherSingers()[singer.id] !== o) continue;
          setOtherSingers({ ...otherSingers(), [singer.id]: { ...o, doc: cal.doc, exists: cal.exists, mtime: cal.mtime } });
          setStatus(`${file} changed on disk; reloaded.`);
        } catch (err: unknown) {
          setOtherSingers({ ...otherSingers(), [singer.id]: { ...o, mtime: m } });
          setStatus(`${file} changed on disk but cannot be read: ${errorMessage(err)}`);
        }
      }
    }, 2000);

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (unsaved()) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", beforeUnload);
    onCleanup(() => {
      clearInterval(poll);
      player?.dispose();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", beforeUnload);
    });

    // Test seams: headless browser runs cannot use the folder picker, so they open a song folder copied into OPFS or served by the dev
    // server. __vocalLanes reports the lanes, their clips (song times and the source each one gets from the mixer: song time `start`,
    // `offset` into the wav, `duration`, all in seconds) and the sources the mixer has scheduled while playing.
    Object.assign(window, {
      __openSong: (handle: FileSystemDirectoryHandle) => loadSong(handleStore(handle)),
      __openProject: (id: string) => loadSong(serverStore(id)),
      __vocalLanes: () => ({
        sampleRate: player?.ctx.sampleRate ?? null,
        renderSampleRate: renders()?.index.sampleRate ?? null,
        lanes: timelineLanes().map((l) => {
          const mixer = player?.clips(`lane:${l.id}`) ?? [];
          return {
            id: l.id,
            ust: l.ust,
            block: l.block,
            audible: l.audible,
            clips: l.clips.map((c) => ({
              id: c.id,
              atBeat: c.atBeat,
              from: c.from,
              to: c.to,
              tick0: c.tick0,
              start: c.start,
              end: c.end,
              mixer: mixer.find((m) => m.id === c.id) ?? null,
            })),
          };
        }),
        scheduled: player?.scheduled() ?? [],
      }),
    });

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
          { label: "Edit Lyrics...", shortcut: "Ctrl+Shift+L", action: () => void openEditLyrics(), disabled: !hasDoc || analysing() || !isLead() },
          "separator",
          { label: "Set Start to Playhead", shortcut: "[", action: () => setEdge("start", currentTime()), disabled: !hasSel },
          { label: "Set End to Playhead", shortcut: "]", action: () => setEdge("end", currentTime()), disabled: !hasSel },
          { label: "Pin / Unpin Syllable", shortcut: "C", action: togglePin, disabled: !hasSel },
          { label: "Freeze / Unfreeze Line", shortcut: "Shift+C", action: toggleLinePin, disabled: !hasSel },
          { label: "Pin Line Edges", action: () => { const s = selectedSyl(); if (s) edit((d) => pinLineEdges(d, s.lineIdx), "Line edges pinned"); }, disabled: !hasSel },
          { label: "Edit Syllable Split", shortcut: "E", action: focusSplit, disabled: !hasSel },
          { label: "Add Section Marker at Playhead", shortcut: "M", action: addSection, disabled: !hasDoc },
          { label: "Set Bar 1 at Playhead", shortcut: "B", action: () => void setBar1Here(), disabled: !beats() },
          { label: "Add Tempo Change at Playhead", shortcut: "T", action: addTempoChange, disabled: !tempoMap() || tempoBusy() },
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
          { label: "Listen: Vocal", action: () => switchMonitor("vocal"), checked: monitor() === "vocal", disabled: !hasVocal() },
          { label: "Listen: Mix", action: () => switchMonitor("mix"), checked: monitor() === "mix", disabled: !song() },
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
          { label: "Razor Tool", shortcut: "R", action: () => toggleRazor(), checked: razor() },
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
          { label: "Auto-time Unpinned Syllables", action: solve, disabled: !hasDoc || solving() || analysing() || resplitWords().length > 0 || analysisStale() || !isLead() },
          { label: "Re-analyze (apply syllable splits)", action: () => void reanalyze(), disabled: !hasDoc || analysing() || solving() || !isLead() },
          { label: "Edit Lyrics and Retime...", action: () => void openEditLyrics(), disabled: !hasDoc || analysing() || !isLead() },
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
            <span class="daw-doc-path"> — {activePath()}</span>
            <Show when={unsaved()}>
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
        hasMix={!!song()}
        hasVocal={hasVocal()}
        onMonitor={switchMonitor}
        snap={snap()}
        onSnap={() => setSnap(!snap())}
        metronome={metronome()}
        onMetronome={() => setMetronome(!metronome())}
        follow={follow()}
        onFollow={() => setFollow(!follow())}
        razor={razor()}
        onRazor={() => toggleRazor()}
        onZoom={(f) => zoom(f)}
        onZoomFit={zoomFit}
        dirty={unsaved()}
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
        notLead={!isLead()}
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
            reviewLines={isLead() ? reviewLines() : []}
            selectedLine={selectedSyl()?.lineIdx ?? null}
            playingLine={playingLine()}
            onSelectLine={gotoLine}
            onSeek={seek}
            onRenameSection={(i, n) => edit((d) => { d.sections[i]!.name = n; }, `Section renamed to ${n}`)}
            onSetSectionStart={(i, t) => edit((d) => moveSectionStart(d, i, t), `Section start → ${t.toFixed(2)} s`)}
            currentTime={currentTime()}
            onRemoveSection={(i) => edit((d) => removeSection(d, i), "Section removed")}
            onAddSection={addSection}
            onEditLyrics={isLead() ? (lineIdx) => void openEditLyrics(lineIdx ?? null) : undefined}
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
            singers={monitorSingers()}
            activeSingerId={activeSinger()}
            activeSingerLead={isLead()}
            onSinger={switchSinger}
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
            tempo={tempoMap()}
            tempoBusy={tempoBusy()}
            onTempoEdit={(map) => void applyTempo(map)}
            onAddTempo={addTempoChange}
            onSeek={seek}
            pins={pinRows()}
            onRemovePin={removePin}
            onClearPins={clearPins}
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
          onClipDragBegin={snapshotPlacements}
          onBoundaryDrag={(ref, edge, t, partner) => {
            edit((d) => moveEdge(d, ref, edge, t, partner), `${edge === "start" ? "Start" : "End"} → ${t.toFixed(3)} s${partner ? "" : " (alone)"}`, false);
          }}
          onSectionDrag={(si, t) => edit((d) => moveSectionStart(d, si, t), `Section start → ${t.toFixed(2)} s`, false)}
          tempo={tempoMap()}
          tempoBusy={tempoBusy()}
          onAddTempo={addTempoChange}
          onTempoDrag={dragTempoChange}
          onTempoDrop={() => void applyTempo()}
          onBarDrop={pinBar}
          onBarUnpin={unpinBar}
          trackMix={{ mix: trackMix().mix ?? UNITY_MIX, vocal: trackMix().vocal ?? UNITY_MIX }}
          audible={{ mix: audible().has("mix"), vocal: audible().has("vocal") }}
          hasVocal={hasVocal()}
          onTrackMix={setMixOf}
          lanes={timelineLanes()}
          blockOptions={blockNames(placements())}
          onLaneMix={(id, patch) => setMixOf(`lane:${id}`, patch)}
          razor={razor()}
          onClipMove={moveClip}
          onClipSplit={splitLaneClip}
          onLaneBlock={setLaneBlock}
          onLaneDuplicate={duplicateLane}
          onLaneRemove={removeLane}
          singers={(singers() ?? []).map((s) => ({ id: s.id, lead: s.lead === true }))}
          activeSinger={activeSinger()}
          onSinger={switchSinger}
          faint={faintSingers()}
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
