import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("package compatibility policy", () => {
  it("does not gate installation on host versions", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
      peerDependencies: Record<string, string>;
      dsh: { client: { inject: string[] } };
      dshWorkshop: { compatibility?: unknown };
    };

    expect(packageJson.version).toBe("0.1.4");
    expect(new Set(Object.values(packageJson.peerDependencies))).toEqual(new Set(["*"]));
    expect(packageJson.dsh.client.inject).toContain("@deepseek-ai/dsh-client-ui-slots");
    expect(packageJson.dsh.client.inject).toContain("@deepseek-ai/dsh-client-ui-settings");
    expect(packageJson.dshWorkshop.compatibility).toBeUndefined();
  });
});
