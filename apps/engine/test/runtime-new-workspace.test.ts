import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import type { JsonValue, RuntimeBrokerPrepareRunRequest, RuntimeBrokerPreparedRun } from "@linmu/dsh-session-contracts";
import { JsonProjectionDirectory } from "@linmu/dsh-session-projection-lifecycle";
import { SqliteInstanceWorkspacePolicyRepository } from "@linmu/dsh-session-store";
import { rc1NativeSessionCodec } from "../../../packages/adapter-dsh-rc1/src/index.js";
import { codexProjectKey } from "../src/codex-project-mapping.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const at = "2026-09-07T00:00:00.000Z";

describe("live DSH sessions in new local workspaces", () => {
  it("registers and persists a new workspace through the next scoped startup without changing Codex membership", async () => {
    const f = await createEngineFixture("runtime-new-local-workspace");
    let run: RuntimeBrokerPreparedRun | undefined;
    const request: RuntimeBrokerPrepareRunRequest = {
      schemaVersion: 1, client: { kind: "launcher", id: "fixture-local-launcher" }, runtimeClientId: "fixture-local-runtime",
      instanceId: "fixture-rc1-runtime", profileId: "web", dshVersion: "0.1.2-rc.1", maintenanceEndpoint: "http://127.0.0.1:41781",
      branchId: "main" as never, pinnedAdapterId: "dsh-rc1" as never, projectSelection: { kind: "all" },
      environment: { packageVersions: { "@deepseek-ai/dsh-session": "0.1.2-rc.1", "@deepseek-ai/dsh-session-persistence": "0.1.2-rc.1" }, runtimeCapabilities: ["sessionPersistence", "session/event", "session/flush"] },
    };
    try {
      await writeFile(join(f.codexHome, ".codex-global-state.json"), JSON.stringify({
        "local-projects": { "folder-selected": { id: "folder-selected", name: "Selected Codex project", rootPaths: ["C:\\fixture\\codex-project"] } },
        "thread-project-assignments": { "thread-fixture": { projectId: "folder-selected", projectKind: "local" } },
      }));
      const key = codexProjectKey(f.engine.instances[0]!.id, "folder-selected");
      await f.engine.codexProjectMapping!.save({ revision: 0, projectKeys: [key] });
      const sourceHash = await hashTree(f.codexHome);
      const cwd = join(f.root, "new-dsh-workspace");
      await mkdir(cwd);
      const policies = new SqliteInstanceWorkspacePolicyRepository(f.engine.repository.database);
      f.engine.repository.database.prepare("INSERT INTO logical_workspaces(id,parent_id,name,sort_key,created_at,updated_at) VALUES ('existing-selected',NULL,'Existing','Existing',?,?)").run(at,at);
      policies.updatePolicy(request.instanceId, { expectedRevision: 0,
        selection: { kind: "ids", workspaceIds: ["existing-selected" as never], includeUnassigned: false } });
      run = await f.engine.prepareProjectionRuntimeRun(request);
      await mkdir(run.persistenceRoot, { recursive: true });
      await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
      const nativeSessionId = "native-new-workspace" as never;
      const registration = { schemaVersion: 1 as const, clientId: request.runtimeClientId, runId: run.runId, nativeSessionId,
        header: { version: 0, id: nativeSessionId, cwd, createdAt: Date.parse(at), isSeeded: false }, title: "New DSH workspace conversation" };
      await expect(f.engine.registerProjectionRuntimeSession({ ...registration, clientId: "another-runtime" })).rejects.toThrow("capability does not match");
      await expect(f.engine.registerProjectionRuntimeSession({ ...registration, header: { ...registration.header, cwd: join(run.persistenceRoot, "unknown-temporary-project") } })).rejects.toThrow("no canonical project root");
      expect(f.engine.repository.database.prepare("SELECT count(*) n FROM logical_projects WHERE source_platform='maintenance'").get()).toEqual({ n: 0 });
      const importFailure = vi.spyOn(f.engine.canonicalEngine, "importDshNative").mockRejectedValueOnce(new Error("synthetic registration interruption"));
      await expect(f.engine.registerProjectionRuntimeSession(registration)).rejects.toThrow("synthetic registration interruption");
      importFailure.mockRestore();
      const registered = await f.engine.registerProjectionRuntimeSession(registration);
      const database = f.engine.repository.database;
      const workspace = database.prepare("SELECT workspace_id FROM workspace_memberships WHERE logical_session_id=?").get(registered.logicalSessionId)!;
      expect(workspace.workspace_id).toEqual(expect.any(String));
      expect(policies.isWorkspaceSelected(request.instanceId, workspace.workspace_id as never)).toBe(true);
      const membership = database.prepare(`SELECT p.id,p.name,p.source_platform,p.source_project_id,r.root_path FROM project_memberships m
        JOIN logical_projects p ON p.id=m.project_id JOIN project_roots r ON r.project_id=p.id WHERE m.logical_session_id=?`).get(registered.logicalSessionId)!;
      expect(membership).toMatchObject({ name: "new-dsh-workspace", source_platform: "maintenance", source_project_id: null, root_path: cwd });
      expect(await f.engine.registerProjectionRuntimeSession(registration)).toEqual(registered);
      expect(database.prepare("SELECT count(*) n FROM logical_projects WHERE source_platform='maintenance' AND deleted_at IS NULL").get()).toEqual({ n: 1 });
      const event: JsonValue = { seq: 0, time: Date.parse(at), type: "user/message", surfaceOp: "append", data: { id: "fixture-user-message", role: "user", content: [{ type: "text", text: "first message in the new workspace" }], source: { kind: "user" } } };
      const receipt = await f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, { runId: run.runId, nativeSessionId,
        operationId: "operation-first-new-workspace" as never, nativeRevision: 1, observedAt: at,
        payload: { logicalSessionId: registered.logicalSessionId, canonicalHistoryMode: "native", events: [event] } });
      expect(receipt.status).toBe("committed");
      expect(receipt.logicalSessionId).toBe(registered.logicalSessionId);
      const nativePayload = { header: registration.header, inheritedEventCount: 0, events: [event] };
      const description = await rc1NativeSessionCodec.describe(nativePayload, run.persistenceRoot);
      const nativePath = join(run.persistenceRoot, description.relativePath);
      await mkdir(dirname(nativePath), { recursive: true });
      await writeFile(nativePath, rc1NativeSessionCodec.encode(nativePayload, description));
      await f.engine.drainProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, runtimeFlushCompletedAt: at });
      await f.engine.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: run.runId, reason: "normal" });
      run = undefined;
      // A restart re-applies the Codex mapping scope; a local DSH conversation must survive it.
      run = await f.engine.prepareProjectionRuntimeRun(request);
      const projected = (await f.engine.projectionRunRepository.listProjectionSessions(run.runId)).find(item => item.logicalSessionId === registered.logicalSessionId);
      expect(projected).toBeDefined();
      const session = await new JsonProjectionDirectory(run.controlRoot ?? dirname(run.persistenceRoot)).readSession(projected!.nativeSessionId) as { events: JsonValue[]; header: { cwd: string }; projectId: string };
      expect(session.events).toEqual([event]);
      expect(session.header.cwd).toBe(cwd);
      expect(session.projectId).toBe(membership.id);
      expect(f.engine.codexProjectMapping!.readPolicy().activeProjectKeys).toEqual([key]);
      expect(database.prepare("SELECT count(*) n FROM platform_bindings WHERE platform='codex'").get()).toEqual({ n: 1 });
      expect(await hashTree(f.codexHome)).toBe(sourceHash);
    } finally {
      try {
        if (run !== undefined) await f.engine.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: run.runId, reason: "recovery" });
      } finally { await f.cleanupAll(); }
    }
  });
});

