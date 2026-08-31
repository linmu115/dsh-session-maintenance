import type {
  CanonicalEventV1,
  CanonicalSessionRecord,
  JsonValue,
  LogicalSessionId,
  LogicalWorkspaceId,
  OperationId,
} from "@linmu/dsh-session-contracts";
import { sha256Canonical } from "@linmu/dsh-session-domain";

import type { CanonicalVersionRecord } from "./engine.js";

export interface DerivedSessionMetadata {
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly workspaceId: LogicalWorkspaceId | null;
}

function record(value: JsonValue): { readonly [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as { readonly [key: string]: JsonValue }
    : undefined;
}

export function derivedLogicalSessionIdFor(
  sourceId: LogicalSessionId,
  operationId: OperationId,
): LogicalSessionId {
  const digest = sha256Canonical({ sourceId, operationId });
  return `logical-derived:${digest.slice("sha256:".length)}` as LogicalSessionId;
}

export function metadataAtDerivationBase(
  base: CanonicalVersionRecord,
  fallback: CanonicalSessionRecord,
): DerivedSessionMetadata {
  const metadata = record(base.metadata);
  const title = typeof metadata?.title === "string" ? metadata.title : fallback.title;
  const tags = Array.isArray(metadata?.tags) && metadata.tags.every((tag) => typeof tag === "string")
    ? metadata.tags as string[]
    : fallback.tags;
  const archivedAt = metadata?.archivedAt === null || typeof metadata?.archivedAt === "string"
    ? metadata.archivedAt
    : fallback.archivedAt;
  return { title, tags, archivedAt, workspaceId: base.workspaceId };
}

export function retargetDerivedEvents(
  events: readonly CanonicalEventV1[],
  childId: LogicalSessionId,
): readonly CanonicalEventV1[] {
  return events.map((event) => ({ ...event, logicalSessionId: childId }));
}
