import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DSH_RC2_WRITE_SURFACE,
  DSH_WRITE_CONTRACT_FINGERPRINT,
  assessDshWriteContract,
} from "../src/index.js";

describe("DSH 0.1.1-rc.2 write contract gate", () => {
  it("exposes only read verification and refuses mutations without official inverse operations", () => {
    const assessment = assessDshWriteContract(DSH_RC2_WRITE_SURFACE);
    expect(assessment.probe.status).toBe("degraded");
    expect(assessment.probe.contract.schemaFingerprint).toBe(DSH_WRITE_CONTRACT_FINGERPRINT);
    expect(DSH_WRITE_CONTRACT_FINGERPRINT).toBe(
      "dsh-write/0.1.1-rc.2/session-v0:2c1456d8a5a834badd6dfd603adce2cfbbae6afdd4e5413e898c78c5a0dcb8f0",
    );
    expect(assessment.probe.capabilities).toEqual(["verify"]);
    expect(assessment.disabledCapabilities).toEqual({
      "append-events": "sessionPersistence has no truncate or replace operation",
      "create-session": "sessionPersistence has no remove or forget operation",
      restore: "sessionPersistence cannot restore an absent or previous artifact",
      "update-archive": "workspaceRegistry exposes archiveSession without an official inverse operation",
      "update-title": "session titles are append-only events without an inverse operation",
    });
  });

  it("keeps the portable fixture identical to the audited contract", async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(
          import.meta.dirname,
          "../../../fixtures/dsh/0.1.1-rc.2/write-contract/contract.json",
        ),
        "utf8",
      ),
    ) as unknown;
    expect(fixture).toEqual(DSH_RC2_WRITE_SURFACE);
  });

  it("fails closed on one-field service drift with zero write capability", () => {
    const drifted = {
      ...DSH_RC2_WRITE_SURFACE,
      workspaceRegistry: [...DSH_RC2_WRITE_SURFACE.workspaceRegistry, "unarchiveSession"],
    };
    const assessment = assessDshWriteContract(drifted);
    expect(assessment.probe.status).toBe("unsupported");
    expect(assessment.probe.capabilities).toEqual([]);
    expect(assessment.probe.issues).toEqual([
      expect.objectContaining({ code: "ADAPTER_INCOMPATIBLE" }),
    ]);
  });
});
