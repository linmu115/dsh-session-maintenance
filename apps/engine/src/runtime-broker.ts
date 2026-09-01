import { createHash } from "node:crypto";
import { join } from "node:path";

import type {
  AdapterId,
  DshRuntimeBridgeV1,
  JsonValue,
  LogicalProjectId,
  NativeAppendOperation,
  NativeSessionId,
  LogicalSessionId,
  ProjectionOperationReceipt,
  RuntimeBrokerAttachRunRequest,
  RuntimeBrokerAttachedRun,
  RuntimeBrokerClosedRun,
  RuntimeBrokerCloseRunRequest,
  RuntimeBrokerFlushRequest,
  RuntimeBrokerFlushResponse,
  RuntimeBrokerDrainRunRequest,
  RuntimeBrokerDrainedRun,
  RuntimeBrokerPrepareRunRequest,
  RuntimeBrokerPreparedRun,
  RuntimeBrokerRegisterSessionRequest,
  RuntimeBrokerRegisteredSession,
  RuntimeDrainResult,
  RuntimeHandle,
  RunId,
} from "@linmu/dsh-session-contracts";
import {
  Alpha2RuntimeBridge,
  recoverAlpha2RuntimeTail,
  manifest as alpha2Manifest,
  type Alpha2RuntimeRegistrar,
  type Alpha2RuntimeRegistration,
} from "@linmu/dsh-session-adapter-alpha2";
import type {
  PreparedProjectionRunHandle,
  ProjectionLifecycle,
  ProjectionRunHandle,
} from "@linmu/dsh-session-projection-lifecycle";
import {
  projectionRootFor,
  readProjectionRecoveryDescriptor,
} from "@linmu/dsh-session-projection-lifecycle";
import type { StatusLog, StatusSpanHandle } from "@linmu/dsh-session-status-log";


export type RuntimeBrokerLifecycleFactory = (input: {
  readonly adapterId: AdapterId;
  readonly bridge: DshRuntimeBridgeV1;
}) => ProjectionLifecycle;

export type RuntimeBrokerAdapterSelector = (
  input: RuntimeBrokerPrepareRunRequest,
) => Promise<AdapterId>;

export interface RuntimeProjectResolver {
  resolveProject(cwd: string): Promise<LogicalProjectId | null>;
  assignProject(logicalSessionId: LogicalSessionId, projectId: LogicalProjectId): Promise<void>;
}

interface BrokerRun {
  readonly ownerClientId: string;
  readonly runtimeClientId: string;
  readonly lifecycle: ProjectionLifecycle;
  readonly bridge: Alpha2RuntimeBridge;
  readonly registrar: BrokerRuntimeRegistrar;
  readonly prepared: PreparedProjectionRunHandle;
  readonly temporaryPersistenceRootId: string;
  active: ProjectionRunHandle | null;
  closing: boolean;
  drainedAt: string | null;
  readonly pendingBySession: Map<NativeSessionId, Set<Promise<unknown>>>;
  readonly dynamicProjects: Map<NativeSessionId, LogicalProjectId>;
}

class BrokerRuntimeRegistrar implements Alpha2RuntimeRegistrar {
  private acknowledgement: RuntimeBrokerAttachRunRequest | null = null;

  acknowledge(input: RuntimeBrokerAttachRunRequest): void {
    if (this.acknowledgement !== null) throw new Error(`Runtime is already acknowledged: ${input.runId}`);
    this.acknowledgement = input;
  }

  async attach(input: { readonly runId: RunId }): Promise<Alpha2RuntimeRegistration> {
    const acknowledgement = this.acknowledgement;
    if (acknowledgement === null || acknowledgement.runId !== input.runId) {
      throw new Error(`Runtime attach acknowledgement is missing: ${input.runId}`);
    }
    return {
      registrationId: `broker:${input.runId}`,
      attachedAt: acknowledgement.attachedAt,
    };
  }

  async drain(_registrationId: string, runId: RunId): Promise<RuntimeDrainResult> {
    return { runId, pendingOperations: 0, receipts: [] };
  }

  async detach(_registrationId: string, _runId: RunId): Promise<void> {}
}

function assertOwner(run: BrokerRun, clientId: string): void {
  if (run.ownerClientId !== clientId) throw new Error("Runtime Broker client does not own this run");
}

function assertRuntime(run: BrokerRun, clientId: string): void {
  if (run.runtimeClientId !== clientId) throw new Error("Runtime Broker runtime capability does not match this run");
}

