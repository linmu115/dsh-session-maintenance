import { createHash } from "node:crypto";
import { join } from "node:path";

import type {
  AdapterId,
  DshRuntimeBridgeV1,
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
  manifest as alpha2Manifest,
  type Alpha2RuntimeRegistrar,
  type Alpha2RuntimeRegistration,
} from "@linmu/dsh-session-adapter-alpha2";
import type {
  PreparedProjectionRunHandle,
  ProjectionLifecycle,
  ProjectionRunHandle,
} from "@linmu/dsh-session-projection-lifecycle";
import type { StatusLog, StatusSpanHandle } from "@linmu/dsh-session-status-log";

export type RuntimeBrokerLifecycleFactory = (input: {
  readonly adapterId: AdapterId;
  readonly bridge: DshRuntimeBridgeV1;
}) => ProjectionLifecycle;

export type RuntimeBrokerAdapterSelector = (
  input: RuntimeBrokerPrepareRunRequest,
) => Promise<AdapterId>;

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

export class ProjectionRuntimeBroker {
  private readonly lifecycleFactory: RuntimeBrokerLifecycleFactory;
  private readonly selectAdapter: RuntimeBrokerAdapterSelector;
  private readonly statusLog: StatusLog;
  private readonly runs = new Map<RunId, BrokerRun>();

  constructor(input: {
    readonly lifecycleFactory: RuntimeBrokerLifecycleFactory;
    readonly selectAdapter: RuntimeBrokerAdapterSelector;
    readonly statusLog: StatusLog;
  }) {
    this.lifecycleFactory = input.lifecycleFactory;
    this.selectAdapter = input.selectAdapter;
    this.statusLog = input.statusLog;
  }

  async prepareRun(input: RuntimeBrokerPrepareRunRequest): Promise<RuntimeBrokerPreparedRun> {
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
      return await promise;
    } finally {
      pending.delete(promise);
      if (pending.size === 0) run.pendingBySession.delete(operation.nativeSessionId);
    }
  }

  async registerSession(input: RuntimeBrokerRegisterSessionRequest): Promise<RuntimeBrokerRegisteredSession> {
    const run = this.run(input.runId);
    assertRuntime(run, input.clientId);
    if (run.closing || run.active === null) throw new Error(`Runtime Broker run cannot register sessions: ${input.runId}`);
    const logicalSessionId = `logical-dsh-${createHash("sha256")
      .update(`${run.prepared.run.instanceId}\0${input.nativeSessionId}`)
      .digest("hex").slice(0, 32)}` as LogicalSessionId;
    const projection = await run.lifecycle.registerNativeSession(run.active, {
      nativeSessionId: input.nativeSessionId,
      logicalSessionId,
      header: input.header,
      title: input.title,
      workspaceId: null,
    });
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
