import type {
  CheckpointId,
  OperationId,
  SessionTombstone,
  WorkspaceMembership,
} from "@linmu/dsh-session-contracts";

import type {
  CanonicalEngineReceipt,
  CanonicalSessionEngineStore,
} from "./engine.js";

export interface TombstoneSessionInput {
  readonly logicalSessionId: SessionTombstone["logicalSessionId"];
  readonly operationId: OperationId;
  readonly checkpointId: CheckpointId;
  readonly deletedAt: string;
  readonly retentionUntil: string;
}

export interface RestoreSessionInput {
  readonly logicalSessionId: SessionTombstone["logicalSessionId"];
  readonly operationId: OperationId;
  readonly restoredAt: string;
}

function membership(
  input: WorkspaceMembership,
): WorkspaceMembership {
  return input;
}

export async function tombstoneSession(
  store: CanonicalSessionEngineStore,
  input: TombstoneSessionInput,
): Promise<CanonicalEngineReceipt> {
  const deletedAt = Date.parse(input.deletedAt);
  const retentionUntil = Date.parse(input.retentionUntil);
  if (!Number.isFinite(deletedAt) || !Number.isFinite(retentionUntil) || retentionUntil <= deletedAt) {
    throw new TypeError("Tombstone retention must end after the deletion timestamp");
  }
  if (String(input.checkpointId).length === 0) {
    throw new TypeError("Tombstone requires a deletion-preflight checkpoint");
  }
  const priorReceipt = await store.getOperationReceipt(input.operationId);
  if (priorReceipt !== undefined) return priorReceipt;
  const current = await store.getSession(input.logicalSessionId);
  if (current === undefined) throw new Error(`Cannot tombstone a missing session: ${input.logicalSessionId}`);
  if (current.tombstone !== null && current.tombstone.restoredAt === null) {
    throw new Error(`Session is already tombstoned: ${input.logicalSessionId}`);
  }
  const tombstone: SessionTombstone = {
    schemaVersion: 1,
    logicalSessionId: input.logicalSessionId,
    operationId: input.operationId,
    checkpointId: input.checkpointId,
    previousWorkspaceId: current.workspaceId,
    deletedAt: input.deletedAt,
    retentionUntil: input.retentionUntil,
    restoredAt: null,
  };
  const session = {
    ...current.session,
    tombstonedAt: input.deletedAt,
    updatedAt: input.deletedAt,
  };
  const receipt: CanonicalEngineReceipt = {
    outcome: "tombstoned",
    operationId: input.operationId,
    logicalSessionId: input.logicalSessionId,
    versionId: current.headVersionId,
    tombstoneState: "deleted",
    committedAt: input.deletedAt,
  };
  return store.commit({
    kind: "tombstone",
    operationId: input.operationId,
    session,
    version: null,
    membership: membership({
      schemaVersion: 1,
      logicalSessionId: input.logicalSessionId,
      workspaceId: null,
      displayOrder: 0,
      pinned: false,
      archived: true,
      revision: current.membershipRevision + 1,
    }),
    derivation: null,
    projectionReceipt: null,
    tombstone,
    observation: null,
    receipt,
  });
}

export async function restoreSession(
  store: CanonicalSessionEngineStore,
  input: RestoreSessionInput,
): Promise<CanonicalEngineReceipt> {
  const priorReceipt = await store.getOperationReceipt(input.operationId);
  if (priorReceipt !== undefined) return priorReceipt;
  const current = await store.getSession(input.logicalSessionId);
  if (current === undefined) throw new Error(`Cannot restore a missing session: ${input.logicalSessionId}`);
  if (current.tombstone === null || current.tombstone.restoredAt !== null) {
    throw new Error(`Session does not have an active tombstone: ${input.logicalSessionId}`);
  }
  const tombstone: SessionTombstone = {
    ...current.tombstone,
    restoredAt: input.restoredAt,
  };
  const session = {
    ...current.session,
    tombstonedAt: null,
    updatedAt: input.restoredAt,
  };
  const receipt: CanonicalEngineReceipt = {
    outcome: "tombstoned",
    operationId: input.operationId,
    logicalSessionId: input.logicalSessionId,
    versionId: current.headVersionId,
    tombstoneState: "restored",
    committedAt: input.restoredAt,
  };
  return store.commit({
    kind: "restore",
    operationId: input.operationId,
    session,
    version: null,
    membership: membership({
      schemaVersion: 1,
      logicalSessionId: input.logicalSessionId,
      workspaceId: current.tombstone.previousWorkspaceId,
      displayOrder: 0,
      pinned: false,
      archived: current.session.archivedAt !== null,
      revision: current.membershipRevision + 1,
    }),
    derivation: null,
    projectionReceipt: null,
    tombstone,
    observation: null,
    receipt,
  });
}
