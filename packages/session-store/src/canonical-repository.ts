import type { DatabaseSync } from "node:sqlite";

import {
  canonicalChangePageSchema,
  canonicalChangeQuerySchema,
  canonicalEventV1Schema,
  canonicalSessionRecordSchema,
  sessionDerivationSchema,
  sessionTombstoneSchema,
  type CanonicalEventV1,
  type CanonicalChangePage,
  type CanonicalChangeQuery,
  type CanonicalChangeV1,
  type CanonicalSessionRecord,
  type CanonicalSessionRepository,
  type JsonValue,
  type LogicalSessionId,
  type LogicalWorkspace,
  type OperationId,
  type SessionDerivation,
  type SessionTombstone,
  type WorkspaceMembership,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

import { SqliteLogicalWorkspaceRepository } from "./logical-workspace-repository.js";
import { SqliteLogicalProjectRepository } from "./logical-project-repository.js";
import { SqliteSessionAliasRepository } from "./session-alias-repository.js";

interface CanonicalSessionRow {
  readonly id: string;
  readonly display_title: string;
  readonly labels_json: string;
  readonly authority_scope: CanonicalSessionRecord["authorityScope"] | null;
  readonly origin_kind: CanonicalSessionRecord["originKind"] | null;
  readonly head_version_id: string | null;
  readonly archived_at: string | null;
  readonly tombstoned_at: string | null;
  readonly created_at: string;
  readonly updated_at: string | null;
}

interface CanonicalEventRow {
  readonly event_json: string;
}

interface CanonicalChangeRow {
  readonly revision: number;
  readonly logical_session_id: string;
  readonly change_kind: CanonicalChangeV1["kind"];
  readonly changed_at: string;
}

interface DerivationRow {
  readonly child_session_id: string;
  readonly parent_session_id: string;
  readonly base_version_id: string;
  readonly derivation_kind: SessionDerivation["kind"];
  readonly trigger_run_id: string;
  readonly trigger_operation_id: string;
  readonly created_at: string;
}

interface TombstoneRow {
  readonly logical_session_id: string;
  readonly operation_id: string;
  readonly checkpoint_id: string;
  readonly previous_workspace_id: string | null;
  readonly deleted_at: string;
  readonly retention_until: string;
  readonly restored_at: string | null;
}

function parseSession(row: CanonicalSessionRow): CanonicalSessionRecord {
  if (row.authority_scope === null || row.origin_kind === null || row.updated_at === null) {
    throw new Error(`Logical session has not been migrated to canonical ownership: ${row.id}`);
  }
  return canonicalSessionRecordSchema.parse({
    schemaVersion: 1,
    id: row.id,
    authorityScope: row.authority_scope,
    originKind: row.origin_kind,
    headVersionId: row.head_version_id,
    title: row.display_title,
    tags: JSON.parse(row.labels_json) as unknown,
    archivedAt: row.archived_at,
    tombstonedAt: row.tombstoned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as unknown as CanonicalSessionRecord;
}

function validatedRecordJson(value: unknown): string {
  return canonicalJson(value as JsonValue);
}

function parseDerivation(row: DerivationRow): SessionDerivation {
  return sessionDerivationSchema.parse({
    schemaVersion: 1,
    childSessionId: row.child_session_id,
    parentSessionId: row.parent_session_id,
    baseVersionId: row.base_version_id,
    kind: row.derivation_kind,
    triggerRunId: row.trigger_run_id,
    triggerOperationId: row.trigger_operation_id,
    createdAt: row.created_at,
  }) as SessionDerivation;
}

function parseTombstone(row: TombstoneRow): SessionTombstone {
  return sessionTombstoneSchema.parse({
    schemaVersion: 1,
    logicalSessionId: row.logical_session_id,
    operationId: row.operation_id,
    checkpointId: row.checkpoint_id,
    previousWorkspaceId: row.previous_workspace_id,
    deletedAt: row.deleted_at,
    retentionUntil: row.retention_until,
    restoredAt: row.restored_at,
  }) as SessionTombstone;
}

export class SqliteCanonicalRepository implements CanonicalSessionRepository {
  readonly database: DatabaseSync;
  readonly workspaces: SqliteLogicalWorkspaceRepository;
  readonly projects: SqliteLogicalProjectRepository;
  readonly aliases: SqliteSessionAliasRepository;

  constructor(database: DatabaseSync) {
    this.database = database;
    this.workspaces = new SqliteLogicalWorkspaceRepository(database);
    this.projects = new SqliteLogicalProjectRepository(database);
    this.aliases = new SqliteSessionAliasRepository(database);
  }

  async createCanonicalSession(input: CanonicalSessionRecord): Promise<boolean> {
    canonicalSessionRecordSchema.parse(input);
    return this.insertCanonicalSession(input);
  }

  async createDerivedCanonicalSession(input: {
    readonly session: CanonicalSessionRecord;
    readonly derivation: SessionDerivation;
  }): Promise<boolean> {
    canonicalSessionRecordSchema.parse(input.session);
    sessionDerivationSchema.parse(input.derivation);
    if (input.session.id !== input.derivation.childSessionId) {
      throw new Error("Derived session ID must match the derivation child session ID");
    }
    if (
      input.session.authorityScope !== "maintenance" ||
      input.session.originKind !== "codex-derived"
    ) {
      throw new Error("Derived sessions must use maintenance authority and codex-derived origin");
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const sessionCreated = this.insertCanonicalSession(input.session);
      const derivationCreated = this.insertDerivation(input.derivation);
      this.database.exec("COMMIT");
      return sessionCreated || derivationCreated;
    } catch (error) {
      this.rollbackPreserving(error);
    }
  }

  async getCanonicalSession(
    id: LogicalSessionId,
  ): Promise<CanonicalSessionRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, display_title, labels_json, authority_scope, origin_kind,
                head_version_id, archived_at, tombstoned_at, created_at, updated_at
         FROM logical_sessions WHERE id = ?`,
      )
      .get(id) as CanonicalSessionRow | undefined;
    return row === undefined ? undefined : parseSession(row);
  }

  async putCanonicalEvent(input: CanonicalEventV1): Promise<boolean> {
    canonicalEventV1Schema.parse(input);
    const serialized = validatedRecordJson(input);
    const existing = this.database
      .prepare("SELECT event_json FROM canonical_events WHERE id = ?")
      .get(input.id) as CanonicalEventRow | undefined;
    if (existing !== undefined) {
      if (existing.event_json !== serialized) {
        throw new Error(`Canonical event ID already has different content: ${input.id}`);
      }
      return false;
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO canonical_events
            (id, logical_session_id, sequence, kind, content_digest, event_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.logicalSessionId,
          input.sequence,
          input.kind,
          input.contentDigest,
          serialized,
        );
      this.database.prepare(
        `INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
         VALUES (?, 'content-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      ).run(input.logicalSessionId);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.rollbackPreserving(error);
    }
  }

  async listChanges(input: CanonicalChangeQuery): Promise<CanonicalChangePage> {
    canonicalChangeQuerySchema.parse(input);
    const revisionRow = this.database.prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM canonical_change_log",
    ).get() as { readonly revision: number };
    const currentRevision = revisionRow.revision;
    if (input.afterRevision > currentRevision) {
      throw new Error(
        `Canonical change cursor ${input.afterRevision} exceeds current revision ${currentRevision}`,
      );
    }
    const rows = this.database.prepare(
      `SELECT revision, logical_session_id, change_kind, changed_at
       FROM canonical_change_log
       WHERE revision > ? AND revision <= ?
       ORDER BY revision
       LIMIT ?`,
    ).all(input.afterRevision, currentRevision, input.limit) as unknown as CanonicalChangeRow[];
    const changes: CanonicalChangeV1[] = rows.map((row) => ({
      schemaVersion: 1,
      revision: row.revision,
      logicalSessionId: row.logical_session_id as CanonicalChangeV1["logicalSessionId"],
      kind: row.change_kind,
      changedAt: row.changed_at,
    }));
    const throughRevision = changes.at(-1)?.revision ?? input.afterRevision;
    const page: CanonicalChangePage = {
      schemaVersion: 1,
      afterRevision: input.afterRevision,
      throughRevision,
      currentRevision,
      hasMore: throughRevision < currentRevision,
      changes,
    };
    canonicalChangePageSchema.parse(page);
    return page;
  }

  async recordDerivation(input: SessionDerivation): Promise<boolean> {
    sessionDerivationSchema.parse(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const created = this.insertDerivation(input);
      this.database.exec("COMMIT");
      return created;
    } catch (error) {
      this.rollbackPreserving(error);
    }
  }

  async findDerivationByOperationId(
    operationId: OperationId,
  ): Promise<SessionDerivation | undefined> {
    const row = this.database
      .prepare(
        `SELECT child_session_id, parent_session_id, base_version_id, derivation_kind,
                trigger_run_id, trigger_operation_id, created_at
         FROM session_derivations WHERE trigger_operation_id = ?`,
      )
      .get(operationId) as DerivationRow | undefined;
    return row === undefined ? undefined : parseDerivation(row);
  }

  async upsertLogicalWorkspace(input: LogicalWorkspace): Promise<void> {
    await this.workspaces.upsert(input);
  }

  async setWorkspaceMembership(input: WorkspaceMembership): Promise<void> {
    await this.workspaces.setMembership(input);
  }

  async upsertLogicalProject(input: import("@linmu/dsh-session-contracts").LogicalProject): Promise<void> {
    await this.projects.upsertProject(input);
  }

  async replaceProjectRoots(
    projectId: import("@linmu/dsh-session-contracts").LogicalProjectId,
    roots: readonly import("@linmu/dsh-session-contracts").ProjectRoot[],
  ): Promise<void> {
    await this.projects.replaceRoots(projectId, roots);
  }

  async setProjectMembership(input: import("@linmu/dsh-session-contracts").ProjectMembership): Promise<void> {
    await this.projects.setMembership(input);
  }

  async saveTombstone(input: SessionTombstone): Promise<void> {
    sessionTombstoneSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO session_tombstones
          (logical_session_id, operation_id, checkpoint_id, previous_workspace_id,
           deleted_at, retention_until, restored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(logical_session_id) DO UPDATE SET
           operation_id = excluded.operation_id,
           checkpoint_id = excluded.checkpoint_id,
           previous_workspace_id = excluded.previous_workspace_id,
           deleted_at = excluded.deleted_at,
           retention_until = excluded.retention_until,
           restored_at = excluded.restored_at`,
      )
      .run(
        input.logicalSessionId,
        input.operationId,
        input.checkpointId,
        input.previousWorkspaceId,
        input.deletedAt,
        input.retentionUntil,
        input.restoredAt,
      );
  }

  async getTombstone(
    logicalSessionId: LogicalSessionId,
  ): Promise<SessionTombstone | undefined> {
    const row = this.database
      .prepare(
        `SELECT logical_session_id, operation_id, checkpoint_id, previous_workspace_id,
                deleted_at, retention_until, restored_at
         FROM session_tombstones WHERE logical_session_id = ?`,
      )
      .get(logicalSessionId) as TombstoneRow | undefined;
    return row === undefined ? undefined : parseTombstone(row);
  }

  private insertCanonicalSession(input: CanonicalSessionRecord): boolean {
    const existing = this.database
      .prepare(
        `SELECT id, display_title, labels_json, authority_scope, origin_kind,
                head_version_id, archived_at, tombstoned_at, created_at, updated_at
         FROM logical_sessions WHERE id = ?`,
      )
      .get(input.id) as CanonicalSessionRow | undefined;
    if (existing !== undefined) {
      if (validatedRecordJson(parseSession(existing)) !== validatedRecordJson(input)) {
        throw new Error(`Canonical session ID already has different content: ${input.id}`);
      }
      return false;
    }

    this.database
      .prepare(
        `INSERT INTO logical_sessions
          (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at,
           authority_scope, origin_kind, head_version_id, archived_at, tombstoned_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.headVersionId,
        "paused",
        input.archivedAt === null ? 0 : 1,
        canonicalJson([...input.tags]),
        input.createdAt,
        input.authorityScope,
        input.originKind,
        input.headVersionId,
        input.archivedAt,
        input.tombstonedAt,
        input.updatedAt,
      );
    return true;
  }

  private insertDerivation(input: SessionDerivation): boolean {
    const existing = this.database
      .prepare(
        `SELECT child_session_id, parent_session_id, base_version_id, derivation_kind,
                trigger_run_id, trigger_operation_id, created_at
         FROM session_derivations WHERE child_session_id = ? OR trigger_operation_id = ?`,
      )
      .get(input.childSessionId, input.triggerOperationId) as DerivationRow | undefined;
    if (existing !== undefined) {
      if (validatedRecordJson(parseDerivation(existing)) !== validatedRecordJson(input)) {
        throw new Error(
          `Derivation child or operation already belongs to different lineage: ${input.triggerOperationId}`,
        );
      }
      return false;
    }
    this.database
      .prepare(
        `INSERT INTO session_derivations
          (child_session_id, parent_session_id, base_version_id, derivation_kind,
           trigger_run_id, trigger_operation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.childSessionId,
        input.parentSessionId,
        input.baseVersionId,
        input.kind,
        input.triggerRunId,
        input.triggerOperationId,
        input.createdAt,
      );
    return true;
  }

  private rollbackPreserving(error: unknown): never {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}
