import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  adapter,
  alpha2NativeSessionId,
  Alpha2RuntimeBridge,
} from "@linmu/dsh-session-adapter-alpha2";
import type {
  CanonicalChangePage,
  CanonicalChangeQuery,
  CanonicalEventV1,
  CanonicalProjectionInput,
  NativeAppendOperation,
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
  projectionCacheIdentity,
  projectionCacheRootFor,
  type IncrementalCanonicalProjectionSource,
} from "../src/index.js";

const roots: string[] = [];
const at = "2026-09-03T00:00:00.000Z";

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
    const current = this.runs.get(id);
    if (current === undefined) throw new Error("run not found");
    this.runs.set(id, { ...current, state });
  }
  async setProjectionRunCheckpoint(id: RunId, checkpointId: string) {
    const current = this.runs.get(id);
    if (current === undefined) throw new Error("run not found");
    this.runs.set(id, { ...current, checkpointId: checkpointId as never });
  }
  async listProjectionSessions(runId: RunId) {
    return [...this.sessions.values()].filter((session) => session.runId === runId);
  }
  async upsertProjectionSession(input: ProjectionSession) { this.sessions.set(`${input.runId}:${input.nativeSessionId}`, input); }
  async saveOperationReceipt(input: ProjectionOperationReceipt) { this.receipts.set(input.operationId, input); }
  async getOperationReceipt(id: OperationId) { return this.receipts.get(id); }
}

class UnchangedSource implements IncrementalCanonicalProjectionSource {
  revision = 1;
  headVersionId: string | null = null;
  updatedAt = at;
  events: readonly CanonicalEventV1[] = [];
  readonly changes = [{
    schemaVersion: 1 as const,
    revision: 1,
    logicalSessionId: "logical-retained" as never,
    kind: "session-created" as const,
    changedAt: at,
  }];
  fullLoads = 0;
  selectedLoads = 0;

  async currentRevision() { return this.revision; }
  async listChanges(input: CanonicalChangeQuery): Promise<CanonicalChangePage> {
    const changes = this.changes.filter((change) => change.revision > input.afterRevision).slice(0, input.limit);
    return {
      schemaVersion: 1,
      afterRevision: input.afterRevision,
      throughRevision: changes.at(-1)?.revision ?? input.afterRevision,
      currentRevision: this.revision,
      hasMore: (changes.at(-1)?.revision ?? input.afterRevision) < this.revision,
      changes,
    };
  }
  async load(run: ProjectionRun): Promise<CanonicalProjectionInput> {
    this.fullLoads += 1;
    return this.payload(run);
  }
  async loadSessions(run: ProjectionRun, ids: readonly string[]): Promise<CanonicalProjectionInput> {
    this.selectedLoads += 1;
    return ids.includes("logical-retained") ? this.payload(run) : { run, workspaces: [], sessions: [] };
  }
  commit(events: readonly CanonicalEventV1[]): void {
    this.revision += 1;
    this.headVersionId = "version-retained-1";
    this.updatedAt = "2026-09-03T00:01:00.000Z";
    this.events = events;
    this.changes.push({
      schemaVersion: 1,
      revision: this.revision,
      logicalSessionId: "logical-retained" as never,
      kind: "content-updated",
      changedAt: this.updatedAt,
    });
  }
  private payload(run: ProjectionRun): CanonicalProjectionInput {
    return {
      run,
      workspaces: [],
      sessions: [{
        session: {
          schemaVersion: 1,
          id: "logical-retained" as never,
          authorityScope: "maintenance",
          originKind: "maintenance-native",
          headVersionId: this.headVersionId as never,
          title: "Retained projection",
          tags: [],
          archivedAt: null,
          tombstonedAt: null,
          createdAt: at,
          updatedAt: this.updatedAt,
        },
        events: this.events,
        workspaceId: null,
        projectId: null,
        projectName: null,
        projectRoot: null,
      }],
    };
  }
}

function runtimeBridge() {
  return new Alpha2RuntimeBridge({
    attach: async ({ runId }) => ({ registrationId: `registration-${runId}`, attachedAt: at }),
    drain: async (_registrationId, runId) => ({ runId, pendingOperations: 0, receipts: [] }),
    detach: async () => undefined,
  });
}

