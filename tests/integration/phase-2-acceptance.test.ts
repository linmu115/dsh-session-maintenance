import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readTarGz, sha256 } from "../../scripts/phase2-pack-lib.mjs";

describe("phase 2 isolated packaged acceptance", () => {
  it("loads and unloads the self-contained plugin against the locked rc.2 fixture", async () => {
    const result = spawnSync(process.execPath, ["scripts/accept-phase2-isolated.mjs"], {
      cwd: process.cwd(), env: process.env, encoding: "utf8", shell: false, windowsHide: true,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    const report = JSON.parse(await readFile(resolve(".artifacts/phase2/isolated-acceptance.json"), "utf8"));
    expect(report).toMatchObject({
      packageImport: "passed",
      clientModuleRegistration: "passed",
      hostProxy: "passed",
      materializedCoreProbe: "passed",
      unloadCleanup: "passed",
      engineStatePreservedAfterProfileRemoval: "passed",
    });

    const manifest = JSON.parse(await readFile(resolve(".artifacts/phase2/phase2-manifest.json"), "utf8"));
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(resolve(".artifacts/phase2", artifact.name));
      expect({ hash: sha256(bytes), entries: readTarGz(bytes).size }).toEqual({
        hash: artifact.sha256,
        entries: expect.any(Number),
      });
    }
  });
});
