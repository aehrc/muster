import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8090",
      // The published key set, so that the console's links to it work in
      // development too. The documentation is deliberately not proxied: the
      // console renders it from the same data, at the same paths.
      "/.well-known": "http://localhost:8090",
    },
  },
});
