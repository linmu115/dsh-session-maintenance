import { defineConfig } from "vite";

export default defineConfig({
  base: "/dashboard/",
  resolve: {
    conditions: ["development"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
