import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    passWithNoTests: false,
  },
});
