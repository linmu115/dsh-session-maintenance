import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { adapter } from "../../packages/adapter-dsh-alpha2/src/index.js";
import type { OperationId, ProjectionOperationReceipt, ProjectionRun, ProjectionRunRepository, ProjectionRunState, ProjectionSession, RunId } from "@linmu/dsh-session-contracts";
import { ProjectionLifecycle } from "../../packages/projection-lifecycle/src/index.js";
import { MemoryStatusEventAdapter, StatusLog } from "../../packages/session-status-log/src/index.js";

const roots: string[] = [];
const at = "2026-08-31T00:00:00.000Z";
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class MemoryRuns implements ProjectionRunRepository {
  readonly runs = new Map<string, ProjectionRun>();
  readonly sessions = new Map<string, ProjectionSession>();
  async createProjectionRun(input: ProjectionRun) { this.runs.set(input.id, input); return input; }
  async getProjectionRun(id: RunId) { return this.runs.get(id); }
  async setProjectionRunState(id: RunId, state: ProjectionRunState) { this.runs.set(id, { ...this.runs.get(id)!, state }); }
  async upsertProjectionSession(input: ProjectionSession) { this.sessions.set(`${input.runId}:${input.nativeSessionId}`, input); }
  async saveOperationReceipt(_input: ProjectionOperationReceipt) {}
  async getOperationReceipt(_id: OperationId) { return undefined; }
}

describe("active projection delete boundary", () => {
  it("drains accepted writes before hiding the native projection and records P8", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-delete-projection-"));
    roots.push(root);
    const runs = new MemoryRuns();
    const statuses = new MemoryStatusEventAdapter();
    const calls: string[] = [];
    let nextId = 0;
    const lifecycle = new ProjectionLifecycle({
      runRepository: runs,
      statusLog: new StatusLog(statuses, { clock: () => at, idFactory: (kind) => `${kind}-${++nextId}` }),
      source: { load: async (run) => ({ run, workspaces: [], sessions: [{
        session: { schemaVersion: 1, id: "logical-delete" as never, authorityScope: "maintenance", originKind: "maintenance-native", headVersionId: null, title: "删除断点", tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at },
        events: [], workspaceId: null,
      }] }) },
      adapter,
      bridge: {
        attach: async (context) => { calls.push("attach"); return { runId: context.run.id, adapterId: adapter.manifest.id, attachedAt: at }; },
        drain: async (handle) => ({ runId: handle.runId, pendingOperations: 0, receipts: [] }),
        drainSession: async (handle, nativeSessionId) => { calls.push(`drain:${nativeSessionId}`); return { runId: handle.runId, pendingOperations: 0, receipts: [] }; },
        hideSession: async (_handle, nativeSessionId) => { calls.push(`hide:${nativeSessionId}`); },
        detach: async () => undefined,
      },
      runtimeRoot: join(root, "runtime"),
      clock: () => at,
      idFactory: (kind) => `${kind}-${++nextId}`,
    });
    const handle = await lifecycle.openRun({ instanceId: "alpha2", profileId: "alpha2", dshVersion: "0.1.2-alpha.2", branchId: "main" as never, maintenanceEndpoint: "http://127.0.0.1:41781" });
    const hidden = await lifecycle.hideSession(handle, "logical-delete");
    expect(hidden.mode).toBe("hidden");
    expect(calls).toEqual(["attach", `drain:${hidden.nativeSessionId}`, `hide:${hidden.nativeSessionId}`]);
    expect([...runs.sessions.values()][0]?.mode).toBe("hidden");
    expect((await statuses.list({ runId: handle.run.id, stage: "run.shutdown-recovery", limit: 20 })).items.map((event) => event.state)).toEqual(["started", "succeeded"]);
  });
});
