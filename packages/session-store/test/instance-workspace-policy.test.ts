import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { LogicalSessionId, LogicalWorkspaceId } from "@linmu/dsh-session-contracts";
import { openMaintenanceDatabase, SqliteInstanceWorkspacePolicyRepository } from "../src/index.js";

const at = "2026-09-18T00:00:00.000Z";
const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(async () => { databases.splice(0).forEach(db => db.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const wid = (id: string) => id as LogicalWorkspaceId;
const sid = (id: string) => id as LogicalSessionId;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-instance-scope-fixture-")); roots.push(root);
  await writeFile(join(root, ".synthetic-fixture"), "Synthetic instance workspace scope test\n");
  const path = join(root, "metadata.sqlite"), db = openMaintenanceDatabase(path); databases.push(db);
  db.prepare("INSERT INTO logical_workspaces (id, name, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("a", "A", "a", at, at);
  db.prepare("INSERT INTO logical_workspaces (id, name, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("b", "B", "b", at, at);
  for (const id of ["in-a", "in-b", "unassigned", "deleted"]) db.prepare(`INSERT INTO logical_sessions
    (id,display_title,sync_mode,archived,labels_json,created_at,tombstoned_at) VALUES (?,?,'continuation',0,'[]',?,?)`)
    .run(id, id, at, id === "deleted" ? at : null);
  for (const [id, workspace] of [["in-a", "a"], ["in-b", "b"]])
    db.prepare("INSERT INTO workspace_memberships VALUES (?,?,0,0,0,0)").run(id!, workspace!);
  return { db, path, repo: new SqliteInstanceWorkspacePolicyRepository(db, () => at) };
}
describe("instance workspace policy repository", () => {
  it("upgrades schema 25 without changing canonical memberships and reopens schema 26 idempotently", async () => {
    const { db, path } = await fixture();
    const before = db.prepare("SELECT * FROM workspace_memberships ORDER BY logical_session_id").all();
    db.exec("DROP TABLE instance_workspace_policies; DELETE FROM schema_migrations WHERE version=26");
    db.close(); databases.splice(databases.indexOf(db), 1);
    const upgraded = openMaintenanceDatabase(path); databases.push(upgraded);
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toMatchObject({ version: 26 });
    expect(upgraded.prepare("SELECT * FROM workspace_memberships ORDER BY logical_session_id").all()).toEqual(before);
    new SqliteInstanceWorkspacePolicyRepository(upgraded).updatePolicy("i-one", { expectedRevision: 0, selection: { kind: "all" } });
    upgraded.close(); databases.splice(databases.indexOf(upgraded), 1);
    const reopened = openMaintenanceDatabase(path); databases.push(reopened);
    expect(new SqliteInstanceWorkspacePolicyRepository(reopened).getPolicy("i-one").revision).toBe(1);
  });
  it("defaults to all without writing, isolates instance policies and allows explicit empty/unassigned-only", async () => {
    const { db, repo } = await fixture();
    expect(repo.getPolicy("i-one")).toEqual({ schemaVersion: 1, instanceId: "i-one", revision: 0, selection: { kind: "all" }, updatedAt: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM instance_workspace_policies").get()).toMatchObject({ count: 0 });
    repo.updatePolicy("i-one", { expectedRevision: 0, selection: { kind: "ids", workspaceIds: [], includeUnassigned: false } });
    expect(repo.sessionScope("i-one", sid("in-a")).status).toBe("not-synced");
    expect(repo.sessionScope("i-one", sid("unassigned")).status).toBe("not-synced");
    expect(repo.sessionScope("i-two", sid("in-a")).status).toBe("allowed");
    repo.updatePolicy("i-one", { expectedRevision: 1, selection: { kind: "ids", workspaceIds: [], includeUnassigned: true } });
    expect(repo.sessionScope("i-one", sid("unassigned")).status).toBe("allowed");
    expect(repo.isWorkspaceSelected("i-one", wid("a"))).toBe(false);
  });
  it("applies current membership and policy synchronously inside a caller transaction; outer rollback retains both", async () => {
    const { db, repo } = await fixture();
    const other = new SqliteInstanceWorkspacePolicyRepository(db);
    db.exec("BEGIN IMMEDIATE");
    repo.updatePolicy("i-one", { expectedRevision: 0, selection: { kind: "ids", workspaceIds: [wid("a")], includeUnassigned: false } });
    expect(other.assertSessionAllowed("i-one", sid("in-a")).policyRevision).toBe(1);
    expect(() => other.assertSessionAllowed("i-one", sid("in-b"))).toThrowError(expect.objectContaining({ code: "SESSION_NOT_SYNCED" }));
    db.prepare("UPDATE workspace_memberships SET workspace_id='b' WHERE logical_session_id='in-a'").run();
    expect(other.sessionScope("i-one", sid("in-a")).status).toBe("not-synced");
    db.exec("ROLLBACK");
    expect(repo.getPolicy("i-one").revision).toBe(0);
    expect(repo.sessionScope("i-one", sid("in-a")).workspaceId).toBe("a");
  });
  it("persists CAS revisions across connections and rejects unknown/deleted/duplicate selections without canonical changes", async () => {
    const { db, repo, path } = await fixture();
    const secondDb = openMaintenanceDatabase(path); databases.push(secondDb);
    const second = new SqliteInstanceWorkspacePolicyRepository(secondDb);
    repo.updatePolicy("i-one", { expectedRevision: 0, selection: { kind: "ids", workspaceIds: [wid("a")], includeUnassigned: false } });
    expect(second.getPolicy("i-one").revision).toBe(1);
    expect(() => second.updatePolicy("i-one", { expectedRevision: 0, selection: { kind: "all" } })).toThrowError(expect.objectContaining({ code: "INSTANCE_WORKSPACE_POLICY_CONFLICT" }));
    for (const ids of [["unknown"], ["a", "a"]]) expect(() => repo.updatePolicy("i-one", { expectedRevision: 1, selection: { kind: "ids", workspaceIds: ids.map(wid), includeUnassigned: false } })).toThrow();
    db.prepare("UPDATE logical_workspaces SET deleted_at=? WHERE id='a'").run(at);
    expect(repo.getPolicy("i-one").selection).toEqual({ kind: "ids", workspaceIds: ["a"], includeUnassigned: false });
    expect(() => repo.updatePolicy("i-one", { expectedRevision: 1, selection: { kind: "ids", workspaceIds: [wid("a")], includeUnassigned: false } })).toThrowError(expect.objectContaining({ code: "INSTANCE_WORKSPACE_UNKNOWN" }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM logical_sessions").get()).toMatchObject({ count: 4 });
    expect(repo.getPolicy("i-one").revision).toBe(1);
  });
  it("does not confuse missing/deleted sessions with scope exclusion and restores the same membership after reselection", async () => {
    const { repo } = await fixture();
    repo.updatePolicy("i-one", { expectedRevision: 0, selection: { kind: "ids", workspaceIds: [], includeUnassigned: false } });
    expect(repo.sessionScope("i-one", sid("missing")).status).toBe("missing");
    expect(() => repo.assertSessionAllowed("i-one", sid("deleted"))).toThrowError(expect.objectContaining({ code: "SESSION_DELETED" }));
    expect(() => repo.assertSessionAllowed("i-one", sid("missing"))).toThrowError(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    repo.updatePolicy("i-one", { expectedRevision: 1, selection: { kind: "ids", workspaceIds: [wid("a")], includeUnassigned: false } });
    expect(repo.assertSessionAllowed("i-one", sid("in-a"))).toEqual({ status: "allowed", workspaceId: "a", policyRevision: 2 });
  });
});
