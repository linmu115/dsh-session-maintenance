import { afterEach, expect, it } from "vitest";
import { SqliteCanonicalRepository } from "@linmu/dsh-session-store";
import type { LogicalWorkspace } from "@linmu/dsh-session-contracts";
import { createEngineFixture } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const at = "2026-09-21T00:00:00.000Z";

/**
 * The "unconfigured means everything" default is gone for existing records too:
 * an instance that was connected before this change has no saved selection, and
 * that must read as an empty scope rather than as all workspaces. Nothing is
 * migrated and nothing is written until an operator selects something.
 */
it("reads an existing instance without a saved record as an empty scope and only widens it on an explicit save", async () => {
  const fixture = await createEngineFixture("instance-scope-empty-default", { withContinuationTarget: true });
  cleanups.push(fixture.cleanupAll);
  const instanceId = "dsh-fixture";
  const database = fixture.engine.repository.database;
  // An instance that was already connected before the change: a run history but no policy row.
  database.prepare("INSERT INTO projection_runs(id,lease_id,branch_id,instance_id,profile_id,dsh_version,adapter_id,state,started_at,heartbeat_at) VALUES (?,?,?,?,'web','0.1.1-rc.2','dsh-rc1','recovered',?,?)")
    .run("run-before-upgrade", "lease-before-upgrade", "main", instanceId, at, at);
  const workspace: LogicalWorkspace = { schemaVersion: 1, id: "workspace-before-upgrade" as LogicalWorkspace["id"], parentId: null,
    name: "已有工作区", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at };
  await fixture.engine.runWrite("instance-scope-existing-instance", () =>
    new SqliteCanonicalRepository(database).upsertLogicalWorkspace(workspace));

  const server = await fixture.startServer();
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.origin };
  const path = `/v1/instances/${instanceId}/workspace-sync`;

  const before = await (await fetch(server.origin + path, { headers })).json() as { configuration: { policy: unknown; activeScopes: unknown[]; pendingActivation: boolean; workspaces: { id: string; selected?: boolean }[] } };
  // No record, no revision, no selection: the empty scope is reported as revision 0 and nothing is written.
  expect(before.configuration.policy).toEqual({ schemaVersion: 1, instanceId, revision: 0,
    selection: { kind: "ids", workspaceIds: [], includeUnassigned: false }, updatedAt: null });
  expect(before.configuration.activeScopes).toEqual([]);
  expect(before.configuration.pendingActivation).toBe(false);
  expect(database.prepare("SELECT count(*) n FROM instance_workspace_policies").get()).toEqual({ n: 0 });
  // The instance's own workspace is visible for selection but is not in scope.
  expect(before.configuration.workspaces).toContainEqual(expect.objectContaining({ id: workspace.id }));

  // The write gate agrees: nothing is synchronised, so the instance's own workspace cannot be written.
  const scope = await (await fetch(`${server.origin}/v1/instances/${instanceId}/workspace-scope?profileId=web`, { headers })).json() as { scope: { selection: unknown; includeUnassigned: boolean; workspaces: { workspaceId: string; selected: boolean }[] } };
  expect(scope.scope.selection).toEqual({ kind: "ids", workspaceIds: [], includeUnassigned: false });
  expect(scope.scope.includeUnassigned).toBe(false);
  expect(scope.scope.workspaces.every(item => item.selected === false)).toBe(true);

  // Only an explicit save widens the scope, and it applies to the next run.
  const saved = await fetch(server.origin + path, { method: "PATCH", headers,
    body: JSON.stringify({ expectedRevision: 0, selection: { kind: "ids", workspaceIds: [workspace.id], includeUnassigned: false } }) });
  expect(saved.status).toBe(200);
  const after = await (await fetch(server.origin + path, { headers })).json() as { configuration: { policy: { revision: number; selection: unknown } } };
  expect(after.configuration.policy).toMatchObject({ revision: 1, selection: { kind: "ids", workspaceIds: [workspace.id], includeUnassigned: false } });
  expect(database.prepare("SELECT instance_id, revision, selection_json FROM instance_workspace_policies").all())
    .toEqual([{ instance_id: instanceId, revision: 1, selection_json: JSON.stringify({ kind: "ids", workspaceIds: [workspace.id], includeUnassigned: false }) }]);
});

it("keeps an explicit all-workspaces selection a real choice rather than a default", async () => {
  const fixture = await createEngineFixture("instance-scope-explicit-all", { withContinuationTarget: true });
  cleanups.push(fixture.cleanupAll);
  const server = await fixture.startServer();
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.origin };
  const path = "/v1/instances/dsh-fixture/workspace-sync";
  expect((await fetch(server.origin + path, { method: "PATCH", headers,
    body: JSON.stringify({ expectedRevision: 0, selection: { kind: "all" } }) })).status).toBe(200);
  const scope = await (await fetch(`${server.origin}/v1/instances/dsh-fixture/workspace-scope?profileId=web`, { headers })).json() as { scope: { selection: unknown; includeUnassigned: boolean } };
  expect(scope.scope.selection).toEqual({ kind: "all" });
  expect(scope.scope.includeUnassigned).toBe(true);
});
