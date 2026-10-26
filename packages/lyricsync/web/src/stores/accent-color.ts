/**
 * Reactive accent color store for DynastyReader.
 *
 * Provides custom accent color customization that persists across sessions
 * and dynamically adapts across Light, Dark, High Contrast, and Windows 7 themes.
 * Color math is centralized in `src/lib/color.ts` so the synchronous head script
 * in index.html can stay in sync (HEAD_SCRIPT_SYNC).
 */
import { persistedSignal, parsePersistedString } from "../lib/persisted-signal";
import { theme, THEME_CHANGE_EVENT, type AppTheme } from "./theme";
import {
  resolveAccentColorHex,
  parseHex,
  toHex,
  adjustBrightness,
  rgbToHsl,
  hslToRgb,
  getContrastText,
  getDeepAccentText,
  getAccessibleLinkColor,
} from "../lib/color";
export interface AccentColorPreset {
  id: string;
  label: string;
  hex: string;
}

export const ACCENT_COLOR_PRESETS: readonly AccentColorPreset[] = [
  { id: "default", label: "Blue (Default)", hex: "#0078d4" },
  { id: "purple", label: "Purple", hex: "#8b5cf6" },
  { id: "pink", label: "Pink", hex: "#ec4899" },
  { id: "red", label: "Red", hex: "#ef4444" },
  { id: "orange", label: "Orange", hex: "#f97316" },
  { id: "amber", label: "Amber", hex: "#d97706" },
  { id: "green", label: "Green", hex: "#10b981" },
  { id: "teal", label: "Teal", hex: "#06b6d4" },
  { id: "slate", label: "Slate", hex: "#64748b" },
  { id: "green-yuri", label: "GreenYuri", hex: "#b1fe00" },
] as const;
const ACCENT_COLOR_STORAGE_KEY = "ds-accent-color";

// Re-export helpers for consumers (DisplaySettings etc.) — single source via lib/color.
export { resolveAccentColorHex, parseHex, toHex, adjustBrightness, rgbToHsl, hslToRgb, getContrastText, getDeepAccentText, getAccessibleLinkColor };

