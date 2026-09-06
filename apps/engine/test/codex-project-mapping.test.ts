import { describe, expect, it } from "vitest";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CodexDesktopProjectDirectory } from "@linmu/dsh-adapter-codex-read";
import { sha256Canonical } from "@linmu/dsh-session-domain";
import { SqliteRuntimeProjectResolver } from "../src/runtime-project-resolver.js";
import { CodexProjectMappingService, codexProjectKey } from "../src/codex-project-mapping.js";
import { createEngineFixture, hashTree } from "./helpers.js";

async function fixture() {
  const f = await createEngineFixture("codex-project-mapping");
  const instance = f.engine.instances.find(item => item.platform === "codex")!;
  await f.engine.importCodex({ operationId: "mapping-seed", instanceIds: [instance.id], mode: "content" });
  const database = f.engine.repository.database;
  const source = database.prepare("SELECT logical_session_id FROM platform_bindings WHERE platform='codex' AND session_id='thread-fixture'").get() as { logical_session_id: string };
  let directory: CodexDesktopProjectDirectory = {
    projects: [{ projectId: "folder-a", name: "Same name", serverProjectId: null, roots: ["/unrelated/cwd"], source: "desktop", kind: "local", memberThreadIds: ["thread-fixture"] },
      { projectId: "folder-b", name: "Same name", serverProjectId: null, roots: [], source: "desktop", kind: "local", memberThreadIds: [] }],
    assignments: { "thread-fixture": { projectId: "folder-a", basis: "desktop-explicit" } },
    migration: { projectsMigrated: true, threadAssignmentsMigrated: false }, safeForSelection: true, issues: [], fingerprint: "fixture-1",
  };
  const make = () => new CodexProjectMappingService({ database, writes: f.engine.writes!, instances: f.engine.instances, directory: async () => directory });
  const service = make();
  const addNative = (id: string) => database.prepare(`INSERT INTO logical_sessions
    (id,display_title,canonical_version_id,sync_mode,archived,labels_json,created_at,authority_scope,origin_kind,head_version_id,updated_at)
    VALUES (?, ?, NULL,'continuation',0,'[]','2026-01-01','maintenance','maintenance-native',NULL,'2026-01-01')`).run(id, id);
  return { ...f, instance, database, sourceId: source.logical_session_id, service, make, addNative,
    setDirectory: (value: CodexDesktopProjectDirectory) => { directory = value; }, getDirectory: () => directory,
    key: codexProjectKey(instance.id, "folder-a"),
    state: (id: string) => database.prepare("SELECT tombstoned_at FROM logical_sessions WHERE id=?").get(id) as { tombstoned_at: string | null },
  };
}

