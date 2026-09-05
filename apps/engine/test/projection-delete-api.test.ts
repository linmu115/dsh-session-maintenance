import { expect, it } from "vitest";
import { SqliteCanonicalRepository } from "../../../packages/session-store/src/index.js";
import { createEngineFixture, hashTree } from "./helpers.js";

it("deletes the current derived mapping atomically, preserves its same-title parent and Codex source, and is idempotent", async () => {
  const fixture = await createEngineFixture("projection-delete-api");
  const at = "2026-09-05T00:00:00.000Z";
  try {
    const beforeCodex = await hashTree(fixture.codexHome);
    const canonical = new SqliteCanonicalRepository(fixture.engine.repository.database);
    for (const id of ["parent", "child"]) await canonical.createCanonicalSession({
      schemaVersion: 1, id: id as never, authorityScope: id === "parent" ? "codex" : "maintenance",
      originKind: id === "parent" ? "codex-mirror" : "maintenance-native", headVersionId: null,
      title: "Same title", tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at,
    });
    await fixture.engine.projectionRunRepository.createProjectionRun({
      schemaVersion: 1, id: "run-delete" as never, leaseId: "lease-delete" as never, branchId: "delete-test" as never,
      instanceId: "rc1-delete", profileId: "web", dshVersion: "0.1.2-rc.1", adapterId: "dsh-rc1" as never,
      state: "running", startedAt: at, heartbeatAt: at, checkpointId: null,
    });
    await fixture.engine.projectionRunRepository.upsertProjectionSession({
      schemaVersion: 1, runId: "run-delete" as never, nativeSessionId: "native-continuation" as never,
      logicalSessionId: "child" as never, baseVersionId: null, mode: "maintenance-write", nativeRevision: 0,
      lastCommittedOperationId: null, derivedChildSessionId: "child" as never,
    });
    const server = await fixture.startServer();
    const headers = { authorization: `Bearer ${server.token}` };
    const endpoint = `${server.origin}/v1/projection-runs/run-delete/sessions/native-continuation`;
    const identity = await fetch(`${endpoint}/identity`, { headers });
    expect(await identity.json()).toMatchObject({ resolution: { logicalSessionId: "child" } });
    const result = await fetch(endpoint, { method: "DELETE", headers });
    expect(result.status).toBe(200);
    const receipt = await result.json();
    expect(receipt).toMatchObject({ resolution: { logicalSessionId: "child" }, deletion: { logicalSessionId: "child", state: "deleted", pendingOperations: 0 } });
    const repeated = await fetch(endpoint, { method: "DELETE", headers });
    expect((await repeated.json()).deletion.checkpointId).toBe(receipt.deletion.checkpointId);
    const db = fixture.engine.repository.database;
    expect(db.prepare("SELECT tombstoned_at FROM logical_sessions WHERE id='parent'").get()?.tombstoned_at).toBeNull();
    expect(db.prepare("SELECT mode FROM projection_sessions WHERE run_id='run-delete'").get()?.mode).toBe("hidden");
    db.prepare("UPDATE projection_runs SET state='closed' WHERE id='run-delete'").run();
    expect((await fetch(endpoint, { method: "DELETE", headers })).status).toBe(404);
    expect(await hashTree(fixture.codexHome)).toBe(beforeCodex);
  } finally { await fixture.cleanupAll(); }
});
