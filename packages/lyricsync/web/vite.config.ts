import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { soulwindow } from "soulwindow/vite";
import { SW_OPTIONS } from "./src/soulwindow-options";

export default defineConfig({
  plugins: [solid(), soulwindow(SW_OPTIONS)],
  server: {
    port: 3000,
  },
  build: {
    target: "esnext",
  },
});
