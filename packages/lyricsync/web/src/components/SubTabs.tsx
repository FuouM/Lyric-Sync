// packages/lyricsync/web/src/components/SubTabs.tsx
import { type JSX, For } from "solid-js";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  icon?: string;
}

export interface SubTabsProps {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  rightControls?: JSX.Element;
}

export function SubTabs(props: SubTabsProps) {
  return (
    <div class="ds-subtabs">
      <div class="ds-subtabs-left">
        <For each={props.tabs}>
          {(t) => (
            <button
              type="button"
              class={`win-button ds-subtab ${props.activeId === t.id ? "active" : ""}`}
              onClick={() => props.onChange(t.id)}
            >
              <span class="ds-btn-text">
                {t.icon && <i class={`bi bi-${t.icon} ds-mr-4`} />}
                <span class="ds-subtab-label">{t.label}</span>
                {t.count !== undefined && <span class="ds-subtab-count">{t.count}</span>}
              </span>
            </button>
          )}
        </For>
      </div>
      {props.rightControls && <div class="ds-subtabs-right">{props.rightControls}</div>}
    </div>
  );
}
