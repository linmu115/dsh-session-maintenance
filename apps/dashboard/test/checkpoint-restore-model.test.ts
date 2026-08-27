import { describe, expect, it, vi } from "vitest";

import type { SyncPlan } from "@linmu/dsh-session-contracts";

import { requestCheckpointRestorePreview } from "../src/catalog-pages.js";

const plan: SyncPlan = {
  schemaVersion: 1,
  id: "plan-checkpoint",
  hash: "hash-checkpoint",
  createdAt: "2026-08-27T00:00:00.000Z",
  logicalSessionId: "logical-1",
  source: { bindingId: "source", key: { platform: "codex", instanceId: "codex", sessionId: "one" }, versionId: "version-1", fingerprints: [] },
  adapterContracts: [],
  operations: [{ type: "create-target-session", targetInstanceId: "dsh-rc2" }],
  risk: "safe",
  confirmations: [],
  preconditions: [],
};

describe("checkpoint restore preview", () => {
  it("creates a branch plan once and reuses the same preview selection", async () => {
    const createCheckpointRestorePlan = vi.fn(async () => plan);
    const api = { createCheckpointRestorePlan };
    const input = { checkpointId: "checkpoint-1", targetInstanceId: "dsh-rc2", createdAt: plan.createdAt };
    const first = await requestCheckpointRestorePreview(api, input);
    const second = await requestCheckpointRestorePreview(api, { ...input, createdAt: "2026-08-27T00:01:00.000Z" }, first);
    expect(first.plan.operations).toEqual([{ type: "create-target-session", targetInstanceId: "dsh-rc2" }]);
    expect(second).toBe(first);
    expect(createCheckpointRestorePlan).toHaveBeenCalledTimes(1);
  });
});
