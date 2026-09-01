import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  AdapterVerificationResult,
  BranchId,
  CheckpointRepository,
  DshRuntimeBridgeV1,
  DshSessionAdapterV1,
  LeaseId,
  ProjectionInspection,
  ProjectionManifest,
  NativeAppendOperation,
  NativeSessionRegistration,
  ProjectionOperationReceipt,
  ProjectionRun,
  ProjectionRunRepository,
  ProjectionSession,
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
import { projectionCloseCheckpoint, removeProjectionRun, type ProjectionCloseReceipt } from "./close.js";
import { ProjectionLease, ProjectionLeaseError } from "./lease.js";
import { JsonProjectionDirectory, projectionRootFor, type CanonicalProjectionSource } from "./materialize.js";
import { ProjectionWriteAheadLog } from "./wal.js";
import {
  readProjectionRecoveryDescriptor,
  writeProjectionRecoveryDescriptor,
} from "./recovery.js";

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

export interface PreparedProjectionRunHandle {
  readonly run: ProjectionRun & { readonly state: "preparing" };
  readonly projectionRoot: string;
  readonly manifest: ProjectionManifest;
  readonly inspection: ProjectionInspection;
  readonly verification: AdapterVerificationResult;
  readonly maintenanceEndpoint: string;
}

interface PreparedProjectionContext {
  readonly handle: PreparedProjectionRunHandle;
  readonly directory: JsonProjectionDirectory;
  readonly sessions: Map<string, ActiveProjectionSession>;
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
  readonly checkpointRepository: Pick<CheckpointRepository, "saveCheckpoint"> | undefined;
  private readonly lease: ProjectionLease;
  private readonly clock: () => string;
  private readonly idFactory: (kind: IdKind) => string;
  private readonly preparedRuns = new Map<RunId, PreparedProjectionContext>();
  private readonly activeRuns = new Map<RunId, ProjectionAppendContext>();

