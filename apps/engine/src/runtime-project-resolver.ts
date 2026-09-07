import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { basename, isAbsolute, normalize, win32 } from "node:path";

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

  /** Creates only a Maintenance project; this never edits Codex project scope. */
  async ensureLocalProject(cwd: string): Promise<LogicalProjectId> {
    const windowsRooted = win32.isAbsolute(cwd) && win32.parse(cwd).root.length > 1;
    if (cwd.trim().length === 0 || (!windowsRooted && !(process.platform !== "win32" && isAbsolute(cwd)))) {
      throw new TypeError("A live-created DSH workspace must have an absolute cwd");
    }
    const path = windowsRooted ? win32.normalize(cwd) : normalize(cwd);
    const existing = await this.resolveProject(path);
    if (existing !== null) return existing;
    const normalized = normalizeNativeProjectRoot(path);
    const projectId = `project-maintenance-${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}` as LogicalProjectId;
    const name = (windowsRooted ? win32.basename(path) : basename(path)) || path;
    const at = new Date().toISOString();
    const nested = this.database.isTransaction;
    this.database.exec(nested ? "SAVEPOINT runtime_local_project" : "BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO logical_projects (id,name,source_platform,source_project_id,sort_key,deleted_at,created_at,updated_at)
        VALUES (?,?,'maintenance',NULL,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET deleted_at=NULL,updated_at=excluded.updated_at
        WHERE logical_projects.source_platform='maintenance' AND logical_projects.source_project_id IS NULL`).run(projectId,name,name,at,at);
      const project = this.database.prepare("SELECT source_platform,source_project_id FROM logical_projects WHERE id=?").get(projectId);
      if (project?.source_platform !== "maintenance" || project.source_project_id !== null) throw new Error("Local project identity belongs to another source");
      this.database.prepare(`INSERT INTO project_roots (project_id,root_path,normalized_root_path,ordinal) VALUES (?,?,?,0)
        ON CONFLICT(project_id,normalized_root_path) DO NOTHING`).run(projectId,path,normalized);
      this.database.exec(nested ? "RELEASE runtime_local_project" : "COMMIT");
    } catch (error) {
      try { this.database.exec(nested ? "ROLLBACK TO runtime_local_project; RELEASE runtime_local_project" : "ROLLBACK"); } catch { /* preserve the project registration error */ }
      throw error;
    }
    return projectId;
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
