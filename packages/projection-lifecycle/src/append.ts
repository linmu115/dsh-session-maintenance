import type {
  CanonicalSessionRecord,
  DshSessionAdapterV1,
  DshRuntimeBridgeV1,
  LogicalSessionId,
  LogicalWorkspaceId,
  NativeAppendOperation,
  ProjectionOperationReceipt,
  ProjectionRunRepository,
  ProjectionSession,
  RuntimeHandle,
  SessionVersionId,
} from "@linmu/dsh-session-contracts";
import type { DshAppendCommitter } from "@linmu/dsh-canonical-session-engine";
import type { StatusLog, StatusSpanHandle } from "@linmu/dsh-session-status-log";

import type { JsonProjectionDirectory } from "./materialize.js";
import type { ProjectionRunHandle } from "./lifecycle.js";
import { ProjectionWriteAheadLog } from "./wal.js";

export interface ActiveProjectionSession {
  projection: ProjectionSession;
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly workspaceId: LogicalWorkspaceId | null;
  authorityScope: CanonicalSessionRecord["authorityScope"];
}

export interface MutableNativeProjectionBridge extends DshRuntimeBridgeV1 {
  validateAppend(
    handle: RuntimeHandle,
    operation: NativeAppendOperation,
    projection: JsonProjectionDirectory,
  ): Promise<unknown>;
  applyAppend(
    handle: RuntimeHandle,
    operation: NativeAppendOperation,
    projection: JsonProjectionDirectory,
  ): Promise<void>;
  switchLogicalSession(
    handle: RuntimeHandle,
    nativeSessionId: NativeAppendOperation["nativeSessionId"],
    logicalSessionId: LogicalSessionId,
    baseVersionId: SessionVersionId | null,
    projection: JsonProjectionDirectory,
  ): Promise<void>;
}

export interface ProjectionAppendContext {
  readonly handle: ProjectionRunHandle;
  readonly directory: JsonProjectionDirectory;
  readonly wal: ProjectionWriteAheadLog;
  readonly sessions: Map<string, ActiveProjectionSession>;
  acceptingAppends: boolean;
}

export class ProjectionAppendError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectionAppendError";
    this.code = code;
  }
}

function appendBridge(bridge: DshRuntimeBridgeV1): MutableNativeProjectionBridge {
  if (!("validateAppend" in bridge) || typeof bridge.validateAppend !== "function"
    || !("applyAppend" in bridge) || typeof bridge.applyAppend !== "function"
    || !("switchLogicalSession" in bridge) || typeof bridge.switchLogicalSession !== "function") {
    throw new ProjectionAppendError("RUNTIME_APPEND_UNSUPPORTED", "Selected runtime bridge cannot update its native projection");
  }
  return bridge as MutableNativeProjectionBridge;
}

function assertNativeRevision(session: ActiveProjectionSession, operation: NativeAppendOperation): void {
  const current = session.projection.nativeRevision;
  if (!Number.isSafeInteger(operation.nativeRevision) || operation.nativeRevision <= current) {
    throw new ProjectionAppendError(
      "NATIVE_REVISION_MISMATCH",
      `Native revision must advance from ${current}: ${operation.nativeRevision}`,
    );
  }
}

function toReceipt(
  operation: NativeAppendOperation,
  logicalSessionId: LogicalSessionId,
  canonicalVersionId: SessionVersionId | null,
  committedAt: string,
): ProjectionOperationReceipt {
  return {
    schemaVersion: 1,
    operationId: operation.operationId,
    runId: operation.runId,
    logicalSessionId,
    nativeSessionId: operation.nativeSessionId,
    status: "committed",
    canonicalVersionId,
    projectionRevision: operation.nativeRevision,
    committedAt,
  };
}

