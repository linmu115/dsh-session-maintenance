import type { DatabaseSync } from "node:sqlite";
import {
  canonicalChangePageSchema,
  canonicalChangeQuerySchema,
  canonicalEventV1Schema,
  canonicalSessionRecordSchema,
  logicalWorkspaceSchema,
  type CanonicalChangePage,
  type CanonicalChangeQuery,
  type CanonicalChangeV1,
  type CanonicalEventV1,
  type CanonicalProjectionInput,
  type CanonicalSessionRecord,
  type ContentObjectStore,
  type IncrementalCanonicalProjectionSource,
  type LogicalSessionId,
  type LogicalWorkspace,
  type ProjectionRun,
} from "@linmu/dsh-session-contracts";

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
  readonly workspace_id: string | null;
  readonly project_id: string | null;
  readonly project_name: string | null;
  readonly project_root: string | null;
}

interface WorkspaceRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly sort_key: string;
  readonly deleted_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EventRow { readonly event_json: string }

export class SqliteCanonicalProjectionSource implements IncrementalCanonicalProjectionSource {
  readonly database: DatabaseSync;
  readonly objectStore: ContentObjectStore | undefined;

  constructor(database: DatabaseSync, objectStore?: ContentObjectStore) {
    this.database = database;
    this.objectStore = objectStore;
  }

  async load(run: ProjectionRun): Promise<CanonicalProjectionInput> {
    return this.loadSelection(run);
  }

  async loadSessions(
    run: ProjectionRun,
    logicalSessionIds: readonly LogicalSessionId[],
  ): Promise<CanonicalProjectionInput> {
    return this.loadSelection(run, logicalSessionIds);
  }

  async currentRevision(): Promise<number> {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM canonical_change_log",
    ).get() as { readonly revision: number };
    return row.revision;
  }

  async listChanges(input: CanonicalChangeQuery): Promise<CanonicalChangePage> {
    canonicalChangeQuerySchema.parse(input);
    const currentRevision = await this.currentRevision();
    if (input.afterRevision > currentRevision) {
      throw new Error(`Canonical change cursor ${input.afterRevision} exceeds current revision ${currentRevision}`);
    }
    const rows = this.database.prepare(
      `SELECT revision, logical_session_id, change_kind, changed_at
       FROM canonical_change_log
       WHERE revision > ? AND revision <= ?
       ORDER BY revision
       LIMIT ?`,
    ).all(input.afterRevision, currentRevision, input.limit) as unknown as Array<{
      readonly revision: number;
      readonly logical_session_id: string;
      readonly change_kind: CanonicalChangeV1["kind"];
      readonly changed_at: string;
    }>;
    const changes: CanonicalChangeV1[] = rows.map((row) => ({
      schemaVersion: 1,
      revision: row.revision,
      logicalSessionId: row.logical_session_id as LogicalSessionId,
      kind: row.change_kind,
      changedAt: row.changed_at,
    }));
    const throughRevision = changes.at(-1)?.revision ?? input.afterRevision;
    return canonicalChangePageSchema.parse({
      schemaVersion: 1,
      afterRevision: input.afterRevision,
      throughRevision,
      currentRevision,
      hasMore: throughRevision < currentRevision,
      changes,
    }) as unknown as CanonicalChangePage;
  }

  private async loadSelection(
    run: ProjectionRun,
    logicalSessionIds?: readonly LogicalSessionId[],
  ): Promise<CanonicalProjectionInput> {
    const workspaceRows = this.database.prepare(
      `SELECT id, parent_id, name, sort_key, deleted_at, created_at, updated_at
       FROM logical_workspaces WHERE deleted_at IS NULL ORDER BY sort_key, id`,
    ).all() as unknown as WorkspaceRow[];
    const workspaces = workspaceRows.map((row) => logicalWorkspaceSchema.parse({
      schemaVersion: 1,
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      sortKey: row.sort_key,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }) as unknown as LogicalWorkspace);
    const existingWorkspaces = new Set(workspaces.map((workspace) => workspace.id));
    if (logicalSessionIds !== undefined && logicalSessionIds.length === 0) {
      return { run, workspaces, sessions: [] };
    }
    const selectionClause = logicalSessionIds === undefined
      ? ""
      : ` AND s.id IN (${logicalSessionIds.map(() => "?").join(",")})`;
    const sessionRows = this.database.prepare(
      `SELECT s.id, s.display_title, s.labels_json, s.authority_scope, s.origin_kind,
              s.head_version_id, s.archived_at, s.tombstoned_at, s.created_at, s.updated_at,
               m.workspace_id,
               p.id AS project_id,
               p.name AS project_name,
               (SELECT r.root_path
                  FROM project_roots r
                 WHERE r.project_id = p.id
                 ORDER BY r.ordinal, r.normalized_root_path
                 LIMIT 1) AS project_root
       FROM logical_sessions s
       LEFT JOIN workspace_memberships m ON m.logical_session_id = s.id
       LEFT JOIN project_memberships pm ON pm.logical_session_id = s.id
       LEFT JOIN logical_projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
       WHERE s.authority_scope IS NOT NULL
         AND s.origin_kind IS NOT NULL
         AND s.updated_at IS NOT NULL
         AND s.tombstoned_at IS NULL
         ${selectionClause}
       ORDER BY s.created_at, s.id`,
    ).all(...(logicalSessionIds ?? [])) as unknown as SessionRow[];
    const sessions = await Promise.all(sessionRows.map(async (row) => {
      const session = canonicalSessionRecordSchema.parse({
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
      const events = await this.loadHeadEvents(row.id, row.head_version_id);
      return {
        session,
        events,
        workspaceId: row.workspace_id !== null && existingWorkspaces.has(row.workspace_id as never)
          ? row.workspace_id as never
          : null,
        projectId: row.project_id as never,
        projectName: row.project_name,
        projectRoot: row.project_root,
      };
    }));
    return { run, workspaces, sessions };
  }

  private async loadHeadEvents(
    logicalSessionId: string,
    headVersionId: string | null,
  ): Promise<readonly CanonicalEventV1[]> {
    if (headVersionId !== null && this.objectStore !== undefined) {
      const version = this.database.prepare(
        "SELECT body_object FROM session_versions WHERE id = ? AND logical_session_id = ?",
      ).get(headVersionId, logicalSessionId) as { readonly body_object: string } | undefined;
      if (version === undefined) {
        throw new Error(`Canonical projection head is missing: ${logicalSessionId}/${headVersionId}`);
      }
      const body = JSON.parse(
        Buffer.from(await this.objectStore.get(version.body_object)).toString("utf8"),
      ) as { readonly schemaVersion?: unknown; readonly events?: unknown };
      if (body.schemaVersion !== 1 || !Array.isArray(body.events)) {
        throw new Error(`Canonical projection body is invalid: ${logicalSessionId}/${headVersionId}`);
      }
      return body.events.map((event) => canonicalEventV1Schema.parse(event) as unknown as CanonicalEventV1);
    }
    const eventRows = this.database.prepare(
      `SELECT event_json FROM canonical_events
       WHERE logical_session_id = ? ORDER BY sequence`,
    ).all(logicalSessionId) as unknown as EventRow[];
    return eventRows.map((eventRow) => canonicalEventV1Schema.parse(
      JSON.parse(eventRow.event_json),
    ) as unknown as CanonicalEventV1);
  }
}
