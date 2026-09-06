import type { DatabaseSync } from "node:sqlite";

import {
  logicalProjectSchema,
  projectMembershipSchema,
  projectRootSchema,
  type LogicalProject,
  type LogicalProjectId,
  type LogicalSessionId,
  type ProjectMembership,
  type ProjectRoot,
} from "@linmu/dsh-session-contracts";

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly source_platform: "codex" | "maintenance";
  readonly source_project_id: string | null;
  readonly sort_key: string;
  readonly deleted_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RootRow {
  readonly project_id: string;
  readonly root_path: string;
  readonly normalized_root_path: string;
  readonly ordinal: number;
}

interface MembershipRow {
  readonly logical_session_id: string;
  readonly project_id: string | null;
  readonly revision: number;
}

function projectFromRow(row: ProjectRow): LogicalProject {
  return logicalProjectSchema.parse({
    schemaVersion: 1,
    id: row.id,
    name: row.name,
    sourcePlatform: row.source_platform,
    sourceProjectId: row.source_project_id,
    sortKey: row.sort_key,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as LogicalProject;
}

function rootFromRow(row: RootRow): ProjectRoot {
  return projectRootSchema.parse({
    schemaVersion: 1,
    projectId: row.project_id,
    path: row.root_path,
    normalizedPath: row.normalized_root_path,
    ordinal: row.ordinal,
  }) as ProjectRoot;
}

function membershipFromRow(row: MembershipRow): ProjectMembership {
  return projectMembershipSchema.parse({
    schemaVersion: 1,
    logicalSessionId: row.logical_session_id,
    projectId: row.project_id,
    revision: row.revision,
  }) as ProjectMembership;
}

export class SqliteLogicalProjectRepository {
  constructor(readonly database: DatabaseSync) {}

  async upsertProject(input: LogicalProject): Promise<void> {
    logicalProjectSchema.parse(input);
    this.database.prepare(
      `INSERT INTO logical_projects
        (id, name, source_platform, source_project_id, sort_key, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name,
         source_platform = excluded.source_platform, source_project_id = excluded.source_project_id,
         sort_key = excluded.sort_key, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`,
    ).run(input.id, input.name, input.sourcePlatform, input.sourceProjectId, input.sortKey, input.deletedAt, input.createdAt, input.updatedAt);
  }

  async getProject(id: LogicalProjectId): Promise<LogicalProject | undefined> {
    const row = this.database.prepare(
      `SELECT id, name, source_platform, source_project_id, sort_key, deleted_at, created_at, updated_at
       FROM logical_projects WHERE id = ?`,
    ).get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : projectFromRow(row);
  }

  async listProjects(): Promise<readonly LogicalProject[]> {
    return (this.database.prepare(
      `SELECT id, name, source_platform, source_project_id, sort_key, deleted_at, created_at, updated_at
       FROM logical_projects WHERE deleted_at IS NULL ORDER BY sort_key, id`,
    ).all() as unknown as ProjectRow[]).map(projectFromRow);
  }

  async replaceRoots(projectId: LogicalProjectId, roots: readonly ProjectRoot[]): Promise<void> {
    for (const root of roots) {
      projectRootSchema.parse(root);
      if (root.projectId !== projectId) throw new Error("Project root belongs to a different project");
    }
    const nested = this.database.isTransaction;
    this.database.exec(nested ? "SAVEPOINT project_roots_replace" : "BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM project_roots WHERE project_id = ?").run(projectId);
      const insert = this.database.prepare(
        `INSERT INTO project_roots (project_id, root_path, normalized_root_path, ordinal)
         VALUES (?, ?, ?, ?)`,
      );
      for (const root of roots) insert.run(projectId, root.path, root.normalizedPath, root.ordinal);
      this.database.exec(nested ? "RELEASE project_roots_replace" : "COMMIT");
    } catch (error) {
      try { this.database.exec(nested ? "ROLLBACK TO project_roots_replace; RELEASE project_roots_replace" : "ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  async listRoots(projectId?: LogicalProjectId): Promise<readonly ProjectRoot[]> {
    const rows = projectId === undefined
      ? this.database.prepare(
        `SELECT project_id, root_path, normalized_root_path, ordinal
         FROM project_roots ORDER BY project_id, ordinal, normalized_root_path`,
      ).all()
      : this.database.prepare(
        `SELECT project_id, root_path, normalized_root_path, ordinal
         FROM project_roots WHERE project_id = ? ORDER BY ordinal, normalized_root_path`,
      ).all(projectId);
    return (rows as unknown as RootRow[]).map(rootFromRow);
  }

  async setMembership(input: ProjectMembership): Promise<void> {
    projectMembershipSchema.parse(input);
    const result = this.database.prepare(
      `INSERT INTO project_memberships (logical_session_id, project_id, revision)
       VALUES (?, ?, ?)
       ON CONFLICT(logical_session_id) DO UPDATE SET project_id = excluded.project_id,
         revision = excluded.revision
       WHERE excluded.revision >= project_memberships.revision`,
    ).run(input.logicalSessionId, input.projectId, input.revision);
    if (Number(result.changes) === 0) throw new Error(`Project membership revision moved backwards: ${input.logicalSessionId}`);
  }

  async getMembership(logicalSessionId: LogicalSessionId): Promise<ProjectMembership | undefined> {
    const row = this.database.prepare(
      `SELECT logical_session_id, project_id, revision FROM project_memberships WHERE logical_session_id = ?`,
    ).get(logicalSessionId) as MembershipRow | undefined;
    return row === undefined ? undefined : membershipFromRow(row);
  }
}
