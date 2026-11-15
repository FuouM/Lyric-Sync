// packages/lyricsync/web/src/main.tsx
import { render } from "solid-js/web";
import "bootstrap-icons/font/bootstrap-icons.css";
import "soulwindow/css";
import "soulwindow/css/pro/daw.css";
import "./styles/daw.css";
import "./soulwindow";
import { App } from "./App";

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
