import type { DatabaseSync } from "node:sqlite";

import type {
  CanonicalEngineMutation,
  CanonicalEngineReceipt,
  CanonicalSessionEngineStore,
  CanonicalSessionSnapshot,
  CanonicalVersionRecord,
  CodexObservationRecord,
} from "@linmu/dsh-canonical-session-engine";
import {
  canonicalEventV1Schema,
  canonicalSessionRecordSchema,
  projectionOperationReceiptSchema,
  type CanonicalEventV1,
  type CanonicalSessionRecord,
  type ContentObjectStore,
  type JsonValue,
  type LogicalSessionId,
  type OperationId,
  type ProjectionOperationReceipt,
  type SessionVersionId,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

import { SqliteCanonicalRepository } from "./canonical-repository.js";
import { SqliteLogicalWorkspaceRepository } from "./logical-workspace-repository.js";

interface SessionRow {
  readonly id: string;
  readonly display_title: string;
  readonly labels_json: string;
  readonly authority_scope: CanonicalSessionRecord["authorityScope"];
  readonly origin_kind: CanonicalSessionRecord["originKind"];
  readonly head_version_id: string | null;
  readonly archived_at: string | null;
  readonly tombstoned_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface VersionRow {
  readonly id: string;
  readonly logical_session_id: string;
  readonly body_hash: string;
  readonly metadata_hash: string;
  readonly created_at: string;
}

interface EventRow { readonly event_json: string }
interface ParentRow { readonly parent_id: string }
interface ReceiptRow { readonly receipt_json: string }

function sessionFromRow(row: SessionRow): CanonicalSessionRecord {
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

export class SqliteCanonicalSessionEngineStore implements CanonicalSessionEngineStore {
  readonly database: DatabaseSync;
  readonly objectStore: ContentObjectStore;
  readonly canonical: SqliteCanonicalRepository;
  readonly workspaces: SqliteLogicalWorkspaceRepository;

  constructor(database: DatabaseSync, objectStore: ContentObjectStore) {
    this.database = database;
    this.objectStore = objectStore;
    this.canonical = new SqliteCanonicalRepository(database);
    this.workspaces = new SqliteLogicalWorkspaceRepository(database);
  }

  async getSession(id: LogicalSessionId): Promise<CanonicalSessionSnapshot | undefined> {
    const session = await this.canonical.getCanonicalSession(id);
    if (session === undefined) return undefined;
    const membership = await this.workspaces.getMembership(id);
    const tombstone = await this.canonical.getTombstone(id);
    return {
      session,
      headVersionId: session.headVersionId,
      workspaceId: membership?.workspaceId ?? null,
      membershipRevision: membership?.revision ?? -1,
      tombstone: tombstone ?? null,
    };
  }

  async getVersion(id: SessionVersionId): Promise<CanonicalVersionRecord | undefined> {
    const row = this.database.prepare(
      `SELECT id, logical_session_id, body_hash, metadata_hash, created_at
       FROM session_versions WHERE id = ?`,
    ).get(id) as VersionRow | undefined;
    if (row === undefined) return undefined;
    const sessionRow = this.database.prepare(
      `SELECT id, display_title, labels_json, authority_scope, origin_kind, head_version_id,
              archived_at, tombstoned_at, created_at, updated_at
       FROM logical_sessions WHERE id = ?`,
    ).get(row.logical_session_id) as unknown as SessionRow;
    const session = sessionFromRow(sessionRow);
    const membership = await this.workspaces.getMembership(session.id);
    const ownEvents = this.readEvents(session.id);
    const derivation = this.database.prepare(
      "SELECT base_version_id FROM session_derivations WHERE child_session_id = ?",
    ).get(session.id) as { readonly base_version_id: string } | undefined;
    const inherited = derivation === undefined
      ? []
      : (await this.getVersion(derivation.base_version_id as SessionVersionId))?.events ?? [];
    const events = [...inherited, ...ownEvents];
    const body = { schemaVersion: 1, workspaceId: membership?.workspaceId ?? null, events } as unknown as JsonValue;
    const metadata = { title: session.title, tags: session.tags, archivedAt: session.archivedAt } as JsonValue;
    const parents = this.database.prepare(
      "SELECT parent_id FROM version_parents WHERE version_id = ? ORDER BY ordinal",
    ).all(id) as unknown as ParentRow[];
    return {
      id,
      logicalSessionId: session.id,
      parentVersionIds: parents.map((parent) => parent.parent_id as SessionVersionId),
      events,
      workspaceId: membership?.workspaceId ?? null,
      body,
      metadata,
      bodyDigest: row.body_hash,
      metadataDigest: row.metadata_hash,
      contentDigest: row.id,
      createdAt: row.created_at,
    };
  }

  async getOperationReceipt(operationId: OperationId): Promise<CanonicalEngineReceipt | undefined> {
    const row = this.database.prepare(
      "SELECT receipt_json FROM run_operations WHERE operation_id = ?",
    ).get(operationId) as ReceiptRow | undefined;
    if (row === undefined) return undefined;
    const projection = projectionOperationReceiptSchema.parse(
      JSON.parse(row.receipt_json),
    ) as unknown as ProjectionOperationReceipt;
    const derived = this.database.prepare(
      "SELECT 1 FROM session_derivations WHERE trigger_operation_id = ?",
    ).get(operationId) !== undefined;
    return {
      outcome: derived ? "derived" : "advanced",
      operationId,
      logicalSessionId: projection.logicalSessionId,
      versionId: projection.canonicalVersionId,
      tombstoneState: null,
      committedAt: projection.committedAt ?? new Date(0).toISOString(),
    };
  }

  async recordCodexObservation(_input: CodexObservationRecord): Promise<void> {
    // Source cursors remain authoritative in platform_refs. A no-op observation
    // does not create another canonical version or duplicate the Codex log.
  }

  async commit(input: CanonicalEngineMutation): Promise<CanonicalEngineReceipt> {
    const bodyObject = input.version === null
      ? null
      : await this.objectStore.put(Buffer.from(canonicalJson(input.version.body), "utf8"));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.ensureSession(input.session);
      if (input.version !== null && bodyObject !== null) this.putVersion(input.version, bodyObject);
      this.updateSession(input.session);
      if (input.membership !== null) await this.workspaces.setMembership(input.membership);
      if (input.derivation !== null) this.putDerivation(input.derivation);
      if (input.tombstone !== null) await this.canonical.saveTombstone(input.tombstone);
      if (input.projectionReceipt !== null) this.putProjectionReceipt(input.projectionReceipt);
      this.database.exec("COMMIT");
      return input.receipt;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve commit failure */ }
      throw error;
    }
  }

  private readEvents(logicalSessionId: LogicalSessionId): readonly CanonicalEventV1[] {
    const rows = this.database.prepare(
      `SELECT event_json FROM canonical_events
       WHERE logical_session_id = ? ORDER BY sequence`,
    ).all(logicalSessionId) as unknown as EventRow[];
    return rows.map((row) => canonicalEventV1Schema.parse(JSON.parse(row.event_json)) as unknown as CanonicalEventV1);
  }

  private ensureSession(input: CanonicalSessionRecord): void {
    canonicalSessionRecordSchema.parse(input);
    this.database.prepare(
      `INSERT INTO logical_sessions
        (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at,
         authority_scope, origin_kind, head_version_id, archived_at, tombstoned_at, updated_at)
       VALUES (?, ?, NULL, 'paused', ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      input.id, input.title, input.archivedAt === null ? 0 : 1,
      canonicalJson([...input.tags]), input.createdAt, input.authorityScope, input.originKind,
      input.archivedAt, input.tombstonedAt, input.updatedAt,
    );
  }

  private updateSession(input: CanonicalSessionRecord): void {
    const result = this.database.prepare(
      `UPDATE logical_sessions SET
         display_title = ?, canonical_version_id = ?, archived = ?, labels_json = ?,
         authority_scope = ?, origin_kind = ?, head_version_id = ?, archived_at = ?,
         tombstoned_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title, input.headVersionId, input.archivedAt === null ? 0 : 1,
      canonicalJson([...input.tags]), input.authorityScope, input.originKind,
      input.headVersionId, input.archivedAt, input.tombstonedAt, input.updatedAt, input.id,
    );
    if (Number(result.changes) !== 1) throw new Error(`Canonical session update failed: ${input.id}`);
  }

  private putVersion(input: CanonicalVersionRecord, bodyObject: string): void {
    const existing = this.database.prepare(
      "SELECT body_hash, metadata_hash FROM session_versions WHERE id = ?",
    ).get(input.id) as { readonly body_hash: string; readonly metadata_hash: string } | undefined;
    if (existing !== undefined) {
      if (existing.body_hash !== input.bodyDigest || existing.metadata_hash !== input.metadataDigest) {
        throw new Error(`Canonical version ID collision: ${input.id}`);
      }
      return;
    }
    const manifest = {
      schemaVersion: 1,
      id: input.id,
      logicalSessionId: input.logicalSessionId,
      parents: input.parentVersionIds,
      bodyObject,
      bodyHash: input.bodyDigest,
      metadataHash: input.metadataDigest,
      source: {
        platform: "dsh",
        instanceId: "canonical-projection",
        sessionId: input.logicalSessionId,
        observedAt: input.createdAt,
      },
      compatibility: { status: "compatible", issues: [] },
    };
    this.database.prepare(
      `INSERT INTO session_versions
        (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.logicalSessionId, bodyObject, input.bodyDigest, input.metadataDigest, canonicalJson(manifest), input.createdAt);
    const parent = this.database.prepare(
      "INSERT INTO version_parents (version_id, ordinal, parent_id) VALUES (?, ?, ?)",
    );
    input.parentVersionIds.forEach((parentId, ordinal) => parent.run(input.id, ordinal, parentId));
    const eventInsert = this.database.prepare(
      `INSERT INTO canonical_events
        (id, logical_session_id, sequence, kind, content_digest, event_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    for (const event of input.events) {
      if (event.logicalSessionId !== input.logicalSessionId) continue;
      eventInsert.run(event.id, input.logicalSessionId, event.sequence, event.kind, event.contentDigest, canonicalJson(event as unknown as JsonValue));
    }
  }

  private putDerivation(input: NonNullable<CanonicalEngineMutation["derivation"]>): void {
    this.database.prepare(
      `INSERT INTO session_derivations
        (child_session_id, parent_session_id, base_version_id, derivation_kind,
         trigger_run_id, trigger_operation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(child_session_id) DO NOTHING`,
    ).run(input.childSessionId, input.parentSessionId, input.baseVersionId, input.kind, input.triggerRunId, input.triggerOperationId, input.createdAt);
  }

  private putProjectionReceipt(input: ProjectionOperationReceipt): void {
    projectionOperationReceiptSchema.parse(input);
    this.database.prepare(
      `INSERT INTO run_operations
        (operation_id, run_id, logical_session_id, native_session_id, status,
         canonical_version_id, projection_revision, committed_at, receipt_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
    ).run(
      input.operationId, input.runId, input.logicalSessionId, input.nativeSessionId,
      input.status, input.canonicalVersionId, input.projectionRevision, input.committedAt,
      canonicalJson(input as unknown as JsonValue),
    );
  }
}
