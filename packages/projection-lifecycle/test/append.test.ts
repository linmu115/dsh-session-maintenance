import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { adapter, alpha2NativeSessionId, Alpha2RuntimeBridge } from "@linmu/dsh-session-adapter-alpha2";
import type {
  OperationId,
  ProjectionOperationReceipt,
  ProjectionRun,
  ProjectionRunRepository,
  ProjectionRunState,
  ProjectionSession,
  RunId,
} from "@linmu/dsh-session-contracts";
import { MemoryStatusEventAdapter, StatusLog } from "@linmu/dsh-session-status-log";

import {
  JsonProjectionDirectory,
  ProjectionLifecycle,
  ProjectionWriteAheadLog,
} from "../src/index.js";

const roots: string[] = [];
const at = "2026-08-31T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryRuns implements ProjectionRunRepository {
  readonly runs = new Map<string, ProjectionRun>();
  readonly sessions = new Map<string, ProjectionSession>();
  readonly receipts = new Map<string, ProjectionOperationReceipt>();

  async createProjectionRun(input: ProjectionRun): Promise<ProjectionRun> {
    this.runs.set(input.id, input);
    return input;
  }

  async getProjectionRun(id: RunId): Promise<ProjectionRun | undefined> { return this.runs.get(id); }

  async setProjectionRunState(id: RunId, state: ProjectionRunState): Promise<void> {
    const run = this.runs.get(id);
    if (run === undefined) throw new Error("run not found");
    this.runs.set(id, { ...run, state });
  }

  async upsertProjectionSession(input: ProjectionSession): Promise<void> {
    this.sessions.set(`${input.runId}:${input.nativeSessionId}`, input);
  }

  async saveOperationReceipt(input: ProjectionOperationReceipt): Promise<void> {
    const existing = this.receipts.get(input.operationId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(input)) {
      throw new Error("receipt changed");
    }
    this.receipts.set(input.operationId, input);
  }

  async getOperationReceipt(operationId: OperationId): Promise<ProjectionOperationReceipt | undefined> {
    return this.receipts.get(operationId);
  }
}

function session(logicalSessionId: string) {
  return {
    session: {
      schemaVersion: 1 as const,
      id: logicalSessionId as never,
      authorityScope: "maintenance" as const,
      originKind: "maintenance-native" as const,
      headVersionId: "version-base" as never,
      title: "Synthetic append fixture",
      tags: ["fixture"],
      archivedAt: null,
      tombstonedAt: null,
      createdAt: at,
      updatedAt: at,
    },
    events: [{
      schemaVersion: 1 as const,
      id: "event-existing",
      logicalSessionId: logicalSessionId as never,
      sequence: 0,
      kind: "user-message" as const,
      role: "user" as const,
      content: { role: "user", content: [{ type: "text", text: "question" }] },
      source: { platform: "dsh" as const, instanceId: "fixture", sessionId: "native", eventId: "0", cursor: "1" },
      contentDigest: "sha256:existing",
      rawPayload: null,
      extensions: {},
    }],
    workspaceId: null,
  };
}

describe("ProjectionLifecycle.append", () => {
  it("keeps a projection-applied WAL pending when Maintenance fails, then retries idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-append-"));
    roots.push(root);
    const runRepository = new MemoryRuns();
    const statusAdapter = new MemoryStatusEventAdapter();
    const logicalSessionId = "logical-append-failure";
    let nextId = 0;
    let unavailable = true;
    const appendDsh = vi.fn(async (input: { readonly projection: { readonly operationId: OperationId; readonly nativeRevision: number }; readonly logicalSessionId: string }) => {
      if (unavailable) throw new Error("Maintenance temporarily unavailable");
      return {
        outcome: "advanced" as const,
        operationId: input.projection.operationId,
        logicalSessionId: input.logicalSessionId as never,
        versionId: "version-after-append" as never,
        tombstoneState: null,
        committedAt: at,
      };
    });
    const bridge = new Alpha2RuntimeBridge({
      attach: async () => ({ registrationId: "registration-append", attachedAt: at }),
      drain: async (_registrationId, runId) => ({ runId, pendingOperations: 0, receipts: [] }),
      detach: async () => undefined,
    });
    const lifecycle = new ProjectionLifecycle({
      runRepository,
      statusLog: new StatusLog(statusAdapter, {
        clock: () => at,
        idFactory: (kind) => `${kind}-${String(++nextId).padStart(3, "0")}`,
      }),
      source: { load: async (run) => ({ run, workspaces: [], sessions: [session(logicalSessionId)] }) },
      adapter,
      bridge,
      canonicalEngine: { appendDsh },
      runtimeRoot: join(root, "runtime"),
      clock: () => at,
      idFactory: (kind) => `${kind}-${String(++nextId).padStart(3, "0")}`,
    });
    const handle = await lifecycle.openRun({
      instanceId: "alpha2-fixture",
      profileId: "alpha2",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    const nativeSessionId = alpha2NativeSessionId(logicalSessionId as never);
    const operation = {
      runId: handle.run.id,
      operationId: "operation-append-failure" as OperationId,
      nativeSessionId,
      nativeRevision: 3,
      observedAt: at,
      payload: {
        logicalSessionId,
        baseVersionId: "version-base",
        events: [
          { type: "assistant/chunk", seq: 1, time: 1, data: { text: "thinking" } },
          { type: "assistant/message", seq: 2, time: 2, data: { message: { role: "assistant", content: [{ type: "text", text: "answer" }] } } },
        ],
      },
    } as const;

    const invalidRevision = {
      ...operation,
      operationId: "operation-invalid-revision" as OperationId,
      nativeRevision: 4,
    };
    await expect(lifecycle.append(handle, invalidRevision)).rejects.toMatchObject({ code: "NATIVE_REVISION_MISMATCH" });
    expect(await new ProjectionWriteAheadLog(handle.projectionRoot).get(invalidRevision.operationId)).toBeUndefined();

    await expect(lifecycle.append(handle, operation)).rejects.toMatchObject({ code: "MAINTENANCE_APPEND_FAILED" });
    const wal = new ProjectionWriteAheadLog(handle.projectionRoot);
    expect(await wal.get(operation.operationId)).toMatchObject({ state: "pending", projectionApplied: true });
    const projection = new JsonProjectionDirectory(handle.projectionRoot);
    expect(await projection.readSession(nativeSessionId)).toMatchObject({ events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }] });
    expect(await runRepository.getOperationReceipt(operation.operationId)).toBeUndefined();
    expect((await statusAdapter.list({ operationId: operation.operationId, limit: 20 })).items.map((event) => event.state)).toEqual([
      "started",
      "failed",
    ]);

    unavailable = false;
    const committed = await lifecycle.append(handle, operation);
    const replayed = await lifecycle.append(handle, operation);
    expect(replayed).toEqual(committed);
    expect(committed).toMatchObject({ status: "committed", projectionRevision: 3, canonicalVersionId: "version-after-append" });
    expect(appendDsh).toHaveBeenCalledTimes(2);
    expect(await wal.get(operation.operationId)).toMatchObject({ state: "committed", projectionApplied: true, receipt: committed });
    expect((await statusAdapter.list({ operationId: operation.operationId, limit: 20 })).items.map((event) => event.state)).toEqual([
      "started",
      "failed",
      "started",
      "succeeded",
    ]);
  });
});
