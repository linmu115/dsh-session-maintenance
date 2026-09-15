import { describe, expect, it, vi } from "vitest";
import { nativeContextFixture } from "./native-context-fixture.js";

describe("native context with the actual Engine and authenticated HTTP", () => {
  it("requires the native capability, keeps one business owner, and rejects generic context editing", async () => {
    const f = await nativeContextFixture();
    try {
      expect((await f.post("status", {}, { auth: false })).status).toBe(401);
      const doc = await f.status(); expect(doc.ownerSessionId).toBe(f.mappings["target-native"].logicalSessionId); expect(doc.sources).toHaveLength(1);
      const written = await f.mutate("source-set", { referenceId: f.ref.referenceId, enabled: false }); expect(written.status, JSON.stringify(written.body)).toBe(200);
      const object = f.engine.extensions!.get(f.extensionScope, doc.objectId).object;
      const panels = f.engine.extensions!.businessPanels({ instanceId: f.extensionScope.instanceId, profileId: f.extensionScope.profileId });
      expect(panels.map(panel => panel.adapterId).sort()).toEqual(["obsidian-series", "thoughtdag"]);
      expect(panels.find(panel => panel.adapterId === "obsidian-series")?.members.some(member => member.scope.namespace === "annotation-context")).toBe(true);
      expect(() => f.engine.extensions!.write({ scope: f.extensionScope, objectId: object.objectId, writerId: object.writerId, expectedRevision: object.revision, deleted: false, content: object.content })).toThrow();
      const other = await f.post("window-set", { targetNativeSessionId: "foreign-native", referenceId: f.ref.referenceId, ranges: null, expectedRevision: 0, operationId: "foreign-ref" }); expect(other.status).toBe(409);
      f.engine.extensions!.enable(f.extensionScope, false); expect((await f.post("status")).status).toBe(409);
      expect((await f.read({ executionId: "disabled-paused-source" })).status).toBe(409);
    } finally { await f.close(); }
  });

  it("uses stable request ranges, excludes future requests, and refuses stale paused/restored cursors", async () => {
    const f = await nativeContextFixture();
    try {
      const requestPage = await f.post("requests", { referenceId: f.ref.referenceId, limit: 1 }); expect(requestPage.status, JSON.stringify(requestPage.body)).toBe(200);
      expect(requestPage.body.items[0].text).toBe("REQUEST-1"); expect(JSON.stringify(requestPage.body)).not.toMatch(/ANSWER-|RUNTIME-INJECTION|REQUEST-[56]/);
      const all = await f.post("requests", { referenceId: f.ref.referenceId, limit: 25 }); expect(all.body.items).toHaveLength(4);
      const rows = all.body.items, ranges = [rows[1].location, rows[3].location].map(({ startEventId, endEventId }: any) => ({ startEventId, endEventId }));
      const window = await f.mutate("window-set", { referenceId: f.ref.referenceId, ranges }); expect(window.status, JSON.stringify(window.body)).toBe(200); expect(window.body.sources[0].cutoffEventId).toBe(f.ref.cutoffEventId);
      const content = await f.read(); expect(content.status, JSON.stringify(content.body)).toBe(200); expect(JSON.stringify(content.body)).toContain("ANSWER-2-"); expect(JSON.stringify(content.body)).toContain("ANSWER-4-"); expect(JSON.stringify(content.body)).not.toMatch(/ANSWER-[1356]-/);
      expect((await f.mutate("window-set", { referenceId: f.ref.referenceId, ranges: [{ startEventId: rows[0].eventId, endEventId: "not-authorized-future" }] })).status).toBe(409);
      expect((await f.mutate("source-set", { referenceId: f.ref.referenceId, enabled: false })).status).toBe(200);
      expect((await f.read({ executionId: "paused-read" })).status).toBe(409);
      expect((await f.post("requests", { referenceId: f.ref.referenceId, cursor: requestPage.body.nextCursor })).status).toBe(409);
      expect((await f.mutate("source-set", { referenceId: f.ref.referenceId, enabled: true })).status).toBe(200);
      expect((await f.post("requests", { referenceId: f.ref.referenceId, cursor: requestPage.body.nextCursor })).status).toBe(409);
    } finally { await f.close(); }
  });

  it("rechecks a source paused while recording disclosure before returning the page without refunding consumed bytes", async () => {
    const f = await nativeContextFixture();
    try {
      const append = f.engine.sessionGraph.appendDisclosure.bind(f.engine.sessionGraph);
      const hook = vi.spyOn(f.engine.sessionGraph, "appendDisclosure").mockImplementationOnce(async (...args) => {
        const receipt = await append(...args);
        const scope = { ...f.scope, actor: "user" as const };
        const before = await f.engine.nativeContext.status(scope);
        const paused = await f.engine.nativeContext.sourceSet({ ...scope, expectedRevision: before.revision,
          operationId: "pause-inside-disclosure", referenceId: f.ref.referenceId, enabled: false });
        expect(paused.sources.find(source => source.referenceId === f.ref.referenceId)?.enabled).toBe(false);
        return receipt;
      });
      const page = await f.read({ executionId: "pause-during-disclosure" });
      expect(hook).toHaveBeenCalledOnce();
      expect(page.status, JSON.stringify(page.body)).toBe(409);
      expect(JSON.stringify(page.body)).toMatch(/暂停|披露窗口/);
      expect(JSON.stringify(page.body)).not.toContain("ANSWER-");
      const used = f.engine.repository.database.prepare("SELECT sum(used_bytes) used FROM context_read_executions WHERE run_id=?").get(f.run.runId)!;
      expect(Number(used.used)).toBeGreaterThan(0);
      hook.mockRestore();
    } finally { await f.close(); }
  });

  it("user preview uses an exact request pair without AI budget, model material claims or disclosure receipts", async () => {
    const f = await nativeContextFixture();
    try {
      const page = await f.post("requests", { referenceId: f.ref.referenceId, limit: 25 }); const selected = page.body.items[2];
      const graph = await f.engine.sessionGraph.ensure(f.run.runId, f.mappings["target-native"].logicalSessionId);
      const beforeLogs = await f.engine.sessionGraph.disclosures(f.run.runId, graph.objectId);
      const budgets = () => f.engine.repository.database.prepare("SELECT count(*) n FROM context_read_executions WHERE run_id=?").get(f.run.runId)!.n;
      const beforeBudget = budgets();
      const preview = await f.post("user-read", { referenceId: f.ref.referenceId, userRequestId: selected.requestId });
      expect(preview.status, JSON.stringify(preview.body)).toBe(200); expect(preview.body.items.map((item: any) => item.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(preview.body)).toContain("REQUEST-3"); expect(JSON.stringify(preview.body)).toContain("ANSWER-3-"); expect(JSON.stringify(preview.body)).not.toMatch(/ANSWER-[12456]-|RUNTIME-INJECTION/);
      expect(budgets()).toBe(beforeBudget); expect((await f.status()).materials).toEqual([]); expect(await f.engine.sessionGraph.disclosures(f.run.runId, graph.objectId)).toEqual(beforeLogs);
      expect((await f.post("user-read", { actor: "model", referenceId: f.ref.referenceId, userRequestId: selected.requestId })).status).toBe(403);
    } finally { await f.close(); }
  });

  it("scopes graph changes to its owner, preserves the anchor, and revoked references cannot be resumed", async () => {
    const f = await nativeContextFixture();
    try {
      let graph = await f.engine.sessionGraph.ensure(f.run.runId, f.mappings["target-native"].logicalSessionId);
      const owner = graph.graph.nodes.find(node => node.data.logicalSessionId === f.mappings["target-native"].logicalSessionId)!;
      expect((await f.mutate("graph-edit", { action: "remove-node", nodeId: owner.id, graphRevision: graph.revision })).status).toBe(409);
      const placeholder = await f.mutate("graph-edit", { action: "add-placeholder", label: "temporary card", graphRevision: graph.revision }); expect(placeholder.status, JSON.stringify(placeholder.body)).toBe(200);
      graph = placeholder.body.graph;
      const node = graph.graph.nodes.find(value => value.data.label === "temporary card")!;
      expect((await f.mutate("graph-edit", { action: "rename", nodeId: "node-from-other-graph", label: "forged", graphRevision: graph.revision })).status).toBe(409);
      expect((await f.mutate("graph-edit", { action: "rename", nodeId: node.id, label: "renamed card", graphRevision: graph.revision })).status).toBe(200);
      graph = await f.engine.sessionGraph.load(f.run.runId, graph.objectId);
      const reverseGraph = await f.engine.sessionGraph.ensure(f.run.runId, f.mappings["source-native"].logicalSessionId);
      const targetPreview = await f.engine.sessionGraph.preview(f.run.runId, f.mappings["target-native"].logicalSessionId);
      const reverse = await f.post("graph-edit", { targetNativeSessionId: "source-native", expectedRevision: 0, operationId: "reject-cycle", graphRevision: reverseGraph.revision, action: "connect", sourceNativeSessionId: "target-native", sourceVersionId: targetPreview.sourceVersionId, sourceAnchorId: targetPreview.capture.anchorId });
      expect(reverse.status, JSON.stringify(reverse.body)).toBe(409); expect(JSON.stringify(reverse.body)).toMatch(/循环|cycle/i);
      const removed = await f.mutate("graph-edit", { action: "disconnect", referenceId: f.ref.referenceId, graphRevision: graph.revision }); expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body.graph.graph.edges).toHaveLength(0); expect((await f.read()).status).toBe(409);
      expect((await f.mutate("source-set", { referenceId: f.ref.referenceId, enabled: true })).status).toBe(409);
    } finally { await f.close(); }
  });

  it("persists metadata allowance across service recreation without blocking release commands", async () => {
    const f=await nativeContextFixture();
    try{
      const query={actor:"model",executionId:"bounded-metadata",modelReadBytes:4000,totalBytes:8000};
      const first=await f.post("status",query);expect(first.status,JSON.stringify(first.body)).toBe(200);expect(first.body.readBudgetRemainingBytes).toBe(4000);
      const {NativeContextService}=await import("../src/native-context-service.js");
      Object.defineProperty(f.engine,"nativeContext",{value:new NativeContextService(f.engine),configurable:true});
      const second=await f.post("status",query);expect(second.status).toBe(200);expect(second.body.readBudgetRemainingBytes).toBe(0);
      expect((await f.post("status",query)).status).toBe(409);
      expect((await f.post("requests",{actor:"model",executionId:query.executionId,referenceId:f.ref.referenceId,maxBytes:4000,totalBytes:8000})).status).toBe(409);
      expect((await f.post("release",{actor:"model",executionId:query.executionId,operationId:"release-after-budget",expectedRevision:0,referenceId:f.ref.referenceId})).status).toBe(200);
    }finally{await f.close();}
  });

  it("rolls back graph and reference changes when persisting the matching context receipt fails", async () => {
    const f = await nativeContextFixture();
    try {
      let graph = await f.engine.sessionGraph.ensure(f.run.runId, f.mappings["target-native"].logicalSessionId);
      const context = await f.status();
      const action = { action: "connect", sourceNativeSessionId: "source-native", sourceVersionId: f.ref.sourceVersionId, sourceAnchorId: "reply-3", graphRevision: graph.revision, expectedRevision: context.revision, operationId: "atomic-connect" };
      const refsBefore = f.engine.extensions!.list({ ...f.extensionScope, namespace: "annotation-upstream" }).items.length;
      const save = vi.spyOn(f.engine.nativeContext as any, "save");
      save.mockImplementationOnce(() => { throw new Error("synthetic context write interrupted"); });
      expect((await f.post("graph-edit", action)).status).toBe(500);
      expect(await f.engine.sessionGraph.load(f.run.runId, graph.objectId)).toEqual(graph);
      expect(f.engine.extensions!.list({ ...f.extensionScope, namespace: "annotation-upstream" }).items.length).toBe(refsBefore);
      const created = await f.post("graph-edit", action); expect(created.status, JSON.stringify(created.body)).toBe(200); expect(created.body.graph.graph.edges).toHaveLength(refsBefore + 1);
      graph = created.body.graph;
      const sourceNode = graph.graph.nodes.find(node => node.data.logicalSessionId === f.mappings["source-native"].logicalSessionId)!;
      const rename = { action: "rename", nodeId: sourceNode.id, label: "atomic renamed source", graphRevision: graph.revision, expectedRevision: (await f.status()).revision, operationId: "atomic-rename" };
      save.mockImplementationOnce(() => { throw new Error("synthetic rename receipt interrupted"); });
      expect((await f.post("graph-edit", rename)).status).toBe(500); expect(await f.engine.sessionGraph.load(f.run.runId, graph.objectId)).toEqual(graph);
      expect((await f.post("graph-edit", rename)).status).toBe(200);
      graph = await f.engine.sessionGraph.load(f.run.runId, graph.objectId);
      const remove = { action: "disconnect", referenceId: f.ref.referenceId, graphRevision: graph.revision, expectedRevision: (await f.status()).revision, operationId: "atomic-remove" };
      save.mockImplementationOnce(() => { throw new Error("synthetic revoke receipt interrupted"); });
      expect((await f.post("graph-edit", remove)).status).toBe(500); expect(await f.engine.sessionGraph.load(f.run.runId, graph.objectId)).toEqual(graph);
      expect((await f.engine.sessionContext.record(f.run.runId, "target-native", f.ref.referenceId)).record.state).not.toBe("revoked");
      expect((await f.post("graph-edit", remove)).status).toBe(200);
      save.mockRestore();
    } finally { await f.close(); }
  });
});
