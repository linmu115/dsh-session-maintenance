import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  AdapterVerificationResult,
  BranchId,
  DshRuntimeBridgeV1,
  DshSessionAdapterV1,
  LeaseId,
  ProjectionInspection,
  ProjectionManifest,
  NativeAppendOperation,
  ProjectionOperationReceipt,
  ProjectionRun,
  ProjectionRunRepository,
  RuntimeHandle,
  RunId,
} from "@linmu/dsh-session-contracts";
import type { DshAppendCommitter } from "@linmu/dsh-canonical-session-engine";
import type { StatusLog, StatusSpanHandle } from "@linmu/dsh-session-status-log";

import {
  commitProjectionAppend,
  type ActiveProjectionSession,
  type MutableNativeProjectionBridge,
  type ProjectionAppendContext,
} from "./append.js";
import { ProjectionLease, ProjectionLeaseError } from "./lease.js";
import { JsonProjectionDirectory, projectionRootFor, type CanonicalProjectionSource } from "./materialize.js";
import { ProjectionWriteAheadLog } from "./wal.js";

export interface OpenProjectionRunInput {
  readonly instanceId: string;
  readonly profileId: string;
  readonly dshVersion: string;
  readonly branchId: BranchId;
  readonly maintenanceEndpoint: string;
}

export interface ProjectionRunHandle {
  readonly run: ProjectionRun & { readonly state: "running" };
  readonly projectionRoot: string;
  readonly manifest: ProjectionManifest;
  readonly inspection: ProjectionInspection;
  readonly verification: AdapterVerificationResult;
  readonly runtime: RuntimeHandle;
}

export class ProjectionLifecycleError extends Error {
  readonly code: string;
  readonly runId: RunId;

  constructor(code: string, runId: RunId, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectionLifecycleError";
    this.code = code;
    this.runId = runId;
  }
}

type IdKind = "run" | "lease";

export class ProjectionLifecycle {
  readonly runRepository: ProjectionRunRepository;
  readonly statusLog: StatusLog;
  readonly source: CanonicalProjectionSource;
  readonly adapter: DshSessionAdapterV1;
  readonly bridge: DshRuntimeBridgeV1;
  readonly runtimeRoot: string;
  readonly canonicalEngine: DshAppendCommitter | undefined;
  private readonly lease: ProjectionLease;
  private readonly clock: () => string;
  private readonly idFactory: (kind: IdKind) => string;
  private readonly activeRuns = new Map<RunId, ProjectionAppendContext>();

