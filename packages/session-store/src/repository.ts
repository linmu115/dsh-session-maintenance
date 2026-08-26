import type { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_SCHEMA_VERSION,
  SessionMaintenanceError,
  sessionVersionManifestSchema,
  syncPlanSchema,
  type ContentObjectStore,
  type JsonValue,
  type LogicalSession,
  type NewVersion,
  type ObservedHead,
  type SessionVersionManifest,
  type SyncPlan,
  type VersionGraphData,
} from "@linmu/dsh-session-contracts";
import {
  canonicalJson,
  sha256Canonical,
  verifySyncPlanIdentity,
} from "@linmu/dsh-session-domain";

interface ManifestRow {
  readonly manifest_json: string;
}

interface VersionRow {
  readonly id: string;
}

interface ParentRow {
  readonly version_id: string;
  readonly parent_id: string;
}

interface ObjectRow {
  readonly body_object: string;
}

interface PlanRow {
  readonly id: string;
  readonly hash: string;
  readonly plan_json: string;
}

type JsonObject = { readonly [key: string]: JsonValue };

function issueJson(issue: NewVersion["compatibility"]["issues"][number]): JsonValue {
  return {
    code: issue.code,
    message: issue.message,
    ...(issue.sourceType === undefined ? {} : { sourceType: issue.sourceType }),
  };
}

function newVersionJson(input: NewVersion): JsonObject {
  return {
    logicalSessionId: input.logicalSessionId,
    parents: [...input.parents],
    bodyObject: input.bodyObject,
    bodyHash: input.bodyHash,
    metadataHash: input.metadataHash,
    source: {
      platform: input.source.platform,
      instanceId: input.source.instanceId,
      sessionId: input.source.sessionId,
      observedAt: input.source.observedAt,
      ...(input.source.sourceVersion === undefined
        ? {}
        : { sourceVersion: input.source.sourceVersion }),
    },
    compatibility: {
      status: input.compatibility.status,
      issues: input.compatibility.issues.map(issueJson),
    },
  };
}

function manifestJson(manifest: SessionVersionManifest): string {
  return canonicalJson({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    ...newVersionJson(manifest),
  });
}

export class SqliteSessionRepository {
  readonly database: DatabaseSync;
  readonly objectStore: ContentObjectStore;

  constructor(database: DatabaseSync, objectStore: ContentObjectStore) {
    this.database = database;
    this.objectStore = objectStore;
  }

