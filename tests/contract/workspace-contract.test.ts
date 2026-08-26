import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/contracts/src/index.js";

describe("workspace contract", () => {
  it("is independent and pinned", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      packageManager?: string;
      engines?: { node?: string };
    };

    expect(pkg.packageManager).toBe("pnpm@11.19.0");
    expect(pkg.engines?.node).toBe(">=22.19.0");
    expect(JSON.stringify(pkg)).not.toMatch(/dsh-codex-session-sync|EAC/);
    expect(CONTRACT_SCHEMA_VERSION).toBe(1);
  });
});
