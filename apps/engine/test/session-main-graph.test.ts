import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATION_022 } from "../../../packages/session-store/src/migrations/022-extension-data.js";
import { SessionGraphStore } from "../src/session-graph-store.js";
import { thoughtDagAdapter } from "../src/extensions/adapters.js";
import { ExtensionDataService } from "../src/extensions/service.js";
import type { GraphDisclosureInput, SessionContextRecord } from "@linmu/dsh-session-contracts";

const scope = { instanceId: "synthetic-copy", profileId: "web", namespace: "thoughtdag" }, writer = "dsh-thoughtdag";
function fixture(maxEntries = 256, maxBytes = 262144) {
  const db = new DatabaseSync(":memory:"); db.exec(MIGRATION_022);
  const graphs = new SessionGraphStore(db, { maxEntries, maxBytes });
  const reference = (referenceId = "ref-a", sourceSessionId = "X", targetSessionId = "Y") => {
    const record: SessionContextRecord = { schemaVersion: 1, referenceId, sourceSessionId, targetSessionId,
      sourceVersionId: "version-1", cutoffEventId: "event-12", cutoffDigest: "digest-12", sourceAnchorId: "reply-12",
      sourceTitle: "上游", selectedText: "重点", state: "pending", targetMessageId: null, createdAt: "2026-09-14T00:00:00Z" };
    graphs.store.write({ scope: { ...scope, namespace: "annotation-upstream" }, writerId: "annotation", objectId: referenceId,
      expectedRevision: 0, deleted: false, content: { schemaVersion: 1, title: "来源", body: record, references: [] } });
    return record;
  };
  return { db, graphs, reference };
}
const read = (requestId: string): GraphDisclosureInput => ({ requestId, executionId: "execution-1", operation: "read",
  delivery: "prepared", ranges: [{ eventId: "event-5", start: 10, end: 20, complete: false }],
  nextCursor: "opaque-position", next: { eventId: "event-5", offset: 20 }, hasMore: true, truncated: true,
  returnedBytes: 1250, status: "ok" });

