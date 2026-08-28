import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("package compatibility policy", () => {
  it("does not gate installation on host versions", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
      peerDependencies: Record<string, string>;
      dshWorkshop: { compatibility?: unknown };
    };

    expect(packageJson.version).toBe("0.1.2");
    expect(new Set(Object.values(packageJson.peerDependencies))).toEqual(new Set(["*"]));
    expect(packageJson.dshWorkshop.compatibility).toBeUndefined();
  });
});
