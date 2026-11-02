import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // near-api-js, used by the wallet selector, expects Node's `global`.
  define: { global: "globalThis" },
  build: { target: "es2020", outDir: "dist", emptyOutDir: true },
});
