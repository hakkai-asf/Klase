import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    fs: { allow: [path.resolve(here, "..")] },
    proxy: {
      "/api": { target: "http://localhost:2567", changeOrigin: true },
      "/health": { target: "http://localhost:2567", changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(here, "../dist"),
    emptyOutDir: true,
  },
});
