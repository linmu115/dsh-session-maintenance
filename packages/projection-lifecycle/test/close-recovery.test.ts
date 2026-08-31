import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

import { ProjectionLifecycle } from "../src/index.js";

const roots: string[] = [];
const at = "2026-08-31T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryRuns implements ProjectionRunRepository {
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
    const run = this.runs.get(id);
    if (run === undefined) throw new Error("run not found");
    this.runs.set(id, { ...run, checkpointId: checkpointId as never });
  }
  async listProjectionSessions(runId: RunId) {
    return [...this.sessions.values()].filter((session) => session.runId === runId);
  }
  async upsertProjectionSession(input: ProjectionSession) { this.sessions.set(`${input.runId}:${input.nativeSessionId}`, input); }
  async saveOperationReceipt(input: ProjectionOperationReceipt) { this.receipts.set(input.operationId, input); }
  async getOperationReceipt(id: OperationId) { return this.receipts.get(id); }
}

function sourceSession(logicalSessionId: string, withEvent: boolean) {
  return {
    session: {
      schemaVersion: 1 as const,
      id: logicalSessionId as never,
      authorityScope: "maintenance" as const,
      originKind: "maintenance-native" as const,
      headVersionId: withEvent ? "version-base" as never : null,
      title: "Close fixture",
      tags: [],
      archivedAt: null,
      tombstonedAt: null,
      createdAt: at,
      updatedAt: at,
    },
    events: withEvent ? [{
      schemaVersion: 1 as const,
      id: "event-0",
      logicalSessionId: logicalSessionId as never,
      sequence: 0,
      kind: "user-message" as const,
      role: "user" as const,
      content: { role: "user", content: [{ type: "text", text: "question" }] },
      source: { platform: "dsh" as const, instanceId: "fixture", sessionId: "native", eventId: "0", cursor: "1" },
      contentDigest: "sha256:event-0",
      rawPayload: null,
      extensions: {},
    }] : [],
    workspaceId: null,
  };
}

function bridge(calls: string[]) {
  return new Alpha2RuntimeBridge({
    attach: async () => { calls.push("attach"); return { registrationId: `registration-${calls.length}`, attachedAt: at }; },
    drain: async (_registrationId, runId) => { calls.push("drain"); return { runId, pendingOperations: 0, receipts: [] }; },
    detach: async () => { calls.push("detach"); },
  });
}

describe("ProjectionLifecycle close and recovery", () => {
  it("drains, checkpoints, detaches and removes the temporary projection on a normal close", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-close-"));
    roots.push(root);
    const runs = new MemoryRuns();
    const statuses = new MemoryStatusEventAdapter();
    const calls: string[] = [];
    const checkpoints = { saveCheckpoint: vi.fn(async () => undefined) };
    let nextId = 0;
    const lifecycle = new ProjectionLifecycle({
      runRepository: runs,
      statusLog: new StatusLog(statuses, { clock: () => at, idFactory: (kind) => `${kind}-${++nextId}` }),
      source: { load: async (run) => ({ run, workspaces: [], sessions: [sourceSession("logical-close", false)] }) },
      adapter,
      bridge: bridge(calls),
      checkpointRepository: checkpoints,
      runtimeRoot: join(root, "runtime"),
      clock: () => at,
      idFactory: (kind) => `${kind}-${++nextId}`,
    });
    const handle = await lifecycle.openRun({
      instanceId: "alpha2-close",
      profileId: "alpha2",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });

    const closed = await lifecycle.closeRun(handle);
    expect(closed).toMatchObject({ runId: handle.run.id, state: "closed", removedProjection: true });
    expect(calls).toEqual(["attach", "drain", "drain", "detach"]);
    expect(checkpoints.saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(runs.runs.get(handle.run.id)).toMatchObject({ state: "closed", checkpointId: closed.checkpointId });
    await expect(access(dirname(handle.projectionRoot))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await statuses.list({ runId: handle.run.id, stage: "run.shutdown-recovery", limit: 20 })).items.map((event) => event.state)).toEqual(["started", "succeeded"]);
  });

  it("replays a pending WAL by operationId and cleans the projection after recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-recover-"));
    roots.push(root);
    const runs = new MemoryRuns();
    const statuses = new MemoryStatusEventAdapter();
    const calls: string[] = [];
    let unavailable = true;
    const appendDsh = vi.fn(async (input: { readonly logicalSessionId: string; readonly projection: { readonly operationId: OperationId } }) => {
      if (unavailable) throw new Error("synthetic Maintenance outage");
      return {
        outcome: "advanced" as const,
        operationId: input.projection.operationId,
        logicalSessionId: input.logicalSessionId as never,
        versionId: "version-recovered" as never,
        tombstoneState: null,
        committedAt: at,
      };
    });
    let nextId = 0;
    const runtimeBridge = bridge(calls);
    const lifecycle = new ProjectionLifecycle({
      runRepository: runs,
      statusLog: new StatusLog(statuses, { clock: () => at, idFactory: (kind) => `${kind}-${++nextId}` }),
      source: { load: async (run) => ({ run, workspaces: [], sessions: [sourceSession("logical-recover", true)] }) },
      adapter,
      bridge: runtimeBridge,
      canonicalEngine: { appendDsh },
      checkpointRepository: { saveCheckpoint: async () => undefined },
      runtimeRoot: join(root, "runtime"),
      clock: () => at,
      idFactory: (kind) => `${kind}-${++nextId}`,
    });
    const handle = await lifecycle.openRun({
      instanceId: "alpha2-recover",
      profileId: "alpha2",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    const operation = {
      runId: handle.run.id,
      operationId: "operation-recover" as OperationId,
      nativeSessionId: alpha2NativeSessionId("logical-recover" as never),
      nativeRevision: 2,
      observedAt: at,
      payload: {
        logicalSessionId: "logical-recover",
        baseVersionId: "version-base",
        events: [{ type: "assistant/message", seq: 1, time: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "answer" }] } } }],
      },
    } as const;
    await expect(runtimeBridge.submitAppend(operation)).rejects.toMatchObject({ code: "MAINTENANCE_APPEND_FAILED" });
    await runs.setProjectionRunState(handle.run.id, "recovery-required");
    unavailable = false;

    const recovered = await lifecycle.recover(handle.run.id);
    expect(recovered.state).toBe("recovered");
    expect(appendDsh).toHaveBeenCalledTimes(2);
    expect(runs.receipts.get(operation.operationId)).toMatchObject({ canonicalVersionId: "version-recovered" });
    expect(runs.runs.get(handle.run.id)?.state).toBe("recovered");
    await expect(access(dirname(handle.projectionRoot))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await statuses.list({ runId: handle.run.id, stage: "run.shutdown-recovery", limit: 20 })).items.map((event) => event.state)).toEqual(["started", "succeeded"]);
  });
});
