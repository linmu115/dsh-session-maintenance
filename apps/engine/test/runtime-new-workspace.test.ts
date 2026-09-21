import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import type { JsonValue, RuntimeBrokerPrepareRunRequest, RuntimeBrokerPreparedRun } from "@linmu/dsh-session-contracts";
import { JsonProjectionDirectory } from "@linmu/dsh-session-projection-lifecycle";
import { SqliteInstanceWorkspacePolicyRepository } from "@linmu/dsh-session-store";
import { rc1NativeSessionCodec } from "../../../packages/adapter-dsh-rc1/src/index.js";
import { codexProjectKey } from "../src/codex-project-mapping.js";
import { createEngineFixture, hashTree, joinInstanceWorkspace } from "./helpers.js";

const at = "2026-09-07T00:00:00.000Z";
const selectionOf = (f: Awaited<ReturnType<typeof createEngineFixture>>, instanceId: string) =>
  new SqliteInstanceWorkspacePolicyRepository(f.engine.repository.database).getPolicy(instanceId).selection;
const countOf = (f: Awaited<ReturnType<typeof createEngineFixture>>, table: string) =>
  f.engine.repository.database.prepare(`SELECT count(*) n FROM ${table}`).get();

describe("live DSH sessions in new local workspaces", () => {
  it("keeps a workspace the instance created on its own out of the maintenance scope until it is explicitly joined", async () => {
    const f = await createEngineFixture("runtime-unjoined-local-workspace");
    const request: RuntimeBrokerPrepareRunRequest = {
      schemaVersion: 1, client: { kind: "launcher", id: "fixture-unjoined-launcher" }, runtimeClientId: "fixture-unjoined-runtime",
      instanceId: "fixture-unjoined-runtime", profileId: "web", dshVersion: "0.1.5-rc.2", maintenanceEndpoint: "http://127.0.0.1:41781",
      branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never, projectSelection: { kind: "all" },
      environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES], packageVersions: Object.fromEntries(
        ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].map(name => [name, "0.1.5-rc.2"])) },
    };
    try {
      // A new instance selects nothing, so the run freezes an empty Maintenance scope.
      const run = await f.engine.prepareProjectionRuntimeRun(request);
      await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
        temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
      const frozen = f.engine.repository.database.prepare("SELECT policy_json FROM projection_run_workspace_scopes WHERE run_id=?").get(run.runId) as { policy_json: string };
      expect(JSON.parse(frozen.policy_json).selection).toEqual({ kind: "ids", workspaceIds: [], includeUnassigned: false });
      const cwd = join(f.root, "own-dsh-workspace");
      await mkdir(cwd);
      const registration = { schemaVersion: 1 as const, clientId: request.runtimeClientId, runId: run.runId, nativeSessionId: "native-own-workspace" as never,
        header: { version: 3, id: "native-own-workspace" as never, cwd, createdAt: Date.parse(at), isSeeded: false, agentPreset: "standard", delegationDepth: 0 },
        title: "Instance-owned workspace conversation" };
      await expect(f.engine.registerProjectionRuntimeSession(registration)).rejects.toMatchObject({ code: "SESSION_NOT_SYNCED" });
      // Nothing was enrolled for the instance's own workspace: no Maintenance workspace, binding, session or project.
      expect(countOf(f, "logical_workspaces")).toEqual({ n: 0 });
      expect(countOf(f, "runtime_workspace_bindings")).toEqual({ n: 0 });
      expect(countOf(f, "runtime_workspace_registrations")).toEqual({ n: 0 });
      expect(countOf(f, "logical_sessions")).toEqual({ n: 0 });
      expect(selectionOf(f, request.instanceId)).toEqual({ kind: "ids", workspaceIds: [], includeUnassigned: false });
      // Joining the workspace later does not retroactively widen the scope of a run that already started.
      const joinedId = await joinInstanceWorkspace(f.engine, { instanceId: request.instanceId, cwd });
      await expect(f.engine.registerProjectionRuntimeSession(registration)).rejects.toMatchObject({ code: "SESSION_NOT_SYNCED" });
      expect(selectionOf(f, request.instanceId)).toEqual({ kind: "ids", workspaceIds: [joinedId], includeUnassigned: false });
    } finally { await f.cleanupAll(); }
  });

  it("synchronises only the explicitly joined workspace of the running instance", async () => {
    const f = await createEngineFixture("runtime-joined-local-workspace");
    const request: RuntimeBrokerPrepareRunRequest = {
      schemaVersion: 1, client: { kind: "launcher", id: "fixture-joined-launcher" }, runtimeClientId: "fixture-joined-runtime",
      instanceId: "fixture-joined-runtime", profileId: "web", dshVersion: "0.1.5-rc.2", maintenanceEndpoint: "http://127.0.0.1:41781",
      branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never, projectSelection: { kind: "all" },
      environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES], packageVersions: Object.fromEntries(
        ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].map(name => [name, "0.1.5-rc.2"])) },
    };
    try {
      const joinedCwd = join(f.root, "joined-workspace"), ownCwd = join(f.root, "own-workspace");
      await Promise.all([mkdir(joinedCwd), mkdir(ownCwd)]);
      // The operator explicitly joins one workspace before the run starts.
      const workspaceId = await joinInstanceWorkspace(f.engine, { instanceId: request.instanceId, cwd: joinedCwd });
      expect(selectionOf(f, request.instanceId)).toEqual({ kind: "ids", workspaceIds: [workspaceId], includeUnassigned: false });
      const run = await f.engine.prepareProjectionRuntimeRun(request);
      await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
        temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
      const registered = await f.engine.registerProjectionRuntimeSession({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
        nativeSessionId: "native-joined" as never,
        header: { version: 3, id: "native-joined" as never, cwd: joinedCwd, createdAt: Date.parse(at), isSeeded: false, agentPreset: "standard", delegationDepth: 0 },
        title: "Joined workspace conversation" });
      const membership = f.engine.repository.database.prepare("SELECT workspace_id FROM workspace_memberships WHERE logical_session_id=?").get(registered.logicalSessionId) as { workspace_id: string };
      expect(membership.workspace_id).toBe(workspaceId);
      const event: JsonValue = { seq: 0, time: Date.parse(at), type: "user/message", surfaceOp: "append",
        data: { id: "joined-first-message", role: "user", content: [{ type: "text", text: "first message" }], source: { kind: "user" } } };
      const receipt = await f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, { runId: run.runId, nativeSessionId: "native-joined" as never,
        operationId: "operation-joined-first" as never, nativeRevision: 1, observedAt: at,
        payload: { logicalSessionId: registered.logicalSessionId, canonicalHistoryMode: "native", events: [event] } });
      expect(receipt.status).toBe("committed");
      // A sibling workspace of the same instance is still the instance's own and stays outside the true source.
      await expect(f.engine.registerProjectionRuntimeSession({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
        nativeSessionId: "native-own" as never,
        header: { version: 3, id: "native-own" as never, cwd: ownCwd, createdAt: Date.parse(at), isSeeded: false, agentPreset: "standard", delegationDepth: 0 },
        title: "Instance-owned workspace conversation" })).rejects.toMatchObject({ code: "SESSION_NOT_SYNCED" });
      expect(countOf(f, "logical_sessions")).toEqual({ n: 1 });
      expect(f.engine.repository.database.prepare("SELECT count(*) n FROM logical_workspaces").get()).toEqual({ n: 1 });
    } finally { await f.cleanupAll(); }
  });

  it("registers and persists a joined local workspace through the next scoped startup without changing Codex membership", async () => {
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
      // The operator joins the instance's new local workspace before the run starts; joining appends to the saved selection.
      const workspaceId = await joinInstanceWorkspace(f.engine, { instanceId: request.instanceId, cwd, workspaceId: "workspace-local-new" });
      expect(selectionOf(f, request.instanceId)).toEqual({ kind: "ids", workspaceIds: ["existing-selected", "workspace-local-new"], includeUnassigned: false });
      run = await f.engine.prepareProjectionRuntimeRun(request);
      await mkdir(run.persistenceRoot, { recursive: true });
      await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
      const nativeSessionId = "native-new-workspace" as never;
      const registration = { schemaVersion: 1 as const, clientId: request.runtimeClientId, runId: run.runId, nativeSessionId,
        header: { version: 0, id: nativeSessionId, cwd, createdAt: Date.parse(at), isSeeded: false }, title: "New DSH workspace conversation" };
      const projects = () => f.engine.repository.database.prepare("SELECT count(*) n FROM logical_projects WHERE source_platform='maintenance'").get();
      await expect(f.engine.registerProjectionRuntimeSession({ ...registration, clientId: "another-runtime" })).rejects.toThrow("capability does not match");
      await expect(f.engine.registerProjectionRuntimeSession({ ...registration, header: { ...registration.header, cwd: join(run.persistenceRoot, "unknown-temporary-project") } })).rejects.toThrow("no canonical project root");
      // A refused registration never adds a local project of its own.
      const projectsBeforeRejection = projects();
      expect(projectsBeforeRejection).toEqual({ n: 1 });
      const importFailure = vi.spyOn(f.engine.canonicalEngine, "importDshNative").mockRejectedValueOnce(new Error("synthetic registration interruption"));
      await expect(f.engine.registerProjectionRuntimeSession(registration)).rejects.toThrow("synthetic registration interruption");
      importFailure.mockRestore();
      const registered = await f.engine.registerProjectionRuntimeSession(registration);
      const database = f.engine.repository.database;
      const workspace = database.prepare("SELECT workspace_id FROM workspace_memberships WHERE logical_session_id=?").get(registered.logicalSessionId)!;
      expect(workspace.workspace_id).toBe(workspaceId);
      expect(policies.isWorkspaceSelected(request.instanceId, workspace.workspace_id as never)).toBe(true);
      // Registration itself never edits the saved selection.
      expect(policies.getPolicy(request.instanceId).selection).toEqual({ kind: "ids", workspaceIds: ["existing-selected", "workspace-local-new"], includeUnassigned: false });
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
      // A restart re-applies the Codex mapping scope; a joined local DSH conversation must survive it.
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

it("commits RC2 v3 first-turn events for a joined workspace with unassigned sessions disabled", async () => {
  const f = await createEngineFixture("runtime-v3-created-workspace");
  try {
    const request: RuntimeBrokerPrepareRunRequest = {
      schemaVersion: 1, client: { kind: "launcher", id: "fixture-v3-launcher" }, runtimeClientId: "fixture-v3-runtime",
      instanceId: "fixture-v3", profileId: "web", dshVersion: "0.1.5-rc.2", maintenanceEndpoint: "http://127.0.0.1:41781",
      branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never, projectSelection: { kind: "all" },
      environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES], packageVersions: Object.fromEntries(
        ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].map(name => [name, "0.1.5-rc.2"])) },
    };
    const cwd = join(f.root, "v3-project");
    await mkdir(cwd);
    await joinInstanceWorkspace(f.engine, { instanceId: request.instanceId, cwd });
    const run = await f.engine.prepareProjectionRuntimeRun(request);
    await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
      temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
    const nativeSessionId = "native-v3-created" as never;
    const header = { version: 3, id: nativeSessionId, cwd, createdAt: Date.parse(at), isSeeded: false, agentPreset: "standard", delegationDepth: 0 };
    const registered = await f.engine.registerProjectionRuntimeSession({ schemaVersion: 1, clientId: request.runtimeClientId,
      runId: run.runId, nativeSessionId, header, title: "V3 joined workspace" });
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
