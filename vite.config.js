import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // GitHub Pages project sites are hosted under /<repository-name>/.
  base: process.env.GITHUB_ACTIONS === "true" ? "/Zod/" : "/",
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./inverse_metaverse.html", import.meta.url))
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 4173
  },
  preview: {
    host: "127.0.0.1",
    port: 4173
  }
});
