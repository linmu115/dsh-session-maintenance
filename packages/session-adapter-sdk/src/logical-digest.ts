import { createHash } from "node:crypto";

import type { CanonicalProjectionInput, JsonValue } from "@linmu/dsh-session-contracts";

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}

/** Adapter-neutral digest used only for cross-version projection verification. */
export function logicalProjectionDigest(input: CanonicalProjectionInput): string {
  const value = {
    workspaces: [...input.workspaces].sort((left, right) => left.id.localeCompare(right.id)).map((workspace) => ({ id: workspace.id, parentId: workspace.parentId, name: workspace.name, sortKey: workspace.sortKey, deletedAt: workspace.deletedAt })),
    sessions: [...input.sessions].sort((left, right) => left.session.id.localeCompare(right.session.id)).map((item) => ({
      id: item.session.id,
      authorityScope: item.session.authorityScope,
      originKind: item.session.originKind,
      headVersionId: item.session.headVersionId,
      workspaceId: item.workspaceId,
      title: item.session.title,
      tags: item.session.tags,
      archivedAt: item.session.archivedAt,
      tombstonedAt: item.session.tombstonedAt,
      events: [...item.events].sort((left, right) => left.sequence - right.sequence).map((event) => ({ id: event.id, sequence: event.sequence, kind: event.kind, role: event.role, contentDigest: event.contentDigest })),
    })),
  } as unknown as JsonValue;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex")}`;
}
