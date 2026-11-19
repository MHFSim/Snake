import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// "single": alles in eine HTML-Datei (zum Teilen als einzelne Seite)
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: mode === "single" ? [viteSingleFile()] : [],
  build: {
    target: "es2022",
    outDir: mode === "single" ? "dist-single" : "dist",
    chunkSizeWarningLimit: 8000,
  },
  test: { environment: "node" },
}));
