import type { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_SCHEMA_VERSION,
  SessionMaintenanceError,
  matchCandidateSchema,
  observedHeadSchema,
  platformBindingSchema,
  sessionVersionManifestSchema,
  syncPlanSchema,
  type ContentObjectStore,
  type JsonValue,
  type LogicalSession,
  type MatchCandidate,
  type NewVersion,
  type ObservationRecord,
  type ObservedHead,
  type Page,
  type PlatformBinding,
  type PlatformKind,
  type PlatformSessionKey,
  type RepositoryCounts,
  type RepositoryWriteResult,
  type SessionQuery,
  type SessionStatus,
  type SessionSummary,
  type SessionVersionManifest,
  type SyncPlan,
  type VersionGraphData,
  type VersionGraphPage,
} from "@linmu/dsh-session-contracts";
import {
  canonicalJson,
  verifySyncPlanIdentity,
  versionIdFor,
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

interface BindingRow {
  readonly id: string;
  readonly logical_session_id: string;
  readonly platform: PlatformKind;
  readonly instance_id: string;
  readonly session_id: string;
  readonly adapter_contract_json: string;
  readonly last_common_version_id: string | null;
  readonly status: PlatformBinding["status"];
}

interface HeadRow {
  readonly binding_id: string;
  readonly version_id: string;
  readonly observed_at: string;
  readonly fingerprint_json: string;
}

interface CandidateRow {
  readonly id: string;
  readonly left_binding_id: string;
  readonly right_key_json: string;
  readonly reason: string;
  readonly confidence: MatchCandidate["confidence"];
  readonly created_at: string;
  readonly resolved_at: string | null;
}

interface CountRow {
  readonly count: number;
}

interface SessionRow {
  readonly id: string;
  readonly display_title: string;
  readonly archived: number;
  readonly created_at: string;
  readonly platforms: string | null;
  readonly binding_count: number;
  readonly head_count: number;
  readonly distinct_heads: number;
  readonly updated_at: string | null;
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

function bindingJson(row: BindingRow): PlatformBinding {
  return platformBindingSchema.parse({
    id: row.id,
    logicalSessionId: row.logical_session_id,
    key: { platform: row.platform, instanceId: row.instance_id, sessionId: row.session_id },
    adapterContract: JSON.parse(row.adapter_contract_json) as unknown,
    lastCommonVersionId: row.last_common_version_id,
    status: row.status,
  });
}

function candidateJson(row: CandidateRow): MatchCandidate {
  return matchCandidateSchema.parse({
    id: row.id,
    leftBindingId: row.left_binding_id,
    rightKey: JSON.parse(row.right_key_json) as unknown,
    reason: row.reason,
    confidence: row.confidence,
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  }) as unknown as MatchCandidate;
}

function headJson(row: HeadRow): ObservedHead {
  return observedHeadSchema.parse({
    bindingId: row.binding_id,
    versionId: row.version_id,
    observedAt: row.observed_at,
    fingerprint: JSON.parse(row.fingerprint_json) as unknown,
  });
}

function versionIdentity(manifest: SessionVersionManifest): JsonValue {
  return {
    logicalSessionId: manifest.logicalSessionId,
    parents: manifest.parents,
    bodyHash: manifest.bodyHash,
    metadataHash: manifest.metadataHash,
  };
}

function expectedVersionId(manifest: SessionVersionManifest): string {
  return versionIdFor({
    logicalSessionId: manifest.logicalSessionId,
    parents: manifest.parents,
    bodyHash: manifest.bodyHash,
    metadataHash: manifest.metadataHash,
  });
}

function parseManifest(serialized: string, id: string): SessionVersionManifest {
  try {
    const parsed = sessionVersionManifestSchema.parse(
      JSON.parse(serialized) as unknown,
    ) as unknown as SessionVersionManifest;
    if (parsed.id !== id || expectedVersionId(parsed) !== id) throw new Error("identity mismatch");
    return parsed;
  } catch (error) {
    throw new SessionMaintenanceError("VERSION_ID_COLLISION", `Stored version identity is corrupt: ${id}`, {
      cause: error,
    });
  }
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
    const id = versionIdFor({
      logicalSessionId: input.logicalSessionId,
      parents: input.parents,
      bodyHash: input.bodyHash,
      metadataHash: input.metadataHash,
    });
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
        const parsed = parseManifest(existing.manifest_json, id);
        if (canonicalJson(versionIdentity(parsed)) !== canonicalJson(versionIdentity(manifest))) {
          throw new SessionMaintenanceError(
            "VERSION_ID_COLLISION",
            `Version ID has different immutable content: ${id}`,
          );
        }
        this.database.exec("COMMIT");
        return parsed;
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

  async findBinding(key: PlatformSessionKey): Promise<PlatformBinding | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, logical_session_id, platform, instance_id, session_id,
                adapter_contract_json, last_common_version_id, status
         FROM platform_bindings
         WHERE platform = ? AND instance_id = ? AND session_id = ?`,
      )
      .get(key.platform, key.instanceId, key.sessionId) as BindingRow | undefined;
    return row === undefined ? undefined : bindingJson(row);
  }

  async bindPlatformSession(input: PlatformBinding): Promise<boolean> {
    platformBindingSchema.parse(input);
    const existing = await this.findBinding(input.key);
    if (existing !== undefined) {
      if (canonicalJson(existing as unknown as JsonValue) !== canonicalJson(input as unknown as JsonValue)) {
        throw new SessionMaintenanceError(
          "IDENTITY_CONFLICT",
          `Platform key already has a different binding: ${input.key.platform}/${input.key.instanceId}/${input.key.sessionId}`,
        );
      }
      return false;
    }
    this.database
      .prepare(
        `INSERT INTO platform_bindings
          (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
           last_common_version_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.logicalSessionId,
        input.key.platform,
        input.key.instanceId,
        input.key.sessionId,
        canonicalJson(input.adapterContract as unknown as JsonValue),
        input.lastCommonVersionId,
        input.status,
      );
    return true;
  }

  async getObservedHead(bindingId: string): Promise<ObservedHead | undefined> {
    const row = this.database
      .prepare(
        `SELECT binding_id, version_id, observed_at, fingerprint_json
         FROM platform_refs WHERE binding_id = ?`,
      )
      .get(bindingId) as HeadRow | undefined;
    return row === undefined ? undefined : headJson(row);
  }

  async upsertMatchCandidate(input: MatchCandidate): Promise<boolean> {
    matchCandidateSchema.parse(input);
    const left = this.database
      .prepare("SELECT logical_session_id FROM platform_bindings WHERE id = ?")
      .get(input.leftBindingId) as { readonly logical_session_id: string } | undefined;
    if (left === undefined) throw new SessionMaintenanceError("OBJECT_CORRUPT", `Missing candidate binding: ${input.leftBindingId}`);
    const existing = this.database
      .prepare(
        `SELECT id, left_binding_id, right_key_json, reason, confidence, created_at, resolved_at
         FROM match_candidates WHERE id = ?`,
      )
      .get(input.id) as CandidateRow | undefined;
    if (existing !== undefined) {
      if (canonicalJson(candidateJson(existing) as unknown as JsonValue) !== canonicalJson(input as unknown as JsonValue)) {
        throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Match candidate ID has different content: ${input.id}`);
      }
      return false;
    }
    this.database
      .prepare(
        `INSERT INTO match_candidates
          (id, logical_session_id, left_binding_id, right_key_json, reason, confidence, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        left.logical_session_id,
        input.leftBindingId,
        canonicalJson(input.rightKey as unknown as JsonValue),
        input.reason,
        input.confidence,
        input.createdAt,
        input.resolvedAt ?? null,
      );
    return true;
  }

  async listMatchCandidates(logicalSessionId: string): Promise<readonly MatchCandidate[]> {
    const rows = this.database
      .prepare(
        `SELECT id, left_binding_id, right_key_json, reason, confidence, created_at, resolved_at
         FROM match_candidates WHERE logical_session_id = ? ORDER BY created_at, id`,
      )
      .all(logicalSessionId) as unknown as CandidateRow[];
    return rows.map(candidateJson);
  }

  async listBindings(logicalSessionId: string): Promise<readonly PlatformBinding[]> {
    const rows = this.database
      .prepare(
        `SELECT id, logical_session_id, platform, instance_id, session_id,
                adapter_contract_json, last_common_version_id, status
         FROM platform_bindings WHERE logical_session_id = ? ORDER BY platform, instance_id, session_id`,
      )
      .all(logicalSessionId) as unknown as BindingRow[];
    return rows.map(bindingJson);
  }

  async counts(): Promise<RepositoryCounts> {
    const count = (table: string): number =>
      (this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow).count;
    return {
      logicalSessions: count("logical_sessions"),
      bindings: count("platform_bindings"),
      versions: count("session_versions"),
      candidates: count("match_candidates"),
      plans: count("sync_plans"),
    };
  }

  async recordObservedVersion(input: ObservationRecord): Promise<RepositoryWriteResult> {
    if (expectedVersionId(input.version) !== input.version.id) {
      throw new SessionMaintenanceError("VERSION_ID_COLLISION", `Version identity does not match: ${input.version.id}`);
    }
    if (
      input.version.logicalSessionId !== input.logicalSession.id ||
      input.binding.logicalSessionId !== input.logicalSession.id ||
      input.head.bindingId !== input.binding.id ||
      input.head.versionId !== input.version.id
    ) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Observation record contains inconsistent identities");
    }
    await this.objectStore.get(input.version.bodyObject);

    let createdLogicalSessions = 0;
    let createdBindings = 0;
    let createdVersions = 0;
    let createdCandidates = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const logical = this.database
        .prepare("SELECT id FROM logical_sessions WHERE id = ?")
        .get(input.logicalSession.id) as { readonly id: string } | undefined;
      if (logical === undefined) {
        this.database
          .prepare(
            `INSERT INTO logical_sessions
              (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.logicalSession.id,
            input.logicalSession.displayTitle,
            null,
            input.logicalSession.syncMode,
            input.logicalSession.archived ? 1 : 0,
            canonicalJson([...input.logicalSession.labels]),
            input.logicalSession.createdAt,
          );
        createdLogicalSessions = 1;
      } else {
        this.database
          .prepare("UPDATE logical_sessions SET display_title = ?, archived = ? WHERE id = ?")
          .run(input.logicalSession.displayTitle, input.logicalSession.archived ? 1 : 0, input.logicalSession.id);
      }

      const existingBinding = this.database
        .prepare(
          `SELECT id, logical_session_id, platform, instance_id, session_id,
                  adapter_contract_json, last_common_version_id, status
           FROM platform_bindings WHERE platform = ? AND instance_id = ? AND session_id = ?`,
        )
        .get(input.binding.key.platform, input.binding.key.instanceId, input.binding.key.sessionId) as BindingRow | undefined;
      if (existingBinding === undefined) {
        this.database
          .prepare(
            `INSERT INTO platform_bindings
              (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
               last_common_version_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.binding.id,
            input.binding.logicalSessionId,
            input.binding.key.platform,
            input.binding.key.instanceId,
            input.binding.key.sessionId,
            canonicalJson(input.binding.adapterContract as unknown as JsonValue),
            input.binding.lastCommonVersionId,
            input.binding.status,
          );
        createdBindings = 1;
      } else if (canonicalJson(bindingJson(existingBinding) as unknown as JsonValue) !== canonicalJson(input.binding as unknown as JsonValue)) {
        throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Platform binding changed identity: ${input.binding.id}`);
      }

      const existingVersion = this.database
        .prepare("SELECT manifest_json FROM session_versions WHERE id = ?")
        .get(input.version.id) as ManifestRow | undefined;
      if (existingVersion === undefined) {
        this.database
          .prepare(
            `INSERT INTO session_versions
              (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.version.id,
            input.version.logicalSessionId,
            input.version.bodyObject,
            input.version.bodyHash,
            input.version.metadataHash,
            manifestJson(input.version),
            input.version.source.observedAt,
          );
        const insertParent = this.database.prepare(
          "INSERT INTO version_parents (version_id, ordinal, parent_id) VALUES (?, ?, ?)",
        );
        input.version.parents.forEach((parent, ordinal) => insertParent.run(input.version.id, ordinal, parent));
        createdVersions = 1;
      } else {
        const stored = parseManifest(existingVersion.manifest_json, input.version.id);
        if (canonicalJson(versionIdentity(stored)) !== canonicalJson(versionIdentity(input.version))) {
          throw new SessionMaintenanceError("VERSION_ID_COLLISION", `Version ID has different content: ${input.version.id}`);
        }
      }

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
          input.head.bindingId,
          input.head.versionId,
          input.head.observedAt,
          canonicalJson(input.head.fingerprint as unknown as JsonValue),
        );

      for (const candidate of input.candidates) {
        const existing = this.database.prepare("SELECT id FROM match_candidates WHERE id = ?").get(candidate.id);
        if (existing !== undefined) continue;
        this.database
          .prepare(
            `INSERT INTO match_candidates
              (id, logical_session_id, left_binding_id, right_key_json, reason, confidence, created_at, resolved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            candidate.id,
            input.logicalSession.id,
            candidate.leftBindingId,
            canonicalJson(candidate.rightKey as unknown as JsonValue),
            candidate.reason,
            candidate.confidence,
            candidate.createdAt,
            candidate.resolvedAt ?? null,
          );
        createdCandidates += 1;
      }
      this.database.exec("COMMIT");
      return { createdLogicalSessions, createdBindings, createdVersions, createdCandidates };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
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

  async listSessions(query: SessionQuery): Promise<Page<SessionSummary>> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError(`Invalid session cursor: ${query.cursor}`);
    const rows = this.database
      .prepare(
        `SELECT ls.id, ls.display_title, ls.archived, ls.created_at,
                GROUP_CONCAT(DISTINCT pb.platform) AS platforms,
                COUNT(DISTINCT pb.id) AS binding_count,
                COUNT(DISTINCT pr.binding_id) AS head_count,
                COUNT(DISTINCT pr.version_id) AS distinct_heads,
                MAX(pr.observed_at) AS updated_at
         FROM logical_sessions ls
         LEFT JOIN platform_bindings pb ON pb.logical_session_id = ls.id
         LEFT JOIN platform_refs pr ON pr.binding_id = pb.id
         GROUP BY ls.id
         ORDER BY COALESCE(MAX(pr.observed_at), ls.created_at) DESC, ls.id`,
      )
      .all() as unknown as SessionRow[];
    const summaries = rows.map((row): SessionSummary => {
      const platforms = (row.platforms?.split(",") ?? []).sort() as PlatformKind[];
      const status: SessionStatus =
        row.binding_count < 2 || row.head_count < 2
          ? "unmapped"
          : row.distinct_heads === 1
            ? "equal"
            : "diverged";
      return {
        logicalSessionId: row.id,
        title: row.display_title,
        archived: Boolean(row.archived),
        platforms,
        status,
        updatedAt: row.updated_at ?? row.created_at,
      };
    });
    const filtered = summaries.filter(
      (summary) =>
        (query.platform === undefined || summary.platforms.includes(query.platform)) &&
        (query.status === undefined || summary.status === query.status),
    );
    const items = filtered.slice(offset, offset + limit);
    return {
      items,
      ...(offset + limit < filtered.length ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  async getGraphPage(logicalSessionId: string, cursor?: string): Promise<VersionGraphPage> {
    const limit = 50;
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError(`Invalid graph cursor: ${cursor}`);
    const rows = this.database
      .prepare(
        `SELECT manifest_json FROM session_versions
         WHERE logical_session_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?`,
      )
      .all(logicalSessionId, limit + 1, offset) as unknown as ManifestRow[];
    const nodes = rows.slice(0, limit).map((row) => {
      const candidate = JSON.parse(row.manifest_json) as { readonly id?: unknown };
      return parseManifest(row.manifest_json, typeof candidate.id === "string" ? candidate.id : "invalid");
    });
    const refs = this.database
      .prepare(
        `SELECT 'observed:' || pb.id AS name, pr.version_id AS version_id
         FROM platform_refs pr
         JOIN platform_bindings pb ON pb.id = pr.binding_id
         WHERE pb.logical_session_id = ?
         UNION ALL
         SELECT 'canonical' AS name, canonical_version_id AS version_id
         FROM logical_sessions
         WHERE id = ? AND canonical_version_id IS NOT NULL
         ORDER BY name`,
      )
      .all(logicalSessionId, logicalSessionId) as unknown as Array<{ readonly name: string; readonly version_id: string }>;
    return {
      nodes,
      refs: refs.map((ref) => ({ name: ref.name, versionId: ref.version_id })),
      ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
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