function runtimeHeader(value: JsonValue): { readonly cwd: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Live-created DSH session header must be an object");
  }
  const cwd = (value as { readonly cwd?: unknown }).cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("Live-created DSH session header must contain cwd");
  }
  return { cwd };
}

export class ProjectionRuntimeBroker {
  private readonly lifecycleFactory: RuntimeBrokerLifecycleFactory;
  private readonly selectAdapter: RuntimeBrokerAdapterSelector;
  private readonly statusLog: StatusLog;
  private readonly projectResolver: RuntimeProjectResolver;
  private readonly clock: () => string;
  private readonly runs = new Map<RunId, BrokerRun>();

  constructor(input: {
    readonly lifecycleFactory: RuntimeBrokerLifecycleFactory;
    readonly selectAdapter: RuntimeBrokerAdapterSelector;
    readonly statusLog: StatusLog;
    readonly projectResolver: RuntimeProjectResolver;
    readonly clock?: () => string;
  }) {
    this.lifecycleFactory = input.lifecycleFactory;
    this.selectAdapter = input.selectAdapter;
    this.statusLog = input.statusLog;
    this.projectResolver = input.projectResolver;
    this.clock = input.clock ?? (() => new Date().toISOString());
  }

  async prepareRun(input: RuntimeBrokerPrepareRunRequest): Promise<RuntimeBrokerPreparedRun> {
    if (input.projectSelection.kind !== "all") {
      throw new Error("Runtime Broker project-id filtering is not yet available; use the all-project selection");
    }
    if ([...this.runs.values()].some((run) => run.ownerClientId === input.client.id && !run.closing)) {
      throw new Error(`Runtime Broker client already owns a run: ${input.client.id}`);
    }
    const adapterId = await this.selectAdapter(input);
    if (adapterId !== alpha2Manifest.id) {
      throw new Error(`Runtime Broker event/flush protocol is not available for adapter ${adapterId}`);
    }
    const registrar = new BrokerRuntimeRegistrar();
    const bridge = new Alpha2RuntimeBridge(registrar);
    const lifecycle = this.lifecycleFactory({ adapterId, bridge });
    const prepared = await lifecycle.prepareRun({
      instanceId: input.instanceId,
      profileId: input.profileId,
      dshVersion: input.dshVersion,
      branchId: input.branchId,
      maintenanceEndpoint: input.maintenanceEndpoint,
      runtimeBroker: {
        ownerClientId: input.client.id,
        runtimeClientId: input.runtimeClientId,
      },
    });
    const temporaryPersistenceRootId = `projection:${prepared.run.id}`;
    this.runs.set(prepared.run.id, {
      ownerClientId: input.client.id,
      runtimeClientId: input.runtimeClientId,
      lifecycle,
      bridge,
      registrar,
      prepared,
      temporaryPersistenceRootId,
      active: null,
      closing: false,
      drainedAt: null,
      pendingBySession: new Map(),
      dynamicProjects: new Map(),
    });
    return {
      schemaVersion: 1,
      runId: prepared.run.id,
      leaseId: prepared.run.leaseId,
      adapterId,
      persistenceRoot: join(prepared.projectionRoot, "runtime-sessions"),
      temporaryPersistenceRootId,
      runtimeClientId: input.runtimeClientId,
      state: "preparing",
    };
  }

  async attachRun(input: RuntimeBrokerAttachRunRequest): Promise<RuntimeBrokerAttachedRun> {
    const run = this.run(input.runId);
    assertRuntime(run, input.clientId);
    if (run.temporaryPersistenceRootId !== input.temporaryPersistenceRootId) {
      throw new Error("Runtime persistence-root acknowledgement does not match the prepared run");
    }
    if (run.active !== null) throw new Error(`Runtime Broker run is already attached: ${input.runId}`);
    run.registrar.acknowledge(input);
    run.active = await run.lifecycle.attachRun(run.prepared);
    return { schemaVersion: 1, runId: input.runId, state: "running", attachedAt: input.attachedAt };
  }

