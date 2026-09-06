import { afterEach, describe, expect, it } from "vitest";
import { SqliteCanonicalRepository } from "@linmu/dsh-session-store";
import { CodexProjectMappingService } from "../src/codex-project-mapping.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
const at = "2026-09-06T00:00:00.000Z";
async function fixture() {
  const f = await createEngineFixture("mapping-manual-restore"); cleanups.push(f.cleanupAll);
  const database = f.engine.repository.database;
  const repository = new SqliteCanonicalRepository(database);
  for (const suffix of ["a", "b"]) {
    await f.engine.canonicalEngine.observeCodex({ logicalSessionId: `restore-${suffix}` as never, title: `Synthetic ${suffix}`,
      tags: [], archivedAt: null, workspaceId: null, events: [], sourceCursor: null, observedAt: at });
    await repository.upsertLogicalProject({ schemaVersion: 1, id: `project-${suffix}` as never, name: "Same name", sourcePlatform: "codex",
      sourceProjectId: `synthetic-${suffix}`, sortKey: suffix, deletedAt: null, createdAt: at, updatedAt: at });
    await repository.replaceProjectRoots(`project-${suffix}` as never, [{ schemaVersion: 1, projectId: `project-${suffix}` as never,
      path: "C:/synthetic/shared", normalizedPath: "c:\\synthetic\\shared", ordinal: 0 }]);
    await repository.setProjectMembership({ schemaVersion: 1, logicalSessionId: `restore-${suffix}` as never, projectId: `project-${suffix}` as never, revision: 0 });
  }
  const service = new CodexProjectMappingService({ database, writes: f.engine.writes!, instances: f.engine.instances,
    directory: async () => ({ projects: [], assignments: {}, migration: { projectsMigrated: true, threadAssignmentsMigrated: true }, safeForSelection: true, issues: [], fingerprint: "synthetic-empty-directory" }) });
  await service.save({ revision: 0, projectKeys: [] });
  const deletion = await service.activateForStartup(async () => {});
  expect(deletion?.removed).toBe(2);
  return { ...f, database, service, deletion };
}

describe("manual restoration after project mapping removal", () => {
  it("revives only the exact membership project and makes the restored session visible", async () => {
    const f = await fixture();
    const sourceBefore = await hashTree(f.codexHome);
    const policyBefore = f.service.readPolicy();
    const versionsBefore = f.database.prepare("SELECT id,head_version_id FROM logical_sessions ORDER BY id").all();
    expect((await f.engine.sessionQueries.readCanonicalProjectDirectory()).projects).toHaveLength(0);
    expect((await f.engine.sessionQueries.readRecentlyDeleted()).map(item => item.session.id)).toContain("restore-a");
    const restored = await f.engine.runWrite("synthetic-manual-restore", () => f.engine.sessionCommands.restoreSession("restore-a"));
    expect(restored?.state).toBe("restored");
    const directory = await f.engine.sessionQueries.readCanonicalProjectDirectory();
    expect(directory.projects.map(item => item.project.id)).toEqual(["project-a"]);
    expect(directory.projects[0]?.sessions.map(item => item.session.id)).toEqual(["restore-a"]);
    expect(directory.unclassified).toEqual([]);
    expect(f.database.prepare("SELECT deleted_at FROM logical_projects WHERE id='project-b'").get()?.deleted_at).not.toBeNull();
    expect(f.database.prepare("SELECT tombstoned_at FROM logical_sessions WHERE id='restore-b'").get()?.tombstoned_at).not.toBeNull();
    expect((await f.engine.sessionQueries.readRecentlyDeleted()).map(item => item.session.id)).not.toContain("restore-a");
    expect(f.service.readPolicy()).toEqual(policyBefore);
    expect(f.database.prepare("SELECT id,head_version_id FROM logical_sessions ORDER BY id").all()).toEqual(versionsBefore);
    expect(await hashTree(f.codexHome)).toBe(sourceBefore);
  });

  it("reapplies the unchanged mapping at next startup with a new recovery point", async () => {
    const f = await fixture();
    await f.engine.runWrite("synthetic-manual-restore", () => f.engine.sessionCommands.restoreSession("restore-a"));
    const next = await f.service.activateForStartup(async () => {});
    expect(next?.removed).toBe(1);
    expect(next?.checkpointId).not.toBeNull();
    expect(next?.checkpointId).not.toBe(f.deletion?.checkpointId);
    expect((await f.engine.sessionQueries.readCanonicalProjectDirectory()).projects).toHaveLength(0);
    const checkpoints = f.database.prepare("SELECT refs_json FROM checkpoints WHERE created_by='codex-project-mapping'").all();
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.every(row => Object.hasOwn(JSON.parse(String(row.refs_json)), "session:restore-a"))).toBe(true);
    expect(f.service.readPolicy().activeProjectKeys).toEqual([]);
  });

  it("rolls back session and tombstone restoration if project revival fails", async () => {
    const f = await fixture();
    const sessionBefore = f.database.prepare("SELECT * FROM logical_sessions WHERE id='restore-a'").get();
    const tombstoneBefore = f.database.prepare("SELECT * FROM session_tombstones WHERE logical_session_id='restore-a'").get();
    f.database.exec(`CREATE TRIGGER synthetic_restore_project_failure BEFORE UPDATE OF deleted_at ON logical_projects
      WHEN OLD.id='project-a' AND NEW.deleted_at IS NULL
      BEGIN SELECT RAISE(ABORT,'synthetic project restore failure'); END`);
    await expect(f.engine.runWrite("synthetic-manual-restore", () => f.engine.sessionCommands.restoreSession("restore-a"))).rejects.toThrow("synthetic project restore failure");
    expect(f.database.prepare("SELECT * FROM logical_sessions WHERE id='restore-a'").get()).toEqual(sessionBefore);
    expect(f.database.prepare("SELECT * FROM session_tombstones WHERE logical_session_id='restore-a'").get()).toEqual(tombstoneBefore);
    expect((await f.engine.sessionQueries.readCanonicalProjectDirectory()).projects).toHaveLength(0);
  });
});