describe("session main graph domain", () => {
  it("archives an owner and revokes its source and target permissions across every instance scope without plugin availability", () => {
    const { db, graphs, reference } = fixture();
    try {
      const xOwn = graphs.ensure(scope, writer, "X", "X"), outgoing = reference(), incoming = reference("to-x", "A", "X");
      const y = graphs.syncReference(scope, writer, outgoing, "X", "Y")!;
      graphs.syncReference(scope, writer, incoming, "A", "X");
      const other = { ...scope, instanceId: "another-copy", profileId: "other-profile" };
      graphs.store.write({ scope: { ...other, namespace: "annotation-upstream" }, objectId: outgoing.referenceId, writerId: "annotation",
        expectedRevision: 0, deleted: false, content: { schemaVersion: 1, title: "Another scope", body: outgoing, references: [] } });
      const otherGraph = graphs.syncReference(other, writer, outgoing, "X", "Y")!;
      const unrelated = reference("unrelated", "U", "V"), unrelatedGraph = graphs.syncReference(scope, writer, unrelated, "U", "V")!;
      const archivedAt = "2026-09-15T00:00:00.000Z";
      graphs.reconcileSessionArchive("X", archivedAt);
      expect(graphs.reference(scope, outgoing.referenceId).record.state).toBe("revoked");
      expect(graphs.reference(scope, incoming.referenceId).record.state).toBe("revoked");
      expect(graphs.reference(other, outgoing.referenceId).record.state).toBe("revoked");
      expect(graphs.load(scope, y.objectId).graph.edges).toEqual([]);
      expect(graphs.load(other, otherGraph.objectId).graph.edges).toEqual([]);
      expect(graphs.load(scope, unrelatedGraph.objectId).revision).toBe(unrelatedGraph.revision);
      const archived = graphs.store.get(scope, xOwn.objectId)!;
      expect(archived.deleted).toBe(true);
      expect(graphs.load(scope, xOwn.objectId, true).graph).toMatchObject({ archivedAt, edges: [] });
      expect(() => graphs.ensure(scope, writer, "X", "X")).toThrow("归档");
      expect(() => graphs.save(scope, writer, { objectId: xOwn.objectId, expectedRevision: archived.revision, graph: xOwn.graph })).toThrow("归档");
      const refsRevision = graphs.reference(scope, outgoing.referenceId).object.revision;
      graphs.reconcileSessionArchive("X", archivedAt);
      expect(graphs.store.get(scope, xOwn.objectId)!.revision).toBe(archived.revision);
      expect(graphs.reference(scope, outgoing.referenceId).object.revision).toBe(refsRevision);
      graphs.reconcileSessionArchive("X", null);
      expect(graphs.load(scope, xOwn.objectId).graph).toMatchObject({ archivedAt: null, edges: [] });
      expect(graphs.syncReference(scope, writer, outgoing, "X", "Y")!.graph.edges).toEqual([]);
      expect(() => graphs.save(scope, writer, { objectId: y.objectId,
        expectedRevision: graphs.load(scope, y.objectId).revision, graph: y.graph })).toThrow("解除");
      expect(graphs.store.connections()).toEqual([]);
    } finally { db.close(); }
  });
  it("never restores a separately deleted graph or creates a missing owner graph during archive", () => {
    const { db, graphs } = fixture();
    try {
      const own = graphs.ensure(scope, writer, "X", "X"), object = graphs.store.get(scope, own.objectId)!;
      graphs.store.write({ scope, writerId: writer, objectId: object.objectId, expectedRevision: object.revision,
        deleted: true, content: object.content });
      graphs.reconcileSessionArchive("X", "2026-09-15T00:00:00.000Z");
      graphs.reconcileSessionArchive("X", null);
      expect(graphs.store.get(scope, own.objectId)!.deleted).toBe(true);
      expect(graphs.store.get(scope, own.objectId)!.content.body).not.toHaveProperty("archivedAt");
      graphs.reconcileSessionArchive("missing", "2026-09-15T00:00:00.000Z");
      expect(graphs.store.list(scope).items).toEqual([]);
      expect(graphs.store.list({ ...scope, deleted: "all" }).items).toHaveLength(1);
    } finally { db.close(); }
  });
  it("disconnects draft edges touching an archived card across scopes without moving cards or unrelated draft lines", () => {
    const { db, graphs } = fixture();
    try {
      const graph = { managedSchema: 2 as const, ownerSessionId: null,
        nodes: [
          { id: "x", position: { x: 20, y: 200 }, data: { kind: "session" as const, logicalSessionId: "X", label: "X" } },
          { id: "a", position: { x: 20, y: 0 }, data: { kind: "placeholder" as const, label: "A" } },
          { id: "b", position: { x: 20, y: 400 }, data: { kind: "placeholder" as const, label: "B" } },
        ], edges: [
          { id: "incoming", source: "a", target: "x", data: { kind: "pending" as const } },
          { id: "outgoing", source: "x", target: "b", data: { kind: "pending" as const } },
          { id: "unrelated", source: "a", target: "b", data: { kind: "pending" as const } },
        ] };
      const other = { ...scope, instanceId: "another-copy", profileId: "other-profile" };
      const first = graphs.save(scope, writer, { expectedRevision: 0, graph });
      const second = graphs.save(other, writer, { expectedRevision: 0, graph });
      graphs.reconcileSessionArchive("X", "2026-09-15T00:00:00.000Z");
      for (const [where, before] of [[scope, first], [other, second]] as const) {
        const after = graphs.load(where, before.objectId);
        expect(after.graph.nodes).toEqual(before.graph.nodes);
        expect(after.graph.edges.map(edge => edge.id)).toEqual(["unrelated"]);
        expect(after.graph.ownerSessionId).toBeNull();
        expect(() => graphs.save(where, writer, { objectId: before.objectId, expectedRevision: before.revision, graph: before.graph })).toThrow("其他操作");
      }
      const revision = graphs.load(scope, first.objectId).revision;
      graphs.reconcileSessionArchive("X", "2026-09-15T00:00:00.000Z");
      graphs.reconcileSessionArchive("X", null);
      expect(graphs.load(scope, first.objectId).revision).toBe(revision);
      expect(graphs.load(scope, first.objectId).graph.edges.map(edge => edge.id)).toEqual(["unrelated"]);
      expect(db.prepare("SELECT count(*) n FROM extension_objects WHERE namespace='annotation-upstream'").get()!.n).toBe(0);
    } finally { db.close(); }
  });
  it("rolls back all reference and graph changes when an archive write fails", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference(), own = graphs.ensure(scope, writer, "X", "X"), target = graphs.syncReference(scope, writer, ref, "X", "Y")!;
      db.exec("CREATE TRIGGER synthetic_fail_archive BEFORE UPDATE ON extension_objects WHEN NEW.namespace='thoughtdag' AND NEW.deleted=1 BEGIN SELECT RAISE(ABORT,'synthetic archive disk failure'); END");
      expect(() => graphs.reconcileSessionArchive("X", "2026-09-15T00:00:00.000Z")).toThrow("synthetic archive disk failure");
      expect(graphs.reference(scope, ref.referenceId).record.state).toBe("pending");
      expect(graphs.load(scope, target.objectId).revision).toBe(target.revision);
      expect(graphs.store.get(scope, own.objectId)!.deleted).toBe(false);
    } finally { db.close(); }
  });
  it("creates top-to-bottom reference cards without moving existing parents or the owner on repeat sync", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference(), first = graphs.syncReference(scope, writer, ref, "X", "Y")!;
      const owner = first.graph.nodes.find(node => node.data.logicalSessionId === "Y")!;
      const source = first.graph.nodes.find(node => node.data.logicalSessionId === "X")!;
      expect(source.position.x).toBe(owner.position.x);
      expect(owner.position.y - source.position.y).toBeGreaterThanOrEqual(200);
      expect(graphs.syncReference(scope, writer, ref, "X", "Y")!.graph.nodes).toEqual(first.graph.nodes);
      let current = first;
      for (const id of ["A", "B", "C", "D"])
        current = graphs.syncReference(scope, writer, reference(`ref-${id}`, id), id, "Y")!;
      expect(current.graph.nodes.slice(0, first.graph.nodes.length)).toEqual(first.graph.nodes);
      const parents = current.graph.nodes.filter(node => node.data.logicalSessionId !== "Y");
      expect(parents.every(node => node.position.y < owner.position.y)).toBe(true);
      expect(new Set(parents.map(node => node.position.y)).size).toBe(1);
      for (const [index, node] of parents.entries()) for (const other of parents.slice(index + 1))
        expect(Math.abs(node.position.x - other.position.x)).toBeGreaterThanOrEqual(300);
    } finally { db.close(); }
  });
  it("preserves old manual layouts and places only new sources in a vacant upper slot", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference(), first = graphs.syncReference(scope, writer, ref, "X", "Y")!;
      const manual = graphs.save(scope, writer, { objectId: first.objectId, expectedRevision: first.revision,
        graph: { ...first.graph, nodes: first.graph.nodes.map(node => ({ ...node, position:
          node.data.logicalSessionId === "Y" ? { x: 111, y: 999 } : { x: 1800, y: 80 } })) } });
      const withObstacle = graphs.save(scope, writer, { objectId: manual.objectId, expectedRevision: manual.revision,
        graph: { ...manual.graph, nodes: [...manual.graph.nodes,
          { id: "manual-placeholder", position: { x: 151, y: 749 }, data: { kind: "placeholder", label: "原有卡片" } }] } });
      expect(graphs.syncReference(scope, writer, ref, "X", "Y")!.graph.nodes).toEqual(withObstacle.graph.nodes);
      const added = graphs.syncReference(scope, writer, reference("ref-new", "A"), "A", "Y")!;
      expect(added.graph.nodes.slice(0, withObstacle.graph.nodes.length)).toEqual(withObstacle.graph.nodes);
      const source = added.graph.nodes.find(node => node.data.logicalSessionId === "A")!;
      expect(source.position.y).toBeLessThan(999);
      expect(Math.abs(source.position.x - 151)).toBeGreaterThanOrEqual(300);
      expect(graphs.load(scope, added.objectId).graph.nodes).toEqual(added.graph.nodes);
    } finally { db.close(); }
  });
  it("places a restored receiver below its existing source and a newly bound owner below draft cards", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference(), first = graphs.syncReference(scope, writer, ref, "X", "Y")!;
      const owner = first.graph.nodes.find(node => node.data.logicalSessionId === "Y")!;
      const removed = graphs.remove(scope, writer, { objectId: first.objectId, expectedRevision: first.revision,
        nodeIds: [owner.id], operationId: "remove-receiver" });
      const restored = graphs.syncReference(scope, writer, reference("ref-new"), "X", "Y")!;
      expect(restored.graph.nodes[0]).toEqual(removed.graph.nodes[0]);
      const source = restored.graph.nodes.find(node => node.data.logicalSessionId === "X")!;
      const target = restored.graph.nodes.find(node => node.data.logicalSessionId === "Y")!;
      expect(target.position.x).toBe(source.position.x);
      expect(target.position.y).toBeGreaterThan(source.position.y);
      const draft = graphs.save(scope, writer, { expectedRevision: 0, graph: { managedSchema: 2, ownerSessionId: null,
        nodes: [{ id: "blank", position: { x: 77, y: 888 }, data: { kind: "placeholder", label: "草稿" } }], edges: [] } });
      const bound = graphs.bind(scope, writer, draft.objectId, draft.revision, "Z", "Z");
      expect(bound.graph.nodes[0]).toEqual(draft.graph.nodes[0]);
      expect(bound.graph.nodes[1]!.position.x).toBe(77);
      expect(bound.graph.nodes[1]!.position.y).toBeGreaterThan(888);
    } finally { db.close(); }
  });
  it("ensures one target graph, keeps an upstream's own graph independent and defers native binding", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference(), first = graphs.syncReference(scope, writer, ref, "X", "Y")!;
      expect(graphs.ensure(scope, writer, "Y", "Y").objectId).toBe(first.objectId);
      expect(graphs.syncReference(scope, writer, ref, "X", "Y")!.revision).toBe(first.revision);
      expect(graphs.ensure(scope, writer, "X", "X").graph.edges).toEqual([]);
      const draft = graphs.save(scope, writer, { expectedRevision: 0, graph: { managedSchema: 2, ownerSessionId: null,
        nodes: [{ id: "blank-a", position: { x: 0, y: 0 }, data: { kind: "placeholder", label: "尚未创建" } },
          { id: "blank-b", position: { x: 1, y: 1 }, data: { kind: "placeholder", label: "接收" } }],
        edges: [{ id: "pending", source: "blank-a", target: "blank-b", data: { kind: "pending" } }] } });
      const bound = graphs.bind(scope, writer, draft.objectId, draft.revision, "Y", "Y");
      expect(bound).toMatchObject({ objectId: first.objectId, reused: true, draftObjectId: draft.objectId });
      expect(graphs.load(scope, draft.objectId).graph.ownerSessionId).toBeNull();
      expect(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='logical_sessions'").get()!.n).toBe(0);
    } finally { db.close(); }
  });
  it("atomically revokes selected references, preserves independent references, rejects stale saves and never reimports", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference(), independent = reference("ref-z", "X", "Z");
      const before = graphs.syncReference(scope, writer, ref, "X", "Y")!;
      graphs.syncReference(scope, writer, independent, "X", "Z");
      expect(() => graphs.save(scope, writer, { objectId: before.objectId, expectedRevision: before.revision,
        graph: { ...before.graph, edges: [] } })).toThrow("统一移除");
      const input = { objectId: before.objectId, expectedRevision: before.revision, edgeIds: [before.graph.edges[0]!.id], operationId: "remove-one" };
      expect(() => graphs.remove(scope, writer, { ...input, expectedRevision: 0 })).toThrow("图已变化");
      expect(graphs.reference(scope, ref.referenceId).record.state).toBe("pending");
      const removed = graphs.remove(scope, writer, input);
      expect(removed.graph.edges).toEqual([]);
      expect(graphs.reference(scope, ref.referenceId).record.state).toBe("revoked");
      expect(graphs.reference(scope, independent.referenceId).record.state).toBe("pending");
      expect(graphs.remove(scope, writer, input).revision).toBe(removed.revision);
      expect(graphs.syncReference(scope, writer, ref, "X", "Y")!.graph.edges).toEqual([]);
      expect(() => graphs.save(scope, writer, { objectId: before.objectId, expectedRevision: removed.revision,
        graph: before.graph })).toThrow("解除");
      const ownerNode = removed.graph.nodes.find(n => n.data.logicalSessionId === "Y")!;
      expect(graphs.remove(scope, writer, { objectId: removed.objectId, expectedRevision: removed.revision,
        nodeIds: [ownerNode.id], operationId: "remove-card" }).graph.ownerSessionId).toBe("Y");
    } finally { db.close(); }
  });
  it("rolls back authoritative revocation when the graph write fails", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference(), before = graphs.syncReference(scope, writer, ref, "X", "Y")!;
      db.exec("CREATE TRIGGER synthetic_fail_graph BEFORE UPDATE ON extension_objects WHEN NEW.namespace='thoughtdag' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
      expect(() => graphs.remove(scope, writer, { objectId: before.objectId, expectedRevision: before.revision,
        edgeIds: [before.graph.edges[0]!.id], operationId: "remove-fails" })).toThrow("synthetic disk failure");
      expect(graphs.reference(scope, ref.referenceId).record.state).toBe("pending");
      expect(graphs.load(scope, before.objectId).revision).toBe(before.revision);
    } finally { db.close(); }
  });
  it("keeps legacy mixed graphs intact and never turns knowledge lines into context", () => {
    const { db, graphs, reference } = fixture();
    try {
      const a = reference(), b = reference("ref-z", "X", "Z");
      const nodes = ["X", "Y", "Z"].map((logicalSessionId, i) => ({ id: logicalSessionId, position: { x: i, y: i }, data: { kind: "session", label: logicalSessionId, logicalSessionId } }));
      const original = { managedSchema: 1, nodes, edges: [
        { id: "xy", source: "X", target: "Y", data: { kind: "upstream", namespace: "annotation-upstream", relationId: a.referenceId } },
        { id: "xz", source: "X", target: "Z", data: { kind: "upstream", namespace: "annotation-upstream", relationId: b.referenceId } },
        { id: "yz", source: "Y", target: "Z", data: { kind: "knowledge" } },
      ] };
      graphs.store.write({ scope, writerId: writer, objectId: "old-mixed", expectedRevision: 0, deleted: false,
        content: { schemaVersion: 1, title: "旧图", body: original, references: [] } });
      const loaded = graphs.load(scope, "old-mixed");
      expect(loaded.graph).toMatchObject({ ownerSessionId: null, edges: [], migration: { status: "needs-review" } });
      expect(loaded.graph.legacyEdges).toHaveLength(3);
      const saved = graphs.save(scope, writer, { objectId: loaded.objectId, expectedRevision: loaded.revision, graph: loaded.graph });
      expect(saved.objectId).not.toBe("old-mixed");
      expect(graphs.store.get(scope, "old-mixed")!.content.body).toEqual(original);
    } finally { db.close(); }
  });
  it("stores only bounded positions, deduplicates settlement and keeps layout revision independent", () => {
    const { db, graphs, reference } = fixture(3, 8192);
    try {
      const ref = reference(), doc = graphs.syncReference(scope, writer, ref, "X", "Y")!;
      const first = graphs.appendDisclosure(scope, writer, ref, read("request-1"));
      expect(graphs.appendDisclosure(scope, writer, ref, read("request-1"))).toEqual(first);
      graphs.settleDisclosure(scope, writer, ref, "request-1", "returned");
      graphs.settleDisclosure(scope, writer, ref, "request-1", "returned");
      expect(graphs.disclosures(scope, "Y").items[0]!.delivery).toBe("returned");
      graphs.settleDisclosure(scope, writer, ref, "request-1", "failed");
      expect(graphs.disclosures(scope, "Y").items[0]!.delivery).toBe("failed");
      graphs.appendDisclosure(scope, writer, ref, read("request-2"));
      graphs.settleDisclosure(scope, writer, ref, "request-2", "failed");
      expect(() => graphs.settleDisclosure(scope, writer, ref, "request-2", "returned")).toThrow("取消");
      graphs.appendDisclosure(scope, writer, ref, { ...read("request-3"), ranges: [{ eventId: "event-5", start: 100, end: 110 }] });
      graphs.appendDisclosure(scope, writer, ref, read("request-4"));
      const page = graphs.disclosures(scope, "Y");
      expect(page).toMatchObject({ trimmed: true, trimmedCount: 1, maxEntries: 3, maxBytes: 8192 });
      expect(page.items).toHaveLength(3);
      expect(graphs.load(scope, doc.objectId).revision).toBe(doc.revision);
      expect(JSON.stringify(page)).not.toContain("重点");
      expect(() => graphs.appendDisclosure(scope, writer, ref, { ...read("bad"), text: "FULL TRANSCRIPT" } as any)).toThrow();
      expect(() => graphs.disclosures(scope, "Y", first.receiptId)).toThrow("裁剪");
      const rows = db.prepare("SELECT content_json FROM extension_objects WHERE namespace='thoughtdag'").all();
      expect(rows).toHaveLength(2); // One current layout and one compact log, never per-read snapshots.
      expect(db.prepare("SELECT count(*) n FROM extension_conflicts").get()!.n).toBe(0);
      for (const row of rows) thoughtDagAdapter.validate(JSON.parse(String(row.content_json)));
      const extensions = new ExtensionDataService(graphs.store, [thoughtDagAdapter]);
      extensions.connect({ instanceId: scope.instanceId, profileId: scope.profileId, plugins: [{ namespace: "thoughtdag", pluginVersion: "0.4.14-rc2.5", writerId: writer }] });
      const object = graphs.store.get(scope, doc.objectId)!;
      expect(() => extensions.write({ scope, writerId: writer, objectId: doc.objectId, expectedRevision: doc.revision,
        deleted: true, content: object.content })).toThrow("统一图操作");
    } finally { db.close(); }
  });
  it("pages recent positions without returning all entries or claiming discontinuous gaps were read", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference();
      for (let i = 0; i < 45; i++) graphs.appendDisclosure(scope, writer, ref, { ...read(`request-${i}`),
        ranges: [{ eventId: "event-5", start: i * 100, end: i * 100 + 10 }] });
      const first = graphs.disclosures(scope, "Y"), second = graphs.disclosures(scope, "Y", first.nextCursor!), third = graphs.disclosures(scope, "Y", second.nextCursor!);
      expect([first.items.length, second.items.length, third.items.length]).toEqual([20, 20, 5]);
      expect(third.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.receiptId)).size).toBe(45);
      expect(first.items.flatMap(item => item.ranges).every(range => range.end - range.start === 10)).toBe(true);
      expect(db.prepare("SELECT count(*) n FROM extension_objects WHERE namespace='thoughtdag'").get()!.n).toBe(1);
    } finally { db.close(); }
  });
  it("derives coverage by merging adjacent returned ranges only within the same reference, version and execution", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference();
      for (const [requestId, start, end, delivery, executionId] of [
        ["first", 0, 10, "returned", "execution-1"], ["adjacent", 10, 20, "returned", "execution-1"],
        ["overlap", 5, 15, "returned", "execution-1"], ["gap", 30, 40, "returned", "execution-1"],
        ["prepared", 20, 30, "prepared", "execution-1"], ["failed", 20, 30, "failed", "execution-1"],
        ["other-execution", 20, 30, "returned", "execution-2"],
      ] as const) graphs.appendDisclosure(scope, writer, ref, { ...read(requestId), executionId, delivery,
        ranges: [{ eventId: "event-5", start, end }] });
      const page = graphs.disclosures(scope, "Y");
      expect(page.items).toHaveLength(7);
      expect(page.coverage).toEqual([
        { referenceId: "ref-a", sourceVersionId: "version-1", executionId: "execution-1", eventId: "event-5", ranges: [{ start: 0, end: 20 }, { start: 30, end: 40 }] },
        { referenceId: "ref-a", sourceVersionId: "version-1", executionId: "execution-2", eventId: "event-5", ranges: [{ start: 20, end: 30 }] },
      ]);
      expect(page.coverageTruncated).toBe(false);
    } finally { db.close(); }
  });
  it("reports missing or trimmed acknowledgements without inventing delivery or blocking independent reads", () => {
    const { db, graphs, reference } = fixture(1);
    try {
      const ref = reference();
      expect(graphs.settleDisclosure(scope, writer, ref, "while-disabled", "returned"))
        .toEqual({ recorded: false, reason: "not-recorded-or-trimmed" });
      expect(db.prepare("SELECT count(*) n FROM extension_objects WHERE namespace='thoughtdag'").get()!.n).toBe(0);
      graphs.appendDisclosure(scope, writer, ref, read("first"));
      graphs.appendDisclosure(scope, writer, ref, read("next"));
      expect(graphs.settleDisclosure(scope, writer, ref, "first", "returned"))
        .toEqual({ recorded: false, reason: "not-recorded-or-trimmed" });
      expect(graphs.settleDisclosure(scope, writer, ref, "next", "returned")).toEqual({ recorded: true });
      expect(graphs.disclosures(scope, "Y").items.map(item => item.requestId)).toEqual(["next"]);
      expect(graphs.disclosures(scope, "Y").trimmedCount).toBe(1);
    } finally { db.close(); }
  });
  it("still rejects ambiguous acknowledgement identities and propagates real receipt write failures", () => {
    const { db, graphs, reference } = fixture();
    try {
      const ref = reference();
      graphs.appendDisclosure(scope, writer, ref, read("same"));
      graphs.appendDisclosure(scope, writer, ref, { ...read("same"), executionId: "other-execution" });
      expect(() => graphs.settleDisclosure(scope, writer, ref, "same", "returned")).toThrow("身份不唯一");
      graphs.appendDisclosure(scope, writer, ref, read("write-failure"));
      db.exec("CREATE TRIGGER synthetic_receipt_write_failure BEFORE UPDATE ON extension_objects WHEN NEW.namespace='thoughtdag' BEGIN SELECT RAISE(ABORT,'synthetic receipt disk failure'); END");
      expect(() => graphs.settleDisclosure(scope, writer, ref, "write-failure", "returned")).toThrow("synthetic receipt disk failure");
      expect(graphs.disclosures(scope, "Y").items.find(item => item.requestId === "write-failure")!.delivery).toBe("prepared");
    } finally { db.close(); }
  });
});
