// packages/lyricsync/web/src/components/SettingsRow.tsx
import { type JSX, Show } from "solid-js";

export function DsSwitch(props: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      class={`ds-switch ${props.checked ? "checked" : ""}`}
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="ds-switch-track">
        <span class="ds-switch-thumb" />
      </span>
    </button>
  );
}

export interface SettingsRowProps {
  label: string | JSX.Element;
  description?: string | JSX.Element;
  hasDivider?: boolean;
  children?: JSX.Element;
}

export function SettingsRow(props: SettingsRowProps) {
  return (
    <div class={`ds-settings-row ${props.hasDivider ? "has-divider" : ""}`}>
      <div class="ds-settings-row-label">
        <div class="ds-label">{props.label}</div>
        <Show when={props.description}>
          <div class="ds-muted ds-settings-row-desc">{props.description}</div>
        </Show>
      </div>
      <div class="ds-settings-row-control">{props.children}</div>
    </div>
  );
}
