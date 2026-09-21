import { describe, expect, it, vi } from "vitest";
import type { RuntimeBrokerPrepareRunRequest, UserRequestPage } from "@linmu/dsh-session-contracts";
import { REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import { createEngineFixture, hashTree, joinInstanceWorkspace } from "./helpers.js";
import { UserRequestIndexService } from "../src/user-request-index-service.js";
import { contextHeader } from "../../../packages/adapter-dsh-0-1-5/test/context-fixture.js";

const at = "2026-09-15T00:00:00Z";
const longText = "代码😀\n".repeat(5000);
function conversation(count: number, firstTurn = 1, startSequence = 0): any[] {
  const events: any[] = [];
  for (let turn = firstTurn; turn < firstTurn + count; turn++) {
    events.push({ type: "turn/start", data: { turn } }, { type: "step/start", data: { turn, step: 1 } },
      { type: "user/message", surfaceOp: "append", data: { id: `q-${turn}`, role: "user", source: { kind: "user" },
        content: [{ type: "text", text: turn === 20 ? longText : `REQUEST-${turn}` }] } },
      { type: "user/message", surfaceOp: "append", data: { id: `context-${turn}`, role: "user",
        source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }, content: [{ type: "text", text: "RUNTIME-INJECTION" }] } },
      { type: "assistant/message", surfaceOp: "append", data: { turn, step: 1,
        message: { id: `reply-${turn}`, role: "assistant", source: { kind: "model", provider: "fixture", model: "fixture" },
          content: [{ type: "text", text: `ANSWER-BODY-${turn}-${"private".repeat(10)}` }] }, stream: [] } },
      { type: "step/end", data: { turn, step: 1 } }, { type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  }
  return events.map((event, index) => ({ ...event, seq: startSequence + index, time: startSequence + index + 1 }));
}

async function fixture(turns = 100) {
  const f = await createEngineFixture("user-request-index");
  const untouched = await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)]);
  const request: RuntimeBrokerPrepareRunRequest = { schemaVersion: 1, client: { kind: "launcher", id: "fixture-launcher" }, runtimeClientId: "fixture-runtime",
    instanceId: "fixture-copy", profileId: "web", dshVersion: "0.1.5-rc.2", maintenanceEndpoint: "http://127.0.0.1:41781", branchId: "main" as never,
    pinnedAdapterId: "dsh-0.1.5" as never, projectSelection: { kind: "all" }, environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES],
      packageVersions: Object.fromEntries(["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].map(p => [p, "0.1.5-rc.2"])) } };
  await joinInstanceWorkspace(f.engine, { instanceId: request.instanceId, cwd: f.root });
  const run = await f.engine.prepareProjectionRuntimeRun(request);
  await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
    temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
  const mappings: Record<string, any> = {};
  for (const id of ["source-native", "target-native"]) mappings[id] = await f.engine.registerProjectionRuntimeSession({ schemaVersion: 1,
    clientId: request.runtimeClientId, runId: run.runId, nativeSessionId: id as never, header: { ...contextHeader, cwd: f.root, id }, title: id });
  const append = (events: any[], operationId: string) => f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, {
    runId: run.runId, nativeSessionId: "source-native" as never, operationId: operationId as never, nativeRevision: events.at(-1).seq + 1,
    observedAt: at, payload: { logicalSessionId: mappings["source-native"].logicalSessionId, instanceId: request.instanceId,
      header: { ...contextHeader, cwd: f.root }, inheritedEventCount: 0, events } });
  expect((await append(conversation(turns), "initial" )).status).toBe("committed");
  f.engine.extensions!.connect({ instanceId: request.instanceId, profileId: "web", plugins: [
    { namespace: "annotation-upstream", pluginVersion: "0.3.12-rc2.10", writerId: "dsh-annotation-core" },
  ] });
  // Isolate the source-status dependency; integration tests of NativeContextService
  // exercise its persisted state. These tests verify the index calls/rechecks it.
  let paused = false, revision = 1;
  const guard = vi.fn(async () => { if (paused) throw new Error("SOURCE_PAUSED"); return { revision }; });
  Object.defineProperty(f.engine, "nativeContext", { value: { assertReferenceReadable: guard,
    allowedEntries: async (_run: string, _target: string, _reference: string, entries: unknown[]) => ({ ...await guard(), window: null, entries }),
  }, configurable: true });
  const service = new UserRequestIndexService(f.engine);
  const captured = await f.engine.sessionContext.capture({ runId: run.runId, targetNativeSessionId: "target-native", sourceNativeSessionId: "source-native",
    operationId: "reference-cutoff", anchorId: `reply-${Math.min(turns, 40)}`, selectedText: "ANSWER" });
  const scope = { runId: run.runId, targetNativeSessionId: "target-native", referenceId: captured.referenceId };
  return { ...f, service, captured, scope, run, mappings, append, guard,
    pause: (value: boolean) => { paused = value; revision++; },
    close: async () => {
      expect(await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)])).toEqual(untouched);
      await f.cleanupAll();
    } };
}

