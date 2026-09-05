import type {
  CanonicalEventV1,
  JsonValue,
  LogicalSessionId,
  LogicalWorkspaceId,
  OperationId,
} from "@linmu/dsh-session-contracts";
import { sha256Canonical } from "@linmu/dsh-session-domain";
import { SessionMaintenanceError } from "@linmu/dsh-session-contracts";

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
): DerivedSessionMetadata {
  const metadata = record(base.metadata);
  if (base.metadataAvailability === "corrupt" ||
      (base.metadataAvailability === "available" && (metadata === undefined || sha256Canonical(metadata) !== base.metadataDigest))) {
    throw new SessionMaintenanceError("OBJECT_CORRUPT", `Historical metadata digest is corrupt: ${base.id}`);
  }
  if (base.metadataAvailability !== "available" || metadata === undefined ||
      typeof metadata.title !== "string" || !Array.isArray(metadata.tags) ||
      !metadata.tags.every((tag) => typeof tag === "string") ||
      !(metadata.archivedAt === null || typeof metadata.archivedAt === "string")) {
    throw new SessionMaintenanceError("HISTORICAL_METADATA_UNAVAILABLE", `Historical metadata is unavailable for derivation: ${base.id}`);
  }
  const { title, archivedAt } = metadata;
  const tags = metadata.tags as string[];
  return { title, tags, archivedAt, workspaceId: base.workspaceId };
}

export function retargetDerivedEvents(
  events: readonly CanonicalEventV1[],
  childId: LogicalSessionId,
): readonly CanonicalEventV1[] {
  return events.map((event) => ({ ...event, logicalSessionId: childId }));
}