function computeAccentPalette(rawColor: string, appTheme: AppTheme = "light"): Record<string, string> {
  const hex = resolveAccentColorHex(rawColor);
  const contrastText = getContrastText(hex);
  const isDark = appTheme === "dark";
  const isHighContrast = appTheme === "high-contrast";

  const accessibleLink = getAccessibleLinkColor(hex, isDark || isHighContrast);
  let primary = hex;
  let primaryHover = adjustBrightness(hex, 10);
  let primaryActive = adjustBrightness(hex, -12);
  let primaryBorder = adjustBrightness(primary, -22);
  let highlightBg = hex;
  let highlightText = contrastText;
  let borderFocus = hex;
  let buttonHover = adjustBrightness(hex, 90);
  let buttonActive = adjustBrightness(hex, 78);
  const buttonPrimaryBg = highlightBg;
  const buttonPrimaryBorder = adjustBrightness(hex, -15);
  const buttonPrimaryHover = isDark || isHighContrast ? adjustBrightness(hex, 10) : adjustBrightness(hex, -8);
  const buttonPrimaryActive = isDark || isHighContrast ? adjustBrightness(hex, -10) : adjustBrightness(hex, -15);
  let link = accessibleLink;
  let linkHover = isDark || isHighContrast ? adjustBrightness(accessibleLink, 15) : adjustBrightness(accessibleLink, -15);
  if (isDark) {
    primary = adjustBrightness(hex, 18);
    primaryHover = adjustBrightness(hex, 28);
    primaryActive = adjustBrightness(hex, 5);
    primaryBorder = adjustBrightness(hex, -15);
    borderFocus = adjustBrightness(hex, 22);
    buttonHover = adjustBrightness(hex, -72);
    buttonActive = adjustBrightness(hex, -55);
    link = adjustBrightness(hex, 18);
    linkHover = adjustBrightness(hex, 32);
  } else if (isHighContrast) {
    primary = adjustBrightness(hex, 25);
    primaryHover = adjustBrightness(hex, 38);
    primaryActive = adjustBrightness(hex, 10);
    primaryBorder = adjustBrightness(hex, -10);
    borderFocus = adjustBrightness(hex, 30);
    buttonHover = adjustBrightness(hex, -60);
    buttonActive = adjustBrightness(hex, -45);
    link = adjustBrightness(hex, 25);
    linkHover = adjustBrightness(hex, 40);
  }
  // Windows 7 Aero Colorization Palette
  const aeroLight = adjustBrightness(hex, 25);
  const aeroMid = hex;
  const aeroDark = getAccessibleLinkColor(hex, false);
  const aeroBorder = adjustBrightness(hex, -32);
  const activeGrad1 = adjustBrightness(hex, 90);
  const activeGrad2 = adjustBrightness(hex, 77);
  const activeGrad3 = adjustBrightness(hex, 60);
  const activeGrad4 = adjustBrightness(hex, 41);
  const activeBorder = adjustBrightness(hex, -25);
  const activeText = getDeepAccentText(hex, 0.14, 0.75);
  const hoverGrad1 = adjustBrightness(hex, 92);
  const hoverGrad2 = adjustBrightness(hex, 76);
  const hoverGrad3 = adjustBrightness(hex, 66);
  const hoverBorder = adjustBrightness(hex, 8);
  const subtabGrad1 = adjustBrightness(hex, 85);
  const subtabGrad2 = adjustBrightness(hex, 72);
  const subtabGrad3 = adjustBrightness(hex, 56);
  const subtabGrad4 = adjustBrightness(hex, 78);
  const subtabBorder = adjustBrightness(hex, -25);
  const subtabText = activeText;
  // Frosted, clean, neutral Aero surfaces tinted in the accent family
  const badgeBg = adjustBrightness(hex, 68);
  const badgeBorder = adjustBrightness(hex, 38);
  const badgeText = getDeepAccentText(hex, 0.16, 0.70);
  const boxBg1 = "#ffffff";
  const boxBg2 = adjustBrightness(hex, 75);
  const boxBorder = adjustBrightness(hex, 40);
  const dividerColor = adjustBrightness(hex, 45);
  const wall1 = adjustBrightness(hex, 60);
  const wall2 = adjustBrightness(hex, 42);
  const wall3 = adjustBrightness(hex, 25);
  const topbar1 = adjustBrightness(hex, 32);
  const topbar2 = adjustBrightness(hex, 18);
  const topbar3 = hex;
  const topbar4 = adjustBrightness(hex, 24);
  const taskbar1 = adjustBrightness(hex, 35);
  const taskbar2 = adjustBrightness(hex, 20);
  const isLightTopbar = contrastText === "#000000";
  const topbarText = isLightTopbar ? getDeepAccentText(hex, 0.12, 0.75) : "#ffffff";
  const topbarShadow = isLightTopbar
    ? "0 0 8px rgba(255, 255, 255, 0.95), 0 0 3px #ffffff, 0 1px 0 #ffffff"
    : "0 1px 2px rgba(0, 0, 0, 0.65), 0 0 6px rgba(0, 0, 0, 0.35)";


  return {
    "--sys-accent": hex,
    "--sys-primary": primary,
    "--sys-primary-border": primaryBorder,
    "--sys-primary-hover": primaryHover,
    "--sys-primary-active": primaryActive,
    "--sys-highlight-bg": highlightBg,
    "--sys-highlight-text": highlightText,
    "--sys-border-focus": borderFocus,
    "--sys-button-hover": buttonHover,
    "--sys-button-active": buttonActive,
    "--sys-button-primary-bg": buttonPrimaryBg,
    "--sys-button-primary-border": buttonPrimaryBorder,
    "--sys-button-primary-hover": buttonPrimaryHover,
    "--sys-button-primary-active": buttonPrimaryActive,
    "--sys-link": link,
    "--sys-link-hover": linkHover,
    "--ds-accent-aero-light": aeroLight,
    "--ds-accent-aero-mid": aeroMid,
    "--ds-accent-aero-dark": aeroDark,
    "--ds-accent-aero-border": aeroBorder,
    "--ds-accent-active-grad-1": activeGrad1,
    "--ds-accent-active-grad-2": activeGrad2,
    "--ds-accent-active-grad-3": activeGrad3,
    "--ds-accent-active-grad-4": activeGrad4,
    "--ds-accent-active-border": activeBorder,
    "--ds-accent-active-text": activeText,
    "--ds-accent-hover-grad-1": hoverGrad1,
    "--ds-accent-hover-grad-2": hoverGrad2,
    "--ds-accent-hover-grad-3": hoverGrad3,
    "--ds-accent-hover-border": hoverBorder,
    "--ds-accent-subtab-grad-1": subtabGrad1,
    "--ds-accent-subtab-grad-2": subtabGrad2,
    "--ds-accent-subtab-grad-3": subtabGrad3,
    "--ds-accent-subtab-grad-4": subtabGrad4,
    "--ds-accent-subtab-border": subtabBorder,
    "--ds-accent-subtab-text": subtabText,
    "--ds-accent-badge-bg": badgeBg,
    "--ds-accent-badge-border": badgeBorder,
    "--ds-accent-badge-text": badgeText,
    "--ds-accent-box-bg-1": boxBg1,
    "--ds-accent-box-bg-2": boxBg2,
    "--ds-accent-box-border": boxBorder,
    "--ds-accent-divider": dividerColor,
    "--ds-accent-wall-1": wall1,
    "--ds-accent-wall-2": wall2,
    "--ds-accent-wall-3": wall3,
    "--ds-accent-topbar-1": topbar1,
    "--ds-accent-topbar-2": topbar2,
    "--ds-accent-topbar-3": topbar3,
    "--ds-accent-topbar-4": topbar4,
    "--ds-accent-taskbar-1": taskbar1,
    "--ds-accent-taskbar-2": taskbar2,
    "--ds-accent-topbar-text": topbarText,
    "--ds-accent-topbar-shadow": topbarShadow,
  };
}

