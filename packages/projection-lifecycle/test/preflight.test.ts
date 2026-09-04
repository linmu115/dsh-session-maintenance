import { describe, expect, it } from "vitest";

import { projectionRuntimePreflight } from "../src/index.js";

describe("projection runtime broker preflight", () => {
  it("blocks every metadata-only client at exact P1-P3 and append seams", () => {
    const result = projectionRuntimePreflight({
      runtimeBrokerPrepareCloseApi: false,
      runtimeClientRunIdHandoff: false,
      temporaryPersistenceRoot: false,
      runtimeAttachAcknowledgement: false,
      durableAppendForwarding: false,
      projectRootCwdMapping: false,
      maintenanceWorkspaceAuthority: false,
    });

    expect(result.canOpenRun).toBe(false);
    expect(result.checkpoints.map(({ checkpoint, ready }) => [checkpoint, ready])).toEqual([
      ["P1", false],
      ["P2", false],
      ["P3", false],
      ["APPEND", false],
      ["CLOSE", false],
      ["GROUPING", false],
    ]);
    expect(result.checkpoints.find((item) => item.checkpoint === "P3")).toMatchObject({
      stage: "runtime.persistence.attach",
      blockers: ["TEMP_PERSISTENCE_ROOT_MISSING", "RUNTIME_ATTACH_ACK_MISSING"],
    });
    expect(result.checkpoints.find((item) => item.checkpoint === "GROUPING")).toMatchObject({
      blockers: ["PROJECT_ROOT_CWD_MAPPING_MISSING", "MAINTENANCE_WORKSPACE_AUTHORITY_MISSING"],
    });
  });

  it("opens for Launcher, plugin or CLI clients only when every broker capability is evidenced", () => {
    const result = projectionRuntimePreflight({
      runtimeBrokerPrepareCloseApi: true,
      runtimeClientRunIdHandoff: true,
      temporaryPersistenceRoot: true,
      runtimeAttachAcknowledgement: true,
      durableAppendForwarding: true,
      projectRootCwdMapping: true,
      maintenanceWorkspaceAuthority: true,
    });

    expect(result).toMatchObject({ canOpenRun: true, blockers: [] });
    expect(result.checkpoints.every((item) => item.ready && item.diagnosticDetailRef.endsWith(":ready"))).toBe(true);
  });
});