describe("persistent ProjectionLifecycle", () => {
  it("retains one Alpha2 format cache across clean runs and removes only run-local state", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-persistent-lifecycle-"));
    roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const source = new UnchangedSource();
    const runs = new MemoryRuns();
    const statuses = new MemoryStatusEventAdapter();
    let sequence = 0;
    const lifecycle = new ProjectionLifecycle({
      runRepository: runs,
      statusLog: new StatusLog(statuses, { clock: () => at, idFactory: (kind) => `${kind}-${++sequence}` }),
      source,
      adapter,
      bridge: runtimeBridge(),
      checkpointRepository: { saveCheckpoint: async () => undefined },
      runtimeRoot,
      clock: () => at,
      idFactory: (kind) => `${kind}-${++sequence}`,
    });
    const open = () => lifecycle.openRun({
      instanceId: "alpha2-retained",
      profileId: "web",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });

    const first = await open();
    const identity = projectionCacheIdentity(adapter, { branchId: "main" });
    const cacheRoot = projectionCacheRootFor(runtimeRoot, adapter.manifest.id, identity.configurationDigest);
    const cachedSession = join(cacheRoot, "sessions", `${Buffer.from(alpha2NativeSessionId("logical-retained" as never), "utf8").toString("base64url")}.json`);
    const firstMtime = (await stat(cachedSession, { bigint: true })).mtimeNs;
    expect(first.projectionRoot).not.toBe(cacheRoot);

    await lifecycle.closeRun(first);
    await access(cacheRoot);
    await expect(access(dirname(first.projectionRoot))).rejects.toMatchObject({ code: "ENOENT" });
    const catalogMtime = (await stat(join(cacheRoot, "session-catalog.json"), { bigint: true })).mtimeNs;

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const second = await open();
    expect(second.projectionRoot).not.toBe(first.projectionRoot);
    expect(source.fullLoads).toBe(1);
    expect(source.selectedLoads).toBe(0);
    expect((await stat(cachedSession, { bigint: true })).mtimeNs).toBe(firstMtime);
    expect((await stat(join(cacheRoot, "session-catalog.json"), { bigint: true })).mtimeNs).toBe(catalogMtime);
    await lifecycle.closeRun(second);

    const retained = (await statuses.list({ stage: "projection.cache-retained" as never, limit: 20 })).items;
    expect(retained.filter((event) => event.state === "succeeded")).toHaveLength(2);
  });

  it("keeps runtime appends in the sparse overlay until their durable canonical change refreshes the cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-persistent-overlay-"));
    roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const source = new UnchangedSource();
    const runs = new MemoryRuns();
    const statuses = new MemoryStatusEventAdapter();
    const bridge = runtimeBridge();
    let sequence = 0;
    const lifecycle = new ProjectionLifecycle({
      runRepository: runs,
      statusLog: new StatusLog(statuses, { clock: () => at, idFactory: (kind) => `${kind}-${++sequence}` }),
      source,
      adapter,
      bridge,
      canonicalEngine: {
        appendDsh: async (input: { readonly appendedEvents: readonly CanonicalEventV1[]; readonly projection: { readonly operationId: OperationId }; readonly logicalSessionId: string }) => {
          source.commit(input.appendedEvents);
          return {
            outcome: "advanced" as const,
            operationId: input.projection.operationId,
            logicalSessionId: input.logicalSessionId as never,
            versionId: "version-retained-1" as never,
            tombstoneState: null,
            committedAt: source.updatedAt,
          };
        },
      },
      checkpointRepository: { saveCheckpoint: async () => undefined },
      runtimeRoot,
      clock: () => at,
      idFactory: (kind) => `${kind}-${++sequence}`,
    });
    const handle = await lifecycle.openRun({
      instanceId: "alpha2-overlay",
      profileId: "web",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    const identity = projectionCacheIdentity(adapter, { branchId: "main" });
    const cacheRoot = projectionCacheRootFor(runtimeRoot, adapter.manifest.id, identity.configurationDigest);
    const nativeSessionId = alpha2NativeSessionId("logical-retained" as never);
    const operation: NativeAppendOperation = {
      runId: handle.run.id,
      operationId: "operation-retained-append" as never,
      nativeSessionId,
      nativeRevision: 1,
      observedAt: source.updatedAt,
      payload: {
        logicalSessionId: "logical-retained",
        baseVersionId: null,
        events: [{
          type: "user/message",
          seq: 0,
          time: Date.parse(source.updatedAt),
          data: { role: "user", content: [{ type: "text", text: "overlay append" }] },
          surfaceOp: "append",
        }],
      },
    };

    await lifecycle.append(handle, operation);
    const baseBeforeClose = await new JsonProjectionDirectory(cacheRoot).readSession(nativeSessionId) as { readonly events: readonly unknown[] };
    const overlayBeforeClose = await new JsonProjectionDirectory(handle.projectionRoot).readSession(nativeSessionId) as { readonly events: readonly unknown[] };
    expect(baseBeforeClose.events).toHaveLength(0);
    expect(overlayBeforeClose.events).toHaveLength(1);

    await lifecycle.closeRun(handle);
    const baseAfterClose = await new JsonProjectionDirectory(cacheRoot).readSession(nativeSessionId) as { readonly events: readonly unknown[] };
    expect(baseAfterClose.events).toHaveLength(1);
    expect(source.fullLoads).toBe(1);
    expect(source.selectedLoads).toBe(1);
    await expect(access(dirname(handle.projectionRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays a projection-applied WAL before refreshing and removing a crashed run overlay", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-persistent-recovery-"));
    roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const source = new UnchangedSource();
    const runs = new MemoryRuns();
    const statuses = new MemoryStatusEventAdapter();
    let sequence = 0;
    let maintenanceAvailable = false;
    const canonicalEngine = {
      appendDsh: async (input: { readonly appendedEvents: readonly CanonicalEventV1[]; readonly projection: { readonly operationId: OperationId }; readonly logicalSessionId: string }) => {
        if (!maintenanceAvailable) throw new Error("synthetic canonical outage");
        source.commit(input.appendedEvents);
        return {
          outcome: "advanced" as const,
          operationId: input.projection.operationId,
          logicalSessionId: input.logicalSessionId as never,
          versionId: "version-retained-1" as never,
          tombstoneState: null,
          committedAt: source.updatedAt,
        };
      },
    };
    const lifecycleInput = {
      runRepository: runs,
      statusLog: new StatusLog(statuses, { clock: () => at, idFactory: (kind: string) => `${kind}-${++sequence}` }),
      source,
      adapter,
      canonicalEngine,
      checkpointRepository: { saveCheckpoint: async () => undefined },
      runtimeRoot,
      clock: () => at,
      idFactory: (kind: "run" | "lease") => `${kind}-${++sequence}`,
    };
    const firstLifecycle = new ProjectionLifecycle({ ...lifecycleInput, bridge: runtimeBridge() });
    const handle = await firstLifecycle.openRun({
      instanceId: "alpha2-recovery",
      profileId: "web",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    const nativeSessionId = alpha2NativeSessionId("logical-retained" as never);
    const operation: NativeAppendOperation = {
      runId: handle.run.id,
      operationId: "operation-pending-recovery" as never,
      nativeSessionId,
      nativeRevision: 1,
      observedAt: source.updatedAt,
      payload: {
        logicalSessionId: "logical-retained",
        baseVersionId: null,
        events: [{
          type: "user/message",
          seq: 0,
          time: Date.parse(source.updatedAt),
          data: { role: "user", content: [{ type: "text", text: "recover me" }] },
          surfaceOp: "append",
        }],
      },
    };
    await expect(firstLifecycle.append(handle, operation)).rejects.toThrow("durable Maintenance receipt");
    expect(await new ProjectionWriteAheadLog(handle.projectionRoot).pending()).toHaveLength(1);

    maintenanceAvailable = true;
    const recoveryLifecycle = new ProjectionLifecycle({ ...lifecycleInput, bridge: runtimeBridge() });
    const receipt = await recoveryLifecycle.recover(handle.run.id);
    expect(receipt).toMatchObject({ state: "recovered", removedProjection: true });
    expect(await new ProjectionWriteAheadLog(handle.projectionRoot).pending()).toHaveLength(0);
    const identity = projectionCacheIdentity(adapter, { branchId: "main" });
    const cacheRoot = projectionCacheRootFor(runtimeRoot, adapter.manifest.id, identity.configurationDigest);
    const cached = await new JsonProjectionDirectory(cacheRoot).readSession(nativeSessionId) as { readonly events: readonly unknown[] };
    expect(cached.events).toHaveLength(1);
    await expect(access(dirname(handle.projectionRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
