// packages/lyricsync/web/src/soulwindow-options.ts
// SoulWindow options, shared by the runtime controller (soulwindow.ts) and the Vite plugin's pre-paint boot script (vite.config.ts).
import type { SoulWindowOptions } from "soulwindow/runtime";

/** `ds-` keeps the theme and accent saved before the move to SoulWindow (`ds-theme`, `ds-accent-color`). */
export const SW_OPTIONS: SoulWindowOptions = { storagePrefix: "ds-", defaultTheme: "light", density: "compact" };