describe("user request index through canonical Maintenance sessions", () => {
  it("filters a 100-turn source at reply 40 before paging, never leaks answers or injected context, and locates full request turns", async () => {
    const f = await fixture();
    try {
      const items: UserRequestPage["items"] = []; let cursor: string | null = null, round = 0;
      do {
        const page = await f.service.list({ ...f.scope, executionId: `round-${round++}`, limit: 25, maxBytes: 16000, ...(cursor ? { cursor } : {}) });
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16000);
        expect(page.sourceVersionId).toBe(f.captured.sourceVersionId);
        expect(JSON.stringify(page)).not.toMatch(/ANSWER-BODY|RUNTIME-INJECTION|REQUEST-(?:4[1-9]|[5-9][0-9]|100)/);
        items.push(...page.items); cursor = page.nextCursor;
      } while (cursor);
      expect(items).toHaveLength(40);
      expect(items.map(item => item.nativeMessageId)).toEqual(Array.from({ length: 40 }, (_, index) => `q-${index + 1}`));
      const located = await f.service.locate({ ...f.scope, executionId: "locate", requestId: items[2]!.requestId });
      expect(located.location.replyEventId).toBe(items[2]!.replyRefs.at(-1)!.eventId);
      expect(located.location.startEventId).toBe(items[2]!.turnBoundaryEventId);
      expect(located.location.rangeState).toBe("complete");
      await expect(f.service.list({ ...f.scope, targetNativeSessionId: "source-native", executionId: "foreign" })).rejects.toThrow("不可用");
      expect(f.guard.mock.calls.length).toBeGreaterThan(2);
    } finally { await f.close(); }
  }, 30000);

  it("pages long request text exactly; static session index works without a runtime and rejects stale snapshots", async () => {
    const f = await fixture(25);
    try {
      const sessionId = f.mappings["source-native"].logicalSessionId;
      let cursor: string | null = null, long: UserRequestPage["items"][number] | undefined;
      do {
        const page = await f.service.listSession({ logicalSessionId: sessionId, limit: 25, maxBytes: 16000, ...(cursor ? { cursor } : {}) });
        long ??= page.items.find(item => item.nativeMessageId === "q-20"); cursor = page.nextCursor;
      } while (cursor && !long);
      expect(long).toBeDefined();
      let text = long!.text, continuation = long!.nextTextCursor;
      while (continuation) {
        const page = await f.service.listSession({ logicalSessionId: sessionId, requestId: long!.requestId, cursor: continuation, maxBytes: 16000 });
        text += page.items[0]!.text; continuation = page.items[0]!.nextTextCursor;
      }
      expect(text).toBe(longText);
      const previous = await f.service.listSession({ logicalSessionId: sessionId, limit: 1 });
      expect((await f.append(conversation(1, 26, 25 * 7), "next-version")).status).toBe("committed");
      await expect(f.service.listSession({ logicalSessionId: sessionId, cursor: previous.nextCursor! })).rejects.toThrow("来源版本");
      const current = await f.service.listSession({ logicalSessionId: sessionId, limit: 1 });
      expect(current.items[0]!.requestId).toBe(previous.items[0]!.requestId);
      // No run lookup or source-status dependency on human read-only navigation.
      vi.spyOn(f.engine.projectionRunRepository, "getProjectionRun").mockRejectedValue(new Error("NO-RUNTIME"));
      expect((await f.service.listSession({ logicalSessionId: sessionId })).items.length).toBeGreaterThan(0);
    } finally { await f.close(); }
  }, 30000);

  it("invalidates old cursors after pause/resume and shares persistent cumulative allowance with context reads", async () => {
    const f = await fixture(3);
    try {
      const query = { ...f.scope, executionId: "shared-execution", totalBytes: 10000, maxBytes: 4000, limit: 1 };
      const first = await f.service.list(query);
      const next = await f.service.list({ ...query, cursor: first.nextCursor! });
      expect(next.remainingBytes).toBeLessThan(first.remainingBytes);
      const budgetBefore = f.engine.repository.database.prepare("SELECT SUM(used_bytes) total FROM context_read_executions").get()!.total;
      for (let attempt = 0; attempt < 8; attempt++) {
        const preview = await f.service.list({ ...query, executionId: "user-preview" }, { preview: true });
        expect(preview.budgetExhausted).toBe(false);
      }
      expect(f.engine.repository.database.prepare("SELECT SUM(used_bytes) total FROM context_read_executions").get()!.total).toBe(budgetBefore);
      const read = await f.engine.sessionContext.read({ ...f.scope, executionId: query.executionId, totalBytes: 10000, maxBytes: 4000 });
      expect(read.remainingBytes).toBeLessThan(next.remainingBytes);
      f.pause(true);
      await expect(f.service.list({ ...query, executionId: "new-round", cursor: first.nextCursor! })).rejects.toThrow("PAUSED");
      f.pause(false);
      await expect(f.service.list({ ...query, executionId: "new-round", cursor: first.nextCursor! })).rejects.toThrow("暂停状态已变化");
      await f.engine.sessionContext.bind(f.scope.runId, f.scope.targetNativeSessionId, f.scope.referenceId, null);
      await expect(f.service.list({ ...query, executionId: "revoked" })).rejects.toThrow("不可用");
    } finally { await f.close(); }
  }, 30000);
});
