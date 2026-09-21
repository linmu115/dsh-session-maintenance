import { describe, expect, it } from "vitest";
import { REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import type { RuntimeBrokerPrepareRunRequest, SessionContextRecord } from "@linmu/dsh-session-contracts";
import { createEngineFixture, hashTree, joinInstanceWorkspace } from "./helpers.js";
import { contextEvents, contextHeader } from "../../../packages/adapter-dsh-0-1-5/test/context-fixture.js";
import { SessionGraphStore, graphObjectId } from "../src/session-graph-store.js";

const at = "2026-09-15T00:00:00.000Z";
async function setup() {
  const f = await createEngineFixture("graph-archive-rc2");
  const request: RuntimeBrokerPrepareRunRequest = { schemaVersion: 1, client: { kind: "launcher", id: "fixture-launcher" },
    runtimeClientId: "fixture-runtime", instanceId: "fixture-archive-copy", profileId: "web", dshVersion: "0.1.5-rc.2",
    maintenanceEndpoint: "http://127.0.0.1:41781", branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never,
    projectSelection: { kind: "all" }, environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES],
      packageVersions: Object.fromEntries(["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence",
        "@deepseek-ai/dsh-session-format-catalog"].map(name => [name, "0.1.5-rc.2"])) } };
  await joinInstanceWorkspace(f.engine, { instanceId: request.instanceId, cwd: f.root });
  const run = await f.engine.prepareProjectionRuntimeRun(request);
  await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
    temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
  const header = { ...contextHeader, cwd: f.root }, mappings: Record<string, any> = {};
  for (const id of ["source", "target", "unrelated"]) mappings[id] = await f.engine.registerProjectionRuntimeSession({
    schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, nativeSessionId: id as never,
    header: { ...header, id }, title: id });
  const append = (events: any[], operationId: string) => f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, {
    runId: run.runId, nativeSessionId: "source" as never, operationId: operationId as never,
    nativeRevision: events.at(-1).seq + 1, observedAt: at, payload: { logicalSessionId: mappings.source.logicalSessionId,
      instanceId: request.instanceId, header: { ...header, id: "source" }, inheritedEventCount: 0, events } });
  await append(contextEvents(false), "initial");
  const scope = { instanceId: request.instanceId, profileId: "web", namespace: "thoughtdag" };
  f.engine.extensions!.connect({ instanceId: scope.instanceId, profileId: scope.profileId, plugins: [
    { namespace: "annotation-upstream", pluginVersion: "0.3.12-rc2.8", writerId: "dsh-annotation-core" },
    { namespace: "thoughtdag", pluginVersion: "0.4.14-rc2.7", writerId: "dsh-thoughtdag" },
  ] });
  const capture = (operationId: string) => f.engine.sessionContext.capture({ runId: run.runId,
    sourceNativeSessionId: "source", targetNativeSessionId: "target", operationId, anchorId: "reply-one", selectedText: "reply" });
  const graphStore = new SessionGraphStore(f.engine.repository.database);
  const own = await f.engine.sessionGraph.ensure(run.runId, mappings.source.logicalSessionId);
  const server = await f.startServer();
  const post = async (operation: string, input: object = {}, context = false) => {
    const response = await fetch(`${server.origin}/v1/session-${context ? "context" : "graph"}/${operation}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ runId: run.runId, ...input }),
    });
    return { status: response.status, value: await response.json() as any };
  };
  return { ...f, run, mappings, scope, graphStore, own, capture, append, post };
}

describe("session graph archive authority", () => {
  it("revokes source markers atomically and propagates native workspace archive while the graph is closed or disabled", async () => {
    const f = await setup();
    try {
      const homes = await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)]);
      const ref = await f.capture("source-revoke"), targetId = f.mappings.target.logicalSessionId;
      expect((await f.post("revoke-source", { nativeSessionId: "unrelated", referenceId: ref.referenceId })).status).toBe(409);
      expect((await f.post("status", { targetNativeSessionId: "source", referenceId: ref.referenceId }, true)).status).toBe(409);
      expect((await f.post("status", { targetNativeSessionId: "target", referenceId: "missing" }, true)).status).toBe(404);
      expect((await f.post("revoke-source", { nativeSessionId: "source", referenceId: ref.referenceId })).value.state).toBe("revoked");
      const target = f.graphStore.load(f.scope, graphObjectId(targetId));
      expect(target.graph.edges).toEqual([]);
      expect((await f.post("revoke-source", { nativeSessionId: "source", referenceId: ref.referenceId })).value.state).toBe("revoked");
      expect(f.graphStore.load(f.scope, target.objectId).revision).toBe(target.revision);
      const live = await f.capture("before-archive");
      await f.engine.sessionContext.bind(f.run.runId, "target", live.referenceId, "submitted-user");
      f.engine.extensions!.enable(f.scope, false);
      f.engine.extensions!.enable({ ...f.scope, namespace: "annotation-upstream" }, false);
      expect((await f.post("set-session-archived", { nativeSessionId: "source", archived: true, runId: "foreign" })).status).toBe(409);
      const archived = await f.post("set-session-archived", { nativeSessionId: "source", archived: true });
      expect(archived.status, JSON.stringify(archived.value)).toBe(200);
      expect(f.graphStore.reference(f.scope, live.referenceId).record.state).toBe("revoked");
      const ownArchive = f.graphStore.store.get(f.scope, f.own.objectId)!;
      expect(ownArchive.deleted).toBe(true);
      expect(f.graphStore.load(f.scope, target.objectId).graph.edges).toEqual([]);
      const sourceHead = (await f.engine.canonicalEngine.store.getSession(f.mappings.source.logicalSessionId))!.headVersionId;
      expect((await f.post("set-session-archived", { nativeSessionId: "source", archived: true })).status).toBe(200);
      expect((await f.engine.canonicalEngine.store.getSession(f.mappings.source.logicalSessionId))!.headVersionId).toBe(sourceHead);
      expect(f.graphStore.store.get(f.scope, f.own.objectId)!.revision).toBe(ownArchive.revision);
      // A model tail already in flight may still flush after the user archives. It must not undo that archive.
      expect((await f.append(contextEvents().slice(7), "late-model-tail")).status).toBe("committed");
      expect((await f.engine.canonicalEngine.store.getSession(f.mappings.source.logicalSessionId))!.session.archivedAt).not.toBeNull();
      expect(f.graphStore.store.get(f.scope, f.own.objectId)!.deleted).toBe(true);
      f.engine.extensions!.enable(f.scope, true);
      f.engine.extensions!.enable({ ...f.scope, namespace: "annotation-upstream" }, true);
      expect((await f.post("load", { objectId: f.own.objectId })).value.graph.archivedAt).toEqual(expect.any(String));
      expect((await f.post("ensure", { logicalSessionId: f.mappings.source.logicalSessionId })).status).toBe(409);
      expect((await f.post("preview", { logicalSessionId: f.mappings.source.logicalSessionId })).status).toBe(409);
      expect((await f.post("status", { targetNativeSessionId: "target", referenceId: live.referenceId }, true)).value)
        .toEqual({ referenceId: live.referenceId, state: "revoked" });
      await expect(f.engine.sessionContext.inspect(f.run.runId, "target", live.referenceId)).rejects.toThrow("不可用");
      expect((await f.post("set-session-archived", { nativeSessionId: "source", archived: false })).status).toBe(200);
      const restored = await f.post("load", { objectId: f.own.objectId });
      expect(restored.value.graph.archivedAt).toBeNull();
      expect(restored.value.graph.nodes).toEqual(f.own.graph.nodes);
      expect(f.graphStore.reference(f.scope, live.referenceId).record.state).toBe("revoked");
      expect((await f.post("source-markers", { nativeSessionId: "source" })).value.items).toEqual([]);
      expect(await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)])).toEqual(homes);
    } finally { await f.cleanupAll(); }
  }, 60000);
  it("rolls canonical archive metadata back with graph failure and applies direct canonical commits without a UI request", async () => {
    const f = await setup();
    try {
      const ref = await f.capture("atomic"), db = f.engine.repository.database;
      db.exec("CREATE TRIGGER synthetic_archive_failure BEFORE UPDATE ON extension_objects WHEN NEW.namespace='thoughtdag' AND NEW.deleted=1 BEGIN SELECT RAISE(ABORT,'synthetic archive failure'); END");
      await expect(f.engine.sessionCommands.updateSession(f.mappings.source.logicalSessionId, { archived: true })).rejects.toThrow("synthetic archive failure");
      expect((await f.engine.canonicalEngine.store.getSession(f.mappings.source.logicalSessionId))!.session.archivedAt).toBeNull();
      expect(f.graphStore.reference(f.scope, ref.referenceId).record.state).toBe("pending");
      db.exec("DROP TRIGGER synthetic_archive_failure");
      const current = (await f.engine.canonicalEngine.store.getSession(f.mappings.source.logicalSessionId))!;
      await f.engine.canonicalEngine.appendDsh({ logicalSessionId: current.session.id, baseVersionId: current.headVersionId!,
        title: current.session.title, tags: current.session.tags, archivedAt: at, workspaceId: current.workspaceId,
        appendedEvents: [], canonicalHistoryMode: "native", observedAt: at, projection: { runId: f.run.runId,
          leaseId: "synthetic-archive" as never, branchId: "main" as never, adapterId: "dsh-0.1.5" as never,
          nativeSessionId: "source" as never, operationId: "canonical-metadata-archive" as never, nativeRevision: 7 } });
      expect(f.graphStore.reference(f.scope, ref.referenceId).record.state).toBe("revoked");
      expect(f.graphStore.store.get(f.scope, f.own.objectId)!.deleted).toBe(true);
      // The target's pending/sent rows may remain as historical data but never become live again.
      const all = f.graphStore.store.list({ ...f.scope, namespace: "annotation-upstream", deleted: "all" });
      expect(all.items).toHaveLength(1);
      const body = f.graphStore.store.get({ ...f.scope, namespace: "annotation-upstream" }, ref.referenceId)!.content.body as unknown as SessionContextRecord;
      expect(body.targetSessionId).toBe(f.mappings.target.logicalSessionId);
    } finally { await f.cleanupAll(); }
  }, 60000);
});
