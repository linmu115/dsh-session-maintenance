import {
  canonicalEventV1Schema,
  type CanonicalEventV1,
  type CanonicalSessionRecord,
  type JsonValue,
  type LogicalSessionId,
  type LogicalWorkspaceId,
  type SessionVersionId,
  type WorkspaceMembership,
} from "@linmu/dsh-session-contracts";
import { sha256Canonical, versionIdFor } from "@linmu/dsh-session-domain";

import type {
  CanonicalEngineReceipt,
  CanonicalSessionEngineStore,
  CanonicalVersionRecord,
  CodexObservationRecord,
} from "./engine.js";

export interface CodexObservationInput {
  readonly logicalSessionId: LogicalSessionId;
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly events: readonly CanonicalEventV1[];
  readonly sourceCursor: string | null;
  readonly observedAt: string;
}

export interface CanonicalVersionInput {
  readonly logicalSessionId: LogicalSessionId;
  readonly parentVersionIds: readonly SessionVersionId[];
  readonly events: readonly CanonicalEventV1[];
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly allowForeignEventSessionIds?: boolean;
}

function assertEventOrder(
  logicalSessionId: LogicalSessionId,
  events: readonly CanonicalEventV1[],
  allowForeignEventSessionIds: boolean,
): void {
  const ids = new Set<string>();
  let previousSequence = -1;
  for (const event of events) {
    canonicalEventV1Schema.parse(event);
    if (!allowForeignEventSessionIds && event.logicalSessionId !== logicalSessionId) {
      throw new TypeError(`Canonical event belongs to another logical session: ${event.id}`);
    }
    if (ids.has(event.id)) throw new TypeError(`Duplicate canonical event ID: ${event.id}`);
    if (event.sequence <= previousSequence) {
      throw new TypeError(`Canonical event sequence is not strictly increasing: ${event.id}`);
    }
    ids.add(event.id);
    previousSequence = event.sequence;
  }
}

export function buildCanonicalVersion(input: CanonicalVersionInput): CanonicalVersionRecord {
  assertEventOrder(
    input.logicalSessionId,
    input.events,
    input.allowForeignEventSessionIds ?? false,
  );
  const body = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    events: input.events,
  } as unknown as JsonValue;
  const metadata = {
    title: input.title,
    tags: [...input.tags],
    archivedAt: input.archivedAt,
  } as JsonValue;
  const bodyDigest = sha256Canonical(body);
  const metadataDigest = sha256Canonical(metadata);
  const contentDigest = sha256Canonical({ body, metadata });
  const id = versionIdFor({
    logicalSessionId: input.logicalSessionId,
    parents: input.parentVersionIds,
    bodyHash: bodyDigest,
    metadataHash: metadataDigest,
  }) as SessionVersionId;
  return {
    id,
    logicalSessionId: input.logicalSessionId,
    parentVersionIds: [...input.parentVersionIds],
    events: input.events.map((event) => ({ ...event })),
    workspaceId: input.workspaceId,
    body,
    metadata,
    bodyDigest,
    metadataDigest,
    contentDigest,
    createdAt: input.createdAt,
  };
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

export async function observeCodex(
  store: CanonicalSessionEngineStore,
  input: CodexObservationInput,
): Promise<CanonicalEngineReceipt> {
  const current = await store.getSession(input.logicalSessionId);
  if (
    current !== undefined &&
    (current.session.authorityScope !== "codex" || current.session.originKind !== "codex-mirror")
  ) {
    throw new Error(`Codex observation cannot update a Maintenance-owned session: ${input.logicalSessionId}`);
  }
  const parentVersionIds = current?.headVersionId === null || current === undefined
    ? []
    : [current.headVersionId];
  const version = buildCanonicalVersion({
    logicalSessionId: input.logicalSessionId,
    parentVersionIds,
    events: input.events,
    workspaceId: input.workspaceId,
    title: input.title,
    tags: input.tags,
    archivedAt: input.archivedAt,
    createdAt: input.observedAt,
  });
  const observation: CodexObservationRecord = {
    logicalSessionId: input.logicalSessionId,
    sourceCursor: input.sourceCursor,
    observedAt: input.observedAt,
    bodyDigest: version.bodyDigest,
    metadataDigest: version.metadataDigest,
  };
  if (current?.headVersionId !== null && current !== undefined) {
    const head = await store.getVersion(current.headVersionId);
    if (head === undefined) {
      throw new Error(`Canonical head version is missing: ${current.headVersionId}`);
    }
    if (head.bodyDigest === version.bodyDigest && head.metadataDigest === version.metadataDigest) {
      await store.recordCodexObservation(observation);
      return {
        outcome: "noop",
        operationId: null,
        logicalSessionId: input.logicalSessionId,
        versionId: head.id,
        tombstoneState: null,
        committedAt: input.observedAt,
      };
    }
  }

  const session: CanonicalSessionRecord = {
    schemaVersion: 1,
    id: input.logicalSessionId,
    authorityScope: "codex",
    originKind: "codex-mirror",
    headVersionId: version.id,
    title: input.title,
    tags: [...input.tags],
    archivedAt: input.archivedAt,
    tombstonedAt: current?.session.tombstonedAt ?? null,
    createdAt: current?.session.createdAt ?? input.observedAt,
    updatedAt: input.observedAt,
  };
  const membershipWorkspaceId =
    current?.tombstone !== null && current?.tombstone !== undefined && current.tombstone.restoredAt === null
      ? current.workspaceId
      : input.workspaceId;
  const receipt: CanonicalEngineReceipt = {
    outcome: current === undefined ? "created" : "advanced",
    operationId: null,
    logicalSessionId: input.logicalSessionId,
    versionId: version.id,
    tombstoneState: null,
    committedAt: input.observedAt,
  };
  return store.commit({
    kind: "codex-observation",
    operationId: null,
    session,
    version,
    membership: membership(
      input.logicalSessionId,
      membershipWorkspaceId,
      (current?.membershipRevision ?? -1) + 1,
      input.archivedAt !== null,
    ),
    derivation: null,
    projectionReceipt: null,
    tombstone: current?.tombstone ?? null,
    observation,
    receipt,
  });
}
