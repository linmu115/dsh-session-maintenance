import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type {
  AdapterId,
  BranchId,
  NativeAppendOperation,
  NativeSessionId,
  ProjectionOperationReceipt,
  RunId,
} from "@linmu/dsh-session-contracts";
import {
  RUNTIME_MANAGED_PROJECT_DIRECTORY,
  runtimeManagedProjectSegment,
} from "@linmu/dsh-session-contracts";
import { JsonProjectionDirectory } from "@linmu/dsh-session-projection-lifecycle";

import { ProjectionRuntimeBroker } from "../src/runtime-broker.js";

const runId = "run-broker-test" as RunId;
const nativeSessionId = "native-broker-test" as NativeSessionId;

function request() {
  return {
    schemaVersion: 1 as const,
    client: { kind: "launcher" as const, id: "client-launcher-test" },
    runtimeClientId: "client-plugin-test",
    instanceId: "alpha2-test",
    profileId: "web",
    dshVersion: "0.1.2-alpha.2",
    maintenanceEndpoint: "http://127.0.0.1:41781",
    branchId: "main" as BranchId,
    environment: {
      packageVersions: { "@deepseek-ai/dsh-session": "0.1.2-alpha.2" },
      runtimeCapabilities: ["sessionPersistence", "session/event", "session/flush"],
    },
    pinnedAdapterId: null,
    projectSelection: { kind: "all" as const },
  };
}

