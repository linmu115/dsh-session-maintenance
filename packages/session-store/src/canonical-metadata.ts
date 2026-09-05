import type { DatabaseSync } from "node:sqlite";
import type { CanonicalSessionMaintenancePatch, LogicalSessionId, SessionVersionId } from "@linmu/dsh-session-contracts";
import type { CanonicalEngineReceipt } from "@linmu/dsh-canonical-session-engine";
import { canonicalJson, sha256Canonical, versionIdFor } from "@linmu/dsh-session-domain";
import { saveVersionMetadataSnapshot } from "./version-metadata.js";

/** Synchronous so the caller can keep identity resolution, membership, and metadata in one transaction. */
export function advanceCanonicalSessionMetadata(database: DatabaseSync, input: {
  readonly logicalSessionId: string;
  readonly patch: Pick<CanonicalSessionMaintenancePatch, "title" | "tags" | "archived">;
  readonly appliedAt: string;
  readonly codexCatalog?: boolean;
}): CanonicalEngineReceipt | undefined {
  database.exec("SAVEPOINT canonical_metadata_update");
  try {
    const row = database.prepare(
      `SELECT display_title, labels_json, archived_at, head_version_id, updated_at, authority_scope, origin_kind
       FROM logical_sessions WHERE id = ? AND authority_scope IS NOT NULL`,
    ).get(input.logicalSessionId) as {
      display_title: string; labels_json: string; archived_at: string | null; head_version_id: string | null;
      updated_at: string; authority_scope: string; origin_kind: string;
    } | undefined;
    if (row === undefined) {
      database.exec("RELEASE canonical_metadata_update");
      return undefined;
    }
    if (input.codexCatalog && (row.authority_scope !== "codex" || row.origin_kind !== "codex-mirror")) {
      throw new Error(`Codex catalog title cannot update a Maintenance-owned session: ${input.logicalSessionId}`);
    }
    const metadata = {
      title: input.patch.title ?? row.display_title,
      tags: input.patch.tags === undefined ? JSON.parse(row.labels_json) as string[] : [...input.patch.tags],
      archivedAt: input.patch.archived === undefined ? row.archived_at
        : input.patch.archived ? row.archived_at ?? input.appliedAt : null,
    };
    const metadataHash = sha256Canonical(metadata);
    const unchanged = metadataHash === sha256Canonical({
      title: row.display_title, tags: JSON.parse(row.labels_json) as string[], archivedAt: row.archived_at,
    });
    const head = row.head_version_id === null ? undefined : database.prepare(
      "SELECT body_object, body_hash, metadata_hash FROM session_versions WHERE id = ? AND logical_session_id = ?",
    ).get(row.head_version_id, input.logicalSessionId) as {
      body_object: string; body_hash: string; metadata_hash: string;
    } | undefined;
    if (row.head_version_id !== null && head === undefined) {
      throw new Error(`Canonical head version is missing: ${row.head_version_id}`);
    }
    let versionId = row.head_version_id;
    // Even a repeated patch repairs an old head/current-metadata mismatch by making an explicit new version.
    const advanced = !unchanged || (head !== undefined && metadataHash !== head.metadata_hash);
    if (advanced && head !== undefined) {
      versionId = versionIdFor({
        logicalSessionId: input.logicalSessionId, parents: [row.head_version_id!],
        bodyHash: head.body_hash, metadataHash,
      });
      const manifest = {
        schemaVersion: 1, id: versionId, logicalSessionId: input.logicalSessionId,
        parents: [row.head_version_id!], bodyObject: head.body_object, bodyHash: head.body_hash, metadataHash,
        source: {
          platform: input.codexCatalog ? "codex" : "dsh",
          instanceId: input.codexCatalog ? "catalog-title-sync" : "canonical-metadata",
          sessionId: input.logicalSessionId, observedAt: input.appliedAt,
        },
        compatibility: { status: "compatible", issues: [] },
      };
      database.prepare(
        `INSERT INTO session_versions (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      ).run(versionId, input.logicalSessionId, head.body_object, head.body_hash, metadataHash, canonicalJson(manifest), input.appliedAt);
      database.prepare(
        "INSERT INTO version_parents (version_id, ordinal, parent_id) VALUES (?, 0, ?) ON CONFLICT(version_id, ordinal) DO NOTHING",
      ).run(versionId, row.head_version_id);
      const stored = database.prepare(
        "SELECT logical_session_id, body_object, body_hash, metadata_hash FROM session_versions WHERE id = ?",
      ).get(versionId) as { logical_session_id: string; body_object: string; body_hash: string; metadata_hash: string };
      const parents = database.prepare("SELECT parent_id FROM version_parents WHERE version_id = ? ORDER BY ordinal")
        .all(versionId) as unknown as Array<{ parent_id: string }>;
      if (stored.logical_session_id !== input.logicalSessionId || stored.body_object !== head.body_object ||
          stored.body_hash !== head.body_hash || stored.metadata_hash !== metadataHash ||
          parents.length !== 1 || parents[0]!.parent_id !== row.head_version_id) {
        throw new Error(`Canonical version ID collision: ${versionId}`);
      }
      saveVersionMetadataSnapshot(database, versionId, metadata, "captured");
    }
    if (advanced) {
      database.prepare(
        `UPDATE logical_sessions SET display_title = ?, labels_json = ?, archived_at = ?, archived = ?,
           head_version_id = ?, canonical_version_id = ?, updated_at = ? WHERE id = ?`,
      ).run(metadata.title, canonicalJson(metadata.tags), metadata.archivedAt, metadata.archivedAt === null ? 0 : 1,
        versionId, versionId, input.codexCatalog ? row.updated_at : input.appliedAt, input.logicalSessionId);
    }
    database.exec("RELEASE canonical_metadata_update");
    return {
      outcome: advanced ? "advanced" : "noop", operationId: null,
      logicalSessionId: input.logicalSessionId as LogicalSessionId, versionId: versionId as SessionVersionId | null,
      tombstoneState: null, committedAt: input.appliedAt,
    };
  } catch (error) {
    try { database.exec("ROLLBACK TO canonical_metadata_update; RELEASE canonical_metadata_update"); } catch { /* preserve failure */ }
    throw error;
  }
}
