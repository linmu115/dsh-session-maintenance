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
