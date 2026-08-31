import type { DatabaseSync } from "node:sqlite";

import {
  logicalWorkspaceSchema,
  workspaceMembershipSchema,
  type LogicalSessionId,
  type LogicalWorkspace,
  type LogicalWorkspaceId,
  type WorkspaceMembership,
} from "@linmu/dsh-session-contracts";

interface WorkspaceRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly sort_key: string;
  readonly deleted_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MembershipRow {
  readonly logical_session_id: string;
  readonly workspace_id: string | null;
  readonly display_order: number;
  readonly pinned: number;
  readonly archived: number;
  readonly revision: number;
}

function workspaceFromRow(row: WorkspaceRow): LogicalWorkspace {
  return logicalWorkspaceSchema.parse({
    schemaVersion: 1,
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    sortKey: row.sort_key,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as LogicalWorkspace;
}

function membershipFromRow(row: MembershipRow): WorkspaceMembership {
  return workspaceMembershipSchema.parse({
    schemaVersion: 1,
    logicalSessionId: row.logical_session_id,
    workspaceId: row.workspace_id,
    displayOrder: row.display_order,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    revision: row.revision,
  }) as WorkspaceMembership;
}

export class SqliteLogicalWorkspaceRepository {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async upsert(input: LogicalWorkspace): Promise<void> {
    logicalWorkspaceSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO logical_workspaces
          (id, parent_id, name, sort_key, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           parent_id = excluded.parent_id,
           name = excluded.name,
           sort_key = excluded.sort_key,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.parentId,
        input.name,
        input.sortKey,
        input.deletedAt,
        input.createdAt,
        input.updatedAt,
      );
  }

  async get(id: LogicalWorkspaceId): Promise<LogicalWorkspace | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, parent_id, name, sort_key, deleted_at, created_at, updated_at
         FROM logical_workspaces WHERE id = ?`,
      )
      .get(id) as WorkspaceRow | undefined;
    return row === undefined ? undefined : workspaceFromRow(row);
  }

  async setMembership(input: WorkspaceMembership): Promise<void> {
    workspaceMembershipSchema.parse(input);
    const result = this.database
      .prepare(
        `INSERT INTO workspace_memberships
          (logical_session_id, workspace_id, display_order, pinned, archived, revision)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(logical_session_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           display_order = excluded.display_order,
           pinned = excluded.pinned,
           archived = excluded.archived,
           revision = excluded.revision
         WHERE excluded.revision >= workspace_memberships.revision`,
      )
      .run(
        input.logicalSessionId,
        input.workspaceId,
        input.displayOrder,
        input.pinned ? 1 : 0,
        input.archived ? 1 : 0,
        input.revision,
      );
    if (Number(result.changes) === 0) {
      throw new Error(
        `Workspace membership revision moved backwards: ${input.logicalSessionId}`,
      );
    }
  }

  async getMembership(
    logicalSessionId: LogicalSessionId,
  ): Promise<WorkspaceMembership | undefined> {
    const row = this.database
      .prepare(
        `SELECT logical_session_id, workspace_id, display_order, pinned, archived, revision
         FROM workspace_memberships WHERE logical_session_id = ?`,
      )
      .get(logicalSessionId) as MembershipRow | undefined;
    return row === undefined ? undefined : membershipFromRow(row);
  }
}
