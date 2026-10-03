import { defineConfig } from "vite";

// Local-only dev/preview servers. The game itself has no runtime network needs.
export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 5173 },
  preview: { host: "127.0.0.1", port: 4173 },
  build: { target: "es2022" },
});
