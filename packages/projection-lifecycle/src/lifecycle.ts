import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  AdapterVerificationResult,
  AdapterEvidencePort,
  BranchId,
  CanonicalProjectionSessionInput,
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
  LogicalProjectId,
  RuntimeHandle,
  RunId,
  JsonValue,
} from "@linmu/dsh-session-contracts";
import type {
  CanonicalEngineReceipt,
  DshAppendCommitter,
  DshNativeImportInput,
} from "@linmu/dsh-canonical-session-engine";
import type { StatusLog, StatusSpanHandle } from "@linmu/dsh-session-status-log";

import {
  commitProjectionAppend,
  type ActiveProjectionSession,
  type MutableNativeProjectionBridge,
  type ProjectionAppendContext,
} from "./append.js";
import { projectionCloseCheckpoint, removeProjectionRun, type ProjectionCloseReceipt } from "./close.js";
import { ProjectionLease, ProjectionLeaseError } from "./lease.js";
import {
  JsonProjectionDirectory,
  projectionRootFor,
  type CanonicalProjectionSource,
} from "./materialize.js";
import {
  projectionCacheIdentity,
  projectionCacheRootFor,
} from "./persistent-cache.js";
import { createRunCacheManager, refreshRunCache, type RunCacheContext } from "./run-cache.js";
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
  readonly runtimeBroker?: {
    readonly ownerClientId: string;
    readonly runtimeClientId: string;
  };
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

export interface ProjectionRecoverySessionSnapshot {
  readonly projection: ProjectionSession;
  readonly payload: import("@linmu/dsh-session-contracts").JsonValue;
  readonly projectId: LogicalProjectId | null;
  readonly header: import("@linmu/dsh-session-contracts").JsonValue;
  readonly committedEvents: readonly import("@linmu/dsh-session-contracts").JsonValue[];
  readonly adapterMetadata?: import("@linmu/dsh-session-contracts").JsonValue;
}

export type ProjectionRecoveryOperationSource = (
  input: {
    readonly run: ProjectionRun;
    readonly projectionRoot: string;
    readonly sessions: readonly ProjectionRecoverySessionSnapshot[];
  },
) => Promise<readonly NativeAppendOperation[]>;

export type ProjectionRecoveredRegistrationHandler = (input: {
  readonly logicalSessionId: import("@linmu/dsh-session-contracts").LogicalSessionId;
  readonly projectId: LogicalProjectId | null;
}) => Promise<void>;

type ProjectionCanonicalEngine = DshAppendCommitter & {
  importDshNative?: (input: DshNativeImportInput) => Promise<CanonicalEngineReceipt>;
};

interface PreparedProjectionContext {
  readonly handle: PreparedProjectionRunHandle;
  readonly directory: JsonProjectionDirectory;
  readonly sessions: Map<string, ActiveProjectionSession>;
  readonly persistentCache: RunCacheContext | null;
}

type LifecycleProjectionContext = ProjectionAppendContext & {
  readonly persistentCache: RunCacheContext | null;
};

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

function projectedNativeRevision(
  adapter: DshSessionAdapterV1,
  canonical: CanonicalProjectionSessionInput,
  payload: JsonValue,
): number {
  const revision = adapter.projectedNativeRevision?.(canonical, payload) ?? canonical.events.length;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`Adapter returned an invalid native revision for ${canonical.session.id}`);
  }
  return revision;
}

function recoveryAppendUsesStaleMetadata(
  active: ActiveProjectionSession | undefined,
  operation: NativeAppendOperation,
): boolean {
  if (active === undefined || typeof operation.payload !== "object" || operation.payload === null || Array.isArray(operation.payload)) {
    return false;
  }
  const payload = operation.payload as Readonly<Record<string, JsonValue>>;
  const logicalSessionId = typeof payload.logicalSessionId === "string" ? payload.logicalSessionId : undefined;
  const baseVersionId = payload.baseVersionId === null || typeof payload.baseVersionId === "string"
    ? payload.baseVersionId
    : undefined;
  return logicalSessionId !== undefined
    && baseVersionId !== undefined
    && (logicalSessionId !== active.projection.logicalSessionId
      || baseVersionId !== active.projection.baseVersionId);
}

