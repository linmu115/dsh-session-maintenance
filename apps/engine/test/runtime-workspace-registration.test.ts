import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { ProjectionRun } from "@linmu/dsh-session-contracts";
import { openMaintenanceDatabase, MaintenanceWriteCoordinator, SqliteInstanceWorkspacePolicyRepository,
  SqliteCanonicalSessionEngineStore, ZstdContentObjectStore } from "@linmu/dsh-session-store";
import { InstanceWorkspaceRuntime } from "../src/instance-workspace-runtime.js";
import { RuntimeWorkspaceRegistration } from "../src/runtime-workspace-registration.js";

const at = "2026-09-19T16:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-workspace-registration-fixture-"));
  await writeFile(join(root, ".synthetic-fixture"), "No real DSH or Codex homes");
  const db = openMaintenanceDatabase(join(root, "metadata.sqlite"));
  const writes = MaintenanceWriteCoordinator.acquire(root);
  cleanups.push(async () => { db.close(); writes.close(); await rm(root, { recursive: true, force: true }); });
  const policy = new SqliteInstanceWorkspacePolicyRepository(db);
  for (const id of ["selected", "excluded"]) db.prepare("INSERT INTO logical_workspaces(id,parent_id,name,sort_key,created_at,updated_at) VALUES (?,NULL,?,?,?,?)").run(id,id,id,at,at);
  for (const id of ["project-new", "project-existing"]) db.prepare("INSERT INTO logical_projects(id,name,source_platform,sort_key,created_at,updated_at) VALUES (?,?,'maintenance',?,?,?)").run(id,id,id,at,at);
  db.prepare("INSERT INTO adapter_registrations VALUES ('fixture','{}','fixture',1,?,?)").run(at,at);
  policy.updatePolicy("instance-a", { expectedRevision: 0, selection: { kind: "ids", workspaceIds: ["selected" as never], includeUnassigned: false } });
  const run = (id: string, instanceId = "instance-a"): ProjectionRun => {
    db.prepare("INSERT INTO projection_runs(id,lease_id,branch_id,instance_id,profile_id,dsh_version,adapter_id,state,started_at,heartbeat_at) VALUES (?,?,?,?,'web','0.1.5-rc.2','fixture','preparing',?,?)").run(id,`lease-${id}`,id,instanceId,at,at);
    const value = { schemaVersion: 1, id, leaseId: `lease-${id}`, branchId: id, instanceId, profileId: "web", dshVersion: "0.1.5-rc.2", adapterId: "fixture", state: "preparing", startedAt: at, heartbeatAt: at, checkpointId: null } as ProjectionRun;
    policy.policyForRun(value);
    return value;
  };
  const current = run("run-current");
  const service = new RuntimeWorkspaceRegistration(db);
  const objects = new ZstdContentObjectStore(root);
  const guard = new InstanceWorkspaceRuntime(db, [], writes);
  const store = new SqliteCanonicalSessionEngineStore(db, objects, undefined, undefined, guard.assertMutationAllowed);
  const engine = new CanonicalSessionEngine(store);
  const input = { run: current, nativeSessionId: "native-new" as never, projectId: "project-new" as never };
  return { db, policy, run, current, service, engine, store, input };
}

it("registers a new workspace, commits its first message, and retains it for the next run without changing another instance", async () => {
  const f = await fixture();
  f.policy.updatePolicy("instance-b", { expectedRevision: 0, selection: { kind: "ids", workspaceIds: [], includeUnassigned: false } });
  const other = f.run("run-other", "instance-b");
  const workspaceId = f.service.resolve(f.input);
  expect(f.policy.workspaceSelected(f.policy.policyForRun(f.current), workspaceId)).toBe(true);
  expect(f.policy.getPolicy("instance-a").selection).toEqual({ kind: "ids", workspaceIds: ["selected", workspaceId].sort(), includeUnassigned: false });
  expect(f.policy.workspaceSelected(f.policy.policyForRun(other), workspaceId)).toBe(false);
  const registered = await f.engine.importDshNative({ operationId: "register" as never, logicalSessionId: "logical-new" as never,
    nativeSessionId: f.input.nativeSessionId, title: "new", tags: [], archivedAt: null, workspaceId, events: [], importedAt: at });
  f.db.prepare("INSERT INTO projection_sessions(run_id,native_session_id,logical_session_id,base_version_id,mode,native_revision) VALUES (?,?,'logical-new',?,'maintenance-write',0)")
    .run(f.current.id, f.input.nativeSessionId, registered.versionId);
  const receipt = await f.engine.appendDsh({ logicalSessionId: "logical-new" as never, baseVersionId: registered.versionId!, title: "new", tags: [], archivedAt: null, workspaceId,
    appendedEvents: [{ schemaVersion: 1, id: "event-new", logicalSessionId: "logical-new" as never, sequence: 0, kind: "user-message", role: "user", content: { text: "hello" }, contentDigest: "sha256:fixture", rawPayload: null, extensions: {}, source: { platform: "dsh", instanceId: "instance-a", sessionId: "native-new", eventId: "0", cursor: "0" } }],
    observedAt: at, projection: { runId: f.current.id, leaseId: f.current.leaseId, branchId: f.current.branchId, adapterId: f.current.adapterId, nativeSessionId: f.input.nativeSessionId, operationId: "append" as never, nativeRevision: 1 } });
  expect(receipt.outcome).toBe("advanced");
  expect((await f.store.getVersion(receipt.versionId!))?.events).toHaveLength(1);
  expect(f.policy.workspaceSelected(f.policy.policyForRun(f.run("run-next")), workspaceId)).toBe(true);
});

