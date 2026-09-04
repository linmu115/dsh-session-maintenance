import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { adapter, alpha2NativeSessionId, Alpha2RuntimeBridge } from "../../packages/adapter-dsh-alpha2/src/index.js";
import type {
  OperationId,
  ProjectionOperationReceipt,
  ProjectionRun,
  ProjectionRunRepository,
  ProjectionRunState,
  ProjectionSession,
  RunId,
} from "../../packages/contracts/src/index.js";
import { ProjectionLifecycle } from "../../packages/projection-lifecycle/src/index.js";
import { MemoryStatusEventAdapter, StatusLog } from "../../packages/session-status-log/src/index.js";

const roots: string[] = [];
const at = "2026-08-31T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class Runs implements ProjectionRunRepository {
  readonly runs = new Map<string, ProjectionRun>();
  readonly sessions = new Map<string, ProjectionSession>();
  readonly receipts = new Map<string, ProjectionOperationReceipt>();
  async createProjectionRun(input: ProjectionRun) { this.runs.set(input.id, input); return input; }
  async getProjectionRun(id: RunId) { return this.runs.get(id); }
  async setProjectionRunState(id: RunId, state: ProjectionRunState) {
    const run = this.runs.get(id);
    if (run === undefined) throw new Error("run not found");
    this.runs.set(id, { ...run, state });
  }
  async setProjectionRunCheckpoint(id: RunId, checkpointId: string) {
    const run = this.runs.get(id)!;
    this.runs.set(id, { ...run, checkpointId: checkpointId as never });
  }
  async listProjectionSessions(runId: RunId) { return [...this.sessions.values()].filter((item) => item.runId === runId); }
  async upsertProjectionSession(input: ProjectionSession) { this.sessions.set(`${input.runId}:${input.nativeSessionId}`, input); }
  async saveOperationReceipt(input: ProjectionOperationReceipt) { this.receipts.set(input.operationId, input); }
  async getOperationReceipt(id: OperationId) { return this.receipts.get(id); }
}

const logicalSessionId = "logical-cold-recovery";
const source = {
  session: {
    schemaVersion: 1 as const,
    id: logicalSessionId as never,
    authorityScope: "maintenance" as const,
    originKind: "maintenance-native" as const,
    headVersionId: "version-cold-base" as never,
    title: "Cold recovery",
    tags: [],
    archivedAt: null,
    tombstonedAt: null,
    createdAt: at,
    updatedAt: at,
  },
  events: [{
    schemaVersion: 1 as const,
    id: "cold-event-0",
    logicalSessionId: logicalSessionId as never,
    sequence: 0,
    kind: "user-message" as const,
    role: "user" as const,
    content: { role: "user", content: [{ type: "text", text: "question" }] },
    source: { platform: "dsh" as const, instanceId: "fixture", sessionId: "cold", eventId: "0", cursor: "1" },
    contentDigest: "sha256:cold-0",
    rawPayload: null,
    extensions: {},
  }],
  workspaceId: null,
};

function runtimeBridge(calls: string[]) {
  return new Alpha2RuntimeBridge({
    attach: async () => { calls.push("attach"); return { registrationId: `registration-${calls.length}`, attachedAt: at }; },
    drain: async (_registrationId, runId) => { calls.push("drain"); return { runId, pendingOperations: 0, receipts: [] }; },
    detach: async () => { calls.push("detach"); },
  });
}

describe("projection cold recovery integration", () => {
  it("reconstructs a run from manifest, mapping and WAL after the original lifecycle is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-cold-recovery-"));
    roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const runs = new Runs();
    const statuses = new MemoryStatusEventAdapter();
    let unavailable = true;
    const appendDsh = vi.fn(async (input: { readonly logicalSessionId: string; readonly projection: { readonly operationId: OperationId } }) => {
      if (unavailable) throw new Error("Maintenance unavailable before crash");
      return {
        outcome: "advanced" as const,
        operationId: input.projection.operationId,
        logicalSessionId: input.logicalSessionId as never,
        versionId: "version-cold-recovered" as never,
        tombstoneState: null,
        committedAt: at,
      };
    });
    let nextId = 0;
    const statusLog = new StatusLog(statuses, { clock: () => at, idFactory: (kind) => `${kind}-${++nextId}` });
    const sourcePort = { load: async (run: ProjectionRun) => ({ run, workspaces: [], sessions: [source] }) };
    const firstBridgeCalls: string[] = [];
    const firstBridge = runtimeBridge(firstBridgeCalls);
    const first = new ProjectionLifecycle({
      runRepository: runs,
      statusLog,
      source: sourcePort,
      adapter,
      bridge: firstBridge,
      canonicalEngine: { appendDsh },
      runtimeRoot,
      clock: () => at,
      idFactory: (kind) => `${kind}-${++nextId}`,
    });
    const handle = await first.openRun({
      instanceId: "alpha2-cold",
      profileId: "alpha2",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    const operation = {
      runId: handle.run.id,
      operationId: "operation-cold-recovery" as OperationId,
      nativeSessionId: alpha2NativeSessionId(logicalSessionId as never),
      nativeRevision: 2,
      observedAt: at,
      payload: {
        logicalSessionId,
        baseVersionId: "version-cold-base",
        events: [{ type: "assistant/message", seq: 1, time: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "answer" }] } } }],
      },
    } as const;
    await expect(firstBridge.submitAppend(operation)).rejects.toMatchObject({ code: "MAINTENANCE_APPEND_FAILED" });
    await runs.setProjectionRunState(handle.run.id, "recovery-required");

    unavailable = false;
    const recoveryBridgeCalls: string[] = [];
    const recovery = new ProjectionLifecycle({
      runRepository: runs,
      statusLog,
      source: sourcePort,
      adapter,
      bridge: runtimeBridge(recoveryBridgeCalls),
      canonicalEngine: { appendDsh },
      checkpointRepository: { saveCheckpoint: async () => undefined },
      runtimeRoot,
      clock: () => at,
      idFactory: (kind) => `${kind}-${++nextId}`,
    });
    const receipt = await recovery.recover(handle.run.id);

    expect(receipt).toMatchObject({ state: "recovered", removedProjection: true });
    expect(recoveryBridgeCalls).toEqual(["attach", "detach"]);
    expect(appendDsh).toHaveBeenCalledTimes(2);
    expect(runs.receipts.get(operation.operationId)).toMatchObject({ canonicalVersionId: "version-cold-recovered" });
    expect(runs.runs.get(handle.run.id)).toMatchObject({ state: "recovered", checkpointId: receipt.checkpointId });
    await expect(access(dirname(handle.projectionRoot))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await statuses.list({ runId: handle.run.id, stage: "run.shutdown-recovery", limit: 20 })).items.map((event) => event.state)).toEqual(["started", "succeeded"]);
  });
});
