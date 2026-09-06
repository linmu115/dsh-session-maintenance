import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CodexProjectMappingPolicy } from "@linmu/dsh-session-contracts";
import { createEngineFixture } from "./helpers.js";
import { reseedCanonicalCandidate } from "../src/canonical-reseed.js";
import { previewConversationTopologyRepair, stageConversationTopologyRepair, activateConversationTopologyRepairCandidate } from "../src/conversation-topology-repair.js";
import { readOfflineCodexPolicy } from "../src/codex-project-mapping-offline.js";

async function setup(name: string) {
  const fixture = await createEngineFixture(name);
  const instance = fixture.engine.instances.find(item => item.platform === "codex")!;
  await writeFile(join(instance.root, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { selected: { id: "selected", name: "Same name", rootPaths: [] }, excluded: { id: "excluded", name: "Same name", rootPaths: [] } },
    "thread-project-assignments": { "thread-fixture": { projectId: "selected", projectKind: "local" } },
  }));
  const policy = (keys: string[]): CodexProjectMappingPolicy => ({ revision: 8, activeRevision: 7, configured: true, activeConfigured: true,
    projectKeys: [`${instance.id}:excluded`], activeProjectKeys: keys.map(id => `${encodeURIComponent(instance.id)}:${encodeURIComponent(id)}`), includeFutureSessions: true });
  const save = (value: CodexProjectMappingPolicy) => fixture.engine.repository.database.prepare("INSERT INTO codex_project_mapping_policy VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET policy_json=excluded.policy_json")
    .run(JSON.stringify(value), "2026-09-06T00:00:00.000Z");
  const repair = { stateRoot: fixture.stateRoot, sourceDatabasePath: join(fixture.stateRoot, "metadata.sqlite"), candidateFile: "metadata.scoped-repair.sqlite", codexInstance: instance, fixtureGuard: fixture.fixturePolicy };
  return { ...fixture, instance, policy, save, repair };
}

