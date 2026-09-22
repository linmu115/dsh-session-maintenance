import { attachLynnExtensionService, lynnExtensionHooks } from "../src/adapters/lynn/composition.js";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureSandbox } from "../../../packages/test-support/src/index.js";
import { openMaintenanceDatabase, SqliteExtensionRepository } from "@linmu/dsh-session-store";
import { annotationMirrorSyncSchema, type AnnotationMirrorSync, type ExtensionDirectoryObject, type ExtensionWrite, type JsonValue } from "@linmu/dsh-session-contracts";
import { ExtensionDataService } from "../src/extensions/service.js";
import { builtInExtensionAdapters } from "../src/extensions/adapters.js";
import { SessionGraphStore, graphObjectId } from "../src/session-graph-store.js";
import type { SessionMaintenanceEngine } from "../src/engine.js";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { createEngineFixture, hashTree, joinInstanceWorkspace } from "./helpers.js";
import { REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import { contextHeader } from "../../../packages/adapter-dsh-0-1-5/test/context-fixture.js";
import type { RuntimeBrokerPrepareRunRequest } from "@linmu/dsh-session-contracts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scope = { instanceId: "copy", profileId: "web" };
const plugins = [
  { namespace: "annotation-upstream", pluginVersion: "0.3.12-rc2.10", writerId: "dsh-annotation-core" },
  { namespace: "annotation-records", pluginVersion: "0.3.12-rc2.10", writerId: "dsh-annotation-core" },
  { namespace: "stickers", pluginVersion: "0.7.3-rc2.16", writerId: "dsh-session-sticker-board" },
  { namespace: "obsidian-links", pluginVersion: "0.6.4-rc2.6", writerId: "obsidian-deepharness-bridge" },
  { namespace: "thoughtdag", pluginVersion: "0.4.14-rc2.8", writerId: "dsh-thoughtdag" },
];
async function fixture() {
  const f = await createFixtureSandbox("extension-owner-directory"), db = openMaintenanceDatabase(join(f.root, "index.sqlite"));
  cleanup.push(async () => { db.close(); await f.cleanup(); });
  const store = new SqliteExtensionRepository(db), service = new ExtensionDataService(store, builtInExtensionAdapters, undefined, lynnExtensionHooks(store));
  attachLynnExtensionService(service, store);
  service.connect({ ...scope, plugins });
  for (const id of ["source", "target"]) db.prepare("INSERT INTO logical_sessions(id,display_title,sync_mode,archived,labels_json,created_at) VALUES(?,?,'continuation',0,'[]','2026-09-15')").run(id, id === "source" ? "来源会话" : "接收会话");
  db.exec("INSERT INTO logical_workspaces VALUES('parent',NULL,'原始目录','a',NULL,'2026-09-15','2026-09-15'); INSERT INTO logical_workspaces VALUES('work','parent','子工作区','b',NULL,'2026-09-15','2026-09-15'); INSERT INTO workspace_memberships VALUES('target','work',0,0,0,0)");
  const write = (namespace: string, objectId: string, body: JsonValue, options: Partial<ExtensionWrite> = {}) => service.write({
    scope: { ...scope, namespace }, writerId: plugins.find(p => p.namespace === namespace)!.writerId,
    objectId, expectedRevision: 0, deleted: false, content: { schemaVersion: namespace === "obsidian-links" ? 2 : 1, title: objectId, body,
      references: [{ logicalSessionId: "source" }, { logicalSessionId: "target" }] }, ...options,
  });
  const fake = { projectionRunRepository: { getProjectionRun: async (id: string) => id === "run" ? { id, ...scope, state: "running" } : undefined },
    sessionGraph: { resolve: async (_run: string, input: { nativeSessionId: string }) => {
      const id = ({ "native-target": "target", "native-source": "source" } as Record<string, string>)[input.nativeSessionId];
      if (!id) throw new Error("missing mapping"); return { logicalSessionId: id, nativeSessionId: input.nativeSessionId, title: id };
    } },
  } as unknown as SessionMaintenanceEngine;
  return { db, store, service, write, fake };
}
function upstream() { return { schemaVersion: 1, referenceId: "upstream-one", sourceSessionId: "source", sourceVersionId: "version-one",
  cutoffEventId: "event-one", cutoffDigest: "digest", targetSessionId: "target", selectedText: "重点", sourceTitle: "来源", sourceAnchorId: "anchor-one",
  state: "sent", targetMessageId: "message-one", createdAt: "2026-09-15" }; }
const query = { ...scope, adapterId: "lynn" };
const entry = (referenceId = "reference-one"): AnnotationMirrorSync["entries"][number] => ({ referenceId, setId: "set-one", sourceType: "dsh-message",
  state: "pending", selectedText: "重点", userComment: "注释", source: { nativeSessionId: "native-source", title: "来源" } });
const sync = (entries = [entry()], sourceRevision = 1): AnnotationMirrorSync => ({ runId: "run", nativeSessionId: "native-target", sourceRevision, entries });

describe("business extension directory", () => {
  it("groups namespaces without changing their writer/version permissions and uses explicit target ownership", async () => {
    const f = await fixture(); f.write("annotation-upstream", "upstream-one", upstream());
    f.write("stickers", "sticker", { kind: "session", logicalSessionId: "target", source: { logicalSessionId: "source", sourceVersionId: "version-one", sourceAnchorId: "anchor-one" } });
    const panels = f.service.businessPanels(scope);
    expect(panels.map(p => p.adapterId).sort()).toEqual(["lynn"]);
    expect(panels.find(p => p.adapterId === "lynn")).toMatchObject({ status: "ready", objectCount: 2 });
    expect(f.service.directory({ ...query, level: "workspaces" }).items).toEqual([expect.objectContaining({ id: "work", label: "原始目录 / 子工作区", count: 2 })]);
    expect(f.service.directory({ ...query, level: "sessions", workspaceId: "work" }).items).toEqual([expect.objectContaining({ id: "target", count: 2 })]);
    const objects = f.service.directory({ ...query, level: "objects", ownerSessionId: "target" });
    expect(objects.items).toHaveLength(2); expect(JSON.stringify(objects)).not.toContain('"content"');
    expect(f.service.directory({ ...query, level: "objects", ownerSessionId: "source" }).items).toHaveLength(0);
    f.service.enable({ ...scope, namespace: "stickers" }, false);
    expect(f.service.businessPanels(scope).find(p => p.adapterId === "lynn")?.status).toBe("partial");
    expect(f.service.directory({ ...query, level: "objects", ownerSessionId: "target" }).items).toContainEqual(expect.objectContaining({ objectId: "sticker", readOnly: true, unavailableReason: "会话贴纸：已停用" }));
  });
  it("rebuilds the disposable index without touching object versions and follows native workspace moves and membership archives", async () => {
    const f = await fixture(); f.write("annotation-upstream", "upstream-one", upstream());
    const before = f.db.prepare("SELECT * FROM extension_objects").all();
    f.service.rebuildOwnerIndex(scope, ["annotation-upstream"]);
    f.db.exec("DELETE FROM extension_object_owners; UPDATE workspace_memberships SET workspace_id=NULL,archived=1,revision=1 WHERE logical_session_id='target'");
    const workspaces = f.service.directory({ ...query, level: "workspaces" });
    expect(workspaces.items).toEqual([expect.objectContaining({ id: "@ungrouped", archived: false })]);
    expect(f.service.directory({ ...query, level: "sessions", workspaceId: "@ungrouped" }).items).toContainEqual(expect.objectContaining({ id: "target", archived: true }));
    expect(f.service.directory({ ...query, level: "objects", ownerSessionId: "target" }).items).toContainEqual(expect.objectContaining({ archived: true, readOnly: true }));
    expect(f.db.prepare("SELECT * FROM extension_objects").all()).toEqual(before);
  });
  it("keeps old multiple-target objects unbound and puts disclosure logs under the owning graph only", async () => {
    const f = await fixture();
    f.service.write({ scope: { ...scope, namespace: "thoughtdag" }, objectId: "old", expectedRevision: 0, writerId: "dsh-thoughtdag", deleted: false,
      content: { schemaVersion: 1, title: "old", body: { nodes: [], edges: [] }, references: [{ logicalSessionId: "source" }, { logicalSessionId: "target" }] } });
    const graphs = new SessionGraphStore(f.db), graph = graphs.ensure({ ...scope, namespace: "thoughtdag" }, "dsh-thoughtdag", "target", "主干");
    f.store.write({ scope: { ...scope, namespace: "thoughtdag" }, objectId: "log", expectedRevision: 0, writerId: "dsh-thoughtdag", deleted: false,
      content: { schemaVersion: 2, title: "读取记录", body: { kind: "disclosure-log", managedSchema: 2, ownerSessionId: "target", graphObjectId: graph.objectId, trimmed: false, trimmedCount: 0, items: [] }, references: [] } });
    const q = { ...scope, adapterId: "lynn" };
    expect(f.service.businessPanels(scope).find(p => p.adapterId === "lynn")?.objectCount).toBe(2);
    expect(f.service.directory({ ...q, level: "objects", ownerSessionId: "target" }).items).toEqual([expect.objectContaining({ objectId: graph.objectId, count: 1 })]);
    expect(f.service.directory({ ...q, level: "objects", ownerSessionId: "target", parentObjectId: graph.objectId, deleted: "all" }).items).toEqual([expect.objectContaining({ objectId: "log", readOnly: true })]);
    expect(f.service.directory({ ...q, level: "objects", ownerSessionId: "@unbound" }).items).toEqual([expect.objectContaining({ objectId: "old", ownerSessionId: null })]);
    f.db.exec("UPDATE logical_sessions SET archived=1,archived_at='2026-09-15T00:00:00.000Z' WHERE id='target'");
    graphs.reconcileSessionArchive("target", "2026-09-15T00:00:00.000Z");
    expect(f.service.directory({ ...q, level: "objects", ownerSessionId: "target", deleted: "deleted" }).items).toContainEqual(expect.objectContaining({ objectId: graphObjectId("target"), archived: true, deleted: true }));
    expect(f.service.directory({ ...q, level: "objects", ownerSessionId: "target", parentObjectId: graph.objectId, deleted: "all" }).items).toHaveLength(1);
  });
  it("paginates across namespaces with bound cursors and isolates instance/profile filters", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) f.write("stickers", `sticker-${i}`, { kind: "session", logicalSessionId: "target" });
    const other = { instanceId: "other", profileId: "web" }; f.service.connect({ ...other, plugins });
    f.write("stickers", "foreign", { kind: "session", logicalSessionId: "target" }, { scope: { ...other, namespace: "stickers" } });
    const first = f.service.directory({ ...query, level: "objects", ownerSessionId: "target", limit: 2 });
    const second = f.service.directory({ ...query, level: "objects", ownerSessionId: "target", limit: 2, after: first.nextCursor! });
    expect([...first.items, ...second.items].map(row => row.id)).toEqual(["stickers/sticker-0", "stickers/sticker-1", "stickers/sticker-2"]);
    expect(second.nextCursor).toBeNull();
    expect(() => f.service.directory({ ...query, level: "objects", ownerSessionId: "source", after: first.nextCursor! })).toThrow("游标");
    expect(() => f.service.directory({ ...query, profileId: "absent", level: "workspaces" })).toThrow("未接入");
    expect(f.service.businessPanels({ instanceId: "other" }).every(p => p.scope.instanceId === "other")).toBe(true);
  });
});