  constructor(input: {
    readonly runRepository: ProjectionRunRepository;
    readonly statusLog: StatusLog;
    readonly source: CanonicalProjectionSource;
    readonly adapter: DshSessionAdapterV1;
    readonly bridge: DshRuntimeBridgeV1;
    readonly canonicalEngine?: DshAppendCommitter;
    readonly checkpointRepository?: Pick<CheckpointRepository, "saveCheckpoint">;
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
    this.checkpointRepository = input.checkpointRepository;
    this.runtimeRoot = resolve(input.runtimeRoot);
    this.lease = new ProjectionLease(input.runRepository);
    this.clock = input.clock ?? (() => new Date().toISOString());
    this.idFactory = input.idFactory ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  async prepareRun(input: OpenProjectionRunInput): Promise<PreparedProjectionRunHandle> {
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
      await writeProjectionRecoveryDescriptor(projectionRoot, {
        schemaVersion: 1,
        runId,
        maintenanceEndpoint: input.maintenanceEndpoint,
      });
      await this.statusLog.succeed(materializeSpan);
    } catch (error) {
      await this.quarantine(runId);
      await this.statusLog.fail(materializeSpan, { errorCode: "PROJECTION_MATERIALIZE_FAILED" });
      throw new ProjectionLifecycleError("PROJECTION_MATERIALIZE_FAILED", runId, "Canonical projection materialization failed", { cause: error });
    }

    const handle: PreparedProjectionRunHandle = {
      run: preparing,
      projectionRoot,
      manifest,
      inspection,
      verification,
      maintenanceEndpoint: input.maintenanceEndpoint,
    };
    this.preparedRuns.set(runId, { handle, directory, sessions });
    return handle;
  }

  async attachRun(prepared: PreparedProjectionRunHandle): Promise<ProjectionRunHandle> {
    const context = this.preparedRuns.get(prepared.run.id);
    if (context === undefined || context.handle !== prepared) {
      throw new ProjectionLifecycleError("RUN_NOT_PREPARED", prepared.run.id, "Projection run is not prepared in this lifecycle");
    }
    const attachSpan = await this.startSpan(prepared.run, "runtime.persistence.attach");
    let attachedRuntime: RuntimeHandle | undefined;
    try {
      const runtime = await this.bridge.attach({
        run: prepared.run,
        projectionRoot: prepared.projectionRoot,
        maintenanceEndpoint: prepared.maintenanceEndpoint,
      });
      attachedRuntime = runtime;
      await this.lease.setState(prepared.run.id, "running");
      const handle: ProjectionRunHandle = {
        run: { ...prepared.run, state: "running" },
        projectionRoot: prepared.projectionRoot,
        manifest: prepared.manifest,
        inspection: prepared.inspection,
        verification: prepared.verification,
        runtime,
      };
      const activeContext: ProjectionAppendContext = {
        handle,
        directory: context.directory,
        wal: new ProjectionWriteAheadLog(prepared.projectionRoot),
        sessions: context.sessions,
        acceptingAppends: true,
      };
      this.preparedRuns.delete(prepared.run.id);
      this.activeRuns.set(prepared.run.id, activeContext);
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
      this.preparedRuns.delete(prepared.run.id);
      this.activeRuns.delete(prepared.run.id);
      if (attachedRuntime !== undefined) {
        await this.bridge.detach(attachedRuntime).catch(() => undefined);
      }
      await this.quarantine(prepared.run.id);
      await this.statusLog.fail(attachSpan, { errorCode: "RUNTIME_ATTACH_FAILED" });
      throw new ProjectionLifecycleError("RUNTIME_ATTACH_FAILED", prepared.run.id, "Alpha2 runtime persistence attach failed", { cause: error });
    }
  }

  async openRun(input: OpenProjectionRunInput): Promise<ProjectionRunHandle> {
    return this.attachRun(await this.prepareRun(input));
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
    if (!context.acceptingAppends) {
      throw new ProjectionLifecycleError("RUN_DRAINING", handle.run.id, "Projection run is draining and no longer accepts native appends");
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

  async registerNativeSession(
    handle: ProjectionRunHandle,
    registration: NativeSessionRegistration,
  ): Promise<ProjectionSession> {
    const context = this.activeRuns.get(handle.run.id);
    if (context === undefined || context.handle.runtime !== handle.runtime) {
      throw new ProjectionLifecycleError("RUN_NOT_ACTIVE", handle.run.id, "Projection run is not active in this lifecycle");
    }
    if (context.sessions.has(registration.nativeSessionId)) {
      return context.sessions.get(registration.nativeSessionId)!.projection;
    }
    if (this.bridge.registerSession === undefined) {
      throw new ProjectionLifecycleError("RUNTIME_SESSION_REGISTER_UNSUPPORTED", handle.run.id, "Runtime bridge cannot register a new native session");
    }
    await this.bridge.registerSession(handle.runtime, registration, context.directory);
    const projection: ProjectionSession = {
      schemaVersion: 1,
      runId: handle.run.id,
      nativeSessionId: registration.nativeSessionId,
      logicalSessionId: registration.logicalSessionId,
      baseVersionId: null,
      mode: "maintenance-write",
      nativeRevision: 0,
      lastCommittedOperationId: null,
      derivedChildSessionId: null,
    };
    await this.runRepository.upsertProjectionSession(projection);
    context.sessions.set(registration.nativeSessionId, {
      projection,
      title: registration.title,
      tags: [],
      archivedAt: null,
      workspaceId: registration.workspaceId,
      authorityScope: "maintenance",
    });
    return projection;
  }

  /** Drains accepted writes before hiding one session from the attached temporary projection. */
  async hideSession(
    handle: ProjectionRunHandle,
    logicalSessionId: string,
  ): Promise<{ readonly nativeSessionId: string; readonly mode: "hidden" }> {
    const context = this.activeRuns.get(handle.run.id);
    if (context === undefined || context.handle.runtime !== handle.runtime) {
      throw new ProjectionLifecycleError("RUN_NOT_ACTIVE", handle.run.id, "Projection run is not active in this lifecycle");
    }
    const match = [...context.sessions.entries()].find(([, session]) => session.projection.logicalSessionId === logicalSessionId);
    if (match === undefined) throw new ProjectionLifecycleError("SESSION_NOT_PROJECTED", handle.run.id, `Logical session is not projected: ${logicalSessionId}`);
    const [nativeSessionId, active] = match;
    const span = await this.startShutdownSpan(context.handle.run);
    context.acceptingAppends = false;
    try {
      const drained = this.bridge.drainSession === undefined
        ? await this.bridge.drain(context.handle.runtime)
        : await this.bridge.drainSession(context.handle.runtime, active.projection.nativeSessionId);
      await this.replayPending(context);
      if (drained.pendingOperations !== 0 || (await context.wal.pending()).length !== 0) {
        throw new Error("Projected session still has pending operations after drain");
      }
      if (this.bridge.hideSession === undefined) throw new Error("Selected runtime bridge cannot hide one projected session");
      await this.bridge.hideSession(context.handle.runtime, active.projection.nativeSessionId);
      active.projection = { ...active.projection, mode: "hidden" };
      await this.runRepository.upsertProjectionSession(active.projection);
      await this.statusLog.succeed(span, { diagnosticDetailRef: "diag:session-delete-hidden" });
      return { nativeSessionId, mode: "hidden" };
    } catch (error) {
      await this.statusLog.fail(span, { errorCode: "SESSION_DELETE_DRAIN_FAILED", diagnosticDetailRef: "diag:session-delete-pending" });
      throw new ProjectionLifecycleError("SESSION_DELETE_DRAIN_FAILED", handle.run.id, "Projected session could not be drained before delete", { cause: error });
    } finally {
      context.acceptingAppends = true;
    }
  }

  async closeRun(handle: ProjectionRunHandle): Promise<ProjectionCloseReceipt> {
    const context = this.activeRuns.get(handle.run.id);
    if (context === undefined) {
      throw new ProjectionLifecycleError("RUN_NOT_ACTIVE", handle.run.id, "Projection run is not active in this lifecycle");
    }
    const span = await this.startShutdownSpan(context.handle.run);
    context.acceptingAppends = false;
    let cleanupStarted = false;
    try {
      await this.lease.setState(handle.run.id, "draining");
      await this.drainPending(context);
      const result = await this.verifyCheckpointAndDetach(context);
      cleanupStarted = true;
      await removeProjectionRun(context.handle.projectionRoot);
      await this.lease.setState(handle.run.id, "closed");
      this.activeRuns.delete(handle.run.id);
      await this.statusLog.succeed(span);
      return { ...result, removedProjection: true, state: "closed" };
    } catch (error) {
      await this.lease.setState(handle.run.id, cleanupStarted ? "cleanup-pending" : "recovery-required").catch(() => undefined);
      await this.statusLog.fail(span, { errorCode: cleanupStarted ? "CLEANUP_PENDING" : "RUN_CLOSE_FAILED" });
      throw new ProjectionLifecycleError(cleanupStarted ? "CLEANUP_PENDING" : "RUN_CLOSE_FAILED", handle.run.id, "Projection run did not close cleanly", { cause: error });
    }
  }

  async recover(runId: RunId): Promise<ProjectionCloseReceipt> {
    const run = await this.runRepository.getProjectionRun(runId);
    if (run === undefined) throw new ProjectionLifecycleError("RUN_NOT_FOUND", runId, "Projection run does not exist");
    const span = await this.startShutdownSpan(run);
    let context = this.activeRuns.get(runId);
    let cleanupStarted = false;
    try {
      await this.lease.setState(runId, "recovering");
      context ??= await this.restoreRecoveryContext(run);
      context.acceptingAppends = false;
      await this.replayPending(context);
      const result = await this.verifyCheckpointAndDetach(context);
      cleanupStarted = true;
      await removeProjectionRun(context.handle.projectionRoot);
      await this.lease.setState(runId, "recovered");
      this.activeRuns.delete(runId);
      await this.statusLog.succeed(span);
      return { ...result, removedProjection: true, state: "recovered" };
    } catch (error) {
      const corrupt = error instanceof SyntaxError || error instanceof TypeError;
      const state = cleanupStarted ? "cleanup-pending" : corrupt ? "quarantined" : "recovery-required";
      await this.lease.setState(runId, state).catch(() => undefined);
      await this.statusLog.fail(span, { errorCode: cleanupStarted ? "CLEANUP_PENDING" : corrupt ? "RECOVERY_QUARANTINED" : "RUN_RECOVERY_FAILED" });
      throw new ProjectionLifecycleError(cleanupStarted ? "CLEANUP_PENDING" : corrupt ? "RECOVERY_QUARANTINED" : "RUN_RECOVERY_FAILED", runId, "Projection recovery did not complete", { cause: error });
    }
  }

  private async drainPending(context: ProjectionAppendContext): Promise<void> {
    await this.bridge.drain(context.handle.runtime);
    await this.replayPending(context);
    const drained = await this.bridge.drain(context.handle.runtime);
    if (drained.pendingOperations !== 0 || (await context.wal.pending()).length !== 0) {
      throw new Error("Projection runtime still has pending operations after drain");
    }
  }

  private async replayPending(context: ProjectionAppendContext): Promise<void> {
    const pending = await context.wal.pending();
    if (pending.length > 0 && this.canonicalEngine === undefined) {
      throw new Error("Canonical session engine is unavailable during recovery");
    }
    for (const record of pending) {
      await commitProjectionAppend({
        context,
        operation: record.operation,
        runRepository: this.runRepository,
        statusLog: this.statusLog,
        adapter: this.adapter,
        bridge: this.bridge,
        canonicalEngine: this.canonicalEngine!,
        clock: this.clock,
      });
    }
  }

  private async verifyCheckpointAndDetach(
    context: ProjectionAppendContext,
  ): Promise<Omit<ProjectionCloseReceipt, "removedProjection" | "state">> {
    const inspection = await this.adapter.inspect(context.directory);
    const finalManifest: ProjectionManifest = {
      schemaVersion: 1,
      runId: context.handle.run.id,
      adapterId: context.handle.run.adapterId,
      sessionCount: inspection.sessionCount,
      workspaceCount: inspection.workspaceCount,
      catalogDigest: inspection.catalogDigest,
      sessionDigests: inspection.sessionDigests,
    };
    const verification = await this.adapter.verify(finalManifest, inspection);
    if (!verification.ok) throw new Error("Projection close verification failed");
    await context.directory.replaceManifest(finalManifest);
    const checkpoint = projectionCloseCheckpoint(context.handle.run, inspection, this.clock());
    if (this.checkpointRepository === undefined) {
      throw new Error("Checkpoint repository is required to finalize a projection run");
    }
    await this.checkpointRepository.saveCheckpoint(checkpoint);
    const checkpointRuns = this.runRepository as ProjectionRunRepository & {
      setProjectionRunCheckpoint?: (runId: RunId, checkpointId: string) => Promise<void>;
    };
    if (checkpointRuns.setProjectionRunCheckpoint === undefined) {
      throw new Error("Projection repository cannot link the close checkpoint");
    }
    await checkpointRuns.setProjectionRunCheckpoint(context.handle.run.id, checkpoint.id);
    await this.bridge.detach(context.handle.runtime);
    return {
      runId: context.handle.run.id,
      checkpointId: checkpoint.id,
      finalCatalogDigest: inspection.catalogDigest,
    };
  }

  private async restoreRecoveryContext(run: ProjectionRun): Promise<ProjectionAppendContext> {
    const projectionRoot = projectionRootFor(this.runtimeRoot, run.id);
    const directory = new JsonProjectionDirectory(projectionRoot);
    const descriptor = await readProjectionRecoveryDescriptor(projectionRoot);
    if (descriptor.runId !== run.id) throw new TypeError("Projection recovery run ID mismatch");
    const manifest = await directory.readManifest();
    const inspection = await this.adapter.inspect(directory);
    const verification = await this.adapter.verify(manifest, inspection);
    const recoveryRuns = this.runRepository as ProjectionRunRepository & {
      listProjectionSessions?: (runId: RunId) => Promise<readonly ProjectionSession[]>;
    };
    const mappings = await recoveryRuns.listProjectionSessions?.(run.id);
    if (mappings === undefined) throw new TypeError("Projection repository cannot enumerate recovery mappings");
    const source = await this.source.load(run);
    const sourceById = new Map(source.sessions.map((item) => [item.session.id, item]));
    const sessions = new Map<string, ActiveProjectionSession>();
    for (const mapping of mappings) {
      const item = sourceById.get(mapping.logicalSessionId);
      if (item === undefined) throw new TypeError(`Recovery mapping has no canonical session: ${mapping.logicalSessionId}`);
      sessions.set(mapping.nativeSessionId, {
        projection: mapping,
        title: item.session.title,
        tags: item.session.tags,
        archivedAt: item.session.archivedAt,
        workspaceId: item.workspaceId,
        authorityScope: item.session.authorityScope,
      });
    }
    const recovering = { ...run, state: "recovering" as const };
    const runtime = await this.bridge.attach({
      run: recovering,
      projectionRoot,
      maintenanceEndpoint: descriptor.maintenanceEndpoint,
    });
    const handle: ProjectionRunHandle = {
      run: { ...run, state: "running" },
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
      acceptingAppends: false,
    };
    this.activeRuns.set(run.id, context);
    if ("bindAppendHandler" in this.bridge && typeof this.bridge.bindAppendHandler === "function") {
      await (this.bridge as MutableNativeProjectionBridge & {
        bindAppendHandler(runtime: RuntimeHandle, handler: (operation: NativeAppendOperation) => Promise<ProjectionOperationReceipt>): Promise<void>;
      }).bindAppendHandler(runtime, async (operation) => this.append(handle, operation));
    }
    return context;
  }

  private startShutdownSpan(run: ProjectionRun): Promise<StatusSpanHandle> {
    return this.statusLog.start({
      runId: run.id,
      leaseId: run.leaseId,
      profileId: run.profileId,
      adapterId: run.adapterId,
      dshVersion: run.dshVersion,
      stage: "run.shutdown-recovery",
      logicalSessionId: null,
      nativeSessionId: null,
      operationId: null,
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
