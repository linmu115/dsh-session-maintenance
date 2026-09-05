import type { DatabaseSync } from "node:sqlite";
import type { JsonValue, VersionMetadataSnapshot } from "@linmu/dsh-session-contracts";
import { canonicalJson, sha256Canonical } from "@linmu/dsh-session-domain";

interface SnapshotRow {
  readonly metadata_json: string | null;
  readonly availability: VersionMetadataSnapshot["metadataAvailability"];
  readonly provenance: VersionMetadataSnapshot["metadataProvenance"];
  readonly first_persisted_at: string | null;
  readonly metadata_hash: string;
}

export function readVersionMetadataSnapshot(database: DatabaseSync, versionId: string): VersionMetadataSnapshot {
  const row = database.prepare(
    `SELECT m.metadata_json, m.availability, m.provenance, m.first_persisted_at, v.metadata_hash
     FROM session_versions v LEFT JOIN version_metadata_snapshots m ON m.version_id = v.id WHERE v.id = ?`,
  ).get(versionId) as SnapshotRow | undefined;
  const unknown: VersionMetadataSnapshot = {
    metadata: null, metadataAvailability: "unknown", metadataProvenance: "unavailable",
    firstPersistedAt: row?.first_persisted_at ?? null,
  };
  if (row?.availability !== "available") return unknown;
  const corrupt: VersionMetadataSnapshot = { ...unknown, metadataAvailability: "corrupt" };
  if (row.metadata_json === null) return corrupt;
  try {
    const metadata = JSON.parse(row.metadata_json) as JsonValue;
    if (metadata === null || sha256Canonical(metadata) !== row.metadata_hash) return corrupt;
    return { ...unknown, metadata, metadataAvailability: "available", metadataProvenance: row.provenance };
  } catch { return corrupt; }
}

/** Caller owns the version transaction. Never replace an already verified snapshot or its local clock. */
export function saveVersionMetadataSnapshot(
  database: DatabaseSync,
  versionId: string,
  metadata: JsonValue,
  provenance: Exclude<VersionMetadataSnapshot["metadataProvenance"], "unavailable">,
): void {
  const row = database.prepare("SELECT metadata_hash FROM session_versions WHERE id = ?").get(versionId) as
    { readonly metadata_hash: string } | undefined;
  if (metadata === null || row === undefined || sha256Canonical(metadata) !== row.metadata_hash) {
    throw new Error(`Version metadata digest mismatch: ${versionId}`);
  }
  database.prepare(
    `INSERT INTO version_metadata_snapshots (version_id, metadata_json, availability, provenance, first_persisted_at)
     VALUES (?, ?, 'available', ?, NULL)
     ON CONFLICT(version_id) DO UPDATE SET metadata_json = excluded.metadata_json,
       availability = excluded.availability, provenance = excluded.provenance
     WHERE version_metadata_snapshots.availability = 'unknown'`,
  ).run(versionId, canonicalJson(metadata), provenance);
  const stored = readVersionMetadataSnapshot(database, versionId);
  if (stored.metadataAvailability !== "available" || canonicalJson(stored.metadata) !== canonicalJson(metadata)) {
    throw new Error(`Version metadata snapshot collision: ${versionId}`);
  }
}

/** Legacy normalized bodies contain their own metadata, unlike MCSF event-only bodies. */
export function metadataFromStoredBody(bytes: Uint8Array, metadataHash: string): JsonValue | undefined {
  try {
    const body = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    if (typeof body.title !== "string" || typeof body.archived !== "boolean") return undefined;
    const candidate = { title: body.title, archived: body.archived };
    return sha256Canonical(candidate) === metadataHash ? candidate : undefined;
  } catch { return undefined; }
}

/** Only a matching hash proves that today's row also describes this historical version. */
export function reconstructCurrentVersionMetadata(database: DatabaseSync): void {
  const rows = database.prepare(
    `SELECT v.id, v.metadata_hash, s.display_title, s.labels_json, s.archived_at, s.archived
     FROM session_versions v JOIN logical_sessions s ON s.id = v.logical_session_id
     JOIN version_metadata_snapshots m ON m.version_id = v.id WHERE m.availability = 'unknown'`,
  ).all() as unknown as Array<{
    id: string; metadata_hash: string; display_title: string; labels_json: string;
    archived_at: string | null; archived: number;
  }>;
  for (const row of rows) {
    let tags: unknown;
    try { tags = JSON.parse(row.labels_json); } catch { continue; }
    const candidates: JsonValue[] = [{ title: row.display_title, archived: row.archived === 1 }];
    if (Array.isArray(tags) && tags.every((tag) => typeof tag === "string")) {
      candidates.unshift({ title: row.display_title, tags, archivedAt: row.archived_at });
    }
    const candidate = candidates.find((item) => sha256Canonical(item) === row.metadata_hash);
    if (candidate !== undefined) saveVersionMetadataSnapshot(database, row.id, candidate, "reconstructed-current");
  }
}
