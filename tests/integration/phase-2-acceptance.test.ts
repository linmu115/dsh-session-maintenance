import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readTarGz, sha256 } from "../../scripts/phase2-pack-lib.mjs";

function runPinnedPnpm(argv: string[]) {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm.cmd", ...argv]
    : argv;
  return spawnSync(command, commandArgs, {
    cwd: process.cwd(), env: process.env, encoding: "utf8", shell: false, windowsHide: true,
  });
}

describe("phase 2 isolated packaged acceptance", () => {
  it("loads and unloads the self-contained plugin against the locked rc.2 fixture", async () => {
    const out = await mkdtemp(join(tmpdir(), "dsh-phase2-acceptance-artifacts-"));
    try {
      const packaged = runPinnedPnpm(["run", "package:phase2", "--", "--out", out]);
      expect(packaged.status, packaged.stderr || packaged.error?.message).toBe(0);
      const result = spawnSync(process.execPath, ["scripts/accept-phase2-isolated.mjs", "--out", out], {
        cwd: process.cwd(), env: process.env, encoding: "utf8", shell: false, windowsHide: true,
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      const report = JSON.parse(await readFile(join(out, "isolated-acceptance.json"), "utf8"));
      expect(report).toMatchObject({
        packageImport: "passed",
        clientModuleRegistration: "passed",
        hostProxy: "passed",
        materializedCoreProbe: "passed",
        unloadCleanup: "passed",
        engineStatePreservedAfterProfileRemoval: "passed",
      });

      const manifest = JSON.parse(await readFile(join(out, "phase2-manifest.json"), "utf8"));
      for (const artifact of manifest.artifacts) {
        const bytes = await readFile(join(out, artifact.name));
        expect({ hash: sha256(bytes), entries: readTarGz(bytes).size }).toEqual({
          hash: artifact.sha256,
          entries: expect.any(Number),
        });
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);
});
