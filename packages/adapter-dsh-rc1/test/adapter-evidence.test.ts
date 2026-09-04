import { describe, expect, it } from "vitest";
import type {
  AdapterEvidenceInputV1,
  AdapterEvidencePort,
  AdapterEvidenceRecordV1,
  AdapterEvidenceRef,
  AdapterId,
  NativeAppendOperation,
} from "@linmu/dsh-session-adapter-sdk";

import { normalizeRc1Append } from "../src/index.js";

const at = "2026-09-03T01:00:00.000Z";

class MemoryEvidence implements AdapterEvidencePort {
  readonly writes: AdapterEvidenceInputV1[] = [];

  async putEvidence(input: AdapterEvidenceInputV1): Promise<AdapterEvidenceRecordV1> {
    this.writes.push(input);
    return {
      schemaVersion: 1,
      ref: `evidence:sha256:${"a".repeat(64)}` as AdapterEvidenceRef,
      adapterId: input.adapterId,
      nativeFormatId: input.nativeFormatId,
      sourceKind: input.sourceKind,
      objectId: `sha256:${"a".repeat(64)}`,
      byteLength: 42,
      createdAt: at,
    };
  }

  async readEvidence(_ref: AdapterEvidenceRef, _expectedAdapterId: AdapterId) {
    return undefined;
  }
}

describe("Rc1 Adapter evidence boundary", () => {
  it("normalizes portable Rc1 appends into exact MCSF conversation semantics", async () => {
    const evidence = new MemoryEvidence();
    const operation = {
      runId: "run-portable",
      operationId: "operation-portable",
      nativeSessionId: "native-portable",
      nativeRevision: 7,
      observedAt: at,
      payload: {
        logicalSessionId: "logical-portable",
        canonicalHistoryMode: "portable",
        events: [
          { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
          { type: "user/message", seq: 2, time: 2, data: {
            id: "user-1", role: "user", content: [{ type: "text", text: "run" }], source: { kind: "user" },
          } },
          { type: "assistant/message", seq: 3, time: 3, data: {
            turn: 1,
            step: 1,
            message: {
              id: "assistant-call", role: "assistant", source: { kind: "model", provider: "deepseek", model: "v4" },
              content: [{ type: "tool-call", id: "call-1", name: "exec", arguments: "pwd" }],
            },
          } },
          { type: "tool/call", seq: 4, time: 4, data: { turn: 1, step: 1, callId: "call-1", name: "exec", arguments: "pwd" } },
          { type: "assistant/chunk", seq: 5, time: 5, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "ignored" } } },
          { type: "tool/result", seq: 6, time: 6, data: {
            turn: 1,
            step: 1,
            message: {
              id: "result-1", role: "user", source: { kind: "tool", callId: "call-1" },
              content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "done" }] }],
            },
            meta: { name: "exec", protocol: "custom" },
          } },
        ],
      },
    } as unknown as NativeAppendOperation;

    const normalized = await normalizeRc1Append(operation, evidence);

    expect(normalized.events.map((event) => event.kind)).toEqual([
      "user-message", "assistant-message", "tool-call", "tool-result",
    ]);
    expect(normalized.events[1]).toMatchObject({
      rawPayload: null,
      content: { content: [] },
      extensions: { portableFromRc1: true },
    });
    expect(normalized.events[2]?.content).toEqual({
      callId: "call-1", name: "exec", protocol: "dsh", arguments: "pwd",
    });
    expect(normalized.events[3]?.content).toEqual({
      callId: "call-1", name: "exec", protocol: "custom", outputText: "done",
    });
    expect(normalized.metadata).toMatchObject({
      canonicalHistoryMode: "portable",
      heldOutEventTypes: ["turn/start", "assistant/chunk"],
    });
    expect(evidence.writes.map((write) => write.sourceKind)).toEqual([
      "dsh-rc1/turn/start", "dsh-rc1/assistant/chunk",
    ]);
  });

  it("scopes native event identities to one projection run while keeping retries idempotent", async () => {
    const operation = {
      runId: "run-event-identity-a",
      operationId: "operation-event-identity-a",
      nativeSessionId: "native-event-identity",
      nativeRevision: 1,
      observedAt: at,
      payload: {
        logicalSessionId: "logical-event-identity",
        events: [{ type: "user/message", seq: 0, time: Date.parse(at), data: { text: "hello" } }],
      },
    } as unknown as NativeAppendOperation;

    const first = await normalizeRc1Append(operation);
    const retry = await normalizeRc1Append(operation);
    const anotherRun = await normalizeRc1Append({
      ...operation,
      runId: "run-event-identity-b" as never,
      operationId: "operation-event-identity-b" as never,
    });

    expect(first.events[0]?.id).toBe("dsh-rc1:run-event-identity-a:native-event-identity:0");
    expect(retry.events[0]?.id).toBe(first.events[0]?.id);
    expect(anotherRun.events[0]?.id).not.toBe(first.events[0]?.id);
  });

  it("places unknown native events in MCSF other and keeps their payload behind evidenceRef", async () => {
    const evidence = new MemoryEvidence();
    const operation = {
      runId: "run-evidence",
      operationId: "operation-evidence",
      nativeSessionId: "native-evidence",
      nativeRevision: 1,
      observedAt: at,
      payload: {
        logicalSessionId: "logical-evidence",
        events: [{ type: "future/private", seq: 0, time: Date.parse(at), data: { secret: "never-public" } }],
      },
    } as unknown as NativeAppendOperation;

    const normalized = await normalizeRc1Append(operation, evidence);
    expect(normalized.events).toHaveLength(1);
    expect(normalized.events[0]).toMatchObject({
      kind: "other",
      role: "unknown",
      rawPayload: null,
      content: {
        type: "other",
        sourceKind: "dsh-rc1/future/private",
        evidenceRef: `evidence:sha256:${"a".repeat(64)}`,
      },
    });
    expect(JSON.stringify(normalized.events[0])).not.toContain("never-public");
    expect(evidence.writes).toEqual([expect.objectContaining({
      adapterId: "dsh-rc1",
      sourceKind: "dsh-rc1/future/private",
      payload: operation.payload.events[0],
    })]);
  });
});
