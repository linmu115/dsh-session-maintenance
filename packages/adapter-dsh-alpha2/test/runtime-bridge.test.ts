import { describe, expect, it, vi } from "vitest";

import { Alpha2RuntimeBridge, adapter } from "../src/index.js";

const at = "2026-08-31T00:00:00.000Z";

describe("Alpha2 Runtime Bridge", () => {
  it("gives the DSH registrar only runId and Maintenance endpoint, never a projection path", async () => {
    const registrar = {
      attach: vi.fn(async () => ({ registrationId: "registration-alpha2", attachedAt: at })),
      drain: vi.fn(async (_registrationId: string, runId: never) => ({ runId, pendingOperations: 0, receipts: [] })),
      detach: vi.fn(async () => undefined),
    };
    const bridge = new Alpha2RuntimeBridge(registrar);
    const run = {
      schemaVersion: 1 as const,
      id: "run-runtime-bridge" as never,
      leaseId: "lease-runtime-bridge" as never,
      branchId: "main" as never,
      instanceId: "alpha2",
      profileId: "alpha2",
      dshVersion: "0.1.2-alpha.2",
      adapterId: adapter.manifest.id,
      state: "preparing" as const,
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    };
    const handle = await bridge.attach({
      run,
      projectionRoot: "D:/must-not-cross-the-bridge/sessions",
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    expect(registrar.attach).toHaveBeenCalledWith({
      runId: run.id,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    expect(JSON.stringify(registrar.attach.mock.calls)).not.toContain("projectionRoot");
    expect(JSON.stringify(registrar.attach.mock.calls)).not.toContain("must-not-cross");
    await expect(bridge.drain(handle)).resolves.toMatchObject({ pendingOperations: 0 });
    await bridge.detach(handle);
    await expect(bridge.drain(handle)).rejects.toThrow("not attached");
  });
});