describe("offline Codex project policy inheritance", () => {
  it("recognizes old schema while refusing malformed policy", () => {
    const database = new DatabaseSync(":memory:");
    try {
      expect(readOfflineCodexPolicy(database)).toBeNull();
      database.exec("CREATE TABLE codex_project_mapping_policy(id INTEGER, policy_json TEXT); INSERT INTO codex_project_mapping_policy VALUES(1,'{}')");
      expect(() => readOfflineCodexPolicy(database)).toThrow();
    } finally { database.close(); }
  });

  it.each([{ keys: [] }, { keys: ["selected"] }])("reseed imports only active selection $keys and copies saved plus active policy", async ({ keys }) => {
    const f = await setup(`offline-reseed-${keys.length}`);
    try {
      const policy = f.policy(keys); f.save(policy);
      const manifest = await reseedCanonicalCandidate({ stateRoot: f.stateRoot, candidateFile: "metadata.scoped-reseed.sqlite",
        dshHome: f.dshHome, dshInstanceId: "dsh-alpha2", retainedDshSessionIds: ["dsh-session-1"],
        maintenanceProjectName: "Maintenance", maintenanceProjectRoot: "D:/synthetic", codexInstance: f.instance,
        expectedCodexSessions: keys.length, fixtureGuard: f.fixturePolicy });
      expect(manifest.codex.scanned).toBe(keys.length);
      const candidate = new DatabaseSync(manifest.candidatePath, { readOnly: true });
      try { expect(readOfflineCodexPolicy(candidate)).toEqual(policy); }
      finally { candidate.close(); }
    } finally { await f.cleanupAll(); }
  });

  it("freezes explicit scope, preserves policy in backup, and rejects activation after policy edits", async () => {
    const f = await setup("offline-scoped-repair");
    try {
      const policy = f.policy(["selected"]); f.save(policy);
      const preview = await previewConversationTopologyRepair(f.repair);
      expect(preview.plannedCodexMirrors).toBe(1);
      const frozen = JSON.parse(await readFile(preview.planSnapshotPath, "utf8"));
      expect(frozen.data.summary.projectScope).toEqual({ revision: 7, projectIds: ["selected"] });
      expect(frozen.data.summary.sourceInstance.id).toBe(f.instance.id);
      const manifest = await stageConversationTopologyRepair({ ...f.repair, expectedSourceDigest: preview.sourceDigest, expectedCodexPlanDigest: preview.codexPlanDigest });
      const candidate = new DatabaseSync(manifest.candidateDatabasePath, { readOnly: true });
      try { expect(readOfflineCodexPolicy(candidate)).toEqual(policy); }
      finally { candidate.close(); }
      f.save({ ...policy, activeRevision: 9, activeProjectKeys: [] });
      let activated = false;
      await expect(activateConversationTopologyRepairCandidate({ ...f.repair, expectedSourceDigest: preview.sourceDigest,
        expectedCandidateDigest: manifest.candidateDigest, activateDatabaseFile: async () => { activated = true; } })).rejects.toThrow(/source changed|POLICY_CHANGED/u);
      expect(activated).toBe(false);
    } finally { await f.cleanupAll(); }
  });

  it("blocks a frozen unrestricted plan once active policy is configured", async () => {
    const f = await setup("offline-old-frozen-plan");
    try {
      const preview = await previewConversationTopologyRepair(f.repair);
      expect(preview.plannedCodexMirrors).toBe(1);
      f.save(f.policy([]));
      await expect(stageConversationTopologyRepair({ ...f.repair, expectedSourceDigest: preview.sourceDigest, expectedCodexPlanDigest: preview.codexPlanDigest }))
        .rejects.toThrow(/SCOPE_CHANGED|source changed/u);
    } finally { await f.cleanupAll(); }
  });

  it("keeps an empty selection closed through preview and staged repair", async () => {
    const f = await setup("offline-empty-repair");
    try {
      const policy = f.policy([]); f.save(policy);
      const preview = await previewConversationTopologyRepair(f.repair);
      expect(preview.plannedCodexMirrors).toBe(0);
      const manifest = await stageConversationTopologyRepair({ ...f.repair, expectedSourceDigest: preview.sourceDigest, expectedCodexPlanDigest: preview.codexPlanDigest });
      expect(manifest.codexImport.scanned).toBe(0);
      const candidate = new DatabaseSync(manifest.candidateDatabasePath, { readOnly: true });
      try { expect(readOfflineCodexPolicy(candidate)).toEqual(policy); }
      finally { candidate.close(); }
    } finally { await f.cleanupAll(); }
  });

  it("rejects frozen membership moved out of the selected project before staging", async () => {
    const f = await setup("offline-reassigned-thread");
    try {
      f.save(f.policy(["selected"]));
      const preview = await previewConversationTopologyRepair(f.repair);
      const path = join(f.instance.root, ".codex-global-state.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      state["thread-project-assignments"]["thread-fixture"].projectId = "excluded";
      await writeFile(path, JSON.stringify(state));
      await expect(stageConversationTopologyRepair({ ...f.repair, expectedSourceDigest: preview.sourceDigest, expectedCodexPlanDigest: preview.codexPlanDigest }))
        .rejects.toThrow("IMPORT_PROJECT_MEMBERSHIP_CHANGED");
    } finally { await f.cleanupAll(); }
  });

  it("rejects an old source database when the active database has a policy", async () => {
    const f = await setup("offline-old-source");
    try {
      const oldPath = join(f.stateRoot, "metadata.old.sqlite");
      await backup(f.engine.repository.database, oldPath);
      f.save(f.policy([]));
      await expect(previewConversationTopologyRepair({ ...f.repair, sourceDatabasePath: oldPath })).rejects.toThrow("OFFLINE_CODEX_PROJECT_POLICY_CHANGED");
    } finally { await f.cleanupAll(); }
  });
});
