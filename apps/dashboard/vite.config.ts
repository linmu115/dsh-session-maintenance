import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
