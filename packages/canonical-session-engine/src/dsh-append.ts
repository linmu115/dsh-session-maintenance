import type {
  AdapterId,
  BranchId,
  CanonicalEventV1,
  CanonicalSessionRecord,
  LeaseId,
  LogicalSessionId,
  LogicalWorkspaceId,
  NativeSessionId,
  OperationId,
  ProjectionOperationReceipt,
  RunId,
  SessionDerivation,
  SessionVersionId,
  WorkspaceMembership,
} from "@linmu/dsh-session-contracts";

import { buildCanonicalVersion } from "./codex-observation.js";
import type {
  CanonicalEngineReceipt,
  CanonicalSessionEngineStore,
  CanonicalSessionSnapshot,
} from "./engine.js";

export interface DshProjectionAppendContext {
  readonly runId: RunId;
  readonly leaseId: LeaseId;
  readonly branchId: BranchId;
  readonly adapterId: AdapterId;
  readonly nativeSessionId: NativeSessionId;
  readonly operationId: OperationId;
  readonly nativeRevision: number;
}

export interface DshAppendInput {
  readonly logicalSessionId: LogicalSessionId;
  readonly derivedLogicalSessionId?: LogicalSessionId;
  readonly baseVersionId?: SessionVersionId;
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly appendedEvents: readonly CanonicalEventV1[];
  readonly observedAt: string;
  readonly projection: DshProjectionAppendContext;
}

function assertAppendTarget(
  logicalSessionId: LogicalSessionId,
  events: readonly CanonicalEventV1[],
): void {
  for (const event of events) {
    if (event.logicalSessionId !== logicalSessionId) {
      throw new TypeError(`DSH append event targets another logical session: ${event.id}`);
    }
  }
}

function membership(
  logicalSessionId: LogicalSessionId,
  workspaceId: LogicalWorkspaceId | null,
  revision: number,
  archived: boolean,
): WorkspaceMembership {
  return {
    schemaVersion: 1,
    logicalSessionId,
    workspaceId,
    displayOrder: 0,
    pinned: false,
    archived,
    revision,
  };
}

function activeTombstone(snapshot: CanonicalSessionSnapshot): boolean {
  return snapshot.tombstone !== null && snapshot.tombstone.restoredAt === null;
}

export async function appendDsh(
  store: CanonicalSessionEngineStore,
  input: DshAppendInput,
): Promise<CanonicalEngineReceipt> {
  const priorReceipt = await store.getOperationReceipt(input.projection.operationId);
  if (priorReceipt !== undefined) return priorReceipt;

  const source = await store.getSession(input.logicalSessionId);
  if (source !== undefined && activeTombstone(source)) {
    throw new Error(`Cannot append to a tombstoned session: ${input.logicalSessionId}`);
  }

  let targetId = input.logicalSessionId;
  let targetSnapshot = source;
  let baseEvents: readonly CanonicalEventV1[] = [];
  let parentVersionIds: readonly SessionVersionId[] = [];
  let derivation: SessionDerivation | null = null;
  let outcome: CanonicalEngineReceipt["outcome"];
  let title = input.title;
  let tags = input.tags;
  let archivedAt = input.archivedAt;
  let workspaceId = input.workspaceId;
  let originKind: CanonicalSessionRecord["originKind"] = "maintenance-native";

  if (source === undefined) {
    outcome = "created";
  } else if (source.session.authorityScope === "codex") {
    if (source.session.originKind !== "codex-mirror") {
      throw new Error(`Codex authority requires a codex-mirror origin: ${source.session.id}`);
    }
    if (input.derivedLogicalSessionId === undefined || input.baseVersionId === undefined) {
      throw new Error("First DSH write to a Codex mirror requires a derived session ID and base version");
    }
    const base = await store.getVersion(input.baseVersionId);
    if (base === undefined || base.logicalSessionId !== source.session.id) {
      throw new Error(`Codex derivation base version is invalid: ${input.baseVersionId}`);
    }
    targetId = input.derivedLogicalSessionId;
    targetSnapshot = await store.getSession(targetId);
    if (targetSnapshot !== undefined) {
      throw new Error(`Derived logical session already exists without an operation receipt: ${targetId}`);
    }
    baseEvents = base.events;
    title = source.session.title;
    tags = source.session.tags;
    archivedAt = source.session.archivedAt;
    workspaceId = source.workspaceId;
    originKind = "codex-derived";
    outcome = "derived";
    derivation = {
      schemaVersion: 1,
      childSessionId: targetId,
      parentSessionId: source.session.id,
      baseVersionId: base.id,
      kind: "dsh-continuation",
      triggerRunId: input.projection.runId,
      triggerOperationId: input.projection.operationId,
      createdAt: input.observedAt,
    };
  } else {
    if (source.session.authorityScope !== "maintenance") {
      throw new Error(`Unsupported session authority: ${source.session.authorityScope}`);
    }
    if (input.baseVersionId !== undefined && input.baseVersionId !== source.headVersionId) {
      throw new Error(`DSH append base version is stale: ${input.baseVersionId}`);
    }
    if (source.headVersionId !== null) {
      const head = await store.getVersion(source.headVersionId);
      if (head === undefined) throw new Error(`Canonical head version is missing: ${source.headVersionId}`);
      baseEvents = head.events;
      parentVersionIds = [head.id];
    }
    outcome = "advanced";
    originKind = source.session.originKind;
  }

  assertAppendTarget(targetId, input.appendedEvents);
  const version = buildCanonicalVersion({
    logicalSessionId: targetId,
    parentVersionIds,
    events: [...baseEvents, ...input.appendedEvents],
    workspaceId,
    title,
    tags,
    archivedAt,
    createdAt: input.observedAt,
    allowForeignEventSessionIds: derivation !== null,
  });
  const session: CanonicalSessionRecord = {
    schemaVersion: 1,
    id: targetId,
    authorityScope: "maintenance",
    originKind,
    headVersionId: version.id,
    title,
    tags: [...tags],
    archivedAt,
    tombstonedAt: null,
    createdAt: targetSnapshot?.session.createdAt ?? input.observedAt,
    updatedAt: input.observedAt,
  };
  const projectionReceipt: ProjectionOperationReceipt = {
    schemaVersion: 1,
    operationId: input.projection.operationId,
    runId: input.projection.runId,
    logicalSessionId: targetId,
    nativeSessionId: input.projection.nativeSessionId,
    status: "committed",
    canonicalVersionId: version.id,
    projectionRevision: input.projection.nativeRevision,
    committedAt: input.observedAt,
  };
  const receipt: CanonicalEngineReceipt = {
    outcome,
    operationId: input.projection.operationId,
    logicalSessionId: targetId,
    versionId: version.id,
    tombstoneState: null,
    committedAt: input.observedAt,
  };
  return store.commit({
    kind: derivation === null ? "dsh-append" : "dsh-derivation",
    operationId: input.projection.operationId,
    session,
    version,
    membership: membership(
      targetId,
      workspaceId,
      (targetSnapshot?.membershipRevision ?? -1) + 1,
      archivedAt !== null,
    ),
    derivation,
    projectionReceipt,
    tombstone: null,
    observation: null,
    receipt,
  });
}
