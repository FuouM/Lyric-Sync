// packages/lyricsync/web/src/components/MenuBar.tsx
// Desktop-style menu bar (File / Edit / View ...) with keyboard-shortcut hints.
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";

export type MenuEntry =
  | { label: string; shortcut?: string; action: () => void; disabled?: boolean; checked?: boolean }
  | "separator";

export interface MenuDef {
  label: string;
  items: MenuEntry[];
}

export function MenuBar(props: { menus: MenuDef[]; children?: JSX.Element }) {
  const [open, setOpen] = createSignal<number | null>(null);
  let root!: HTMLDivElement;

  const onDocDown = (e: PointerEvent) => {
    if (!root.contains(e.target as Node)) setOpen(null);
  };
  onMount(() => document.addEventListener("pointerdown", onDocDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDocDown));

  return (
    <div class="daw-menubar" ref={root}>
      <span class="daw-brand">
        <img src="/favicon.svg" class="daw-brand-icon" alt="" /> lyricsync
      </span>
      <For each={props.menus}>
        {(m, mi) => (
          <div class="daw-menu">
            <button
              class="daw-menu-btn"
              classList={{ "daw-menu-btn--open": open() === mi() }}
              onClick={() => setOpen(open() === mi() ? null : mi())}
              onPointerEnter={() => open() !== null && setOpen(mi())}
            >
              {m.label}
            </button>
            <Show when={open() === mi()}>
              <div class="daw-menu-pop">
                <For each={m.items}>
                  {(it) =>
                    it === "separator" ? (
                      <div class="daw-menu-sep" />
                    ) : (
                      <button
                        class="daw-menu-item"
                        disabled={it.disabled}
                        onClick={() => {
                          setOpen(null);
                          it.action();
                        }}
                      >
                        <span class="daw-menu-check">{it.checked ? <i class="bi bi-check2" /> : null}</span>
                        <span class="daw-menu-label">{it.label}</span>
                        <span class="daw-menu-shortcut">{it.shortcut ?? ""}</span>
                      </button>
                    )
                  }
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
      <div class="daw-menubar-right">{props.children}</div>
    </div>
  );
}
