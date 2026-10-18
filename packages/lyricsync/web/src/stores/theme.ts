/**
 * Reactive theme store for DynastyReader.
 *
 * Owns the signal, localStorage persistence (`ds-theme`), DOM application
 * (`data-theme` attribute + `ds-<theme>` body/root class), and the
 * `THEME_CHANGE_EVENT` dispatch.
 *
 * Adding a new theme (e.g. windows-xp): add one entry to `THEME_REGISTRY`
 * and one file `src/styles/themes/<name>.css` with `:root[data-theme="<name>"]` vars.
 * Keep `index.html` head-script maps (HEAD_SCRIPT_SYNC) in sync — they are the
 * pre-paint mirror of this registry to prevent flashbang.
 */
import { persistedSignal, parsePersistedId } from "../lib/persisted-signal";
const log = { debug: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {} };
export const THEME_REGISTRY = {
  light: { meta: "#f5f5f5", bg: "#ececec", text: "#000000", colorScheme: "light" as const, label: "Light" },
  dark: { meta: "#181818", bg: "#1e1e1e", text: "#e0e0e0", colorScheme: "dark" as const, label: "Dark" },
  "high-contrast": { meta: "#000000", bg: "#000000", text: "#ffffff", colorScheme: "dark" as const, label: "High Contrast" },
  windows7: { meta: "#3a8bdc", bg: "#d2e6f9", text: "#162030", colorScheme: "light" as const, label: "Windows 7" },
} as const;

export type AppTheme = keyof typeof THEME_REGISTRY;

/** All valid theme ids — derived from registry. */
const VALID_THEMES: readonly AppTheme[] = Object.keys(THEME_REGISTRY) as AppTheme[];

/** Theme-color meta tag values (Android status bar / PWA chrome). */
const THEME_META: Record<AppTheme, string> = Object.fromEntries(
  Object.entries(THEME_REGISTRY).map(([k, v]) => [k, v.meta]),
) as Record<AppTheme, string>;

const STORAGE_KEY = "ds-theme";
export const THEME_CHANGE_EVENT = "ds-theme-change";

function isAppTheme(value: unknown): value is AppTheme {
  return (VALID_THEMES as readonly string[]).includes(value as string);
}

function deserializeTheme(raw: string): AppTheme {
  const parsed = parsePersistedId(raw, "light");
  return isAppTheme(parsed) ? parsed : "light";
}
let activeTransitionTimer: number | null = null;

function applyThemeToDom(t: AppTheme): void {
  // Dual guard: CSS class (earliest layer, !important beats all layers) + injected style fallback.
  // Release WebView batches differently than Vite dev — rAF alone can remove guard before paint.
  const root = document.documentElement;
  root.classList.add("ds-disable-transitions");
  // Clean up any earlier pending transition guard style tags and timer.
  if (activeTransitionTimer !== null) {
    window.clearTimeout(activeTransitionTimer);
    activeTransitionTimer = null;
  }
  document.head.querySelectorAll("style[data-ds-disable-transitions]").forEach((el) => el.remove());
  const disableTransitions = document.createElement("style");
  disableTransitions.setAttribute("data-ds-disable-transitions", "");
  disableTransitions.textContent =
    "*, *::before, *::after { -webkit-transition: none !important; -moz-transition: none !important; -o-transition: none !important; -ms-transition: none !important; transition: none !important; animation: none !important; scroll-behavior: auto !important; }";
  document.head.appendChild(disableTransitions);
  void disableTransitions.offsetHeight;
  void window.getComputedStyle(disableTransitions).opacity;
  void window.getComputedStyle(root).color;

  // Clear temporary inline styles from index.html bootstrap script so tokens.css controls it

  root.style.removeProperty("background-color");
  root.style.removeProperty("color");
  const cfg = THEME_REGISTRY[t] ?? THEME_REGISTRY.light;
  root.style.colorScheme = cfg.colorScheme;
  // Always set data-theme explicitly so CSS [data-theme="light"] selectors work.
  root.setAttribute("data-theme", t);
  // Swap ds-<theme> class: remove any prior theme class, add the current one.
  const body = document.body;
  const dsRoot = document.getElementById("ds-root");
  VALID_THEMES.forEach((name) => {
    body?.classList.remove(`ds-${name}`);
    dsRoot?.classList.remove(`ds-${name}`);
  });
  body?.classList.add(`ds-${t}`);
  dsRoot?.classList.add(`ds-${t}`);
  // Keep legacy ds-dark in sync so any residual ds-dark CSS still fires.
  const isDark = cfg.colorScheme === "dark";
  body?.classList.toggle("ds-dark", isDark);
  dsRoot?.classList.toggle("ds-dark", isDark);
  const meta = document.getElementById("ds-theme-color-meta") as HTMLMetaElement | null;
  if (meta) {
    meta.setAttribute("content", THEME_META[t] ?? "#f5f5f5");
  }

  // Force synchronous style recalc so new theme colors take effect immediately while guard is active.
  void root.offsetHeight;
  if (body) void body.offsetHeight;
  if (dsRoot) void dsRoot.offsetHeight;
  void window.getComputedStyle(root).color;

  // Restore normal CSS transitions after paint + short grace period.
  // Double rAF ensures we are past the next paint; setTimeout covers WebView batching where
  // the transition would otherwise start after the guard is removed (release vs dev timing).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      activeTransitionTimer = window.setTimeout(() => {
        activeTransitionTimer = null;
        disableTransitions.remove();
        root.classList.remove("ds-disable-transitions");
      }, 150);
    });
  });
}

const [themeSignal, setThemeSignal] = persistedSignal<AppTheme>(
  STORAGE_KEY,
  "dark",
  { deserialize: deserializeTheme }
);

export const theme = themeSignal;

export function setTheme(t: AppTheme): void {
  setThemeSignal(t);
  applyThemeToDom(t);
  window.dispatchEvent(new CustomEvent<{ theme: AppTheme }>(THEME_CHANGE_EVENT, { detail: { theme: t } }));
}

export function toggleTheme(): void {
  const idx = VALID_THEMES.indexOf(theme());
  setTheme(VALID_THEMES[(idx + 1) % VALID_THEMES.length] ?? "light");
}

/** Applies the persisted theme on startup. */
export function initAppTheme(): void {
  applyThemeToDom(theme());
}