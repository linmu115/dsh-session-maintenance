import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexReadAdapter, readCodexDesktopProjectDirectory } from "@linmu/dsh-adapter-codex-read";
import { JsonProjectionDirectory } from "@linmu/dsh-session-projection-lifecycle";
import { SqliteCanonicalRepository } from "@linmu/dsh-session-store";
import { canonicalJson, logicalSessionIdFor } from "@linmu/dsh-session-domain";
import type { CodexProjectMappingConfiguration, JsonValue, RuntimeBrokerPrepareRunRequest } from "@linmu/dsh-session-contracts";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { CodexCanonicalImportService, type CanonicalImportPlanV1 } from "../src/codex-canonical-import.js";
import { codexProjectKey } from "../src/codex-project-mapping.js";
import { SqliteCodexProjectPort } from "../src/sqlite-codex-project-port.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const f = await createEngineFixture("codex-mapping-composition-http"); cleanups.push(f.cleanupAll);
  const instance = f.engine.instances[0]!;
  const native = {
    "local-projects": {
      "folder-selected": { id: "folder-selected", name: "Shared title", rootPaths: ["C:\\fixture\\workspace"] },
      "folder-outside": { id: "folder-outside", name: "Shared title", rootPaths: ["C:\\fixture\\workspace"] },
    },
    "thread-project-assignments": {
      "thread-fixture": { projectId: "folder-selected", projectKind: "local" },
      "thread-outside": { projectId: "folder-outside", projectKind: "local" },
    } as Record<string, { projectId: string; projectKind: string }>,
  };
  const save = () => writeFile(join(f.codexHome, ".codex-global-state.json"), JSON.stringify(native));
  const clone = async (id: string, projectId: string, body = true) => {
    const source = new DatabaseSync(join(f.codexHome, "state_5.sqlite"));
    try {
      const original = source.prepare("SELECT * FROM threads WHERE id='thread-fixture'").get()!;
      const row = { ...original, id, rollout_path: `rollouts/${id}.jsonl`, name: id, title: id };
      const columns = Object.keys(row);
      source.prepare(`INSERT INTO threads (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
    } finally { source.close(); }
    if (body) await writeFile(join(f.codexHome, `rollouts/${id}.jsonl`),
      (await readFile(join(f.codexHome, "rollouts/thread-fixture.jsonl"), "utf8")).replaceAll("thread-fixture", id));
    native["thread-project-assignments"][id] = { projectId, projectKind: "local" }; await save();
  };
  await clone("thread-outside", "folder-outside");
  const key = codexProjectKey(instance.id, "folder-selected");
  const logicalId = (id: string) => logicalSessionIdFor({ platform: "codex", instanceId: instance.id, sessionId: id });
  const liveIds = () => (f.engine.repository.database.prepare("SELECT id FROM logical_sessions WHERE tombstoned_at IS NULL ORDER BY id").all() as { id: string }[]).map(row => row.id);
  return { ...f, instance, native, save, clone, key, logicalId, liveIds };
}

describe("Codex project mapping composition and HTTP activation", () => {
  it("authenticates GET/PATCH, enforces CSRF/CAS, and activates saved scope before real RC1 materialization", async () => {
    const f = await fixture();
    await f.engine.importCodex({ operationId: "composition-legacy-seed", instanceIds: [f.instance.id], mode: "content" });
    expect(f.liveIds()).toEqual([f.logicalId("thread-fixture"), f.logicalId("thread-outside")].sort());
    await f.clone("thread-new-selected", "folder-selected");
    await appendFile(join(f.codexHome, "rollouts/thread-new-selected.jsonl"), JSON.stringify({ timestamp: "2026-09-06T01:00:00.000Z", type: "response_item", payload: { type: "integration_unknown", detail: "fixture evidence" } }) + "\n");
    await f.clone("thread-excluded-broken", "folder-outside", false);
    const sourceHash = await hashTree(f.codexHome);
    const server = await f.startServer();
    // Timer behavior has its own suite; keep this prepare boundary deterministic.
    await f.engine.codexProjectObserver!.stop();
    const endpoint = `${server.origin}/v1/codex-project-mapping`;
    const bearer = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { method: "PATCH", body: JSON.stringify({ revision: 0, projectKeys: [f.key] }) })).status).toBe(401);
    const directoryResponse = await fetch(endpoint, { headers: bearer });
    expect(directoryResponse.status).toBe(200);
    const initial = (await directoryResponse.json() as { configuration: CodexProjectMappingConfiguration }).configuration;
    expect(initial.policy).toMatchObject({ revision: 0, configured: false, activeConfigured: false });
    expect(initial.projects.map(project => [project.projectId, project.sessionCount]).sort()).toEqual([
      ["folder-outside", 2], ["folder-selected", 2],
    ]);

    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    const launch = await client.createDashboardLaunchCode();
    const claim = await fetch(launch.url, { redirect: "manual" });
    const cookie = claim.headers.get("set-cookie")!.split(";", 1)[0]!;
    const uiResponse = await fetch(`${server.origin}/v1/ui/session`, { headers: { cookie, "sec-fetch-site": "same-origin" } });
    const ui = await uiResponse.json() as { session: { csrfToken: string } };
    const uiHeaders = { cookie, origin: server.origin, "x-dsh-csrf": ui.session.csrfToken, "content-type": "application/json" };
    const update = JSON.stringify({ revision: 0, projectKeys: [f.key] });
    expect((await fetch(endpoint, { method: "PATCH", headers: { cookie, origin: server.origin, "content-type": "application/json" }, body: update })).status).toBe(403);
    expect((await fetch(endpoint, { method: "PATCH", headers: { ...uiHeaders, origin: "https://other.invalid" }, body: update })).status).toBe(403);
    const savedResponse = await fetch(endpoint, { method: "PATCH", headers: uiHeaders, body: update });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json() as { configuration: CodexProjectMappingConfiguration }).configuration;
    expect(saved).toMatchObject({ pendingActivation: true, policy: { revision: 1, projectKeys: [f.key], activeRevision: 0, activeConfigured: false } });
    const stale = await fetch(endpoint, { method: "PATCH", headers: bearer, body: JSON.stringify({ revision: 0, projectKeys: [] }) });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("MAPPING_POLICY_CHANGED");
    expect(await f.engine.codexProjectMapping!.readScope(f.instance)).toBeUndefined();
    expect(f.liveIds()).toEqual([f.logicalId("thread-fixture"), f.logicalId("thread-outside")].sort());

    const database = f.engine.repository.database;
    const exec = vi.spyOn(database, "exec");
    const observe = vi.spyOn(CodexReadAdapter.prototype, "observe");
    const selectedIds = [f.logicalId("thread-fixture"), f.logicalId("thread-new-selected")].sort();
    const prepareOriginal = f.engine.runtimeBroker.prepareRun.bind(f.engine.runtimeBroker);
    const prepare = vi.spyOn(f.engine.runtimeBroker, "prepareRun").mockImplementation(async input => {
      expect(database.isTransaction).toBe(false);
      expect(f.engine.codexProjectMapping!.readPolicy()).toMatchObject({ activeConfigured: true, activeRevision: 1, activeProjectKeys: [f.key] });
      expect(f.liveIds()).toEqual(selectedIds);
      return prepareOriginal(input);
    });
    const request: RuntimeBrokerPrepareRunRequest = {
      schemaVersion: 1, client: { kind: "launcher", id: "fixture-mapping-launcher" }, runtimeClientId: "fixture-mapping-runtime",
      instanceId: "fixture-rc1-runtime", profileId: "web", dshVersion: "0.1.2-rc.1", maintenanceEndpoint: server.origin,
      branchId: "main" as never, pinnedAdapterId: "dsh-rc1" as never, projectSelection: { kind: "all" },
      environment: { packageVersions: { "@deepseek-ai/dsh-session": "0.1.2-rc.1", "@deepseek-ai/dsh-session-persistence": "0.1.2-rc.1" }, runtimeCapabilities: ["sessionPersistence", "session/event", "session/flush"] },
    };
    const run = await f.engine.prepareProjectionRuntimeRun(request);
    try {
      expect(run).toMatchObject({ state: "preparing", adapterId: "dsh-rc1" });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(observe.mock.calls.map(call => call[1].sessionId).sort()).toEqual(["thread-fixture", "thread-new-selected"]);
      const sql = exec.mock.calls.map(call => call[0]);
      expect(sql).toContain("SAVEPOINT canonical_commit");
      expect(sql).toContain("SAVEPOINT codex_observation");
      expect(sql).toContain("SAVEPOINT project_roots_replace");
      const projections = await f.engine.projectionRunRepository.listProjectionSessions(run.runId);
      expect(projections.map(item => item.logicalSessionId).sort()).toEqual(selectedIds);
      const directory = new JsonProjectionDirectory(run.controlRoot ?? dirname(run.persistenceRoot));
      expect(await directory.listNativeSessionIds()).toHaveLength(2);
      const policy = (await (await fetch(endpoint, { headers: bearer })).json() as { configuration: CodexProjectMappingConfiguration }).configuration;
      expect(policy).toMatchObject({ pendingActivation: false, policy: { activeRevision: 1, activeProjectKeys: [f.key] } });
      expect(database.prepare("SELECT tombstoned_at FROM logical_sessions WHERE id=?").get(f.logicalId("thread-outside"))).toMatchObject({ tombstoned_at: expect.any(String) });
      expect(database.prepare("SELECT count(*) AS n FROM adapter_evidence").get()).toEqual({ n: 1 });
      expect(await hashTree(f.codexHome)).toBe(sourceHash);
    } finally {
      await f.engine.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: run.runId, reason: "recovery" });
    }
  });

  it("replays a scoped plan after canonical JSON persistence reorders its snapshot fields", async () => {
    const f = await fixture();
    const importer = new CodexCanonicalImportService({
      canonicalEngine: f.engine.canonicalEngine, projectPort: new SqliteCodexProjectPort(new SqliteCanonicalRepository(f.engine.repository.database)),
      writes: f.engine.writes!, fixtureGuard: f.fixturePolicy,
      projectScope: async () => ({ revision: 1, projectIds: ["folder-selected"], directory: await readCodexDesktopProjectDirectory(f.instance, { fixtureGuard: f.fixturePolicy }) }),
    });
    const plan = await importer.plan({ instance: f.instance });
    const persisted = JSON.parse(canonicalJson(plan as unknown as JsonValue)) as CanonicalImportPlanV1;
    expect(Object.keys(persisted.projectScope!)).toEqual(["projectIds", "revision"]);
    await expect(importer.apply({ plan: persisted })).resolves.toMatchObject({ created: 1, scanned: 1 });
    expect(f.liveIds()).toEqual([f.logicalId("thread-fixture")]);
  });
});
