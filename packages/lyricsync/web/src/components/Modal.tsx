// packages/lyricsync/web/src/components/Modal.tsx
import { type JSX, Show, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { Button } from "./Button";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  width?: string;
  children?: JSX.Element;
  footer?: JSX.Element;
}

export function Modal(props: ModalProps) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && props.open) {
      props.onClose();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div class="ds-modal-backdrop" onClick={props.onClose}>
          <div
            class="ds-modal-window"
            role="dialog"
            aria-modal="true"
            style={{ width: props.width ?? "500px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div class="ds-modal-header">
              <span class="ds-modal-title">{props.title}</span>
              <button
                type="button"
                class="win-button ds-modal-close"
                title="Close (Esc)"
                onClick={props.onClose}
              >
                <i class="bi bi-x-lg" />
              </button>
            </div>
            <div class="ds-modal-body">{props.children}</div>
            <Show when={props.footer}>
              <div class="ds-modal-footer">
                <div class="ds-modal-footer-actions">{props.footer}</div>
              </div>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
