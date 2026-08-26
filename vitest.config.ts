import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
  test: {
    environment: "node",
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    passWithNoTests: false,
  },
});
