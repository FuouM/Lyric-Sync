// src/index.ts
// Public API. Typical use:
//   const { session } = Session.init({ dir, vocalPath, lyricsPath, language: 'en', beats: { kind: 'mix', path: mixPath } });
//   await session.prepare();
//   const { lyrics, review } = await session.solve();          // free solve
//   const anchors = session.loadAnchors();
//   setLineBounds(anchors, session.definition, 3, 12.3, 15.1);  // something you know
//   session.saveAnchors(anchors);
//   await session.solve();                                      // re-solve around it

export * from './types.ts';
export { isNumber, isRecord, isStringArray } from './guards.ts';


export { Session } from './workspace/session.ts';
export type { BeatsDocument, InitOptions, Progress, SolveResult, SyllableChange, WorkspaceStatus } from './workspace/session.ts';
export { computeAudioKey, computeEvidenceKey, workspacePaths } from './workspace/manifest.ts';
export type { BeatSource, WorkspaceManifest, WorkspacePaths } from './workspace/manifest.ts';
export {
  clearAnchors,
  emptyAnchors,
  importCalibrated,
  isLineAnchored,
  loadAnchors,
  pinsOf,
  saveAnchors,
  setBoundary,
  setLineBounds,
  summarizeAnchors,
  syllableCount,
  validateAnchors,
} from './workspace/anchors.ts';
export type { AnchorSummary, ImportLevel, ImportOptions, ImportSummary } from './workspace/anchors.ts';

export {
  approximateEnglishPhonemes,
  dictionaryG2P,
  EN_VOWEL_PHONES,
  formatPhonemeSuggestion,
  lintLyricsText,
  lyricsSectionOutline,
  parseLyricsJson,
  parseLyricsText,
  parseStoredDefinition,
  pronounceAs,
  pronunciationKey,
  readLyricsFile,
  resolveSyllables,
  syllabifyEnglish,
  syllabifyJapanese,
} from './lyrics/index.ts';
export type { AutoSplitNote, LyricsIssue, ParsedLyrics, Pronunciations, SectionOutline, SylJoins } from './lyrics/index.ts';

export { alignAnchoredLines, computeQueries, extractEvidence, loadEvidence, readBoundaryConfig, saveEvidence } from './evidence/index.ts';
export type { ExtractOptions } from './evidence/index.ts';
export { loadWeights } from './engine/weights.ts';
export { solve } from './engine/solve.ts';
export { solveAnalytic, ANALYTIC_DESIGN } from './engine/analytic.ts';
export { loadTrainingSongs, readTrainingManifest } from './train/songs.ts';
export type { TrainingManifestSong } from './train/songs.ts';
export type { TrainingSong } from './train/train.ts';

// The song folder (also importable alone, without the models: "lyricsync/song-folder").
export * from './song-folder.ts';
export { isSylPinned, parseCalibrationDoc } from './calibration-doc.ts';
