import { afterEach, describe, expect, it } from "vitest";

import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { SqliteCanonicalRepository, SqliteProjectionRunRepository } from "../../../packages/session-store/src/index.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));
const at = "2026-08-31T00:00:00.000Z";

describe("Maintenance canonical operations API", () => {
  it("moves, checkpoints, tombstones, hides and restores without writing Codex", async () => {
    const fixture = await createEngineFixture("maintenance-operations", { withContinuationTarget: true });
    cleanups.push(fixture.cleanupAll);
    Object.assign(fixture.engine.instances.find((instance) => instance.id === "dsh-fixture")!, { platformVersion: "0.1.2-alpha.2" });
    const beforeCodex = await hashTree(fixture.codexHome);
    const database = fixture.engine.repository.database;
    const canonical = new SqliteCanonicalRepository(database);
    await canonical.createCanonicalSession({
      schemaVersion: 1, id: "logical-managed" as never, authorityScope: "codex", originKind: "codex-mirror", headVersionId: null,
      title: "受管会话", tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at,
    });
    await canonical.upsertLogicalWorkspace({ schemaVersion: 1, id: "workspace-managed" as never, parentId: null, name: "项目", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at });
    await canonical.setWorkspaceMembership({ schemaVersion: 1, logicalSessionId: "logical-managed" as never, workspaceId: "workspace-managed" as never, displayOrder: 0, pinned: false, archived: false, revision: 1 });
    const runs = new SqliteProjectionRunRepository(database);
    const adapterId = (database.prepare("SELECT adapter_id FROM adapter_registrations ORDER BY adapter_id LIMIT 1").get() as { readonly adapter_id: string }).adapter_id;
    await runs.createProjectionRun({ schemaVersion: 1, id: "run-managed" as never, leaseId: "lease-managed" as never, branchId: "branch-managed" as never, instanceId: "dsh-fixture", profileId: "alpha2", dshVersion: "0.1.2-alpha.2", adapterId: adapterId as never, state: "running", startedAt: at, heartbeatAt: at, checkpointId: null });
    await runs.upsertProjectionSession({ schemaVersion: 1, runId: "run-managed" as never, nativeSessionId: "native-managed" as never, logicalSessionId: "logical-managed" as never, baseVersionId: null, mode: "codex-read-until-write", nativeRevision: 1, lastCommittedOperationId: null, derivedChildSessionId: null });
    database.prepare(
      `INSERT INTO run_operations (operation_id, run_id, logical_session_id, native_session_id, status, canonical_version_id, projection_revision, committed_at, receipt_json)
       VALUES (?, ?, ?, ?, 'pending', NULL, 1, NULL, ?)`,
    ).run("operation-pending", "run-managed", "logical-managed", "native-managed", "{}");
    const server = await fixture.startServer();
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });

    const updated = await client.updateCanonicalSession("logical-managed", { title: "新标题", tags: ["alpha2"], pinned: true, archived: false });
    expect(updated.session).toMatchObject({ title: "新标题", tags: ["alpha2"] });
    expect(updated.membership?.pinned).toBe(true);

    const pending = await client.deleteCanonicalSession("logical-managed");
    expect(pending).toMatchObject({ state: "pending-delete", checkpointId: null, pendingOperations: 1 });
    expect((await client.listRecentlyDeleted())[0]).toMatchObject({ pendingOperations: 1, tombstone: null });
    expect(database.prepare("SELECT mode FROM projection_sessions WHERE run_id = ? AND native_session_id = ?").get("run-managed", "native-managed")).toEqual({ mode: "recovery-only" });

    database.prepare("UPDATE run_operations SET status = 'committed', committed_at = ? WHERE operation_id = ?").run(at, "operation-pending");
    const deleted = await client.deleteCanonicalSession("logical-managed");
    expect(deleted.state).toBe("deleted");
    expect(deleted.checkpointId).toMatch(/^checkpoint-delete-/u);
    expect(database.prepare("SELECT mode FROM projection_sessions WHERE run_id = ? AND native_session_id = ?").get("run-managed", "native-managed")).toEqual({ mode: "hidden" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE id = ?").get(deleted.checkpointId)).toEqual({ count: 1 });

    const runCenter = await client.listProjectionRuns();
    expect(runCenter[0]).toMatchObject({ pendingOperations: 0, hiddenSessions: 1 });
    expect(runCenter[0]?.latestStages["run.shutdown-recovery"]?.state).toBe("succeeded");
    const restored = await client.restoreCanonicalSession("logical-managed");
    expect(restored).toMatchObject({ state: "restored", workspaceId: "workspace-managed" });
    expect((await client.listCanonicalWorkspaces()).workspaces[0]?.sessions[0]?.session.id).toBe("logical-managed");

    await client.deleteCanonicalWorkspace("workspace-managed");
    expect((await client.listCanonicalWorkspaces()).unclassified[0]?.session.id).toBe("logical-managed");
    expect(await client.listCanonicalAdapters()).toHaveLength(2);
    const experimental = await client.selectExperimentalAdapter("dsh-fixture", adapterId);
    expect(experimental.adapterId).toBe(adapterId);
    expect(["pinned", "experimental", "probe-compatible", "verified"]).toContain(experimental.reason);
    expect(await hashTree(fixture.codexHome)).toBe(beforeCodex);
  });
});
