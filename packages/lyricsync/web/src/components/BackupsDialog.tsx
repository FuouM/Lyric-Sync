// packages/lyricsync/web/src/components/BackupsDialog.tsx
// File > Backups…: the backup copies of the open calibration file (src/backup-policy.ts), newest first. Picking one shows what it
// holds. "Use this backup" puts it in the editor as an undoable, unsaved edit, so Save writes it (and backs up the file it replaces).
// A backup whose lyrics differ from the open ones (taken before a lyrics edit) brings its lyrics back too: the analysis is redone.
import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { isSylPinned, type CalibrationDoc } from "../../../src/calibration-doc";
import { errorMessage, listBackups, loadCalibration, type FileBackup, type SongStore } from "../lib/song-files";
import { Modal } from "soulwindow/solid";

export interface BackupsDialogProps {
  open: boolean;
  store: SongStore | null;
  /** The calibration file the editor has open (song-folder path). */
  path: string;
  current: CalibrationDoc | null;
  /** `lyricsDiffer`: the backup's lines are not the open ones, so its lyrics must be restored and the analysis redone. */
  onUse: (doc: CalibrationDoc, backup: FileBackup, lyricsDiffer: boolean) => void;
  onClose: () => void;
}

const REASONS: Record<string, string> = {
  save: "before a save",
  "edit-lyrics": "before Edit Lyrics",
  reanalyze: "before Re-analyze",
  "tempo-map": "before a tempo map change",
  retime: "before retime",
};

const pinnedCount = (doc: CalibrationDoc) => doc.lines.reduce((n, l) => n + l.words.reduce((m, w) => m + w.syl.filter((_, si) => isSylPinned(l, w, si)).length, 0), 0);

export function BackupsDialog(props: BackupsDialogProps) {
  const [selected, setSelected] = createSignal<FileBackup | null>(null);
  const [backups] = createResource(
    () => (props.open && props.store ? { store: props.store, path: props.path } : null),
    ({ store, path }) => listBackups(store, path)
  );
  const [preview] = createResource(
    () => {
      const b = selected();
      return b && props.store ? { store: props.store, b } : null;
    },
    async ({ store, b }) => (await loadCalibration(store, b.path)).doc
  );
  createEffect(() => {
    if (!props.open) setSelected(null);
  });

  /** The first line where the backup's lyrics differ from the open ones, or null when they are the same. */
  const difference = () => {
    const doc = preview();
    const cur = props.current;
    if (!doc || !cur) return null;
    const n = Math.max(doc.lines.length, cur.lines.length);
    const i = Array.from({ length: n }, (_, k) => k).find((k) => doc.lines[k]?.text !== cur.lines[k]?.text);
    if (i === undefined) return null;
    const quote = (t: string | undefined) => (t === undefined ? "no line" : `"${t}"`);
    return `line ${i + 1}: ${quote(doc.lines[i]?.text)}, now ${quote(cur.lines[i]?.text)}`;
  };

  return (
    <Modal
      open={props.open}
      title={`Backups of ${props.path}`}
      width={620}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="win-button" onClick={props.onClose}>
            Close
          </button>
          <button
            type="button"
            class="win-button primary"
            disabled={!preview()}
            onClick={() => {
              const b = selected();
              const doc = preview();
              if (b && doc) props.onUse(doc, b, difference() !== null);
            }}
          >
            {difference() ? "Use this backup and its lyrics…" : "Use this backup"}
          </button>
        </>
      }
    >
      <Show when={!backups.error} fallback={<p class="daw-wizard-note daw-warn">Cannot list the backups: {errorMessage(backups.error)}</p>}>
        <Show when={backups()} fallback={<p class="daw-wizard-note">Reading the backups…</p>}>
          {(list) => (
            <Show when={list().length > 0} fallback={<p class="daw-wizard-note">No backups of this file yet. One is taken each time something overwrites it.</p>}>
              <div class="daw-backup-list">
                <For each={list()}>
                  {(b) => (
                    <div class="daw-row" classList={{ "daw-row--selected": selected() === b }} onClick={() => setSelected(b)}>
                      <i class="bi bi-clock-history" />
                      <span class="daw-row-text">
                        {b.time.toLocaleString()} <span class="daw-muted">· {REASONS[b.reason] ?? b.reason}</span>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </Show>
      <Show when={selected()}>
        <Show when={!preview.error} fallback={<p class="daw-wizard-note daw-warn">Cannot read this backup: {errorMessage(preview.error)}</p>}>
          <Show when={preview()} fallback={<p class="daw-wizard-note">Reading…</p>}>
            {(doc) => (
              <p class="daw-wizard-note">
                {doc().lines.length} lines, {doc().sections.length} sections, {pinnedCount(doc())} pinned syllables
                <Show when={props.current}>{(cur) => <> (open now: {pinnedCount(cur())} pinned)</>}</Show>.
                <Show when={!difference()}> Using it is one undoable edit; Save writes it.</Show>
              </p>
            )}
          </Show>
          <Show when={difference()}>
            {(d) => (
              <p class="daw-wizard-note daw-warn">
                Its lyrics differ from the open ones ({d()}). Using it brings its lyrics back too: Edit Lyrics opens with them, and Apply
                redoes the analysis (about 2 minutes), keeping this backup's pins.
              </p>
            )}
          </Show>
        </Show>
      </Show>
    </Modal>
  );
}
