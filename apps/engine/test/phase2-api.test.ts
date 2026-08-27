import { afterEach, describe, expect, it, vi } from "vitest";

import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { createSyncPlan } from "../../../packages/session-domain/src/index.js";
import { appendOnlyPlanFixture } from "../../../packages/session-domain/test/plan-fixtures.js";
import type {
  Checkpoint,
  IssuedConfirmation,
  TransactionDetail,
} from "../../../packages/contracts/src/index.js";
import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const at = "2026-08-27T00:00:00.000Z";

describe("phase 2 operation API", () => {
  it("keeps client and server DTOs aligned and resumes persisted write-job events", async () => {
    const fixture = await createEngineFixture("phase2-operations");
    cleanups.push(fixture.cleanupAll);
    await fixture.engine.scan({ instanceIds: ["codex-fixture"] });

    const sessions = await fixture.engine.listSessions({ limit: 10 });
    const logicalSessionId = sessions.items[0]!.logicalSessionId;
    const graph = await fixture.engine.getGraph(logicalSessionId);
    const versionId = graph.nodes[0]!.id;
    const checkpoint: Checkpoint = {
      id: "checkpoint-fixture",
      name: "Known good fixture",
      description: "Synthetic only",
      refs: { canonical: versionId },
      backupTransactionIds: [],
      createdBy: "test",
      createdAt: at,
    };
    const transaction: TransactionDetail = {
      transaction: {
        id: "transaction-fixture",
        planId: "plan-fixture",
        planHash: "plan-hash-fixture",
        platform: "dsh",
        instanceId: "dsh-fixture",
        rootIdentity: "fixture-root",
        adapterContract: {
          adapter: "dsh-write-fixture",
          platformVersion: "0.1.1-rc.2",
          schemaFingerprint: "fixture-write-v1",
        },
        status: "completed",
        createdAt: at,
        updatedAt: at,
      },
      steps: [],
      recovery: {
        action: "restore-completed",
        allowed: true,
        confirmationRequired: true,
        reason: "fixture backup is restorable",
      },
    };
    const confirmation: IssuedConfirmation = {
      operation: "restore-transaction",
      resourceId: transaction.transaction.id,
      operationHash: "restore-hash-fixture",
      token: "scoped-token-fixture",
      expiresAt: "2026-08-27T00:01:00.000Z",
    };

    vi.spyOn(fixture.engine, "listTransactions").mockResolvedValue({
      items: [{
        id: transaction.transaction.id,
        planId: transaction.transaction.planId,
        platform: "dsh",
        instanceId: transaction.transaction.instanceId,
        status: transaction.transaction.status,
        createdAt: at,
        updatedAt: at,
      }],
    });
    vi.spyOn(fixture.engine, "getTransactionDetail").mockResolvedValue(transaction);
    vi.spyOn(fixture.engine, "listCheckpoints").mockResolvedValue([checkpoint]);
    vi.spyOn(fixture.engine, "createCheckpoint").mockResolvedValue(checkpoint);
    vi.spyOn(fixture.engine, "issueRestoreConfirmation").mockResolvedValue(confirmation);
    vi.spyOn(fixture.engine, "issueRecoveryConfirmation").mockResolvedValue({ ...confirmation, operation: "recover" });
    vi.spyOn(fixture.engine, "applyPlan").mockResolvedValue({ id: transaction.transaction.id, status: "completed" });
    vi.spyOn(fixture.engine, "restoreTransaction").mockResolvedValue({ id: transaction.transaction.id, status: "restored" });
    vi.spyOn(fixture.engine, "recoverTransaction").mockResolvedValue({ id: transaction.transaction.id, status: "restored" });
    const listedPlan = createSyncPlan(appendOnlyPlanFixture(at));
    await fixture.engine.repository.savePlan(listedPlan);

    const server = await fixture.startServer();
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    expect((await client.overview()).sessions).toBe(1);
    expect((await client.getSession(logicalSessionId)).summary.logicalSessionId).toBe(logicalSessionId);
    expect((await client.getVersion(logicalSessionId, versionId)).manifest.id).toBe(versionId);
    expect((await client.listTransactions()).items[0]?.id).toBe(transaction.transaction.id);
    expect((await client.listPlans({ limit: 1 })).items[0]?.id).toBe(listedPlan.id);
    expect((await client.getTransaction(transaction.transaction.id)).transaction.status).toBe("completed");
    expect((await client.listCheckpoints())[0]?.id).toBe(checkpoint.id);
    expect((await client.createCheckpoint({
      name: checkpoint.name,
      description: checkpoint.description,
      refs: checkpoint.refs,
      backupTransactionIds: [],
      createdBy: checkpoint.createdBy,
      createdAt: checkpoint.createdAt,
    })).id).toBe(checkpoint.id);
    const diagnostics = await client.diagnostics();
    expect(diagnostics[0]?.instance.id).toBe("codex-fixture");
    expect(JSON.stringify(diagnostics)).not.toContain(fixture.root);
    expect((await client.patchSettings({ backupRetention: 30 })).backupRetention).toBe(30);
    expect((await client.getSettings()).backupRetention).toBe(30);

    const apply = await client.applyPlan("plan-fixture");
    const replay = [];
    for await (const event of client.subscribe(apply.id, { after: 1 })) replay.push(event.sequence);
    expect(replay).toEqual([2, 3, 4]);

    expect((await client.requestRestoreConfirmation(transaction.transaction.id)).token).toBe(confirmation.token);
    const restore = await client.restoreTransaction(transaction.transaction.id, confirmation.token);
    expect(server.jobStore.get(restore.id)?.request).toEqual({
      kind: "restore",
      transactionId: transaction.transaction.id,
    });
    const recoveryConfirmation = await client.requestRecoveryConfirmation(transaction.transaction.id);
    expect(recoveryConfirmation.operation).toBe("recover");
    const recovery = await client.recoverTransaction(transaction.transaction.id, recoveryConfirmation.token);
    expect(server.jobStore.get(recovery.id)?.request).toEqual({
      kind: "recover",
      transactionId: transaction.transaction.id,
    });

    const rejectedField = await fetch(`${server.origin}/v1/plans/plan-fixture/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ root: "D:/forbidden" }),
    });
    expect(rejectedField.status).toBe(400);
    const rejectedPath = await fetch(`${server.origin}/v1/sessions/${encodeURIComponent("bad/id")}`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(rejectedPath.status).toBe(400);
    const rejectedSettingsPath = await fetch(`${server.origin}/v1/settings`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ dshInstanceId: "D:/not-an-instance-id" }),
    });
    expect(rejectedSettingsPath.status).toBe(400);
  });
});
