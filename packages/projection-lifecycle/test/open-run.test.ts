import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type {
  OperationId,
  ProjectionOperationReceipt,
  ProjectionRun,
  ProjectionRunRepository,
  ProjectionRunState,
  ProjectionSession,
  RunId,
} from "@linmu/dsh-session-contracts";
import { adapter } from "@linmu/dsh-session-adapter-alpha2";
import { MemoryStatusEventAdapter, StatusLog } from "@linmu/dsh-session-status-log";

import { ProjectionLifecycle, ProjectionLifecycleError } from "../src/index.js";

const roots: string[] = [];
const at = "2026-08-31T00:00:00.000Z";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryRuns implements ProjectionRunRepository {
  readonly runs = new Map<string, ProjectionRun>();

  async createProjectionRun(input: ProjectionRun): Promise<ProjectionRun> {
    if (this.runs.has(input.id)) throw new Error("duplicate run");
    this.runs.set(input.id, input);
    return input;
  }

  async getProjectionRun(id: RunId): Promise<ProjectionRun | undefined> { return this.runs.get(id); }

  async setProjectionRunState(id: RunId, state: ProjectionRunState): Promise<void> {
    const current = this.runs.get(id);
    if (current === undefined) throw new Error("run not found");
    const active = new Set(["preparing", "running", "draining", "verifying", "recovery-required", "recovering", "cleanup-pending"]);
    if (active.has(state) && [...this.runs.values()].some((run) => run.id !== id && run.branchId === current.branchId && active.has(run.state))) {
      const error = new Error("active writer branch lease is held") as Error & { code?: string };
      error.code = "SQLITE_CONSTRAINT_UNIQUE";
      throw error;
    }
    this.runs.set(id, { ...current, state });
  }

  async upsertProjectionSession(_input: ProjectionSession): Promise<void> {}
  async saveOperationReceipt(_input: ProjectionOperationReceipt): Promise<void> {}
  async getOperationReceipt(_operationId: OperationId): Promise<ProjectionOperationReceipt | undefined> { return undefined; }
}

describe("ProjectionLifecycle.openRun", () => {
  it("passes P1-P3 in order, materializes outside the profile and rejects a second writer lease", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-open-run-"));
    roots.push(root);
    const runtimeRoot = join(root, "maintenance-runtime");
    const profileRoot = join(root, "launcher-profile");
    const runRepository = new MemoryRuns();
    const statusAdapter = new MemoryStatusEventAdapter();
    let nextId = 0;
    const calls: string[] = [];
    const bridge = {
      attach: async (context: { readonly run: ProjectionRun }) => {
        calls.push("attach");
        return { runId: context.run.id, adapterId: adapter.manifest.id, attachedAt: at };
      },
      drain: async (handle: { readonly runId: RunId }) => ({ runId: handle.runId, pendingOperations: 0, receipts: [] }),
      detach: async () => undefined,
    };
    const lifecycle = new ProjectionLifecycle({
      runRepository,
      statusLog: new StatusLog(statusAdapter, {
        clock: () => at,
        idFactory: (kind) => `${kind}-${String(++nextId).padStart(3, "0")}`,
      }),
      source: {
        load: async (run) => ({
          run,
          workspaces: [],
          sessions: [{
            session: {
              schemaVersion: 1,
              id: "logical-open-run" as never,
              authorityScope: "maintenance",
              originKind: "maintenance-native",
              headVersionId: null,
              title: "Synthetic open run",
              tags: [],
              archivedAt: null,
              tombstonedAt: null,
              createdAt: at,
              updatedAt: at,
            },
            events: [],
            workspaceId: null,
          }],
        }),
      },
      adapter,
      bridge,
      runtimeRoot,
      clock: () => at,
      idFactory: (kind) => `${kind}-${String(++nextId).padStart(3, "0")}`,
    });
    const first = await lifecycle.openRun({
      instanceId: "launcher-alpha2",
      profileId: "alpha2",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });

    expect(first.run.state).toBe("running");
    expect(first.manifest.sessionCount).toBe(1);
    expect(calls).toEqual(["attach"]);
    const events = (await statusAdapter.list({ runId: first.run.id, limit: 100 })).items;
    expect(events.map((event) => `${event.stage}:${event.state}`)).toEqual([
      "run.lease:started",
      "run.lease:succeeded",
      "projection.materialize:started",
      "projection.materialize:succeeded",
      "runtime.persistence.attach:started",
      "runtime.persistence.attach:succeeded",
    ]);
    await expect(access(join(profileRoot, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(first.projectionRoot.startsWith(runtimeRoot)).toBe(true);

    await expect(lifecycle.openRun({
      instanceId: "launcher-alpha2-second",
      profileId: "alpha2",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    })).rejects.toMatchObject<Partial<ProjectionLifecycleError>>({ code: "LEASE_HELD" });
    const failed = [...runRepository.runs.values()].find((run) => run.id !== first.run.id)!;
    expect(failed.state).toBe("quarantined");
    const failedEvents = (await statusAdapter.list({ runId: failed.id, limit: 100 })).items;
    expect(failedEvents.map((event) => `${event.stage}:${event.state}`)).toEqual([
      "run.lease:started",
      "run.lease:failed",
    ]);
  });
});
