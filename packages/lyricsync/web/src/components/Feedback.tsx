// packages/lyricsync/web/src/components/Feedback.tsx
import { Show, type JSX } from "solid-js";
import { Button } from "./Button";

export function Loading(props: { message?: string }) {
  return (
    <div class="ds-flex-col ds-items-center ds-justify-center ds-py-16 ds-gap-8" style={{ color: "var(--sys-text-muted)" }}>
      <span class="ds-btn-spinner" style={{ width: "24px", height: "24px" }} />
      <span class="ds-text-sm">{props.message ?? "Loading..."}</span>
    </div>
  );
}

export function EmptyState(props: { icon?: string; message: string; hint?: string; action?: JSX.Element }) {
  return (
    <div class="ds-flex-col ds-items-center ds-justify-center ds-py-16 ds-gap-4 ds-text-center">
      {props.icon && <i class={`bi bi-${props.icon} ds-text-xl`} style={{ color: "var(--sys-text-muted)" }} />}
      <div class="ds-text-md" style={{ color: "var(--sys-window-text)", "font-weight": 500 }}>{props.message}</div>
      {props.hint && <div class="ds-text-xs" style={{ color: "var(--sys-text-muted)" }}>{props.hint}</div>}
      {props.action && <div class="ds-mt-4">{props.action}</div>}
    </div>
  );
}

export function ErrorNotice(props: { message: string; onRetry?: () => void }) {
  return (
    <div class="ds-status-row ds-status-row--danger ds-flex-row ds-items-center ds-justify-between ds-p-8 ds-gap-8">
      <div class="ds-flex-row ds-items-center ds-gap-8">
        <i class="bi bi-exclamation-triangle" />
        <span class="ds-text-sm">{props.message}</span>
      </div>
      <Show when={props.onRetry}>
        <Button size="xs" variant="danger" onClick={props.onRetry}>
          Retry
        </Button>
      </Show>
    </div>
  );
}