describe("ProjectionRuntimeBroker", () => {
  it("keeps P3 pending until the runtime acknowledges the prepared temporary root", async () => {
    const calls: string[] = [];
    const lifecycle = {
      prepareRun: async () => ({
        run: { id: runId, leaseId: "lease-test", state: "preparing" },
        projectionRoot: "D:/synthetic/projection-run",
        manifest: {}, inspection: {}, verification: {}, maintenanceEndpoint: "runtime-broker",
      }),
      attachRun: async (prepared: { run: { id: RunId } }) => {
        calls.push(`attach:${prepared.run.id}`);
        return { ...prepared, run: { ...prepared.run, state: "running" }, runtime: {} };
      },
    };
    const broker = new ProjectionRuntimeBroker({
      lifecycleFactory: () => lifecycle as never,
      selectAdapter: async () => "dsh-alpha2" as AdapterId,
      statusLog: { start: async () => ({ event: {} }), succeed: async () => undefined, fail: async () => undefined } as never,
      projectResolver: { resolveProject: async () => "project-test", assignProject: async () => undefined } as never,
    });

    const prepared = await broker.prepareRun(request());
    expect(prepared).toMatchObject({ runId, state: "preparing", temporaryPersistenceRootId: `projection:${runId}` });
    expect(calls).toEqual([]);
    await expect(broker.attachRun({
      schemaVersion: 1,
      clientId: request().runtimeClientId,
      runId,
      temporaryPersistenceRootId: "projection:another-run",
      attachedAt: "2026-09-01T00:00:00.000Z",
    })).rejects.toThrow("does not match");
    await broker.attachRun({
      schemaVersion: 1,
      clientId: request().runtimeClientId,
      runId,
      temporaryPersistenceRootId: prepared.temporaryPersistenceRootId,
      attachedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(calls).toEqual([`attach:${runId}`]);
  });

  it("makes flush and close wait for the per-session canonical commit", async () => {
    let resolveAppend!: (receipt: ProjectionOperationReceipt) => void;
    const appendPromise = new Promise<ProjectionOperationReceipt>((resolve) => { resolveAppend = resolve; });
    const calls: string[] = [];
    const lifecycle = {
      prepareRun: async () => ({
        run: { id: runId, leaseId: "lease-test", state: "preparing" },
        projectionRoot: "D:/synthetic/projection-run",
        manifest: {}, inspection: {}, verification: {}, maintenanceEndpoint: "runtime-broker",
      }),
      attachRun: async (prepared: object) => ({ ...prepared, run: { id: runId, state: "running" }, runtime: {} }),
      append: async () => appendPromise,
      closeRun: async () => { calls.push("checkpoint-cleanup"); return { state: "closed", removedProjection: true }; },
    };
    const broker = new ProjectionRuntimeBroker({
      lifecycleFactory: () => lifecycle as never,
      selectAdapter: async () => "dsh-alpha2" as AdapterId,
      statusLog: { start: async () => ({ event: {} }), succeed: async () => undefined, fail: async () => undefined } as never,
      projectResolver: { resolveProject: async () => "project-test", assignProject: async () => undefined } as never,
    });
    const prepared = await broker.prepareRun(request());
    await broker.attachRun({ schemaVersion: 1, clientId: request().runtimeClientId, runId, temporaryPersistenceRootId: prepared.temporaryPersistenceRootId, attachedAt: "2026-09-01T00:00:00.000Z" });
    const operation = {
      runId,
      operationId: "operation-broker-test",
      nativeSessionId,
      nativeRevision: 1,
      payload: { logicalSessionId: "logical-test", events: [] },
      observedAt: "2026-09-01T00:00:00.000Z",
    } as NativeAppendOperation;
    const append = broker.append(request().runtimeClientId, operation);
    const flush = broker.flush({ schemaVersion: 1, clientId: request().runtimeClientId, runId, nativeSessionId });
    await expect(broker.closeRun({
      schemaVersion: 1,
      clientId: request().client.id,
      runId,
      reason: "normal",
    })).rejects.toThrow("runtime-drained acknowledgement");
    const drain = broker.drainRun({ schemaVersion: 1, clientId: request().runtimeClientId, runId, runtimeFlushCompletedAt: "2026-09-01T00:00:00.000Z" });
    await Promise.resolve();
    expect(calls).toEqual([]);
    resolveAppend({ schemaVersion: 1, operationId: operation.operationId, runId, nativeSessionId, logicalSessionId: "logical-test" as never, canonicalVersionId: null, projectionRevision: 1, committedAt: operation.observedAt, status: "committed" });
    await expect(append).resolves.toMatchObject({ status: "committed" });
    await expect(flush).resolves.toMatchObject({ pendingOperations: 0 });
    await expect(drain).resolves.toMatchObject({ state: "drained", pendingOperations: 0 });
    const close = broker.closeRun({ schemaVersion: 1, clientId: request().client.id, runId, reason: "normal" });
    await expect(close).resolves.toMatchObject({ state: "closed", removedProjection: true });
    expect(calls).toEqual(["checkpoint-cleanup"]);
  });

  it("registers a DSH-created native session before accepting its first live event", async () => {
    const registrations: unknown[] = [];
    const assignments: unknown[] = [];
    const lifecycle = {
      prepareRun: async () => ({
        run: { id: runId, leaseId: "lease-test", instanceId: "alpha2-test", state: "preparing" },
        projectionRoot: "D:/synthetic/projection-run",
        manifest: {}, inspection: {}, verification: {}, maintenanceEndpoint: "runtime-broker",
      }),
      attachRun: async (prepared: object) => ({ ...prepared, run: { id: runId, state: "running" }, runtime: {} }),
      registerNativeSession: async (_active: unknown, registration: unknown) => {
        registrations.push(registration);
        return {
          logicalSessionId: (registration as { logicalSessionId: string }).logicalSessionId,
          baseVersionId: "version-live-created",
        };
      },
      append: async (_active: unknown, operation: NativeAppendOperation) => ({
        schemaVersion: 1,
        operationId: operation.operationId,
        runId,
        nativeSessionId,
        logicalSessionId: (operation.payload as { logicalSessionId: string }).logicalSessionId,
        canonicalVersionId: null,
        projectionRevision: operation.nativeRevision,
        committedAt: operation.observedAt,
        status: "committed",
      }),
    };
    const broker = new ProjectionRuntimeBroker({
      lifecycleFactory: () => lifecycle as never,
      selectAdapter: async () => "dsh-alpha2" as AdapterId,
      statusLog: { start: async () => ({ event: {} }), succeed: async () => undefined, fail: async () => undefined } as never,
      projectResolver: {
        resolveProject: async () => "project-deepseek",
        assignProject: async (logicalSessionId: string, projectId: string) => { assignments.push({ logicalSessionId, projectId }); },
      } as never,
    });
    const prepared = await broker.prepareRun(request());
    await broker.attachRun({
      schemaVersion: 1,
      clientId: request().runtimeClientId,
      runId,
      temporaryPersistenceRootId: prepared.temporaryPersistenceRootId,
      attachedAt: "2026-09-01T00:00:00.000Z",
    });
    const header = { version: 0, id: nativeSessionId, cwd: "D:/synthetic/project-root" };
    const registered = await broker.registerSession({
      schemaVersion: 1,
      clientId: request().runtimeClientId,
      runId,
      nativeSessionId,
      header,
      title: "DSH live-created session",
    });

    expect(registered).toMatchObject({ nativeSessionId, baseVersionId: "version-live-created" });
    expect(registrations).toEqual([expect.objectContaining({
      nativeSessionId,
      logicalSessionId: registered.logicalSessionId,
      header,
      title: "DSH live-created session",
      workspaceId: null,
      projectId: "project-deepseek",
    })]);
    await broker.append(request().runtimeClientId, {
      runId,
      operationId: "operation-live-created" as never,
      nativeSessionId,
      nativeRevision: 1,
      payload: { logicalSessionId: registered.logicalSessionId, events: [{ seq: 0, type: "message" }] },
      observedAt: "2026-09-01T00:00:01.000Z",
    });
    expect(assignments).toEqual([{ logicalSessionId: registered.logicalSessionId, projectId: "project-deepseek" }]);
  });

  it("maps a live-created session in a run-scoped managed cwd back to its canonical project", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-maintenance-managed-project-"));
    const projectionRoot = join(root, "projection");
    const projectId = "project-codex-import";
    const registrations: Array<{ readonly projectId: string }> = [];
    const lifecycle = {
      prepareRun: async () => ({
        run: { id: runId, leaseId: "lease-test", instanceId: "alpha2-test", state: "preparing" },
        projectionRoot,
        manifest: {}, inspection: {}, verification: {}, maintenanceEndpoint: "runtime-broker",
      }),
      attachRun: async (prepared: object) => ({ ...prepared, run: { id: runId, state: "running" }, runtime: {} }),
      registerNativeSession: async (_active: unknown, registration: { readonly logicalSessionId: string; readonly projectId: string }) => {
        registrations.push(registration);
        return { logicalSessionId: registration.logicalSessionId };
      },
    };
    const broker = new ProjectionRuntimeBroker({
      lifecycleFactory: () => lifecycle as never,
      selectAdapter: async () => "dsh-alpha2" as AdapterId,
      statusLog: { start: async () => ({ event: {} }), succeed: async () => undefined, fail: async () => undefined } as never,
      projectResolver: { resolveProject: async () => null, assignProject: async () => undefined } as never,
    });
    try {
      const prepared = await broker.prepareRun(request());
      const directory = new JsonProjectionDirectory(projectionRoot);
      await directory.initialize();
      await directory.writeSession("native-canonical-source" as NativeSessionId, {
        projectId,
        updatedAt: "2026-09-01T00:00:00.000Z",
        header: { version: 0, id: "native-canonical-source", createdAt: 1 },
        events: [],
      });
      await directory.rebuildSessionCatalog(runId);
      await broker.attachRun({
        schemaVersion: 1,
        clientId: request().runtimeClientId,
        runId,
        temporaryPersistenceRootId: prepared.temporaryPersistenceRootId,
        attachedAt: "2026-09-01T00:00:00.000Z",
      });
      const managedCwd = join(
        projectionRoot,
        RUNTIME_MANAGED_PROJECT_DIRECTORY,
        runtimeManagedProjectSegment(projectId),
      );
      await expect(broker.registerSession({
        schemaVersion: 1,
        clientId: request().runtimeClientId,
        runId,
        nativeSessionId,
        header: { version: 0, id: nativeSessionId, cwd: managedCwd },
        title: "Derived in DSH",
      })).resolves.toMatchObject({ nativeSessionId });
      expect(registrations).toEqual([expect.objectContaining({ projectId })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inherits the projected Codex project's membership when the first DSH write derives a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-maintenance-derived-project-"));
    const projectionRoot = join(root, "projection");
    const projectId = "project-codex-parent";
    const assignments: unknown[] = [];
    const lifecycle = {
      prepareRun: async () => ({
        run: { id: runId, leaseId: "lease-test", instanceId: "alpha2-test", state: "preparing" },
        projectionRoot,
        manifest: {}, inspection: {}, verification: {}, maintenanceEndpoint: "runtime-broker",
      }),
      attachRun: async (prepared: object) => ({ ...prepared, run: { id: runId, state: "running" }, runtime: {} }),
      append: async (_active: unknown, operation: NativeAppendOperation) => ({
        schemaVersion: 1 as const,
        operationId: operation.operationId,
        runId,
        nativeSessionId,
        logicalSessionId: "logical-derived-child",
        canonicalVersionId: "version-derived-child",
        projectionRevision: operation.nativeRevision,
        committedAt: operation.observedAt,
        status: "committed" as const,
      }),
    };
    const broker = new ProjectionRuntimeBroker({
      lifecycleFactory: () => lifecycle as never,
      selectAdapter: async () => "dsh-alpha2" as AdapterId,
      statusLog: { start: async () => ({ event: {} }), succeed: async () => undefined, fail: async () => undefined } as never,
      projectResolver: {
        resolveProject: async () => null,
        assignProject: async (logicalSessionId: string, assignedProjectId: string) => {
          assignments.push({ logicalSessionId, projectId: assignedProjectId });
        },
      } as never,
    });
    try {
      const prepared = await broker.prepareRun(request());
      const directory = new JsonProjectionDirectory(projectionRoot);
      await directory.initialize();
      await directory.writeSession(nativeSessionId, {
        logicalSessionId: "logical-codex-parent",
        baseVersionId: "version-codex-parent",
        projectId,
        updatedAt: "2026-09-01T00:00:00.000Z",
        header: { version: 0, id: nativeSessionId, createdAt: 1 },
        events: [],
      });
      await directory.rebuildSessionCatalog(runId);
      await broker.attachRun({
        schemaVersion: 1,
        clientId: request().runtimeClientId,
        runId,
        temporaryPersistenceRootId: prepared.temporaryPersistenceRootId,
        attachedAt: "2026-09-01T00:00:00.000Z",
      });
      await broker.append(request().runtimeClientId, {
        runId,
        operationId: "operation-derived-project" as never,
        nativeSessionId,
        nativeRevision: 1,
        payload: { logicalSessionId: "logical-codex-parent", baseVersionId: "version-codex-parent", events: [] },
        observedAt: "2026-09-01T00:00:01.000Z",
      });
      expect(assignments).toEqual([{ logicalSessionId: "logical-derived-child", projectId }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses recovery instead of normal close when the runtime did not drain", async () => {
    const calls: string[] = [];
    const lifecycle = {
      prepareRun: async () => ({
        run: { id: runId, leaseId: "lease-test", state: "preparing" },
        projectionRoot: "D:/synthetic/projection-run",
        manifest: {}, inspection: {}, verification: {}, maintenanceEndpoint: "runtime-broker",
      }),
      attachRun: async (prepared: object) => ({ ...prepared, run: { id: runId, state: "running" }, runtime: {} }),
      recover: async () => {
        calls.push("tail-reconcile-checkpoint-cleanup");
        return { state: "recovered", removedProjection: true };
      },
    };
    const broker = new ProjectionRuntimeBroker({
      lifecycleFactory: () => lifecycle as never,
      selectAdapter: async () => "dsh-alpha2" as AdapterId,
      statusLog: { start: async () => ({ event: {} }), succeed: async () => undefined, fail: async () => undefined } as never,
      projectResolver: { resolveProject: async () => "project-test", assignProject: async () => undefined } as never,
    });
    const prepared = await broker.prepareRun(request());
    await broker.attachRun({
      schemaVersion: 1,
      clientId: request().runtimeClientId,
      runId,
      temporaryPersistenceRootId: prepared.temporaryPersistenceRootId,
      attachedAt: "2026-09-01T00:00:00.000Z",
    });
    await expect(broker.closeRun({
      schemaVersion: 1,
      clientId: request().client.id,
      runId,
      reason: "recovery",
    })).resolves.toMatchObject({ state: "recovered", removedProjection: true });
    expect(calls).toEqual(["tail-reconcile-checkpoint-cleanup"]);
  });

  it("discards a materialized projection without attaching or re-inspecting it when launch aborts", async () => {
    const calls: string[] = [];
    const lifecycle = {
      prepareRun: async () => ({
        run: { id: runId, leaseId: "lease-test", state: "preparing" },
        projectionRoot: "D:/synthetic/projection-run",
        manifest: {}, inspection: {}, verification: {}, maintenanceEndpoint: "runtime-broker",
      }),
      discardPreparedRun: async (discardedRunId: RunId) => {
        calls.push(`discard:${discardedRunId}`);
        return { runId: discardedRunId, state: "recovered", removedProjection: true };
      },
      recover: async () => {
        calls.push("unexpected-full-recovery");
        return { state: "recovered", removedProjection: true };
      },
    };
    const broker = new ProjectionRuntimeBroker({
      lifecycleFactory: () => lifecycle as never,
      selectAdapter: async () => "dsh-alpha2" as AdapterId,
      statusLog: { start: async () => ({ event: {} }), succeed: async () => undefined, fail: async () => undefined } as never,
      projectResolver: { resolveProject: async () => "project-test", assignProject: async () => undefined } as never,
    });
    await broker.prepareRun(request());
    await expect(broker.closeRun({
      schemaVersion: 1,
      clientId: request().client.id,
      runId,
      reason: "recovery",
    })).resolves.toMatchObject({ state: "recovered", removedProjection: true });
    expect(calls).toEqual([`discard:${runId}`]);
  });
});
