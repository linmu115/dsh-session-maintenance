import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { NativeAppendOperation, ProjectionOperationReceipt } from "@linmu/dsh-session-contracts";

import { ProjectionWriteAheadLog } from "../src/wal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectionWriteAheadLog long operation IDs", () => {
  it("advances a Windows-safe WAL record and accepts a retry with a new observation timestamp", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-long-wal-"));
    roots.push(root);
    const wal = new ProjectionWriteAheadLog(join(root, "projection"));
    const nativeSessionId = `dsh-maintenance_${"derived-session-identity".repeat(5)}` as never;
    const operationId = `run-long:${nativeSessionId}:20505` as never;
    const operation: NativeAppendOperation = {
      runId: "run-long" as never,
      operationId,
      nativeSessionId,
      nativeRevision: 1,
      payload: {
        logicalSessionId: "logical-derived:long" as never,
        baseVersionId: "version-base" as never,
        events: [{ type: "user/message", seq: 0, time: 1, data: { text: "test" } }],
      },
      observedAt: "2026-09-02T05:09:26.115Z",
    };

    const pending = await wal.putPending(operation, operation.observedAt);
    expect(pending.projectionApplied).toBe(false);
    await expect(wal.putPending({
      ...operation,
      observedAt: "2026-09-02T05:09:27.000Z",
    }, "2026-09-02T05:09:27.000Z")).resolves.toEqual(pending);

    const applied = await wal.markProjectionApplied(operationId, "2026-09-02T05:09:28.000Z");
    expect(applied.projectionApplied).toBe(true);
    const receipt: ProjectionOperationReceipt = {
      schemaVersion: 1,
      status: "committed",
      runId: operation.runId,
      operationId,
      logicalSessionId: operation.payload.logicalSessionId,
      nativeSessionId,
      canonicalVersionId: "version-next" as never,
      projectionRevision: 1,
      committedAt: "2026-09-02T05:09:29.000Z",
    };
    await wal.markCommitted(operationId, receipt, receipt.committedAt);
    await expect(wal.get(operationId)).resolves.toMatchObject({
      state: "committed",
      projectionApplied: true,
      receipt,
    });
  });
});