describe("Codex project mapping policy and recoverable scope activation", () => {
  it("rolls back an imported prefix and its bindings/versions when startup fails after real canonical commits", async () => {
    const f = await fixture();
    try {
      const source = new DatabaseSync(join(f.codexHome, "state_5.sqlite"));
      const row = source.prepare("SELECT rollout_path FROM threads WHERE id='thread-fixture'").get() as { rollout_path: string };
      source.close();
      const before = f.database.prepare("SELECT head_version_id FROM logical_sessions WHERE id=?").get(f.sourceId);
      const versions = f.database.prepare("SELECT count(*) n FROM session_versions").get();
      await appendFile(join(f.codexHome, row.rollout_path), JSON.stringify({ timestamp: "2026-09-06T01:00:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Canonical startup prefix" }] } }) + "\n");
      await f.service.save({ revision: 0, projectKeys: [f.key] });
      await expect(f.service.activateForStartup(async () => {
        await f.engine.importCodex({ operationId: "startup-prefix", instanceIds: [f.instance.id], mode: "content" });
        expect(f.database.prepare("SELECT head_version_id FROM logical_sessions WHERE id=?").get(f.sourceId)).not.toEqual(before);
        f.addNative("partially-imported");
        throw new Error("injected late source failure");
      })).rejects.toThrow("injected late source failure");
      expect(f.database.prepare("SELECT head_version_id FROM logical_sessions WHERE id=?").get(f.sourceId)).toEqual(before);
      expect(f.database.prepare("SELECT count(*) n FROM session_versions").get()).toEqual(versions);
      expect(f.database.prepare("SELECT id FROM logical_sessions WHERE id='partially-imported'").get()).toBeUndefined();
      expect(f.service.readPolicy().activeRevision).toBe(0);
    } finally { await f.cleanupAll(); }
  });
  it("migrates native server-project membership and excludes retired roots from new DSH session routing", async () => {
    const f = await fixture();
    try {
      const idFor = (id: string) => `project-${sha256Canonical({ platform: "codex", instanceId: f.instance.id, sourceProjectId: id }).slice(0, 24)}`;
      const oldId = idFor("server-a"); const newId = idFor("folder-a");
      f.setDirectory({ ...f.getDirectory(), projects: f.getDirectory().projects.map(p => p.projectId === "folder-a" ? { ...p, serverProjectId: "server-a", roots: ["C:/project"] } : p) });
      f.database.prepare("INSERT INTO logical_projects VALUES (?, 'Same name', 'codex', 'server-a', 'a', NULL, '2026-01-01', '2026-01-01')").run(oldId);
      f.database.prepare("INSERT INTO project_roots VALUES (?, 'C:/project', 'c:\\project', 0)").run(oldId);
      f.addNative("native-progress");
      f.database.prepare("INSERT INTO project_memberships VALUES ('native-progress',?,0)").run(oldId);
      await f.service.save({ revision: 0, projectKeys: [f.key] });
      await f.service.activateForStartup(async () => {});
      expect(f.state("native-progress").tombstoned_at).toBeNull();
      expect(f.database.prepare("SELECT project_id FROM project_memberships WHERE logical_session_id='native-progress'").get()).toEqual({ project_id: newId });
      expect((f.database.prepare("SELECT deleted_at FROM logical_projects WHERE id=?").get(oldId) as { deleted_at: string }).deleted_at).not.toBeNull();
      expect(await new SqliteRuntimeProjectResolver(f.database).resolveProject("C:/project")).toBe(newId);
    } finally { await f.cleanupAll(); }
  });
  it("persists saved intent without switching active scope; rejects stale revisions and unknown IDs", async () => {
    const f = await fixture();
    try {
      const result = await f.service.save({ revision: 0, projectKeys: [f.key] });
      expect(result).toMatchObject({ pendingActivation: true, policy: { revision: 1, activeRevision: 0, activeConfigured: false } });
      expect(await f.service.readScope(f.instance)).toBeUndefined();
      expect(f.make().readPolicy().projectKeys).toEqual([f.key]);
      expect((await f.service.get()).projects.map(p => p.name)).toEqual(["Same name", "Same name"]);
      await expect(f.service.save({ revision: 0, projectKeys: [] })).rejects.toMatchObject({ code: "MAPPING_POLICY_CHANGED" });
      await expect(f.service.save({ revision: 1, projectKeys: ["unknown"] })).rejects.toMatchObject({ code: "MAPPING_PROJECT_UNKNOWN" });
      expect(f.service.readPolicy().revision).toBe(1);
    } finally { await f.cleanupAll(); }
  });

  it("keeps explicit mirrors and DSH descendant progress while deleting every outside canonical session", async () => {
    const f = await fixture();
    try {
      const beforeSource = await hashTree(f.codexHome);
      f.addNative("outside"); f.addNative("child"); f.addNative("grandchild");
      f.database.prepare("UPDATE logical_sessions SET origin_kind='codex-derived' WHERE id IN ('child','grandchild')").run();
      const sourceHead = f.database.prepare("SELECT head_version_id FROM logical_sessions WHERE id=?").get(f.sourceId) as { head_version_id: string };
      f.database.prepare("INSERT INTO session_derivations VALUES ('child',?,?,'dsh-continuation','r','op-child','2026-01-01')").run(f.sourceId, sourceHead.head_version_id);
      f.database.prepare("INSERT INTO session_versions (id,logical_session_id,body_object,body_hash,metadata_hash,manifest_json,created_at) SELECT 'child-base','child',body_object,body_hash,metadata_hash,manifest_json,created_at FROM session_versions WHERE id=?").run(sourceHead.head_version_id);
      f.database.prepare("UPDATE logical_sessions SET head_version_id='child-base' WHERE id='child'").run();
      f.database.prepare("INSERT INTO session_derivations VALUES ('grandchild','child','child-base','dsh-continuation','r','op-grandchild','2026-01-01')").run();
      await f.service.save({ revision: 0, projectKeys: [f.key] });
      const result = await f.service.activateForStartup(async () => {});
      expect(result).toMatchObject({ removed: 1, kept: 3, restored: 0 });
      for (const id of [f.sourceId, "child", "grandchild"]) expect(f.state(id).tombstoned_at).toBeNull();
      expect(f.state("outside").tombstoned_at).not.toBeNull();
      expect(f.database.prepare("SELECT head_version_id FROM logical_sessions WHERE id='child'").get()).toEqual({ head_version_id: "child-base" });
      expect(await hashTree(f.codexHome)).toBe(beforeSource);
      expect((await f.service.readScope(f.instance))?.projectIds).toEqual(["folder-a"]);
      expect((await f.service.get()).pendingActivation).toBe(false);
    } finally { await f.cleanupAll(); }
  });

  it("treats empty selection as zero imports and restores only removals made by mapping", async () => {
    const f = await fixture();
    try {
      await f.service.save({ revision: 0, projectKeys: [] });
      expect((await f.service.activateForStartup(async () => {}))?.removed).toBe(1);
      expect((await f.service.readScope(f.instance))?.projectIds).toEqual([]);
      await f.service.save({ revision: 1, projectKeys: [f.key] });
      expect((await f.service.activateForStartup(async () => {}))?.restored).toBe(1);
      expect(f.state(f.sourceId).tombstoned_at).toBeNull();
      // A later manual deletion has another operation ID and must stay deleted.
      f.database.prepare("UPDATE logical_sessions SET tombstoned_at='2026-02-01' WHERE id=?").run(f.sourceId);
      f.database.prepare("UPDATE session_tombstones SET operation_id='manual-delete',restored_at=NULL WHERE logical_session_id=?").run(f.sourceId);
      await f.service.save({ revision: 2, projectKeys: [] }); await f.service.activateForStartup(async () => {});
      await f.service.save({ revision: 3, projectKeys: [f.key] });
      expect((await f.service.activateForStartup(async () => {}))?.restored).toBe(0);
      expect(f.state(f.sourceId).tombstoned_at).toBe("2026-02-01");
    } finally { await f.cleanupAll(); }
  });

  it("blocks unsafe/missing directory data, incomplete imports and unresolved running instances before deletion", async () => {
    const f = await fixture();
    try {
      await f.service.save({ revision: 0, projectKeys: [f.key] });
      const good = f.getDirectory();
      f.setDirectory({ ...good, safeForSelection: false, issues: ["ambiguous"] });
      await expect(f.service.activateForStartup(async () => {})).rejects.toMatchObject({ code: "MAPPING_DIRECTORY_UNSAFE" });
      f.setDirectory({ ...good, projects: good.projects.map(p => p.projectId === "folder-a" ? { ...p, memberThreadIds: [...p.memberThreadIds, "new-not-imported"] } : p) });
      await expect(f.service.activateForStartup(async () => {})).rejects.toMatchObject({ code: "MAPPING_IMPORT_INCOMPLETE" });
      f.setDirectory(good);
      const adapter = f.database.prepare("SELECT adapter_id FROM adapter_registrations LIMIT 1").get() as { adapter_id: string };
      f.database.prepare("INSERT INTO projection_runs (id,lease_id,branch_id,instance_id,profile_id,dsh_version,adapter_id,state,started_at,heartbeat_at) VALUES ('active','lease','branch','instance','web','0.1.2-rc.1',?,'running','2026-01-01','2026-01-01')").run(adapter.adapter_id);
      await expect(f.service.activateForStartup(async () => {})).rejects.toMatchObject({ code: "MAPPING_RUNTIME_ACTIVE" });
      expect(f.service.readPolicy().activeRevision).toBe(0);
      expect(f.state(f.sourceId).tombstoned_at).toBeNull();
    } finally { await f.cleanupAll(); }
  });

  it("rolls back cleanup and policy together if activation cannot be persisted", async () => {
    const f = await fixture();
    try {
      await f.service.save({ revision: 0, projectKeys: [] });
      f.database.exec("CREATE TRIGGER fail_activation BEFORE UPDATE ON codex_project_mapping_policy BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END");
      await expect(f.service.activateForStartup(async () => {})).rejects.toThrow("injected persistence failure");
      expect(f.state(f.sourceId).tombstoned_at).toBeNull();
      expect(f.service.readPolicy().activeRevision).toBe(0);
      expect(f.database.prepare("SELECT count(*) n FROM codex_project_mapping_removals").get()).toEqual({ n: 0 });
      expect(f.database.prepare("SELECT count(*) n FROM checkpoints WHERE created_by='codex-project-mapping'").get()).toEqual({ n: 0 });
    } finally { await f.cleanupAll(); }
  });
});
