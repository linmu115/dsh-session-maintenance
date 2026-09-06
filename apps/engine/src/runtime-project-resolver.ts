import type { DatabaseSync } from "node:sqlite";

import type {
  LogicalProjectId,
  LogicalSessionId,
} from "@linmu/dsh-session-contracts";

import type { RuntimeProjectResolver } from "./runtime-broker.js";

interface ProjectRootRow {
  readonly project_id: string;
}

interface MembershipRow {
  readonly project_id: string | null;
  readonly revision: number;
}

interface InheritedProjectRow {
  readonly project_id: string | null;
}

function normalizeNativeProjectRoot(path: string): string {
  return path
    .replace(/^\\\\\?\\/u, "")
    .replaceAll("/", "\\")
    .replace(/\\+$/u, "")
    .toLocaleLowerCase("en-US");
}

/** Maps native cwd to an existing canonical project without treating cwd as workspace authority. */
export class SqliteRuntimeProjectResolver implements RuntimeProjectResolver {
  constructor(private readonly database: DatabaseSync) {}

  async resolveProject(cwd: string): Promise<LogicalProjectId | null> {
    if (cwd.length === 0) throw new TypeError("A live-created DSH session must expose SessionHeader.cwd");
    const rows = this.database.prepare(
      `SELECT DISTINCT r.project_id FROM project_roots r JOIN logical_projects p ON p.id=r.project_id
       WHERE r.normalized_root_path = ? AND p.deleted_at IS NULL ORDER BY r.project_id`,
    ).all(normalizeNativeProjectRoot(cwd)) as unknown as ProjectRootRow[];
    if (rows.length > 1) throw new Error(`Native cwd matches multiple canonical projects: ${cwd}`);
    return (rows[0]?.project_id ?? null) as LogicalProjectId | null;
  }

  async resolveInheritedProject(logicalSessionId: LogicalSessionId): Promise<LogicalProjectId | null> {
    const row = this.database.prepare(
      `SELECT pm.project_id
         FROM session_derivations d
         JOIN project_memberships pm ON pm.logical_session_id = d.parent_session_id
        WHERE d.child_session_id = ?`,
    ).get(logicalSessionId) as InheritedProjectRow | undefined;
    return (row?.project_id ?? null) as LogicalProjectId | null;
  }

  async assignProject(logicalSessionId: LogicalSessionId, projectId: LogicalProjectId): Promise<void> {
    const existing = this.database.prepare(
      "SELECT project_id, revision FROM project_memberships WHERE logical_session_id = ?",
    ).get(logicalSessionId) as MembershipRow | undefined;
    if (existing?.project_id === projectId) return;
    const revision = (existing?.revision ?? -1) + 1;
    this.database.prepare(
      `INSERT INTO project_memberships (logical_session_id, project_id, revision)
       VALUES (?, ?, ?)
       ON CONFLICT(logical_session_id) DO UPDATE SET project_id = excluded.project_id,
         revision = excluded.revision
       WHERE excluded.revision >= project_memberships.revision`,
    ).run(logicalSessionId, projectId, revision);
  }
}
