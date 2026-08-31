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
import type { StatusLog } from "@linmu/dsh-session-status-log";

import type { JsonProjectionDirectory } from "./materialize.js";
import type { ProjectionRunHandle } from "./lifecycle.js";
import { ProjectionWriteAheadLog } from "./wal.js";

export interface ActiveProjectionSession {
  projection: ProjectionSession;
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly authorityScope: CanonicalSessionRecord["authorityScope"];
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
}

export interface ProjectionAppendContext {
  readonly handle: ProjectionRunHandle;
  readonly directory: JsonProjectionDirectory;
  readonly wal: ProjectionWriteAheadLog;
  readonly sessions: Map<string, ActiveProjectionSession>;
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
    || !("applyAppend" in bridge) || typeof bridge.applyAppend !== "function") {
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
    if (session.projection.nativeRevision < existingReceipt.projectionRevision) {
      const advanced: ProjectionSession = {
        ...session.projection,
        logicalSessionId: existingReceipt.logicalSessionId,
        baseVersionId: existingReceipt.canonicalVersionId,
        nativeRevision: existingReceipt.projectionRevision,
        lastCommittedOperationId: existingReceipt.operationId,
      };
      await input.runRepository.upsertProjectionSession(advanced);
      session.projection = advanced;
    }
    const wal = await context.wal.get(operation.operationId);
    if (wal !== undefined && wal.state !== "committed" && wal.projectionApplied) {
      await context.wal.markCommitted(operation.operationId, existingReceipt, input.clock());
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
    const receipt = toReceipt(
      operation,
      canonical.logicalSessionId,
      canonical.versionId,
      canonical.committedAt,
    );
    failureCode = "PROJECTION_RECEIPT_WRITE_FAILED";
    await input.runRepository.saveOperationReceipt(receipt);
    const advanced: ProjectionSession = {
      ...session.projection,
      logicalSessionId: canonical.logicalSessionId,
      baseVersionId: canonical.versionId,
      nativeRevision: operation.nativeRevision,
      lastCommittedOperationId: operation.operationId,
    };
    await input.runRepository.upsertProjectionSession(advanced);
    session.projection = advanced;
    await context.wal.markCommitted(operation.operationId, receipt, input.clock());
    await input.statusLog.succeed(span);
    return receipt;
  } catch (error) {
    if (error instanceof ProjectionAppendError) failureCode = error.code;
    await input.statusLog.fail(span, { errorCode: failureCode });
    if (error instanceof ProjectionAppendError) throw error;
    throw new ProjectionAppendError(failureCode, "Projection append did not reach a durable Maintenance receipt", { cause: error });
  }
}