  async createLogicalSession(input: LogicalSession): Promise<boolean> {
    const existing = this.database
      .prepare(
        `SELECT display_title, canonical_version_id, sync_mode, archived, labels_json, created_at
         FROM logical_sessions WHERE id = ?`,
      )
      .get(input.id) as
      | {
          readonly display_title: string;
          readonly canonical_version_id: string | null;
          readonly sync_mode: string;
          readonly archived: number;
          readonly labels_json: string;
          readonly created_at: string;
        }
      | undefined;
    if (existing !== undefined) {
      const same =
        existing.display_title === input.displayTitle &&
        existing.canonical_version_id === input.canonicalVersionId &&
        existing.sync_mode === input.syncMode &&
        Boolean(existing.archived) === input.archived &&
        existing.labels_json === canonicalJson([...input.labels]) &&
        existing.created_at === input.createdAt;
      if (!same) {
        throw new SessionMaintenanceError(
          "IDENTITY_CONFLICT",
          `Logical session ID already has different content: ${input.id}`,
        );
      }
      return false;
    }

    this.database
      .prepare(
        `INSERT INTO logical_sessions
          (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.displayTitle,
        input.canonicalVersionId,
        input.syncMode,
        input.archived ? 1 : 0,
        canonicalJson([...input.labels]),
        input.createdAt,
      );
    return true;
  }

  async putVersion(input: NewVersion): Promise<SessionVersionManifest> {
    await this.objectStore.get(input.bodyObject);
    const id = `sv_${sha256Canonical(newVersionJson(input)).slice(0, 24)}`;
    const manifest: SessionVersionManifest = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id,
      logicalSessionId: input.logicalSessionId,
      parents: [...input.parents],
      bodyObject: input.bodyObject,
      bodyHash: input.bodyHash,
      metadataHash: input.metadataHash,
      source: {
        platform: input.source.platform,
        instanceId: input.source.instanceId,
        sessionId: input.source.sessionId,
        observedAt: input.source.observedAt,
        ...(input.source.sourceVersion === undefined
          ? {}
          : { sourceVersion: input.source.sourceVersion }),
      },
      compatibility: {
        status: input.compatibility.status,
        issues: input.compatibility.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          ...(issue.sourceType === undefined ? {} : { sourceType: issue.sourceType }),
        })),
      },
    };
    const serialized = manifestJson(manifest);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT manifest_json FROM session_versions WHERE id = ?")
        .get(id) as ManifestRow | undefined;
      if (existing !== undefined) {
        if (existing.manifest_json !== serialized) {
          throw new SessionMaintenanceError(
            "VERSION_ID_COLLISION",
            `Version ID has different immutable content: ${id}`,
          );
        }
        this.database.exec("COMMIT");
        const parsed: unknown = JSON.parse(existing.manifest_json);
        sessionVersionManifestSchema.parse(parsed);
        return parsed as SessionVersionManifest;
      }

      this.database
        .prepare(
          `INSERT INTO session_versions
            (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.logicalSessionId,
          input.bodyObject,
          input.bodyHash,
          input.metadataHash,
          serialized,
          input.source.observedAt,
        );
      const insertParent = this.database.prepare(
        "INSERT INTO version_parents (version_id, ordinal, parent_id) VALUES (?, ?, ?)",
      );
      input.parents.forEach((parent, ordinal) => insertParent.run(id, ordinal, parent));
      this.database.exec("COMMIT");
      return manifest;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  async recordObservation(input: ObservedHead): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO platform_refs (binding_id, version_id, observed_at, fingerprint_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(binding_id) DO UPDATE SET
           version_id = excluded.version_id,
           observed_at = excluded.observed_at,
           fingerprint_json = excluded.fingerprint_json`,
      )
      .run(
        input.bindingId,
        input.versionId,
        input.observedAt,
        canonicalJson({
          platform: input.fingerprint.platform,
          instanceId: input.fingerprint.instanceId,
          sessionId: input.fingerprint.sessionId,
          kind: input.fingerprint.kind,
          value: input.fingerprint.value,
        }),
      );
  }

  async getGraph(logicalSessionId: string): Promise<VersionGraphData> {
    const versions = this.database
      .prepare("SELECT id FROM session_versions WHERE logical_session_id = ? ORDER BY id")
      .all(logicalSessionId) as unknown as VersionRow[];
    const parents = this.database
      .prepare(
        `SELECT vp.version_id, vp.parent_id
         FROM version_parents vp
         JOIN session_versions sv ON sv.id = vp.version_id
         WHERE sv.logical_session_id = ?
         ORDER BY vp.version_id, vp.ordinal`,
      )
      .all(logicalSessionId) as unknown as ParentRow[];
    const byVersion = new Map<string, string[]>();
    for (const parent of parents) {
      const list = byVersion.get(parent.version_id) ?? [];
      list.push(parent.parent_id);
      byVersion.set(parent.version_id, list);
    }
    return {
      nodes: versions.map((version) => ({
        id: version.id,
        parents: byVersion.get(version.id) ?? [],
      })),
    };
  }

  async listReachableObjectIds(): Promise<readonly string[]> {
    const rows = this.database
      .prepare(
        `WITH RECURSIVE
           roots(id) AS (
             SELECT version_id FROM platform_refs
             UNION
             SELECT canonical_version_id FROM logical_sessions WHERE canonical_version_id IS NOT NULL
             UNION
             SELECT CAST(json_each.value AS TEXT)
             FROM checkpoints, json_each(checkpoints.refs_json)
           ),
           reachable(id) AS (
             SELECT id FROM roots
             UNION
             SELECT vp.parent_id
             FROM version_parents vp
             JOIN reachable r ON vp.version_id = r.id
           )
         SELECT DISTINCT sv.body_object
         FROM session_versions sv
         JOIN reachable r ON r.id = sv.id
         ORDER BY sv.body_object`,
      )
      .all() as unknown as ObjectRow[];
    return rows.map((row) => row.body_object);
  }

  async savePlan(plan: SyncPlan): Promise<void> {
    syncPlanSchema.parse(plan);
    if (!verifySyncPlanIdentity(plan)) {
      throw new SessionMaintenanceError(
        "VERSION_ID_COLLISION",
        `Sync plan identity does not match its immutable content: ${plan.id}`,
      );
    }
    const serialized = canonicalJson(plan as unknown as JsonValue);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existingById = this.database
        .prepare("SELECT id, hash, plan_json FROM sync_plans WHERE id = ?")
        .get(plan.id) as PlanRow | undefined;
      if (existingById !== undefined) {
        if (existingById.hash !== plan.hash || existingById.plan_json !== serialized) {
          throw new SessionMaintenanceError(
            "VERSION_ID_COLLISION",
            `Sync plan ID has different immutable content: ${plan.id}`,
          );
        }
        this.database.exec("COMMIT");
        return;
      }

      const existingByHash = this.database
        .prepare("SELECT id, hash, plan_json FROM sync_plans WHERE hash = ?")
        .get(plan.hash) as PlanRow | undefined;
      if (existingByHash !== undefined) {
        throw new SessionMaintenanceError(
          "VERSION_ID_COLLISION",
          `Sync plan hash is already assigned to ${existingByHash.id}`,
        );
      }

      this.database
        .prepare("INSERT INTO sync_plans (id, hash, plan_json, created_at) VALUES (?, ?, ?, ?)")
        .run(plan.id, plan.hash, serialized, plan.createdAt);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  async getPlan(id: string): Promise<SyncPlan | undefined> {
    const row = this.database
      .prepare("SELECT id, hash, plan_json FROM sync_plans WHERE id = ?")
      .get(id) as PlanRow | undefined;
    if (row === undefined) {
      return undefined;
    }

    try {
      const parsed: unknown = JSON.parse(row.plan_json);
      syncPlanSchema.parse(parsed);
      const plan = parsed as SyncPlan;
      if (plan.id !== row.id || plan.hash !== row.hash || !verifySyncPlanIdentity(plan)) {
        throw new Error("Stored plan identity mismatch");
      }
      return plan;
    } catch (error) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Stored sync plan is corrupt: ${id}`, {
        cause: error,
      });
    }
  }

  close(): void {
    this.database.close();
  }
}
