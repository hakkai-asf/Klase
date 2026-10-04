import fs from "node:fs";
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
    outDir: "dist",
    emptyOutDir: true,
  },
  plugins: [
    {
      // Vercel 404s /admin and /auth/callback unless the project uses SPA rewrites.
      // Copying index.html to 404.html is the fallback that works even when
      // vercel.json is ignored (Root Directory = client, dashboard-only config).
      name: "spa-404-fallback",
      closeBundle() {
        const index = path.resolve(here, "dist/index.html");
        const dest = path.resolve(here, "dist/404.html");
        if (fs.existsSync(index)) fs.copyFileSync(index, dest);
      },
    },
  ],
});
