/**
 * Author: John Grimes
 */

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Tailwind runs here and nowhere else: the console's stylesheet is compiled at build time,
  // so the server keeps its single-file bundle and gains no styling toolchain of its own.
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Everything the console reads is under `/api`, so the dev server proxies that
    // prefix and renders every other path itself.
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
