import { describe, expect, it } from "vitest";
import type {
  AdapterEvidenceInputV1,
  AdapterEvidencePort,
  AdapterEvidenceRecordV1,
  AdapterEvidenceRef,
  AdapterId,
  NativeAppendOperation,
} from "@linmu/dsh-session-adapter-sdk";

import { normalizeAlpha2Append } from "../src/index.js";

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

describe("Alpha2 Adapter evidence boundary", () => {
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

    const first = await normalizeAlpha2Append(operation);
    const retry = await normalizeAlpha2Append(operation);
    const anotherRun = await normalizeAlpha2Append({
      ...operation,
      runId: "run-event-identity-b" as never,
      operationId: "operation-event-identity-b" as never,
    });

    expect(first.events[0]?.id).toBe("dsh-alpha2:run-event-identity-a:native-event-identity:0");
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

    const normalized = await normalizeAlpha2Append(operation, evidence);
    expect(normalized.events).toHaveLength(1);
    expect(normalized.events[0]).toMatchObject({
      kind: "other",
      role: "unknown",
      rawPayload: null,
      content: {
        type: "other",
        sourceKind: "dsh-alpha2/future/private",
        evidenceRef: `evidence:sha256:${"a".repeat(64)}`,
      },
    });
    expect(JSON.stringify(normalized.events[0])).not.toContain("never-public");
    expect(evidence.writes).toEqual([expect.objectContaining({
      adapterId: "dsh-alpha2",
      sourceKind: "dsh-alpha2/future/private",
      payload: operation.payload.events[0],
    })]);
  });
});