/** All CSS custom property names managed by the accent color system — derived from the palette to guarantee sync. */
const MANAGED_VARS = Object.keys(computeAccentPalette("#0078d4")) as readonly string[];

function applyAccentColorToDom(color: string | null, activeTheme?: AppTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root) return;

  const curTheme = activeTheme ?? theme();

  if (!color || color === "default") {
    for (const v of MANAGED_VARS) {
      root.style.removeProperty(v);
    }
    return;
  }

  const resolvedHex = resolveAccentColorHex(color);
  const palette = computeAccentPalette(resolvedHex, curTheme);
  for (const [key, val] of Object.entries(palette)) {
    root.style.setProperty(key, val);
  }
}

function deserializeAccentColor(raw: string): string {
  return parsePersistedString(raw, "default").trim().toLowerCase() || "default";
}

const [accentColorSignal, setAccentColorSignal] = persistedSignal<string>(
  ACCENT_COLOR_STORAGE_KEY,
  "default",
  { deserialize: deserializeAccentColor }
);

export const accentColor = accentColorSignal;

export function setAccentColor(color: string): void {
  const norm = color.trim().toLowerCase();
  setAccentColorSignal(norm);
  applyAccentColorToDom(norm, theme());
}

export function initAccentColor(): void {
  applyAccentColorToDom(accentColor(), theme());

  // Listen to theme changes to re-adapt the active accent color
  if (typeof window !== "undefined") {
    window.addEventListener(THEME_CHANGE_EVENT, ((ev: Event) => {
      const custom = ev as CustomEvent<{ theme: AppTheme }>;
      const t = custom.detail?.theme ?? theme();
      applyAccentColorToDom(accentColor(), t);
    }) as EventListener);
  }
}
