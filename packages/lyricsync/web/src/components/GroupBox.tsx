// packages/lyricsync/web/src/components/GroupBox.tsx
import { type JSX, createSignal, Show } from "solid-js";

export interface GroupBoxProps {
  id?: string;
  title: string | JSX.Element;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  actions?: JSX.Element;
  class?: string;
  children?: JSX.Element;
}

export function GroupBox(props: GroupBoxProps) {
  const [collapsed, setCollapsed] = createSignal(props.defaultCollapsed ?? false);

  const toggle = () => {
    if (props.collapsible) setCollapsed(!collapsed());
  };

  return (
    <div
      id={props.id}
      class={`group-box ${props.actions ? "group-box--has-actions" : ""} ${collapsed() ? "collapsed" : ""} ${props.class ?? ""}`}
    >
      <div
        class={`group-box-title ${props.collapsible ? "group-box-title--collapsible" : ""}`}
        onClick={toggle}
      >
        <Show when={props.collapsible}>
          <span class="group-box-collapse-btn">
            <i class={`bi bi-chevron-${collapsed() ? "right" : "down"}`} />
          </span>
        </Show>
        <span class="group-box-title-text">{props.title}</span>
      </div>
      <Show when={props.actions}>
        <div class="group-box-actions" onClick={(e) => e.stopPropagation()}>
          {props.actions}
        </div>
      </Show>
      <Show when={!collapsed()}>
        <div class="group-box-body">{props.children}</div>
      </Show>
    </div>
  );
}