  async append(
    clientId: string,
    operation: NativeAppendOperation,
  ): Promise<ProjectionOperationReceipt> {
    const run = this.run(operation.runId);
    assertRuntime(run, clientId);
    if (run.closing || run.active === null) throw new Error(`Runtime Broker run is not accepting appends: ${operation.runId}`);
    const received = await this.startSpan(run, "runtime.event.received", operation.nativeSessionId, operation.operationId);
    await this.statusLog.succeed(received, { diagnosticDetailRef: "diag:runtime-event-enqueued" });
    const promise = run.lifecycle.append(run.active, operation);
    const pending = run.pendingBySession.get(operation.nativeSessionId) ?? new Set<Promise<unknown>>();
    pending.add(promise);
    run.pendingBySession.set(operation.nativeSessionId, pending);
    try {
      const receipt = await promise;
      const projectId = run.dynamicProjects.get(operation.nativeSessionId);
      if (projectId !== undefined) {
        await this.projectResolver.assignProject(receipt.logicalSessionId, projectId);
        run.dynamicProjects.delete(operation.nativeSessionId);
      }
      return receipt;
    } finally {
      pending.delete(promise);
      if (pending.size === 0) run.pendingBySession.delete(operation.nativeSessionId);
    }
  }

  async registerSession(input: RuntimeBrokerRegisterSessionRequest): Promise<RuntimeBrokerRegisteredSession> {
    const run = this.run(input.runId);
    assertRuntime(run, input.clientId);
    if (run.closing || run.active === null) throw new Error(`Runtime Broker run cannot register sessions: ${input.runId}`);
    const header = runtimeHeader(input.header);
    const projectId = await this.projectResolver.resolveProject(header.cwd);
    if (projectId === null) {
      throw new Error(`Live-created DSH session cwd has no canonical project root: ${header.cwd}`);
    }
    const logicalSessionId = `logical-dsh-${createHash("sha256")
      .update(`${run.prepared.run.instanceId}\0${input.nativeSessionId}`)
      .digest("hex").slice(0, 32)}` as LogicalSessionId;
    const projection = await run.lifecycle.registerNativeSession(run.active, {
      nativeSessionId: input.nativeSessionId,
      logicalSessionId,
      header: input.header,
      title: input.title,
      workspaceId: null,
      projectId,
    });
    run.dynamicProjects.set(input.nativeSessionId, projectId);
    return {
      schemaVersion: 1,
      runId: input.runId,
      nativeSessionId: input.nativeSessionId,
      logicalSessionId: projection.logicalSessionId,
      baseVersionId: null,
    };
  }

  async flush(input: RuntimeBrokerFlushRequest): Promise<RuntimeBrokerFlushResponse> {
    const run = this.run(input.runId);
    assertRuntime(run, input.clientId);
    const span = await this.startSpan(run, "runtime.session.flush", input.nativeSessionId, null);
    try {
      for (;;) {
        const pending = [...(run.pendingBySession.get(input.nativeSessionId) ?? [])];
        if (pending.length === 0) break;
        await Promise.all(pending);
      }
      await this.statusLog.succeed(span, { diagnosticDetailRef: "diag:runtime-flush-pending-zero" });
    } catch (error) {
      await this.statusLog.fail(span, { errorCode: "RUNTIME_FLUSH_FAILED", diagnosticDetailRef: "diag:runtime-flush-failed" });
      throw error;
    }
    return {
      schemaVersion: 1,
      runId: input.runId,
      nativeSessionId: input.nativeSessionId,
      pendingOperations: 0,
    };
  }

  async drainRun(input: RuntimeBrokerDrainRunRequest): Promise<RuntimeBrokerDrainedRun> {
    const run = this.run(input.runId);
    assertRuntime(run, input.clientId);
    if (run.active === null) throw new Error(`Runtime Broker run is not attached: ${input.runId}`);
    await this.flushAll(run);
    run.drainedAt = input.runtimeFlushCompletedAt;
    return {
      schemaVersion: 1,
      runId: input.runId,
      state: "drained",
      pendingOperations: 0,
      drainedAt: input.runtimeFlushCompletedAt,
    };
  }

  async closeRun(input: RuntimeBrokerCloseRunRequest): Promise<RuntimeBrokerClosedRun> {
    if (input.reason === "recovery") return this.recoverRun(input);
    const run = this.run(input.runId);
    assertOwner(run, input.clientId);
    if (run.active === null) throw new Error(`Runtime Broker run is not attached: ${input.runId}`);
    if (input.reason === "normal" && run.drainedAt === null) {
      throw new Error("Runtime Broker normal close requires a plugin runtime-drained acknowledgement");
    }
    run.closing = true;
    try {
      await this.flushAll(run);
      const receipt = await run.lifecycle.closeRun(run.active);
      this.runs.delete(input.runId);
      return {
        schemaVersion: 1,
        runId: input.runId,
        state: receipt.state,
        removedProjection: true,
      };
    } catch (error) {
      run.closing = false;
      throw error;
    }
  }