function nativeRegistrationOperationId(runId: RunId, nativeSessionId: string) {
  return `${runId}:native-register:${createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 32)}` as import("@linmu/dsh-session-contracts").OperationId;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 500);
}

type IdKind = "run" | "lease";

export class ProjectionLifecycle {
  readonly runRepository: ProjectionRunRepository;
  readonly statusLog: StatusLog;
  readonly source: CanonicalProjectionSource;
  readonly adapter: DshSessionAdapterV1;
  readonly bridge: DshRuntimeBridgeV1;
  readonly runtimeRoot: string;
  readonly canonicalEngine: ProjectionCanonicalEngine | undefined;
  readonly evidencePort: AdapterEvidencePort | undefined;
  readonly checkpointRepository: Pick<CheckpointRepository, "saveCheckpoint"> | undefined;
  private readonly lease: ProjectionLease;
  private readonly clock: () => string;
  private readonly idFactory: (kind: IdKind) => string;
  private readonly preparedRuns = new Map<RunId, PreparedProjectionContext>();
  private readonly activeRuns = new Map<RunId, LifecycleProjectionContext>();

  constructor(input: {
    readonly runRepository: ProjectionRunRepository;
    readonly statusLog: StatusLog;
    readonly source: CanonicalProjectionSource;
    readonly adapter: DshSessionAdapterV1;
    readonly bridge: DshRuntimeBridgeV1;
    readonly canonicalEngine?: ProjectionCanonicalEngine;
    readonly evidencePort?: AdapterEvidencePort;
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
    this.evidencePort = input.evidencePort;
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
    let manifest: ProjectionManifest;
    let inspection: ProjectionInspection;
    let verification: AdapterVerificationResult;
    let persistentCache: RunCacheContext | null = null;
    const sessions = new Map<string, ActiveProjectionSession>();
    const materializeSpan = await this.startSpan(preparing, "projection.materialize");
    try {
      const cacheManager = createRunCacheManager({ runtimeRoot: this.runtimeRoot, source: this.source,
        adapter: this.adapter, statusLog: this.statusLog, clock: this.clock });
      if (cacheManager !== undefined) {
        const configuration: JsonValue = { branchId: preparing.branchId };
        const cached = await cacheManager.apply({ run: preparing, configuration });
        persistentCache = { manager: cacheManager, cacheRoot: cached.cacheRoot, configuration };
        const baseDirectory = new JsonProjectionDirectory(cached.cacheRoot);
        const catalog = await baseDirectory.snapshotSessionCatalog(runId);
        await directory.initialize();
        await directory.bindBaseProjection(cached.cacheRoot);
        await directory.replaceSessionCatalog(catalog);
        manifest = cached.projectionManifest;
        inspection = cached.inspection;
        verification = cached.verification;
        await directory.writeManifest(manifest);
        for (const state of cached.cacheManifest.sessions) {
          const projection = {
            schemaVersion: 1,
            runId,
            nativeSessionId: state.nativeSessionId,
            logicalSessionId: state.logicalSessionId,
            baseVersionId: state.canonicalHeadVersionId,
            mode: state.authorityScope === "codex" ? "codex-read-until-write" : "maintenance-write",
            nativeRevision: state.nativeRevision,
            lastCommittedOperationId: null,
            derivedChildSessionId: null,
          } as const;
          await this.runRepository.upsertProjectionSession(projection);
          sessions.set(state.nativeSessionId, {
            projection,
            title: state.title,
            tags: state.tags,
            archivedAt: state.archivedAt,
            workspaceId: state.workspaceId,
            authorityScope: state.authorityScope,
          });
        }
      } else {
        const projectionInput = await this.source.load(preparing);
        const catalogUpdatedAt = new Map<string, string>();
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
          const nativeRevision = projectedNativeRevision(
            this.adapter,
            item,
            await directory.readSession(reference.nativeSessionId),
          );
          const projection = {
            schemaVersion: 1,
            runId,
            nativeSessionId: reference.nativeSessionId,
            logicalSessionId: item.session.id,
            baseVersionId: item.session.headVersionId,
            mode: item.session.authorityScope === "codex" ? "codex-read-until-write" : "maintenance-write",
            nativeRevision,
            lastCommittedOperationId: null,
            derivedChildSessionId: null,
          } as const;
          await this.runRepository.upsertProjectionSession(projection);
          catalogUpdatedAt.set(reference.nativeSessionId, item.session.updatedAt);
          sessions.set(reference.nativeSessionId, {
            projection,
            title: item.session.title,
            tags: item.session.tags,
            archivedAt: item.session.archivedAt,
            workspaceId: item.workspaceId,
            authorityScope: item.session.authorityScope,
          });
        }
        await directory.rebuildSessionCatalog(runId, catalogUpdatedAt);
      }
      await writeProjectionRecoveryDescriptor(projectionRoot, {
        schemaVersion: 1,
        runId,
        maintenanceEndpoint: input.maintenanceEndpoint,
        ...(persistentCache === null ? {} : { baseProjectionRoot: persistentCache.cacheRoot }),
        ...(input.runtimeBroker === undefined ? {} : {
          runtimeBroker: {
            ...input.runtimeBroker,
            temporaryPersistenceRootId: `projection:${runId}`,
          },
        }),
      });
      await this.statusLog.succeed(materializeSpan, {
        diagnosticDetailRef: "diag:projection-structure-verified",
      });
    } catch (error) {
      await this.quarantine(runId);
      await this.statusLog.fail(materializeSpan, { errorCode: "PROJECTION_MATERIALIZE_FAILED" });
      throw new ProjectionLifecycleError(
        "PROJECTION_MATERIALIZE_FAILED",
        runId,
        `Canonical projection materialization failed: ${boundedErrorMessage(error)}`,
        { cause: error },
      );
    }

    const handle: PreparedProjectionRunHandle = {
      run: preparing,
      projectionRoot,
      manifest,
      inspection,
      verification,
      maintenanceEndpoint: input.maintenanceEndpoint,
    };
    this.preparedRuns.set(runId, { handle, directory, sessions, persistentCache });
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
      const activeContext: LifecycleProjectionContext = {
        handle,
        directory: context.directory,
        wal: new ProjectionWriteAheadLog(prepared.projectionRoot),
        sessions: context.sessions,
        persistentCache: context.persistentCache,
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
      throw new ProjectionLifecycleError("RUNTIME_ATTACH_FAILED", prepared.run.id, "DSH runtime persistence attach failed", { cause: error });
    }
  }