  constructor(input: {
    readonly runRepository: ProjectionRunRepository;
    readonly statusLog: StatusLog;
    readonly source: CanonicalProjectionSource;
    readonly adapter: DshSessionAdapterV1;
    readonly bridge: DshRuntimeBridgeV1;
    readonly canonicalEngine?: DshAppendCommitter;
    readonly runtimeRoot: string;
    readonly clock?: () => string;
    readonly idFactory?: (kind: IdKind) => string;
  }) {
    this.runRepository = input.runRepository;
    this.statusLog = input.statusLog;
    this.source = input.source;
    this.adapter = input.adapter;
    this.bridge = input.bridge;
    this.canonicalEngine = input.canonicalEngine;
    this.runtimeRoot = resolve(input.runtimeRoot);
    this.lease = new ProjectionLease(input.runRepository);
    this.clock = input.clock ?? (() => new Date().toISOString());
    this.idFactory = input.idFactory ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  async openRun(input: OpenProjectionRunInput): Promise<ProjectionRunHandle> {
    const at = this.clock();
    const runId = this.idFactory("run") as RunId;
    const leaseId = this.idFactory("lease") as LeaseId;
    const candidate: ProjectionRun = {
      schemaVersion: 1,
      id: runId,
      leaseId,
      branchId: input.branchId,
      instanceId: input.instanceId,
      profileId: input.profileId,
      dshVersion: input.dshVersion,
      adapterId: this.adapter.manifest.id,
      state: "quarantined",
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    };
    await this.lease.registerCandidate(candidate);
    const leaseSpan = await this.startSpan(candidate, "run.lease");
    try {
      await this.lease.acquire(runId);
      await this.statusLog.succeed(leaseSpan);
    } catch (error) {
      await this.statusLog.fail(leaseSpan, { errorCode: "LEASE_HELD" });
      if (error instanceof ProjectionLeaseError) {
        throw new ProjectionLifecycleError("LEASE_HELD", runId, error.message, { cause: error });
      }
      throw new ProjectionLifecycleError("LEASE_ACQUIRE_FAILED", runId, "Projection writer lease acquisition failed", { cause: error });
    }

    const preparing = { ...candidate, state: "preparing" as const };
    const projectionRoot = projectionRootFor(this.runtimeRoot, runId);
    const directory = new JsonProjectionDirectory(projectionRoot);
    let projectionInput: Awaited<ReturnType<CanonicalProjectionSource["load"]>>;
    let manifest: ProjectionManifest;
    let inspection: ProjectionInspection;
    let verification: AdapterVerificationResult;
    const sessions = new Map<string, ActiveProjectionSession>();
    const materializeSpan = await this.startSpan(preparing, "projection.materialize");
    try {
      projectionInput = await this.source.load(preparing);
      await directory.initialize();
      manifest = await this.adapter.materialize(projectionInput, directory);
      await directory.writeManifest(manifest);
      inspection = await this.adapter.inspect(directory);
      verification = await this.adapter.verify(manifest, inspection);
      if (!verification.ok) throw new Error("Projection verification failed");
      for (const item of projectionInput.sessions) {
        const reference = await this.adapter.resolveReference({
          logicalSessionId: item.session.id,
          logicalAnchorId: null,
          legacyNativeSessionId: null,
        }, preparing);
        if (reference.nativeSessionId === null || reference.status !== "resolved") {
          throw new Error(`Adapter did not resolve native identity for ${item.session.id}`);
        }
        const projection = {
          schemaVersion: 1,
          runId,
          nativeSessionId: reference.nativeSessionId,
          logicalSessionId: item.session.id,
          baseVersionId: item.session.headVersionId,
          mode: item.session.authorityScope === "codex" ? "codex-read-until-write" : "maintenance-write",
          nativeRevision: item.events.length,
          lastCommittedOperationId: null,
          derivedChildSessionId: null,
        } as const;
        await this.runRepository.upsertProjectionSession(projection);
        sessions.set(reference.nativeSessionId, {
          projection,
          title: item.session.title,
          tags: item.session.tags,
          archivedAt: item.session.archivedAt,
          workspaceId: item.workspaceId,
          authorityScope: item.session.authorityScope,
        });
      }
      await this.statusLog.succeed(materializeSpan);
    } catch (error) {
      await this.quarantine(runId);
      await this.statusLog.fail(materializeSpan, { errorCode: "PROJECTION_MATERIALIZE_FAILED" });
      throw new ProjectionLifecycleError("PROJECTION_MATERIALIZE_FAILED", runId, "Canonical projection materialization failed", { cause: error });
    }

    const attachSpan = await this.startSpan(preparing, "runtime.persistence.attach");
    let attachedRuntime: RuntimeHandle | undefined;
    try {
      const runtime = await this.bridge.attach({
        run: preparing,
        projectionRoot,
        maintenanceEndpoint: input.maintenanceEndpoint,
      });
      attachedRuntime = runtime;
      await this.lease.setState(runId, "running");
      const handle: ProjectionRunHandle = {
        run: { ...preparing, state: "running" },
        projectionRoot,
        manifest,
        inspection,
        verification,
        runtime,
      };
      const context: ProjectionAppendContext = {
        handle,
        directory,
        wal: new ProjectionWriteAheadLog(projectionRoot),
        sessions,
      };
      this.activeRuns.set(runId, context);
      if ("bindAppendHandler" in this.bridge && typeof this.bridge.bindAppendHandler === "function") {
        await (this.bridge as MutableNativeProjectionBridge & {
          bindAppendHandler(
            runtime: RuntimeHandle,
            handler: (operation: NativeAppendOperation) => Promise<ProjectionOperationReceipt>,
          ): Promise<void>;
        }).bindAppendHandler(runtime, async (operation) => this.append(handle, operation));
      }
      await this.statusLog.succeed(attachSpan);
      return handle;
    } catch (error) {
      this.activeRuns.delete(runId);
      if (attachedRuntime !== undefined) {
        await this.bridge.detach(attachedRuntime).catch(() => undefined);
      }
      await this.quarantine(runId);
      await this.statusLog.fail(attachSpan, { errorCode: "RUNTIME_ATTACH_FAILED" });
      throw new ProjectionLifecycleError("RUNTIME_ATTACH_FAILED", runId, "Alpha2 runtime persistence attach failed", { cause: error });
    }
  }

  async append(
    handle: ProjectionRunHandle,
    operation: NativeAppendOperation,
  ): Promise<ProjectionOperationReceipt> {
    const context = this.activeRuns.get(handle.run.id);
    if (context === undefined || context.handle.runtime !== handle.runtime) {
      throw new ProjectionLifecycleError("RUN_NOT_ACTIVE", handle.run.id, "Projection run is not active in this lifecycle");
    }
    if (this.canonicalEngine === undefined) {
      throw new ProjectionLifecycleError("CANONICAL_ENGINE_UNAVAILABLE", handle.run.id, "Canonical session engine is not configured");
    }
    return commitProjectionAppend({
      context,
      operation,
      runRepository: this.runRepository,
      statusLog: this.statusLog,
      adapter: this.adapter,
      bridge: this.bridge,
      canonicalEngine: this.canonicalEngine,
      clock: this.clock,
    });
  }

  private startSpan(run: ProjectionRun, stage: "run.lease" | "projection.materialize" | "runtime.persistence.attach"): Promise<StatusSpanHandle> {
    return this.statusLog.start({
      runId: run.id,
      leaseId: run.leaseId,
      profileId: run.profileId,
      adapterId: run.adapterId,
      dshVersion: run.dshVersion,
      stage,
      logicalSessionId: null,
      nativeSessionId: null,
      operationId: null,
    });
  }

  private async quarantine(runId: RunId): Promise<void> {
    await this.lease.setState(runId, "quarantined").catch(() => undefined);
  }
}