  async recoverRun(input: RuntimeBrokerCloseRunRequest): Promise<RuntimeBrokerClosedRun> {
    const existing = this.runs.get(input.runId);
    if (existing !== undefined) {
      assertOwner(existing, input.clientId);
      existing.closing = true;
      try {
        const runtimeWasAttached = existing.active !== null;
        if (!runtimeWasAttached) {
          existing.registrar.acknowledge({
            schemaVersion: 1,
            clientId: existing.runtimeClientId,
            runId: input.runId,
            temporaryPersistenceRootId: existing.temporaryPersistenceRootId,
            attachedAt: this.clock(),
          });
        }
        await this.flushAll(existing);
        const receipt = await this.recoverLifecycle(existing.lifecycle, input.runId, runtimeWasAttached);
        this.runs.delete(input.runId);
        return { schemaVersion: 1, runId: input.runId, state: receipt.state, removedProjection: true };
      } catch (error) {
        existing.closing = false;
        throw error;
      }
    }

    const registrar = new BrokerRuntimeRegistrar();
    const bridge = new Alpha2RuntimeBridge(registrar);
    const lifecycle = this.lifecycleFactory({ adapterId: alpha2Manifest.id, bridge });
    const projectionRoot = projectionRootFor(lifecycle.runtimeRoot, input.runId);
    const descriptor = await readProjectionRecoveryDescriptor(projectionRoot);
    if (descriptor.runtimeBroker === undefined) {
      throw new Error(`Projection run predates recoverable Runtime Broker ownership: ${input.runId}`);
    }
    if (descriptor.runtimeBroker.ownerClientId !== input.clientId) {
      throw new Error("Runtime Broker client does not own this recoverable run");
    }
    registrar.acknowledge({
      schemaVersion: 1,
      clientId: descriptor.runtimeBroker.runtimeClientId,
      runId: input.runId,
      temporaryPersistenceRootId: descriptor.runtimeBroker.temporaryPersistenceRootId,
      attachedAt: this.clock(),
    });
    const receipt = await this.recoverLifecycle(lifecycle, input.runId);
    return { schemaVersion: 1, runId: input.runId, state: receipt.state, removedProjection: true };
  }

  private run(runId: RunId): BrokerRun {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`Runtime Broker run does not exist: ${runId}`);
    return run;
  }

  private async flushAll(run: BrokerRun): Promise<void> {
    for (;;) {
      const pending = [...run.pendingBySession.values()].flatMap((items) => [...items]);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  private recoverLifecycle(lifecycle: ProjectionLifecycle, runId: RunId, recoverRuntimeTail = true) {
    if (!recoverRuntimeTail) return lifecycle.recover(runId);
    return lifecycle.recover(
      runId,
      async ({ projectionRoot, sessions }) => recoverAlpha2RuntimeTail({
        runId,
        persistenceRoot: join(projectionRoot, "runtime-sessions"),
        observedAt: this.clock(),
        sessions: sessions.map((session) => ({
          nativeSessionId: session.projection.nativeSessionId,
          logicalSessionId: session.projection.logicalSessionId,
          baseVersionId: session.projection.baseVersionId,
          nativeRevision: session.projection.nativeRevision,
          header: session.header,
          committedEvents: session.committedEvents,
        })),
      }),
      async ({ receipt, projectId }) => {
        if (projectId !== null) await this.projectResolver.assignProject(receipt.logicalSessionId, projectId);
      },
    );
  }

  private startSpan(
    run: BrokerRun,
    stage: "runtime.event.received" | "runtime.session.flush",
    nativeSessionId: NativeSessionId | null,
    operationId: NativeAppendOperation["operationId"] | null,
  ): Promise<StatusSpanHandle> {
    return this.statusLog.start({
      runId: run.prepared.run.id,
      leaseId: run.prepared.run.leaseId,
      profileId: run.prepared.run.profileId,
      adapterId: run.prepared.run.adapterId,
      dshVersion: run.prepared.run.dshVersion,
      stage,
      logicalSessionId: null,
      nativeSessionId,
      operationId,
    });
  }
}