it("reuses durable registration after failure and restart, and does not duplicate a workspace for another session", async () => {
  const f = await fixture();
  const first = f.service.resolve(f.input);
  expect(new RuntimeWorkspaceRegistration(f.db).resolve(f.input)).toBe(first);
  expect(f.service.resolve({ ...f.input, nativeSessionId: "native-second" as never })).toBe(first);
  expect(f.db.prepare("SELECT count(*) n FROM logical_workspaces").get()?.n).toBe(3);
  expect(f.policy.getPolicy("instance-a").revision).toBe(2);
});

it("inherits an explicitly selected workspace and rejects excluded or ambiguous existing choices", async () => {
  const f = await fixture();
  expect(f.service.resolve({ ...f.input, workspaceId: "selected" as never })).toBe("selected");
  expect(() => f.service.resolve({ ...f.input, nativeSessionId: "other" as never, workspaceId: "excluded" as never })).toThrow(/同步/);
  expect(() => f.service.resolve({ ...f.input, workspaceId: "excluded" as never })).toThrow(/registration/i);
  expect(f.policy.getPolicy("instance-a").revision).toBe(1);
});

it("does not activate unrelated saved edits or alter another active run while enrolling a new workspace", async () => {
  const f = await fixture();
  const sibling = f.run("run-sibling");
  f.policy.updatePolicy("instance-a", { expectedRevision: 1, selection: { kind: "ids", workspaceIds: ["excluded" as never], includeUnassigned: true } });
  const workspaceId = f.service.resolve(f.input);
  expect(f.policy.policyForRun(f.current).selection).toEqual({ kind: "ids", workspaceIds: ["selected", workspaceId].sort(), includeUnassigned: false });
  expect(f.policy.getPolicy("instance-a").selection).toEqual({ kind: "ids", workspaceIds: ["excluded", workspaceId].sort(), includeUnassigned: true });
  expect(f.policy.workspaceSelected(f.policy.policyForRun(sibling), workspaceId)).toBe(false);
  expect(f.policy.policyForRun(f.current).revision).not.toBe(f.policy.getPolicy("instance-a").revision);
});

it("reuses a unique existing project membership, refuses ambiguity, and respects later deselection", async () => {
  const f = await fixture();
  const add = async (id: string, workspaceId: string) => {
    await f.engine.importDshNative({ operationId: `register-${id}` as never, logicalSessionId: id as never, nativeSessionId: id as never,
      title: id, tags: [], archivedAt: null, workspaceId: workspaceId as never, events: [], importedAt: at });
    f.db.prepare("INSERT INTO project_memberships(logical_session_id,project_id,revision) VALUES (?,'project-existing',0)").run(id);
  };
  await add("existing-selected", "selected");
  expect(f.service.resolve({ ...f.input, projectId: "project-existing" as never })).toBe("selected");
  await add("existing-excluded", "excluded");
  expect(() => f.service.resolve({ ...f.input, projectId: "project-existing" as never, nativeSessionId: "ambiguous" as never })).toThrow("multiple Maintenance workspaces");
  const created = f.service.resolve({ ...f.input, nativeSessionId: "created" as never });
  const saved = f.policy.getPolicy("instance-a");
  f.policy.updatePolicy("instance-a", { expectedRevision: saved.revision, selection: { kind: "ids", workspaceIds: ["selected" as never], includeUnassigned: false } });
  const next = f.run("after-deselection");
  expect(() => f.service.resolve({ ...f.input, run: next, nativeSessionId: "excluded-new" as never })).toThrow(/同步/);
  expect(f.policy.isWorkspaceSelected("instance-a", created)).toBe(false);
});

it("rolls back workspace and policy creation if its registration intent cannot be persisted", async () => {
  const f = await fixture();
  f.db.exec("CREATE TRIGGER reject_intent BEFORE INSERT ON runtime_workspace_registrations BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  expect(() => f.service.resolve(f.input)).toThrow("fixture failure");
  expect(f.db.prepare("SELECT count(*) n FROM logical_workspaces").get()?.n).toBe(2);
  expect(f.policy.getPolicy("instance-a").revision).toBe(1);
  expect(f.policy.policyForRun(f.current).revision).toBe(1);
  expect(f.db.isTransaction).toBe(false);
});
