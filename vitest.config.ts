import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
  test: {
    environment: "node",
    include: ["apps/*/test/**/*.test.{ts,tsx}", "packages/*/test/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    passWithNoTests: false,
  },
});
