import { describe, expect, it } from "vitest";
import { REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import type { RuntimeBrokerPrepareRunRequest } from "@linmu/dsh-session-contracts";
import { createEngineFixture, hashTree } from "./helpers.js";
import { contextEvents, contextHeader } from "../../../packages/adapter-dsh-0-1-5/test/context-fixture.js";

const at = "2026-09-14T00:00:00Z";
describe("RC2 managed graph navigation", () => {
  it("isolates the current run, pages completed answers, rejects stale sources and preserves relationships without Annotation", async () => {
    const f = await createEngineFixture("managed-graph-rc2");
    try {
      const homesBefore = await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)]);
      const request: RuntimeBrokerPrepareRunRequest = { schemaVersion: 1, client: { kind: "launcher", id: "fixture-launcher" },
        runtimeClientId: "fixture-runtime", instanceId: "fixture-rc2-copy", profileId: "web", dshVersion: "0.1.5-rc.2",
        maintenanceEndpoint: "http://127.0.0.1:41781", branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never,
        projectSelection: { kind: "all" }, environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES],
          packageVersions: Object.fromEntries(["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence",
            "@deepseek-ai/dsh-session-format-catalog"].map(name => [name, "0.1.5-rc.2"])) } };
      const run = await f.engine.prepareProjectionRuntimeRun(request);
      await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
        temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
      const header = { ...contextHeader, cwd: f.root }, mappings: Record<string, any> = {};
      for (const id of ["source-native", "target-native"]) mappings[id] = await f.engine.registerProjectionRuntimeSession({
        schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, nativeSessionId: id as never,
        header: { ...header, id }, title: id });
      const sourceId = mappings["source-native"].logicalSessionId;
      const append = (events: any[], operationId: string) => f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, {
        runId: run.runId, nativeSessionId: "source-native" as never, operationId: operationId as never,
        nativeRevision: events.at(-1).seq + 1, observedAt: at, payload: { logicalSessionId: sourceId,
          instanceId: request.instanceId, header, inheritedEventCount: 0, events } });
      const prefix = contextEvents(false);
      const answer = "问答中文😀\"\\ " .repeat(12000) + "ANSWER-END";
      prefix[4].data.message.content[0].text = answer;
      expect((await append(prefix, "graph-first")).status).toBe("committed");
      const server = await f.startServer();
      const post = async (op: string, input: object = {}, auth = true) => {
        const response = await fetch(server.origin + "/v1/session-graph/" + op, { method: "POST",
          headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${server.token}` } : {}) },
          body: JSON.stringify({ runId: run.runId, ...input }) });
        return { status: response.status, value: await response.json() as any };
      };
      expect((await post("directory", {}, false)).status).toBe(401);
      expect((await post("directory", { runId: "foreign-run" })).status).toBe(409);
      const workspaces = (await post("directory")).value;
      const directory = (await post("directory", { workspaceId: workspaces.items[0].id })).value;
      expect(directory.items.some((row: any) => row.logicalSessionId === sourceId)).toBe(true);
      expect(JSON.stringify(directory)).not.toContain("old question");
      expect((await post("resolve", { target: { logicalSessionId: sourceId } })).value.nativeSessionId).toBe("source-native");
      expect((await post("resolve", { target: { nativeSessionId: "source-native" } })).value.logicalSessionId).toBe(sourceId);
      expect((await post("resolve", { target: { logicalSessionId: "source-native" } })).status).toBe(409);
      const counts = () => ["logical_sessions", "session_versions", "extension_objects"].map(table =>
        f.engine.repository.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n);
      const before = counts();
      const first = await post("preview", { logicalSessionId: sourceId });
      expect(first.status, JSON.stringify(first.value)).toBe(200);
      expect(first.value.capture).toMatchObject({ sourceSessionId: "source-native", anchorId: "reply-one", messageId: "reply-one" });
      expect(first.value.items[0].text).toBe("old question");
      let page = first.value, text = "", pages = 0;
      while (true) {
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16000);
        for (const item of page.items) if (item.role === "assistant") text += item.text;
        if (!page.nextCursor) break;
        expect(pages++).toBeLessThan(100);
        const next = await post("preview", { logicalSessionId: sourceId, cursor: page.nextCursor });
        expect(next.status, JSON.stringify(next.value)).toBe(200); page = next.value;
      }
      expect(text).toBe(answer);
      expect(counts()).toEqual(before);
      expect((await post("preview", { logicalSessionId: sourceId, cursor: "invalid" })).status).toBe(409);
      const selected = await post("preview", { logicalSessionId: sourceId,
        selection: { sourceVersionId: first.value.sourceVersionId, sourceAnchorId: "reply-one" } });
      expect(selected.status).toBe(200);
      expect((await post("preview", { logicalSessionId: sourceId,
        selection: { sourceVersionId: first.value.sourceVersionId, sourceAnchorId: "missing" } })).status).toBe(409);
      const scope = { instanceId: request.instanceId, profileId: "web", namespace: "annotation-upstream" };
      f.engine.extensions!.connect({ instanceId: scope.instanceId, profileId: scope.profileId,
        plugins: [{ namespace: scope.namespace, pluginVersion: "0.3.12-rc2.6", writerId: "dsh-annotation-core" }] });
      const reference = await f.engine.sessionContext.capture({ runId: run.runId, sourceNativeSessionId: "source-native",
        targetNativeSessionId: "target-native", operationId: "graph-ref", anchorId: "reply-one", selectedText: "問" });
      await f.engine.sessionContext.bind(run.runId, "target-native", reference.referenceId, "actual-user");
      f.engine.extensions!.enable(scope, false);
      const relations = await post("relations");
      expect(relations.value.items).toEqual([expect.objectContaining({ referenceId: reference.referenceId,
        namespace: "annotation-upstream", sourceSessionId: sourceId, targetMessageId: "actual-user", state: "sent" })]);
      expect(JSON.stringify(relations.value)).not.toContain(answer);
      expect((await post("directory")).status).toBe(200);
      f.engine.repository.database.prepare("UPDATE projection_sessions SET mode='hidden' WHERE run_id=? AND native_session_id=?")
        .run(run.runId, "target-native");
      expect((await post("relations")).value.items).toEqual([]);
      expect((await post("resolve", { target: { nativeSessionId: "target-native" } })).status).toBe(409);
      expect((await append(contextEvents().slice(7), "graph-next")).status).toBe("committed");
      expect((await post("preview", { logicalSessionId: sourceId, cursor: first.value.nextCursor })).status).toBe(409);
      expect((await post("preview", { logicalSessionId: sourceId,
        selection: { sourceVersionId: first.value.sourceVersionId, sourceAnchorId: "reply-one" } })).status).toBe(409);
      const latest = await post("preview", { logicalSessionId: sourceId });
      expect(latest.value.items.map((row: any) => row.text)).toEqual(["FUTURE-SENTINEL", "FUTURE-ANSWER"]);
      const earlier = await post("preview", { logicalSessionId: sourceId, cursor: latest.value.nextCursor });
      expect(earlier.value.capture.anchorId).toBe("reply-one");
      expect(await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)])).toEqual(homesBefore);
    } finally { await f.cleanupAll(); }
  }, 60000);
});