describe("Annotation metadata mirrors", () => {
  it("moves a submitted mirror only after message verification and accepts an identical restored export", async () => {
    const f = await fixture();
    await f.service.syncAnnotation(sync(), f.fake);
    f.fake.resolveStableReference = async () => ({ status: "resolved", logicalSessionId: "source" }) as any;
    const submitted = { ...entry(), state: "sent" as const, targetMessageId: "message" };
    const moved = await f.service.syncAnnotation(sync([submitted], 4), f.fake);
    expect(moved.items[0]?.status).toBe("saved");
    // Read using the fixture scope from the saved object metadata.
    const previous = f.service.directory({ ...query, level: "objects", ownerSessionId: "target" });
    expect(previous.items).toHaveLength(0);
    expect(f.service.directory({ ...query, level: "objects", ownerSessionId: "source" }).items).toHaveLength(1);
    expect((await f.service.syncAnnotation(sync([submitted], 1), f.fake)).items[0]?.status).toBe("unchanged");
    f.fake.resolveStableReference = async () => ({ status: "unavailable", logicalSessionId: null }) as any;
    expect((await f.service.syncAnnotation(sync([{ ...submitted, referenceId: "unresolved" }]), f.fake)).items[0]?.status).toBe("deferred");
  });

  it("resolves native identities on Engine, fences old revisions and supports idempotent pages without deleting absent entries", async () => {
    const f = await fixture(); const first = await f.service.syncAnnotation(sync(), f.fake);
    expect(first.items[0]).toMatchObject({ status: "saved", sourceRevision: 1 });
    expect((await f.service.syncAnnotation(sync(), f.fake)).items[0]).toMatchObject({ status: "unchanged", revision: first.items[0]!.revision });
    const second = await f.service.syncAnnotation(sync([entry("reference-two")]), f.fake);
    expect(second.items[0]?.status).toBe("saved");
    expect(f.service.directory({ ...query, level: "objects", ownerSessionId: "target" }).items).toHaveLength(2);
    const updated = await f.service.syncAnnotation(sync([{ ...entry(), userComment: "new" }], 2), f.fake);
    expect(updated.items[0]?.status).toBe("saved");
    expect((await f.service.syncAnnotation(sync(), f.fake)).items[0]?.status).toBe("stale");
    expect((await f.service.syncAnnotation(sync([{ ...entry(), userComment: "conflict" }], 2), f.fake)).items[0]?.status).toBe("conflict");
    const object = f.store.get({ ...scope, namespace: "annotation-records" }, first.items[0]!.objectId)!;
    expect(object.content.body).toMatchObject({ targetSessionId: "target", source: { logicalSessionId: "source" }, userComment: "new" });
    expect(() => f.service.write({ scope: object.scope, objectId: object.objectId, writerId: object.writerId, deleted: false,
      content: object.content, expectedRevision: object.revision })).toThrow("只读镜像");
  });
  it("uses positive tombstones and keeps upstream identity for deduplication without changing authority", async () => {
    const f = await fixture(); f.write("annotation-upstream", "upstream-one", upstream());
    const item = { ...entry(), source: { ...entry().source, upstreamReferenceId: "upstream-one" } };
    const first = await f.service.syncAnnotation(sync([item]), f.fake);
    expect(f.service.businessPanels(scope).find(p => p.adapterId === "lynn")?.objectCount).toBe(1);
    expect(f.service.directory({ ...query, level: "objects", ownerSessionId: "target" }).items.map(i => (i as ExtensionDirectoryObject).scope.namespace)).toEqual(["annotation-upstream"]);
    const deleted = { ...item, state: "deleted" as const, selectedText: "", userComment: "", source: {} };
    expect((await f.service.syncAnnotation(sync([deleted], 2), f.fake)).items[0]?.status).toBe("saved");
    expect(f.store.get({ ...scope, namespace: "annotation-records" }, first.items[0]!.objectId)).toMatchObject({ deleted: true, content: { body: { source: { upstreamReferenceId: "upstream-one" } } } });
    const unknown = await f.service.syncAnnotation(sync([{ ...deleted, referenceId: "unknown" }], 3), f.fake);
    expect(f.store.get({ ...scope, namespace: "annotation-records" }, unknown.items[0]!.objectId)?.deleted).toBe(true);
    expect((await f.service.syncAnnotation(sync([entry("unknown")], 2), f.fake)).items[0]?.status).toBe("stale");
    expect(f.store.get({ ...scope, namespace: "annotation-upstream" }, "upstream-one")?.content.body).toEqual(upstream());
  });
  it("rejects injected logical targets/full snapshots and retries unresolved mapping without publishing an unowned record", async () => {
    const f = await fixture();
    expect(annotationMirrorSyncSchema.safeParse({ ...sync(), targetSessionId: "source" }).success).toBe(false);
    expect(annotationMirrorSyncSchema.safeParse(sync([{ ...entry(), source: { logicalSessionId: "source" } } as never])).success).toBe(false);
    expect(annotationMirrorSyncSchema.safeParse(sync([{ ...entry(), snapshot: "full document" } as never])).success).toBe(false);
    await expect(f.service.syncAnnotation({ ...sync(), nativeSessionId: "not-mapped" }, f.fake)).rejects.toThrow("missing mapping");
    expect((await f.service.syncAnnotation(sync([{ ...entry(), source: { nativeSessionId: "not-mapped" } }]), f.fake)).items[0]?.status).toBe("deferred");
    expect(f.store.list({ ...scope, namespace: "annotation-records" }).items).toHaveLength(0);
  });
  it("keeps mirror writer/version boundaries and refuses oversized export pages", async () => {
    const f = await fixture();
    expect(annotationMirrorSyncSchema.safeParse(sync(Array.from({ length: 51 }, (_, i) => entry(`ref-${i}`)))).success).toBe(false);
    f.service.connect({ ...scope, plugins: plugins.map(p => p.namespace === "annotation-records" ? { ...p, pluginVersion: "999" } : p) });
    await expect(f.service.syncAnnotation(sync(), f.fake)).rejects.toThrow("尚未启用兼容");
    f.service.connect({ ...scope, plugins });
    f.service.enable({ ...scope, namespace: "annotation-records" }, false);
    await expect(f.service.syncAnnotation(sync(), f.fake)).rejects.toThrow("尚未启用兼容");
    expect(f.store.list({ ...scope, namespace: "annotation-records" }).items).toHaveLength(0);
  });
  it("serves the new authenticated SDK routes and leaves synthetic native homes unchanged", async () => {
    const f = await createEngineFixture("extension-directory-http"); cleanup.push(f.cleanupAll);
    const before = await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)]);
    const server = await f.startServer(), client = new MaintenanceClient({ origin: server.origin, token: server.token });
    await client.connectExtensions({ instanceId: "codex-fixture", profileId: "web", plugins });
    const panels = await client.listExtensionBusinessPanels({ instanceId: "codex-fixture" });
    expect(panels).toHaveLength(1); expect(panels.every(p => p.instanceLabel === "Codex fixture")).toBe(true);
    expect(await client.listExtensionDirectory({ instanceId: "codex-fixture", profileId: "web", adapterId: "lynn", level: "workspaces" })).toMatchObject({ items: [] });
    const denied = await fetch(server.origin + "/v1/extensions/directory?instanceId=codex-fixture&profileId=web&adapterId=obsidian-series&level=workspaces");
    expect(denied.status).toBe(401); await denied.arrayBuffer();
    await expect(client.syncAnnotationMirror(sync())).rejects.toThrow();
    const request: RuntimeBrokerPrepareRunRequest = { schemaVersion: 1, client: { kind: "launcher", id: "mirror-fixture-launcher" },
      runtimeClientId: "mirror-fixture-runtime", instanceId: "mirror-fixture-rc2", profileId: "web", dshVersion: "0.1.5-rc.2",
      maintenanceEndpoint: server.origin, branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never,
      projectSelection: { kind: "all" }, environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES],
        packageVersions: Object.fromEntries(["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].map(name => [name, "0.1.5-rc.2"])) } };
    await joinInstanceWorkspace(f.engine, { instanceId: request.instanceId, cwd: f.root });
    const run = await f.engine.prepareProjectionRuntimeRun(request);
    await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
      temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: "2026-09-15T00:00:00Z", nativeMode: run.nativeMode });
    for (const id of ["native-source", "native-target"]) await f.engine.registerProjectionRuntimeSession({ schemaVersion: 1,
      clientId: request.runtimeClientId, runId: run.runId, nativeSessionId: id as never, header: { ...contextHeader, id, cwd: f.root }, title: id });
    await client.connectExtensions({ instanceId: request.instanceId, profileId: "web", plugins });
    const successful = await client.syncAnnotationMirror({ ...sync(), runId: run.runId });
    expect(successful.items[0]?.status).toBe("saved");
    expect((await client.syncAnnotationMirror({ ...sync(), runId: run.runId })).items[0]?.status).toBe("unchanged");
    const detail = await client.getExtensionObject({ instanceId: request.instanceId, profileId: "web", namespace: "annotation-records" }, successful.items[0]!.objectId);
    const resolved = await f.engine.sessionGraph.resolve(run.runId, { nativeSessionId: "native-target" });
    expect(detail.object.content.body).toMatchObject({ targetSessionId: resolved.logicalSessionId });
    expect(resolved.logicalSessionId).not.toBe("native-target");
    expect(await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)])).toEqual(before);
  });
});
