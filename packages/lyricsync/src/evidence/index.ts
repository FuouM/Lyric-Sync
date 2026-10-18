// packages/lyricsync/src/evidence/index.ts
// Primary audio + evidence API for lyricsync.

import type {
  ConsensusLine,
  Language,
  LyricsDefinition,
  SlicedAlignment,
  SongEvidence,
} from '../types.ts';
import { loadAudioFile } from '../audio/audio.ts';
import { extractBoundaryEvidence } from './boundary.ts';
import { HubertAligner } from './hubert.ts';
import { createNucleusResolver } from './nucleus.ts';
import { runHarmoF0, runRmvpe, runSwiftF0 } from './pitch.ts';
import { loadEvidence, saveEvidence } from './store.ts';

export interface ExtractOptions {
  vocalPath: string;
  definition: LyricsDefinition;
  beats: number[];
  onProgress?: (message: string) => void;
}

/**
 * Extracts all audio-derived evidence needed by the lyricsync DP engine.
 */
export async function extractEvidence(opts: ExtractOptions): Promise<SongEvidence> {
  opts.onProgress?.('Loading vocal audio...');
  const audio = await loadAudioFile(opts.vocalPath, 44100);
  const durationSec = audio.length / 44100;

  opts.onProgress?.('Extracting RMVPE pitch contour...');
  const { f0Hz, rmvpeNotes } = await runRmvpe(audio, 44100);

  opts.onProgress?.('Extracting Swift-F0 transient note onsets...');
  const swiftNotes = await runSwiftF0(audio, 44100);

  opts.onProgress?.('Extracting HarmoF0 sustained notes...');
  const harmoNotes = await runHarmoF0(audio, 44100);

  opts.onProgress?.('Extracting base HuBERT posteriors, edges and breaths...');
  const baseAligner = new HubertAligner('base');
  const posteriors = await baseAligner.extractPosteriorgram(audio);
  const basePriors = await baseAligner.extractAcousticPriors(audio);

  opts.onProgress?.('Aligning full song (base model)...');
  const fullBase = await baseAligner.alignFullSong(audio, opts.definition);

  opts.onProgress?.('Extracting combined HuBERT edges...');
  const combinedAligner = new HubertAligner('combined');
  const combinedPriors = await combinedAligner.extractAcousticPriors(audio);

  let fullCombined: ConsensusLine[] | null = null;
  if (opts.definition.language === 'en') {
    opts.onProgress?.('Aligning full song (combined model)...');
    fullCombined = await combinedAligner.alignFullSong(audio, opts.definition);
  }

  opts.onProgress?.('Running the boundary model...');
  const boundary = await extractBoundaryEvidence(audio, 44100, opts.definition);
  const { resolver: nucleusFor, silenceId } = createNucleusResolver(opts.definition.language);
  posteriors.silenceId = silenceId;

  return {
    language: opts.definition.language,
    durationSec,
    audio,
    sampleRate: 44100,
    swiftNotes,
    harmoNotes,
    rmvpeNotes,
    f0Hz,
    edgeSets: [basePriors.edges, combinedPriors.edges],
    breaths: basePriors.breaths,
    beats: opts.beats,
    posteriors,
    nucleusFor,
    fullBase,
    fullCombined,
    boundary,
  };
}

/**
 * Forced alignment of each anchored line cut to its bounds (+/-0.1 s audio padding).
 * English: base AND combined models. Japanese: base only (combined is null).
 */
export async function alignAnchoredLines(
  evidence: SongEvidence,
  definition: LyricsDefinition,
  bounds: Record<number, { start: number; end: number }>,
  onProgress?: (m: string) => void
): Promise<Record<number, SlicedAlignment>> {
  const baseAligner = new HubertAligner('base');
  let combinedAligner: HubertAligner | null = null;
  if (definition.language === 'en') {
    combinedAligner = new HubertAligner('combined');
  }

  const results: Record<number, SlicedAlignment> = {};
  const total = definition.lines.length;

  for (let idx = 0; idx < total; idx++) {
    const line = definition.lines[idx]!;
    const b = bounds[line.index];
    if (!b) continue;

    onProgress?.(`Aligning anchored line ${idx + 1}/${total} (${line.text})...`);

    const s0 = Math.max(0, Math.floor((b.start - 0.1) * evidence.sampleRate));
    const s1 = Math.min(evidence.audio.length, Math.ceil((b.end + 0.1) * evidence.sampleRate));
    const slice = evidence.audio.subarray(s0, s1);
    const lineOffset = s0 / evidence.sampleRate;

    const baseWords = await baseAligner.alignLineSlice(slice, line.words, lineOffset, definition.language);
    const baseLine: ConsensusLine = {
      i: line.index,
      text: line.text,
      start: b.start,
      end: b.end,
      words: baseWords,
    };

    let combinedLine: ConsensusLine | null = null;
    if (combinedAligner) {
      const combinedWords = await combinedAligner.alignLineSlice(slice, line.words, lineOffset, definition.language);
      combinedLine = {
        i: line.index,
        text: line.text,
        start: b.start,
        end: b.end,
        words: combinedWords,
      };
    }

    results[line.index] = {
      base: baseLine,
      combined: combinedLine,
    };
  }

  return results;
}

export { saveEvidence, loadEvidence };
export * from './events.ts';
export * from './pitch.ts';
export * from './nucleus.ts';
export * from './hubert.ts';
export { boundaryContexts, computeQueries, extractBoundaryEvidence, readBoundaryConfig, type ContextSyllable } from './boundary.ts';
