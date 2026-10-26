// packages/lyricsync/web/src/main.tsx
import { render } from "solid-js/web";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/themes/dark.css";
import "./styles/themes/high-contrast.css";
import "./styles/reset.css";
import "./styles/curator-ui-base.css";
import "./styles/utilities.css";
import "./styles/index.css";
import "./styles/daw.css";
import { initAccentColor } from "./stores/accent-color";
import { initAppTheme } from "./stores/theme";

initAppTheme();
initAccentColor();

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
