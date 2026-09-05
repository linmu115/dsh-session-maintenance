import { afterEach, expect, it, vi } from "vitest";
import { SqliteCanonicalRepository } from "../../../packages/session-store/src/index.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const at = "2026-09-05T00:00:00.000Z";

async function setup() {
  const fixture = await createEngineFixture("sm03-synthetic-commands");
  cleanups.push(fixture.cleanupAll);
  const { engine } = fixture;
  const database = engine.repository.database;
  const canonical = new SqliteCanonicalRepository(database);
  for (const id of ["parent", "child"]) await canonical.createCanonicalSession({
    schemaVersion: 1, id: id as never, authorityScope: id === "parent" ? "codex" : "maintenance",
    originKind: id === "parent" ? "codex-mirror" : "maintenance-native", headVersionId: null,
    title: "Same title", tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at,
  });
  await canonical.upsertLogicalWorkspace({ schemaVersion: 1, id: "workspace" as never, parentId: null,
    name: "Workspace", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at });
  await canonical.setWorkspaceMembership({ schemaVersion: 1, logicalSessionId: "child" as never,
    workspaceId: "workspace" as never, displayOrder: 3, pinned: true, archived: false, revision: 1 });
  await engine.projectionRunRepository.createProjectionRun({
    schemaVersion: 1, id: "run" as never, leaseId: "lease" as never, branchId: "branch" as never,
    instanceId: "sm03-instance", profileId: "web", dshVersion: "0.1.2-rc.1", adapterId: "dsh-rc1" as never,
    state: "running", startedAt: at, heartbeatAt: at, checkpointId: null,
  });
  await engine.projectionRunRepository.upsertProjectionSession({ schemaVersion: 1, runId: "run" as never,
    nativeSessionId: "native" as never, logicalSessionId: "parent" as never, baseVersionId: null,
    mode: "codex-read-until-write", nativeRevision: 0, lastCommittedOperationId: null, derivedChildSessionId: null });
  return { ...fixture, database, canonical };
}

it("resolves the mapping after asynchronous logging and holds the transaction through mutation and receipt", async () => {
  const { engine, database, codexHome } = await setup();
  const beforeCodex = await hashTree(codexHome);
  const start = engine.statusLog.start.bind(engine.statusLog);
  vi.spyOn(engine.statusLog, "start").mockImplementationOnce(async (input) => {
    const span = await start(input);
    database.exec("UPDATE projection_sessions SET logical_session_id = 'child', mode = 'maintenance-write' WHERE native_session_id = 'native'");
    return span;
  });
  const resolve = engine.sessionQueries.resolveProjectionSessionIdentity.bind(engine.sessionQueries);
  let committedBeforeNextMicrotask = false;
  vi.spyOn(engine.sessionQueries, "resolveProjectionSessionIdentity").mockImplementation((runId, nativeId) => {
    expect(database.isTransaction).toBe(true);
    const result = resolve(runId, nativeId);
    // A yield after resolving would expose an uncommitted deletion here.
    queueMicrotask(() => {
      committedBeforeNextMicrotask = !database.isTransaction &&
        database.prepare("SELECT tombstoned_at FROM logical_sessions WHERE id = 'child'").get()?.tombstoned_at !== null;
    });
    return result;
  });
  const receipt = await engine.sessionCommands.deleteProjectedSession("run", "native");
  expect(committedBeforeNextMicrotask).toBe(true);
  expect(receipt).toMatchObject({ resolution: { logicalSessionId: "child" }, deletion: { logicalSessionId: "child", state: "deleted" } });
  expect(database.prepare("SELECT tombstoned_at FROM logical_sessions WHERE id = 'parent'").get()?.tombstoned_at).toBeNull();
  expect((await engine.sessionCommands.deleteProjectedSession("run", "native"))?.deletion.checkpointId).toBe(receipt?.deletion.checkpointId);
  expect(await hashTree(codexHome)).toBe(beforeCodex);
});

it("checkpoints the current metadata head and rolls back a partially applied restore", async () => {
  const { engine, database } = await setup();
  const observed = await engine.canonicalEngine.observeCodex({ logicalSessionId: "checkpoint-session" as never,
    title: "Original", tags: [], archivedAt: null, workspaceId: null, events: [], sourceCursor: null, observedAt: at });
  const patched = await engine.sessionCommands.updateSession(observed.logicalSessionId, { title: "Edited", workspaceId: "workspace" as never });
  expect(patched?.session.headVersionId).not.toBe(observed.versionId);
  const deletion = await engine.sessionCommands.deleteSession(observed.logicalSessionId);
  const checkpoint = (await engine.listCheckpoints()).find((item) => item.id === deletion?.checkpointId);
  expect(checkpoint?.refs).toEqual({ [`session:${observed.logicalSessionId}`]: patched?.session.headVersionId });
  database.exec(`CREATE TRIGGER sm03_fail_restore BEFORE UPDATE OF workspace_id ON workspace_memberships
    WHEN NEW.logical_session_id = 'checkpoint-session' AND NEW.workspace_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'sm03 restore failure'); END`);
  expect(() => engine.sessionCommands.restoreSession(observed.logicalSessionId)).toThrow("sm03 restore failure");
  const deleted = (await engine.sessionQueries.readRecentlyDeleted()).find((item) => item.session.id === observed.logicalSessionId);
  expect(deleted?.tombstone?.restoredAt).toBeNull();
  expect(deleted?.session.tombstonedAt).not.toBeNull();
  expect(engine.sessionQueries.workspaceMembership(observed.logicalSessionId)?.workspaceId).toBeNull();
  database.exec("DROP TRIGGER sm03_fail_restore");
  expect(engine.sessionCommands.restoreSession(observed.logicalSessionId)).toMatchObject({ state: "restored", workspaceId: "workspace" });
});

