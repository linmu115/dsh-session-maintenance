import { expect } from "vitest";
import { REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import type { RuntimeBrokerPrepareRunRequest } from "@linmu/dsh-session-contracts";
import { contextHeader } from "../../../packages/adapter-dsh-0-1-5/test/context-fixture.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const at = "2026-09-15T00:00:00Z";
function events(count: number) {
  const rows: any[] = [];
  for (let turn = 1; turn <= count; turn++) rows.push(
    { type: "turn/start", data: { turn } }, { type: "step/start", data: { turn, step: 1 } },
    { type: "user/message", surfaceOp: "append", data: { id: `question-${turn}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text: `REQUEST-${turn}` }] } },
    { type: "user/message", surfaceOp: "append", data: { id: `runtime-${turn}`, role: "user", source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }, content: [{ type: "text", text: "RUNTIME-INJECTION" }] } },
    { type: "assistant/message", surfaceOp: "append", data: { turn, step: 1, message: { id: `reply-${turn}`, role: "assistant", source: { kind: "model", provider: "fixture", model: "fixture" }, content: [{ type: "text", text: `ANSWER-${turn}-${"bounded-source ".repeat(30)}` }] }, stream: [] } },
    { type: "step/end", data: { turn, step: 1 } }, { type: "turn/end", data: { turn, reason: { kind: "completed" } } },
  );
  return rows.map((row, seq) => ({ ...row, seq, time: seq + 1 }));
}

export async function nativeContextFixture() {
  const f = await createEngineFixture("native-context-http");
  const untouched = await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)]);
  const request: RuntimeBrokerPrepareRunRequest = { schemaVersion: 1, client: { kind: "launcher", id: "fixture-launcher" }, runtimeClientId: "fixture-runtime", instanceId: "fixture-native-context", profileId: "web", dshVersion: "0.1.5-rc.2", maintenanceEndpoint: "http://127.0.0.1:41781", branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never, projectSelection: { kind: "all" }, environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES], packageVersions: Object.fromEntries(["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].map(name => [name, "0.1.5-rc.2"])) } };
  const run = await f.engine.prepareProjectionRuntimeRun(request);
  await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
  const mappings: Record<string, any> = {};
  for (const id of ["source-native", "target-native", "foreign-native"]) mappings[id] = await f.engine.registerProjectionRuntimeSession({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, nativeSessionId: id as never, header: { ...contextHeader, cwd: f.root, id }, title: id });
  for (const [id, count] of [["source-native", 6], ["target-native", 2]] as const) {
    const rows = events(count);
    const appended = await f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, { runId: run.runId, nativeSessionId: id as never, operationId: `append-${id}` as never, nativeRevision: rows.length, observedAt: at, payload: { logicalSessionId: mappings[id].logicalSessionId, instanceId: request.instanceId, header: { ...contextHeader, cwd: f.root, id }, inheritedEventCount: 0, events: rows } });
    expect(appended.status).toBe("committed");
  }
  const extensionScope = { instanceId: request.instanceId, profileId: "web", namespace: "annotation-context" };
  f.engine.extensions!.connect({ instanceId: extensionScope.instanceId, profileId: extensionScope.profileId, plugins: [
    { namespace: "annotation-upstream", pluginVersion: "0.3.12-rc2.10", writerId: "dsh-annotation-core" },
    { namespace: "annotation-context", pluginVersion: "0.3.12-rc2.11", writerId: "dsh-annotation-core" },
    { namespace: "thoughtdag", pluginVersion: "0.4.14-rc2.8", writerId: "thoughtdag" },
  ] });
  const ref = await f.engine.sessionContext.capture({ runId: run.runId, sourceNativeSessionId: "source-native", targetNativeSessionId: "target-native", operationId: "fixed-reference", anchorId: "reply-4", selectedText: "ANSWER-4" });
  const server = await f.startServer();
  const scope = { runId: run.runId, targetNativeSessionId: "target-native", actor: "user", executionId: "user:target-native" };
  const post = async (operation: string, input: object = {}, options: { auth?: boolean; prefix?: string } = {}) => {
    const response = await fetch(`${server.origin}/v1/${options.prefix ?? "native-context"}/${operation}`, { method: "POST", headers: { "content-type": "application/json", ...(options.auth === false ? {} : { authorization: `Bearer ${server.token}` }) }, body: JSON.stringify({ ...scope, ...input }) });
    return { status: response.status, body: await response.json() as any };
  };
  const read = async (input: object = {}) => {
    const response = await fetch(`${server.origin}/v1/session-context/read`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` }, body: JSON.stringify({ runId: run.runId, targetNativeSessionId: "target-native", referenceId: ref.referenceId, executionId: "native-test-read", ...input }) });
    return { status: response.status, body: await response.json() as any };
  };
  const status = async () => { const result = await post("status"); expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body; };
  const mutate = async (operation: string, input: object = {}) => post(operation, { expectedRevision: (await status()).revision, operationId: crypto.randomUUID(), ...input });
  return { ...f, server, run, mappings, ref, scope, extensionScope, post, read, status, mutate,
    close: async () => { expect(await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)])).toEqual(untouched); await f.cleanupAll(); } };
}