  async openRun(input: OpenProjectionRunInput): Promise<ProjectionRunHandle> {
    return this.attachRun(await this.prepareRun(input));
  }

  /**
   * Disposes a projection that was fully materialized but never attached to a
   * DSH runtime. No native process could have appended to this projection, so
   * the verified materialization snapshot is the final snapshot and does not
   * need an expensive second inspection pass.
   */
  async discardPreparedRun(runId: RunId): Promise<ProjectionCloseReceipt> {
    const context = this.preparedRuns.get(runId);
    const run = context?.handle.run ?? await this.runRepository.getProjectionRun(runId);
    if (run === undefined || (context === undefined && run.state !== "preparing")) {
      throw new ProjectionLifecycleError("RUN_NOT_PREPARED", runId, "Projection run is not safely discardable before runtime attach");
    }
    const projectionRoot = context?.handle.projectionRoot ?? projectionRootFor(this.runtimeRoot, runId);
    const inspection = context?.handle.inspection ?? await this.preparedInspection(projectionRoot);
    const span = await this.startShutdownSpan(run);
    let cleanupStarted = false;
    try {
      await this.lease.setState(runId, "recovering");
      const checkpoint = await this.saveCloseCheckpoint(run, inspection);
      cleanupStarted = true;
      await removeProjectionRun(projectionRoot);
      await this.lease.setState(runId, "recovered");
      this.preparedRuns.delete(runId);
      await this.statusLog.succeed(span, { diagnosticDetailRef: "diag:prepared-projection-discarded" });
      return {
        runId,
        checkpointId: checkpoint.id,
        finalCatalogDigest: inspection.catalogDigest,
        removedProjection: true,
        state: "recovered",
      };
    } catch (error) {
      await this.lease.setState(runId, cleanupStarted ? "cleanup-pending" : "recovery-required").catch(() => undefined);
      await this.statusLog.fail(span, {
        errorCode: cleanupStarted ? "CLEANUP_PENDING" : "RUN_RECOVERY_FAILED",
        diagnosticDetailRef: "diag:prepared-projection-discard-failed",
      });
      throw new ProjectionLifecycleError(
        cleanupStarted ? "CLEANUP_PENDING" : "RUN_RECOVERY_FAILED",
        runId,
        "Prepared projection could not be discarded",
        { cause: error },
      );
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
    if (!context.acceptingAppends) {
      throw new ProjectionLifecycleError("RUN_DRAINING", handle.run.id, "Projection run is draining and no longer accepts native appends");
    }
    return commitProjectionAppend({
      context,
      operation,
      runRepository: this.runRepository,
      statusLog: this.statusLog,
      adapter: this.adapter,
      ...(this.evidencePort === undefined ? {} : { evidencePort: this.evidencePort }),
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
    if (this.canonicalEngine?.importDshNative === undefined) {
      throw new ProjectionLifecycleError("CANONICAL_ENGINE_UNAVAILABLE", handle.run.id, "Canonical session engine is required to register a native session");
    }
    await this.bridge.registerSession(handle.runtime, registration, context.directory);
    const operationId = nativeRegistrationOperationId(handle.run.id, registration.nativeSessionId);
    const canonical = await this.canonicalEngine.importDshNative({
      operationId,
      logicalSessionId: registration.logicalSessionId,
      nativeSessionId: registration.nativeSessionId,
      title: registration.title,
      tags: [],
      archivedAt: null,
      workspaceId: registration.workspaceId,
      events: [],
      importedAt: this.clock(),
    });
    if (!("switchLogicalSession" in this.bridge) || typeof this.bridge.switchLogicalSession !== "function") {
      throw new ProjectionLifecycleError("RUNTIME_APPEND_UNSUPPORTED", handle.run.id, "Runtime bridge cannot finish native session registration");
    }
    await (this.bridge as MutableNativeProjectionBridge).switchLogicalSession(
      handle.runtime,
      registration.nativeSessionId,
      registration.logicalSessionId,
      canonical.versionId,
      context.directory,
    );
    const projection: ProjectionSession = {
      schemaVersion: 1,
      runId: handle.run.id,
      nativeSessionId: registration.nativeSessionId,
      logicalSessionId: registration.logicalSessionId,
      baseVersionId: canonical.versionId,
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
      await refreshRunCache(context.persistentCache, context.handle.run, this.statusLog);
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

  async recover(
    runId: RunId,
    operationSource?: ProjectionRecoveryOperationSource,
    onCommitted?: (input: {
      readonly receipt: ProjectionOperationReceipt;
      readonly projectId: LogicalProjectId | null;
    }) => Promise<void>,
    onRecoveredRegistration?: ProjectionRecoveredRegistrationHandler,
  ): Promise<ProjectionCloseReceipt> {
    const run = await this.runRepository.getProjectionRun(runId);
    if (run === undefined) throw new ProjectionLifecycleError("RUN_NOT_FOUND", runId, "Projection run does not exist");
    const span = await this.startShutdownSpan(run);
    let context = this.activeRuns.get(runId);
    let cleanupStarted = false;
    try {
      await this.lease.setState(runId, "recovering");
      context ??= await this.restoreRecoveryContext(run);
      context.acceptingAppends = false;
      for (const registration of context.recoveredRegistrations ?? []) {
        await onRecoveredRegistration?.(registration);
      }
      await this.supersedeStalePending(context);
      await this.replayPending(context);
      if (operationSource !== undefined) {
        if (this.canonicalEngine === undefined) throw new Error("Canonical session engine is unavailable during recovery");
        const snapshots = await this.recoverySnapshots(context);
        const projects = new Map(snapshots.map((snapshot) => [snapshot.projection.nativeSessionId, snapshot.projectId]));
        for (const operation of await operationSource({
          run,
          projectionRoot: context.handle.projectionRoot,
          sessions: snapshots,
        })) {
          const receipt = await commitProjectionAppend({
            context,
            operation,
            runRepository: this.runRepository,
            statusLog: this.statusLog,
            adapter: this.adapter,
            ...(this.evidencePort === undefined ? {} : { evidencePort: this.evidencePort }),
            bridge: this.bridge,
            canonicalEngine: this.canonicalEngine,
            clock: this.clock,
          });
          await onCommitted?.({ receipt, projectId: projects.get(operation.nativeSessionId) ?? null });
        }
      }
      const result = await this.verifyCheckpointAndDetach(context);
      await refreshRunCache(context.persistentCache, context.handle.run, this.statusLog);
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
      throw new ProjectionLifecycleError(
        cleanupStarted ? "CLEANUP_PENDING" : corrupt ? "RECOVERY_QUARANTINED" : "RUN_RECOVERY_FAILED",
        runId,
        `Projection recovery did not complete: ${boundedErrorMessage(error)}`,
        { cause: error },
      );
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
        ...(this.evidencePort === undefined ? {} : { evidencePort: this.evidencePort }),
        bridge: this.bridge,
        canonicalEngine: this.canonicalEngine!,
        clock: this.clock,
      });
    }
  }

  private async supersedeStalePending(context: ProjectionAppendContext): Promise<void> {
    for (const record of await context.wal.pending()) {
      const active = context.sessions.get(record.operation.nativeSessionId);
      if (!record.projectionApplied || !recoveryAppendUsesStaleMetadata(active, record.operation)) continue;
      const run = context.handle.run;
      const supersedeSpan = await this.statusLog.start({
        runId: run.id,
        leaseId: run.leaseId,
        profileId: run.profileId,
        adapterId: run.adapterId,
        dshVersion: run.dshVersion,
        stage: "runtime.wal.durable",
        logicalSessionId: active?.projection.logicalSessionId ?? null,
        nativeSessionId: record.operation.nativeSessionId,
        operationId: record.operation.operationId,
        diagnosticDetailRef: "diag:recovery-stale-metadata-superseded",
      });
      try {
        await context.wal.supersede(record.operation.operationId);
        await this.statusLog.succeed(supersedeSpan, {
          diagnosticDetailRef: "diag:recovery-stale-metadata-superseded",
        });
      } catch (error) {
        await this.statusLog.fail(supersedeSpan, {
          errorCode: "RECOVERY_WAL_SUPERSEDE_FAILED",
          diagnosticDetailRef: "diag:recovery-stale-metadata-supersede-failed",
        });
        throw error;
      }
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
    const checkpoint = await this.saveCloseCheckpoint(context.handle.run, inspection);
    await this.bridge.detach(context.handle.runtime);
    return {
      runId: context.handle.run.id,
      checkpointId: checkpoint.id,
      finalCatalogDigest: inspection.catalogDigest,
    };
  }

  private async saveCloseCheckpoint(run: ProjectionRun, inspection: ProjectionInspection) {
    const checkpoint = projectionCloseCheckpoint(run, inspection, this.clock());
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
    await checkpointRuns.setProjectionRunCheckpoint(run.id, checkpoint.id);
    return checkpoint;
  }

  private async preparedInspection(projectionRoot: string): Promise<ProjectionInspection> {
    const manifest = await new JsonProjectionDirectory(projectionRoot).readManifest();
    return {
      sessionCount: manifest.sessionCount,
      workspaceCount: manifest.workspaceCount,
      catalogDigest: manifest.catalogDigest,
      sessionDigests: manifest.sessionDigests,
      issues: [],
    };
  }

  private async restoreRecoveryContext(run: ProjectionRun): Promise<LifecycleProjectionContext> {
    const projectionRoot = projectionRootFor(this.runtimeRoot, run.id);
    const directory = new JsonProjectionDirectory(projectionRoot);
    const descriptor = await readProjectionRecoveryDescriptor(projectionRoot);
    if (descriptor.runId !== run.id) throw new TypeError("Projection recovery run ID mismatch");
    const configuration: JsonValue = { branchId: run.branchId };
    const cacheManager = createRunCacheManager({ runtimeRoot: this.runtimeRoot, source: this.source,
      adapter: this.adapter, statusLog: this.statusLog, clock: this.clock });
    let persistentCache: RunCacheContext | null = null;
    if (descriptor.baseProjectionRoot !== undefined) {
      if (cacheManager === undefined) {
        throw new TypeError("Persistent projection recovery requires an incremental source and cache-capable Adapter");
      }
      const identity = projectionCacheIdentity(this.adapter, configuration);
      const expectedRoot = projectionCacheRootFor(
        this.runtimeRoot,
        this.adapter.manifest.id,
        identity.configurationDigest,
      );
      if (resolve(descriptor.baseProjectionRoot) !== resolve(expectedRoot)) {
        throw new TypeError("Projection recovery base cache identity mismatch");
      }
      if (await cacheManager.readCacheManifest(expectedRoot) === undefined) {
        throw new TypeError("Projection recovery base cache manifest is unavailable");
      }
      persistentCache = { manager: cacheManager, cacheRoot: expectedRoot, configuration };
    }
    const manifest = await directory.readManifest();
    await directory.readSessionCatalog(run.id);
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
    const recoveredRegistrations: Array<{
      readonly logicalSessionId: import("@linmu/dsh-session-contracts").LogicalSessionId;
      readonly projectId: LogicalProjectId | null;
    }> = [];
    const wal = new ProjectionWriteAheadLog(projectionRoot);
    const correctedInitialRevisions = new Map<string, number>();
    for (const persistedMapping of mappings) {
      let mapping = persistedMapping;
      const item = sourceById.get(mapping.logicalSessionId);
      if (item !== undefined) {
        const payload = await directory.readSession(mapping.nativeSessionId);
        if (mapping.lastCommittedOperationId === null && this.adapter.projectedNativeRevision !== undefined) {
          let canonical = item;
          if (item.session.authorityScope === "codex" && item.session.originKind === "codex-mirror"
            && typeof item.session.headVersionId === "string" && item.session.headVersionId !== mapping.baseVersionId) {
            if (mapping.baseVersionId === null || this.source.loadVersionEvents === undefined) {
              throw new TypeError(`Recovery cannot verify the pinned base version for ${mapping.nativeSessionId}`);
            }
            // A live Codex observer may have advanced the head after startup.
            // Verify this run against its immutable base; never roll back the head.
            canonical = { ...item, session: { ...item.session, headVersionId: mapping.baseVersionId },
              events: await this.source.loadVersionEvents(mapping.logicalSessionId, mapping.baseVersionId) };
          }
          const canonicalRevision = projectedNativeRevision(this.adapter, canonical, payload);
          if (canonicalRevision < mapping.nativeRevision) {
            throw new TypeError(`Canonical native revision regressed for ${mapping.nativeSessionId}`);
          }
          if (canonicalRevision > mapping.nativeRevision) {
            mapping = { ...mapping, nativeRevision: canonicalRevision };
            await this.runRepository.upsertProjectionSession(mapping);
            correctedInitialRevisions.set(mapping.nativeSessionId, canonicalRevision);
          }
        }
        sessions.set(mapping.nativeSessionId, {
          projection: mapping,
          title: item.session.title,
          tags: item.session.tags,
          archivedAt: item.session.archivedAt,
          workspaceId: item.workspaceId,
          authorityScope: item.session.authorityScope,
        });
        continue;
      }
      if (this.adapter.recoverProjectionSession === undefined) {
        throw new TypeError(`Recovery mapping has no canonical session: ${mapping.logicalSessionId}`);
      }
      const recovered = this.adapter.recoverProjectionSession(mapping, await directory.readSession(mapping.nativeSessionId));
      sessions.set(mapping.nativeSessionId, {
        projection: mapping,
        title: recovered.title,
        tags: recovered.tags,
        archivedAt: recovered.archivedAt,
        workspaceId: recovered.workspaceId,
        authorityScope: recovered.authorityScope,
      });
    }
    const recovering = { ...run, state: "recovering" as const };
    const runtime = await this.bridge.attach({
      run: recovering,
      projectionRoot,
      maintenanceEndpoint: descriptor.maintenanceEndpoint,
    });
    const persistedNativeIds = new Set(mappings.map((mapping) => mapping.nativeSessionId));
    for (const nativeSessionId of await directory.listNativeSessionIds()) {
      if (persistedNativeIds.has(nativeSessionId)) continue;
      if (this.adapter.recoverUnmappedProjectionSession === undefined) {
        throw new TypeError(`Recovery projection contains an unmapped native session: ${nativeSessionId}`);
      }
      const orphanSpan = await this.statusLog.start({
        runId: run.id,
        leaseId: run.leaseId,
        profileId: run.profileId,
        adapterId: run.adapterId,
        dshVersion: run.dshVersion,
        stage: "run.shutdown-recovery",
        logicalSessionId: null,
        nativeSessionId,
        operationId: null,
        diagnosticDetailRef: "diag:unmapped-native-registration-detected",
      });
      try {
        const recovered = this.adapter.recoverUnmappedProjectionSession(
          run.id,
          nativeSessionId,
          await directory.readSession(nativeSessionId),
        );
        if (this.canonicalEngine?.importDshNative === undefined) {
          throw new TypeError("Canonical session engine is unavailable for unmapped native registration recovery");
        }
        const operationId = nativeRegistrationOperationId(run.id, nativeSessionId);
        const canonical = await this.canonicalEngine.importDshNative({
          operationId,
          logicalSessionId: recovered.logicalSessionId,
          nativeSessionId,
          title: recovered.recovered.title,
          tags: recovered.recovered.tags,
          archivedAt: recovered.recovered.archivedAt,
          workspaceId: recovered.recovered.workspaceId,
          events: [],
          importedAt: this.clock(),
        });
        if (!("switchLogicalSession" in this.bridge) || typeof this.bridge.switchLogicalSession !== "function") {
          throw new TypeError("Runtime bridge cannot finish unmapped native registration recovery");
        }
        await (this.bridge as MutableNativeProjectionBridge).switchLogicalSession(
          runtime,
          nativeSessionId,
          recovered.logicalSessionId,
          canonical.versionId,
          directory,
        );
        const projection: ProjectionSession = {
          schemaVersion: 1,
          runId: run.id,
          nativeSessionId,
          logicalSessionId: recovered.logicalSessionId,
          baseVersionId: canonical.versionId,
          mode: recovered.mode,
          nativeRevision: recovered.nativeRevision,
          lastCommittedOperationId: null,
          derivedChildSessionId: null,
        };
        await this.runRepository.upsertProjectionSession(projection);
        sessions.set(nativeSessionId, {
          projection,
          title: recovered.recovered.title,
          tags: recovered.recovered.tags,
          archivedAt: recovered.recovered.archivedAt,
          workspaceId: recovered.recovered.workspaceId,
          authorityScope: recovered.recovered.authorityScope,
        });
        recoveredRegistrations.push({
          logicalSessionId: recovered.logicalSessionId,
          projectId: recovered.recovered.projectId,
        });
        await this.statusLog.succeed(orphanSpan, {
          diagnosticDetailRef: "diag:unmapped-native-registration-recovered",
        });
      } catch (error) {
        await this.statusLog.fail(orphanSpan, {
          errorCode: "UNMAPPED_NATIVE_RECOVERY_FAILED",
          diagnosticDetailRef: "diag:unmapped-native-registration-invalid",
        });
        throw error;
      }
    }
    for (const record of await wal.pending()) {
      const active = sessions.get(record.operation.nativeSessionId);
      if (record.projectionApplied && recoveryAppendUsesStaleMetadata(active, record.operation)) {
        const supersedeSpan = await this.statusLog.start({
          runId: run.id,
          leaseId: run.leaseId,
          profileId: run.profileId,
          adapterId: run.adapterId,
          dshVersion: run.dshVersion,
          stage: "runtime.wal.durable",
          logicalSessionId: active?.projection.logicalSessionId ?? null,
          nativeSessionId: record.operation.nativeSessionId,
          operationId: record.operation.operationId,
          diagnosticDetailRef: "diag:recovery-stale-metadata-superseded",
        });
        try {
          await wal.supersede(record.operation.operationId);
          await this.statusLog.succeed(supersedeSpan, {
            diagnosticDetailRef: "diag:recovery-stale-metadata-superseded",
          });
        } catch (error) {
          await this.statusLog.fail(supersedeSpan, {
            errorCode: "RECOVERY_WAL_SUPERSEDE_FAILED",
            diagnosticDetailRef: "diag:recovery-stale-metadata-supersede-failed",
          });
          throw error;
        }
        continue;
      }
      if (this.adapter.shouldSupersedeRecoveryAppend?.(record.operation) === true) {
        const supersedeSpan = await this.statusLog.start({
          runId: run.id,
          leaseId: run.leaseId,
          profileId: run.profileId,
          adapterId: run.adapterId,
          dshVersion: run.dshVersion,
          stage: "runtime.wal.durable",
          logicalSessionId: active?.projection.logicalSessionId ?? null,
          nativeSessionId: record.operation.nativeSessionId,
          operationId: record.operation.operationId,
          diagnosticDetailRef: "diag:recovery-prelude-superseded",
        });
        try {
          await wal.supersede(record.operation.operationId);
          await this.statusLog.succeed(supersedeSpan, {
            diagnosticDetailRef: "diag:recovery-prelude-superseded",
          });
        } catch (error) {
          await this.statusLog.fail(supersedeSpan, {
            errorCode: "RECOVERY_WAL_SUPERSEDE_FAILED",
            diagnosticDetailRef: "diag:recovery-prelude-supersede-failed",
          });
          throw error;
        }
        continue;
      }
      const correctedRevision = correctedInitialRevisions.get(record.operation.nativeSessionId);
      if (correctedRevision !== undefined
        && record.projectionApplied
        && record.operation.operationId.includes(":tail-recovery:")
        && record.operation.nativeRevision <= correctedRevision) {
        await wal.supersede(record.operation.operationId);
      }
    }
    const handle: ProjectionRunHandle = {
      run: { ...run, state: "running" },
      projectionRoot,
      manifest,
      inspection,
      verification,
      runtime,
    };
    const context: LifecycleProjectionContext = {
      handle,
      directory,
      wal,
      sessions,
      recoveredRegistrations,
      persistentCache,
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

  private async recoverySnapshots(context: ProjectionAppendContext): Promise<readonly ProjectionRecoverySessionSnapshot[]> {
    if (this.adapter.recoverProjectionSession === undefined) {
      throw new TypeError(`Adapter does not expose recovery projection decoding: ${this.adapter.manifest.id}`);
    }
    const snapshots: ProjectionRecoverySessionSnapshot[] = [];
    for (const active of context.sessions.values()) {
      const payload = await context.directory.readSession(active.projection.nativeSessionId);
      const recovered = this.adapter.recoverProjectionSession(active.projection, payload);
      snapshots.push({
        projection: active.projection,
        payload,
        projectId: recovered.projectId,
        header: recovered.header,
        committedEvents: recovered.committedEvents,
        ...(recovered.adapterMetadata === undefined ? {} : { adapterMetadata: recovered.adapterMetadata }),
      });
    }
    return snapshots;
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