it.each(["closed", "unmapped"] as const)("rejects a %s target changed during logging without a checkpoint", async (change) => {
  const { engine, database } = await setup();
  const start = engine.statusLog.start.bind(engine.statusLog);
  vi.spyOn(engine.statusLog, "start").mockImplementationOnce(async (input) => {
    const span = await start(input);
    database.exec(change === "closed" ? "UPDATE projection_runs SET state = 'closed'" : "DELETE FROM projection_sessions");
    return span;
  });
  expect(await engine.sessionCommands.deleteProjectedSession("run", "native")).toBeUndefined();
  expect(database.prepare("SELECT COUNT(*) AS count FROM checkpoints").get()?.count).toBe(0);
  expect(database.prepare("SELECT COUNT(*) AS count FROM logical_sessions WHERE tombstoned_at IS NOT NULL").get()?.count).toBe(0);
});

it("rolls back checkpoint, tombstone, membership and projection changes on a late deletion failure", async () => {
  const { engine, database } = await setup();
  database.exec("UPDATE projection_sessions SET logical_session_id = 'child', mode = 'maintenance-write'");
  const membership = engine.sessionQueries.workspaceMembership("child");
  database.exec(`CREATE TRIGGER sm03_fail_hide BEFORE UPDATE OF mode ON projection_sessions
    WHEN NEW.mode = 'hidden' BEGIN SELECT RAISE(ABORT, 'sm03 synthetic failure'); END`);
  await expect(engine.sessionCommands.deleteProjectedSession("run", "native")).rejects.toThrow("sm03 synthetic failure");
  expect(database.isTransaction).toBe(false);
  expect(database.prepare("SELECT COUNT(*) AS count FROM checkpoints").get()?.count).toBe(0);
  expect(database.prepare("SELECT COUNT(*) AS count FROM session_tombstones").get()?.count).toBe(0);
  expect(database.prepare("SELECT tombstoned_at FROM logical_sessions WHERE id = 'child'").get()?.tombstoned_at).toBeNull();
  expect(engine.sessionQueries.workspaceMembership("child")).toEqual(membership);
  expect(database.prepare("SELECT mode FROM projection_sessions").get()?.mode).toBe("maintenance-write");
  database.exec("DROP TRIGGER sm03_fail_hide");
  expect((await engine.sessionCommands.deleteProjectedSession("run", "native"))?.deletion.state).toBe("deleted");
});

it.each(["parent", "child"])("preserves pending-delete and restoration modes for %s authority", async (id) => {
  const { engine, database } = await setup();
  database.prepare("UPDATE projection_sessions SET logical_session_id = ?, mode = ?").run(id, id === "parent" ? "codex-read-until-write" : "maintenance-write");
  database.prepare(`INSERT INTO run_operations
    (operation_id, run_id, logical_session_id, native_session_id, status, canonical_version_id, projection_revision, committed_at, receipt_json)
    VALUES ('pending', 'run', ?, 'native', 'pending', NULL, 1, NULL, '{}')`).run(id);
  expect((await engine.sessionCommands.deleteProjectedSession("run", "native"))?.deletion).toMatchObject({ state: "pending-delete", pendingOperations: 1, checkpointId: null });
  expect(database.prepare("SELECT mode FROM projection_sessions").get()?.mode).toBe("recovery-only");
  expect(engine.sessionCommands.restoreSession(id)?.state).toBe("restored");
  expect(database.prepare("SELECT mode FROM projection_sessions").get()?.mode).toBe(id === "parent" ? "codex-read-until-write" : "maintenance-write");
  database.prepare("UPDATE run_operations SET status = 'committed', committed_at = ?").run(at);
  const deleted = await engine.sessionCommands.deleteSession(id);
  expect(deleted?.state).toBe("deleted");
  expect(engine.sessionCommands.restoreSession(id)?.state).toBe("restored");
  expect(database.prepare("SELECT mode FROM projection_sessions").get()?.mode).toBe(id === "parent" ? "codex-read-until-write" : "maintenance-write");
  expect(engine.sessionCommands.restoreSession(id)).toBeUndefined();
});

it("rejects unauthenticated maintenance writes without changing canonical state", async () => {
  const { engine, database, startServer } = await setup();
  const server = await startServer();
  for (const [method, path, body] of [
    ["PATCH", "/v1/canonical/sessions/parent", { title: "Forbidden" }],
    ["DELETE", "/v1/canonical/sessions/parent", undefined],
    ["POST", "/v1/canonical/sessions/parent/restore", {}],
    ["DELETE", "/v1/projection-runs/run/sessions/native", undefined],
    ["DELETE", "/v1/canonical/workspaces/workspace", undefined],
  ] as const) {
    expect((await fetch(`${server.origin}${path}`, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).status).toBe(401);
  }
  expect((await engine.sessionQueries.readCanonicalDashboardSession("parent"))?.session).toMatchObject({ title: "Same title", tombstonedAt: null });
  expect(database.prepare("SELECT COUNT(*) AS count FROM checkpoints").get()?.count).toBe(0);
  expect((await engine.sessionQueries.readCanonicalWorkspaceDirectory()).workspaces).toHaveLength(1);
});
