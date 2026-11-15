// packages/lyricsync/web/src/soulwindow.ts
// The SoulWindow theme / accent / density controller, created once at startup.
import { createSoulWindow } from "soulwindow/runtime";
import { useSoulWindow } from "soulwindow/solid";
import { createRoot } from "solid-js";
import { SW_OPTIONS } from "./soulwindow-options";

export const sw = createSoulWindow(SW_OPTIONS);

/** App-wide signals that follow `sw` (theme, accent, density, isDark). */
export const swState = createRoot(() => useSoulWindow(sw));