export async function commitProjectionAppend(input: {
  readonly context: ProjectionAppendContext;
  readonly operation: NativeAppendOperation;
  readonly runRepository: ProjectionRunRepository;
  readonly statusLog: StatusLog;
  readonly adapter: Pick<DshSessionAdapterV1, "normalizeAppend">;
  readonly bridge: DshRuntimeBridgeV1;
  readonly canonicalEngine: DshAppendCommitter;
  readonly clock: () => string;
}): Promise<ProjectionOperationReceipt> {
  const { context, operation } = input;
  if (operation.runId !== context.handle.run.id) {
    throw new ProjectionAppendError("RUN_MISMATCH", "Native append belongs to another projection run");
  }
  const session = context.sessions.get(operation.nativeSessionId);
  if (session === undefined) {
    throw new ProjectionAppendError("PROJECTION_SESSION_NOT_FOUND", `Projection session not found: ${operation.nativeSessionId}`);
  }
  const existingReceipt = await input.runRepository.getOperationReceipt(operation.operationId);
  if (existingReceipt?.status === "committed") {
    if (existingReceipt.runId !== operation.runId || existingReceipt.nativeSessionId !== operation.nativeSessionId) {
      throw new ProjectionAppendError("OPERATION_RECEIPT_MISMATCH", "Operation receipt belongs to another projection target");
    }
    const needsReconciliation = session.projection.nativeRevision < existingReceipt.projectionRevision
      || session.projection.logicalSessionId !== existingReceipt.logicalSessionId;
    if (needsReconciliation) {
      const reconciliationSpan = await input.statusLog.start({
        runId: context.handle.run.id,
        leaseId: context.handle.run.leaseId,
        profileId: context.handle.run.profileId,
        adapterId: context.handle.run.adapterId,
        dshVersion: context.handle.run.dshVersion,
        stage: "session.append.commit",
        logicalSessionId: session.projection.logicalSessionId,
        nativeSessionId: operation.nativeSessionId,
        operationId: operation.operationId,
      });
      const derivationReconciliationSpan = session.authorityScope === "codex"
        ? await input.statusLog.start({
            runId: context.handle.run.id,
            leaseId: context.handle.run.leaseId,
            profileId: context.handle.run.profileId,
            adapterId: context.handle.run.adapterId,
            dshVersion: context.handle.run.dshVersion,
            stage: "session.derivation.create",
            logicalSessionId: session.projection.logicalSessionId,
            nativeSessionId: operation.nativeSessionId,
            operationId: operation.operationId,
          })
        : undefined;
      try {
        if (session.projection.logicalSessionId !== existingReceipt.logicalSessionId) {
          await appendBridge(input.bridge).switchLogicalSession(
            context.handle.runtime,
            operation.nativeSessionId,
            existingReceipt.logicalSessionId,
            existingReceipt.canonicalVersionId,
            context.directory,
          );
        }
        const advanced: ProjectionSession = {
          ...session.projection,
          logicalSessionId: existingReceipt.logicalSessionId,
          baseVersionId: existingReceipt.canonicalVersionId,
          nativeRevision: existingReceipt.projectionRevision,
          lastCommittedOperationId: existingReceipt.operationId,
          mode: "maintenance-write",
          derivedChildSessionId: session.authorityScope === "codex"
            ? existingReceipt.logicalSessionId
            : session.projection.derivedChildSessionId,
        };
        await input.runRepository.upsertProjectionSession(advanced);
        session.projection = advanced;
        session.authorityScope = "maintenance";
        const wal = await context.wal.get(operation.operationId);
        if (wal !== undefined && wal.state !== "committed" && wal.projectionApplied) {
          await context.wal.markCommitted(operation.operationId, existingReceipt, input.clock());
        }
        if (derivationReconciliationSpan !== undefined) {
          await input.statusLog.succeed(derivationReconciliationSpan);
        }
        await input.statusLog.succeed(reconciliationSpan);
      } catch (error) {
        if (derivationReconciliationSpan !== undefined) {
          await input.statusLog.fail(derivationReconciliationSpan, { errorCode: "PROJECTION_RECONCILE_FAILED" });
        }
        await input.statusLog.fail(reconciliationSpan, { errorCode: "PROJECTION_RECONCILE_FAILED" });
        throw new ProjectionAppendError("PROJECTION_RECONCILE_FAILED", "Committed append could not reconcile its projection mapping", { cause: error });
      }
    }
    return existingReceipt;
  }
  const span = await input.statusLog.start({
    runId: context.handle.run.id,
    leaseId: context.handle.run.leaseId,
    profileId: context.handle.run.profileId,
    adapterId: context.handle.run.adapterId,
    dshVersion: context.handle.run.dshVersion,
    stage: "session.append.commit",
    logicalSessionId: session.projection.logicalSessionId,
    nativeSessionId: operation.nativeSessionId,
    operationId: operation.operationId,
  });
  let failureCode = "APPEND_COMMIT_FAILED";
  let derivationSpan: StatusSpanHandle | undefined;
  try {
    const bridge = appendBridge(input.bridge);
    let walRecord = await context.wal.get(operation.operationId);
    if (walRecord === undefined) {
      assertNativeRevision(session, operation);
      failureCode = "NATIVE_REVISION_MISMATCH";
      await bridge.validateAppend(context.handle.runtime, operation, context.directory);
      failureCode = "APPEND_COMMIT_FAILED";
      walRecord = await context.wal.putPending(operation, input.clock());
    } else {
      walRecord = await context.wal.putPending(operation, input.clock());
    }
    if (!walRecord.projectionApplied) {
      assertNativeRevision(session, operation);
      failureCode = "NATIVE_REVISION_MISMATCH";
      await bridge.validateAppend(context.handle.runtime, operation, context.directory);
      failureCode = "APPEND_COMMIT_FAILED";
      await bridge.applyAppend(
        context.handle.runtime,
        operation,
        context.directory,
      );
      walRecord = await context.wal.markProjectionApplied(operation.operationId, input.clock());
    }
    const normalized = await input.adapter.normalizeAppend(walRecord.operation);
    if (normalized.logicalSessionId !== session.projection.logicalSessionId) {
      throw new ProjectionAppendError("LOGICAL_SESSION_MISMATCH", "Adapter append resolved another logical session");
    }
    const deriving = session.authorityScope === "codex";
    if (deriving) {
      derivationSpan = await input.statusLog.start({
        runId: context.handle.run.id,
        leaseId: context.handle.run.leaseId,
        profileId: context.handle.run.profileId,
        adapterId: context.handle.run.adapterId,
        dshVersion: context.handle.run.dshVersion,
        stage: "session.derivation.create",
        logicalSessionId: session.projection.logicalSessionId,
        nativeSessionId: operation.nativeSessionId,
        operationId: operation.operationId,
      });
    }
    failureCode = "MAINTENANCE_APPEND_FAILED";
    const canonical = await input.canonicalEngine.appendDsh({
      logicalSessionId: normalized.logicalSessionId,
      ...(normalized.baseVersionId === null ? {} : { baseVersionId: normalized.baseVersionId }),
      title: session.title,
      tags: session.tags,
      archivedAt: session.archivedAt,
      workspaceId: session.workspaceId,
      appendedEvents: normalized.events,
      observedAt: operation.observedAt,
      projection: {
        runId: context.handle.run.id,
        leaseId: context.handle.run.leaseId,
        branchId: context.handle.run.branchId,
        adapterId: context.handle.run.adapterId,
        nativeSessionId: operation.nativeSessionId,
        operationId: operation.operationId,
        nativeRevision: operation.nativeRevision,
      },
    });
    if (deriving && canonical.outcome !== "derived") {
      throw new ProjectionAppendError("DERIVATION_OUTCOME_INVALID", "Codex first write did not create a derived session");
    }
    const receipt = toReceipt(
      operation,
      canonical.logicalSessionId,
      canonical.versionId,
      canonical.committedAt,
    );
    failureCode = "PROJECTION_RECEIPT_WRITE_FAILED";
    await input.runRepository.saveOperationReceipt(receipt);
    if (deriving) {
      await appendBridge(input.bridge).switchLogicalSession(
        context.handle.runtime,
        operation.nativeSessionId,
        canonical.logicalSessionId,
        canonical.versionId,
        context.directory,
      );
    }
    const advanced: ProjectionSession = {
      ...session.projection,
      logicalSessionId: canonical.logicalSessionId,
      baseVersionId: canonical.versionId,
      nativeRevision: operation.nativeRevision,
      lastCommittedOperationId: operation.operationId,
      mode: deriving ? "maintenance-write" : session.projection.mode,
      derivedChildSessionId: deriving
        ? canonical.logicalSessionId
        : session.projection.derivedChildSessionId,
    };
    await input.runRepository.upsertProjectionSession(advanced);
    session.projection = advanced;
    if (deriving) session.authorityScope = "maintenance";
    await context.wal.markCommitted(operation.operationId, receipt, input.clock());
    if (derivationSpan !== undefined) {
      await input.statusLog.succeed(derivationSpan);
      derivationSpan = undefined;
    }
    await input.statusLog.succeed(span);
    return receipt;
  } catch (error) {
    if (error instanceof ProjectionAppendError) failureCode = error.code;
    if (derivationSpan !== undefined) {
      await input.statusLog.fail(derivationSpan, { errorCode: failureCode });
    }
    await input.statusLog.fail(span, { errorCode: failureCode });
    if (error instanceof ProjectionAppendError) throw error;
    throw new ProjectionAppendError(failureCode, "Projection append did not reach a durable Maintenance receipt", { cause: error });
  }
}
