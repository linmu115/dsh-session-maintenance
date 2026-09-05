import {
  canonicalEventV1Schema,
  type AdapterContractRef,
  type CanonicalEventV1,
  type CanonicalSessionRecord,
  type JsonValue,
  type LogicalSessionId,
  type LogicalWorkspaceId,
  type PlatformSessionKey,
  type SessionVersionId,
  type StateFingerprint,
  type WorkspaceMembership,
} from "@linmu/dsh-session-contracts";
import { sha256Canonical, versionIdFor } from "@linmu/dsh-session-domain";
import { retainCanonicalEventIdentities } from "./retained-event-identity.js";

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
  readonly authorityBinding?: {
    readonly bindingId: string;
    readonly key: PlatformSessionKey;
    readonly adapterContract: AdapterContractRef;
    readonly fingerprint: StateFingerprint;
  };
}

export interface CodexMirrorRetitleInput {
  readonly logicalSessionId: LogicalSessionId;
  readonly title: string;
  readonly appliedAt: string;
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
    metadataAvailability: "available",
    metadataProvenance: "captured",
    firstPersistedAt: null,
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
  const head = parentVersionIds.length === 0 ? undefined : await store.getVersion(parentVersionIds[0]!);
  if (parentVersionIds.length > 0 && head === undefined) {
    throw new Error(`Canonical head version is missing: ${current!.headVersionId}`);
  }
  const version = buildCanonicalVersion({
    logicalSessionId: input.logicalSessionId,
    parentVersionIds,
    events: retainCanonicalEventIdentities(head?.events ?? [], input.events),
    workspaceId: input.workspaceId,
    title: input.title,
    tags: input.tags,
    archivedAt: input.archivedAt,
    createdAt: input.observedAt,
  });
  const observation: CodexObservationRecord = {
    logicalSessionId: input.logicalSessionId,
    versionId: version.id,
    sourceCursor: input.sourceCursor,
    observedAt: input.observedAt,
    bodyDigest: version.bodyDigest,
    metadataDigest: version.metadataDigest,
    authorityBinding: input.authorityBinding ?? null,
  };
  if (current?.headVersionId !== null && current !== undefined) {
    if (head === undefined) {
      throw new Error(`Canonical head version is missing: ${current.headVersionId}`);
    }
    if (head.bodyDigest === version.bodyDigest && head.metadataDigest === version.metadataDigest) {
      await store.recordCodexObservation({ ...observation, versionId: head.id });
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

/**
 * Applies Codex's lightweight catalog title without re-reading or rewriting its
 * authoritative rollout. Conversation events and activity ordering stay fixed;
 * only canonical metadata advances.
 */
export async function retitleCodexMirror(
  store: CanonicalSessionEngineStore,
  input: CodexMirrorRetitleInput,
): Promise<CanonicalEngineReceipt | undefined> {
  const title = input.title.trim();
  if (title.length === 0) throw new TypeError("Codex mirror title must not be empty");
  if (store.retitleCodexMirrorMetadata !== undefined) {
    return store.retitleCodexMirrorMetadata({ ...input, title });
  }
  const current = await store.getSession(input.logicalSessionId);
  if (current === undefined) return undefined;
  if (current.session.authorityScope !== "codex" || current.session.originKind !== "codex-mirror") {
    throw new Error(`Codex catalog title cannot update a Maintenance-owned session: ${input.logicalSessionId}`);
  }
  if (current.session.title === title) {
    return {
      outcome: "noop",
      operationId: null,
      logicalSessionId: input.logicalSessionId,
      versionId: current.headVersionId,
      tombstoneState: null,
      committedAt: input.appliedAt,
    };
  }
  if (current.headVersionId === null) throw new Error(`Codex mirror has no canonical head: ${input.logicalSessionId}`);
  const head = await store.getVersion(current.headVersionId);
  if (head === undefined) throw new Error(`Canonical head version is missing: ${current.headVersionId}`);
  const version = buildCanonicalVersion({
    logicalSessionId: input.logicalSessionId,
    parentVersionIds: [head.id],
    events: head.events,
    workspaceId: head.workspaceId,
    title,
    tags: current.session.tags,
    archivedAt: current.session.archivedAt,
    createdAt: input.appliedAt,
  });
  const session: CanonicalSessionRecord = {
    ...current.session,
    headVersionId: version.id,
    title,
    // A catalog-only rename must not make an old conversation look recently active.
    updatedAt: current.session.updatedAt,
  };
  const receipt: CanonicalEngineReceipt = {
    outcome: "advanced",
    operationId: null,
    logicalSessionId: input.logicalSessionId,
    versionId: version.id,
    tombstoneState: null,
    committedAt: input.appliedAt,
  };
  return store.commit({
    kind: "codex-observation",
    operationId: null,
    session,
    version,
    membership: null,
    derivation: null,
    projectionReceipt: null,
    tombstone: current.tombstone,
    observation: null,
    receipt,
  });
}