it("commits RC2 v3 first-turn events with unassigned sessions disabled", async () => {
  const f = await createEngineFixture("runtime-v3-created-workspace");
  try {
    const request: RuntimeBrokerPrepareRunRequest = {
      schemaVersion: 1, client: { kind: "launcher", id: "fixture-v3-launcher" }, runtimeClientId: "fixture-v3-runtime",
      instanceId: "fixture-v3", profileId: "web", dshVersion: "0.1.5-rc.2", maintenanceEndpoint: "http://127.0.0.1:41781",
      branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never, projectSelection: { kind: "all" },
      environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES], packageVersions: Object.fromEntries(
        ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].map(name => [name, "0.1.5-rc.2"])) },
    };
    new SqliteInstanceWorkspacePolicyRepository(f.engine.repository.database).updatePolicy(request.instanceId, {
      expectedRevision: 0, selection: { kind: "ids", workspaceIds: [], includeUnassigned: false },
    });
    const run = await f.engine.prepareProjectionRuntimeRun(request);
    await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
      temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
    const nativeSessionId = "native-v3-created" as never;
    const header = { version: 3, id: nativeSessionId, cwd: join(f.root, "v3-project"), createdAt: Date.parse(at), isSeeded: false, agentPreset: "standard", delegationDepth: 0 };
    const registered = await f.engine.registerProjectionRuntimeSession({ schemaVersion: 1, clientId: request.runtimeClientId,
      runId: run.runId, nativeSessionId, header, title: "V3 created workspace" });
    const events = [
      { type: "agent/inbox/spliced", seq: 0, time: Date.parse(at), data: { target: "next-turn", start: 0, inserted: [{ source: { kind: "user" }, content: [{ type: "text", text: "hello" }], role: "user", id: "fixture-input" }] } },
      { type: "turn/start", seq: 1, time: Date.parse(at), data: { turn: 1 } },
    ];
    const operation = { runId: run.runId, nativeSessionId, operationId: "v3-created-first-message" as never,
      nativeRevision: events.length, observedAt: at, payload: { logicalSessionId: registered.logicalSessionId, instanceId: request.instanceId, header, inheritedEventCount: 0, events } };
    const receipt = await f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, operation);
    expect(receipt.status).toBe("committed");
    expect(await f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, operation)).toEqual(receipt);
    expect((await f.engine.canonicalEngine.store.getVersion(receipt.canonicalVersionId!))?.events).toHaveLength(2);
    const detail = await f.engine.canonicalEngine.store.getSession(registered.logicalSessionId as never);
    expect(detail?.workspaceId).not.toBeNull();
    f.engine.repository.database.prepare("INSERT INTO logical_workspaces(id,parent_id,name,sort_key,created_at,updated_at) VALUES ('excluded',NULL,'Excluded','Excluded',?,?)").run(at,at);
    const server = await f.startServer();
    const rejected = await fetch(`${server.origin}/v1/runtime-broker/runs/${run.runId}/sessions`, {
      method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, nativeSessionId: "explicit-excluded",
        header: { ...header, id: "explicit-excluded" }, title: "Excluded", workspaceId: "excluded" }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "SESSION_NOT_SYNCED", message: expect.stringContaining("同步范围") } });
  } finally { await f.cleanupAll(); }
});
