import type { DatabaseSync } from "node:sqlite";
import { readRc1CanonicalEventText } from "@linmu/dsh-session-adapter-rc1";

import {
  canonicalEventV1Schema,
  logicalWorkspaceSchema,
  sessionDerivationSchema,
  sessionTombstoneSchema,
  projectionRunSchema,
  workspaceMembershipSchema,
  logicalProjectSchema,
  projectMembershipSchema,
  projectRootSchema,
  type CanonicalDashboardSessionDetail,
  type CanonicalDashboardSessionSummary,
  type CanonicalLineageRelation,
  type CanonicalWorkspaceDirectory,
  type CanonicalProjectDirectory,
  type RecentlyDeletedSession,
  type RunCenterItem,
  type LogicalWorkspace,
  type LogicalProject,
  type ProjectMembership,
  type ProjectRoot,
  type SessionDerivation,
  type WorkspaceMembership,
} from "@linmu/dsh-session-contracts";
import {
  SqliteCanonicalRepository,
  SqliteNativeSessionReferenceRepository,
  readVersionMetadataSnapshot,
} from "@linmu/dsh-session-store";

interface IdRow { readonly id: string }
interface CanonicalEventRow { readonly event_json: string }
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
interface ProjectRootRow {
  readonly project_id: string;
  readonly root_path: string;
  readonly normalized_root_path: string;
  readonly ordinal: number;
}
interface ProjectMembershipRow {
  readonly logical_session_id: string;
  readonly project_id: string | null;
  readonly revision: number;
}
interface DerivationRow {
  readonly child_session_id: string;
  readonly parent_session_id: string;
  readonly base_version_id: string;
  readonly derivation_kind: "dsh-continuation";
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
interface RunRow {
  readonly id: string;
  readonly lease_id: string;
  readonly branch_id: string;
  readonly instance_id: string;
  readonly profile_id: string;
  readonly dsh_version: string;
  readonly adapter_id: string;
  readonly state: string;
  readonly started_at: string;
  readonly heartbeat_at: string;
  readonly checkpoint_id: string | null;
}

function parseWorkspace(row: WorkspaceRow): LogicalWorkspace {
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

function parseMembership(row: MembershipRow | undefined): WorkspaceMembership | null {
  if (row === undefined) return null;
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

function parseProject(row: ProjectRow): LogicalProject {
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

function parseProjectRoot(row: ProjectRootRow): ProjectRoot {
  return projectRootSchema.parse({
    schemaVersion: 1,
    projectId: row.project_id,
    path: row.root_path,
    normalizedPath: row.normalized_root_path,
    ordinal: row.ordinal,
  }) as ProjectRoot;
}

function parseProjectMembership(row: ProjectMembershipRow | undefined): ProjectMembership | null {
  if (row === undefined) return null;
  return projectMembershipSchema.parse({
    schemaVersion: 1,
    logicalSessionId: row.logical_session_id,
    projectId: row.project_id,
    revision: row.revision,
  }) as ProjectMembership;
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


function getWorkspace(database: DatabaseSync, id: string | null): LogicalWorkspace | null {
  if (id === null) return null;
  const row = database.prepare(
    `SELECT id, parent_id, name, sort_key, deleted_at, created_at, updated_at
     FROM logical_workspaces WHERE id = ?`,
  ).get(id) as WorkspaceRow | undefined;
  return row === undefined ? null : parseWorkspace(row);
}

function getProjectMembership(database: DatabaseSync, logicalSessionId: string): ProjectMembership | null {
  return parseProjectMembership(database.prepare(
    "SELECT logical_session_id, project_id, revision FROM project_memberships WHERE logical_session_id = ?",
  ).get(logicalSessionId) as ProjectMembershipRow | undefined);
}

function getProject(database: DatabaseSync, id: string | null): LogicalProject | null {
  if (id === null) return null;
  const row = database.prepare(
    `SELECT id, name, source_platform, source_project_id, sort_key, deleted_at, created_at, updated_at
     FROM logical_projects WHERE id = ?`,
  ).get(id) as ProjectRow | undefined;
  return row === undefined ? null : parseProject(row);
}

function getProjectRoots(database: DatabaseSync, id: string | null): readonly ProjectRoot[] {
  if (id === null) return [];
  return (database.prepare(
    `SELECT project_id, root_path, normalized_root_path, ordinal
     FROM project_roots WHERE project_id = ? ORDER BY ordinal, normalized_root_path`,
  ).all(id) as unknown as ProjectRootRow[]).map(parseProjectRoot);
}

/** Stable Maintenance read models; platform homes are never opened. */
export class SessionMaintenanceQueries {
  constructor(readonly database: DatabaseSync) {}

  pendingOperations(logicalSessionId: string): number {
    const database = this.database;
    const row = database.prepare(
      `SELECT COUNT(*) AS count FROM run_operations ro
       JOIN projection_runs pr ON pr.id = ro.run_id
       WHERE ro.logical_session_id = ? AND ro.status = 'pending'
         AND pr.state IN ('preparing', 'running', 'draining', 'verifying', 'recovery-required', 'recovering')`,
    ).get(logicalSessionId) as { readonly count: number };
    return row.count;
  }

  workspaceMembership(logicalSessionId: string): WorkspaceMembership | null {
    const database = this.database;
    return parseMembership(database.prepare(
      `SELECT logical_session_id, workspace_id, display_order, pinned, archived, revision
       FROM workspace_memberships WHERE logical_session_id = ?`,
    ).get(logicalSessionId) as MembershipRow | undefined);
  }

  /** Reads only Maintenance's stable canonical tables; no platform home is opened. */
  async readCanonicalWorkspaceDirectory(): Promise<CanonicalWorkspaceDirectory> {
    const database = this.database;
    const canonical = new SqliteCanonicalRepository(database);
    const workspaceRows = database.prepare(
      `SELECT id, parent_id, name, sort_key, deleted_at, created_at, updated_at
       FROM logical_workspaces WHERE deleted_at IS NULL ORDER BY sort_key, id`,
    ).all() as unknown as WorkspaceRow[];
    const summaries = new Map<string | null, CanonicalDashboardSessionSummary[]>();
    const sessionRows = database.prepare(
      `SELECT ls.id FROM logical_sessions ls
       LEFT JOIN workspace_memberships wm ON wm.logical_session_id = ls.id
       WHERE ls.authority_scope IS NOT NULL AND ls.origin_kind IS NOT NULL AND ls.tombstoned_at IS NULL
       ORDER BY COALESCE(wm.pinned, 0) DESC, COALESCE(wm.display_order, 0), ls.updated_at DESC, ls.id`,
    ).all() as unknown as IdRow[];
    for (const row of sessionRows) {
      const session = await canonical.getCanonicalSession(row.id as never);
      if (session === undefined) continue;
      const membership = this.workspaceMembership(row.id);
      const key = membership?.workspaceId ?? null;
      const items = summaries.get(key) ?? [];
      items.push({ session, membership });
      summaries.set(key, items);
    }
    return {
      schemaVersion: 1,
      workspaces: workspaceRows.map((row) => {
        const workspace = parseWorkspace(row);
        return { workspace, sessions: summaries.get(workspace.id) ?? [] };
      }),
      unclassified: summaries.get(null) ?? [],
    };
  }

  /** Reads the stable project directory. Workspace membership is intentionally not used for grouping. */
  async readCanonicalProjectDirectory(): Promise<CanonicalProjectDirectory> {
    const database = this.database;
    const canonical = new SqliteCanonicalRepository(database);
    const projectRows = database.prepare(
      `SELECT id, name, source_platform, source_project_id, sort_key, deleted_at, created_at, updated_at
       FROM logical_projects WHERE deleted_at IS NULL ORDER BY sort_key, id`,
    ).all() as unknown as ProjectRow[];
    const summaries = new Map<string | null, CanonicalDashboardSessionSummary[]>();
    const sessionRows = database.prepare(
      `SELECT ls.id FROM logical_sessions ls
       LEFT JOIN project_memberships pm ON pm.logical_session_id = ls.id
       LEFT JOIN workspace_memberships wm ON wm.logical_session_id = ls.id
       WHERE ls.authority_scope IS NOT NULL AND ls.origin_kind IS NOT NULL AND ls.tombstoned_at IS NULL
       ORDER BY COALESCE(wm.pinned, 0) DESC, COALESCE(wm.display_order, 0), ls.updated_at DESC, ls.id`,
    ).all() as unknown as IdRow[];
    for (const row of sessionRows) {
      const session = await canonical.getCanonicalSession(row.id as never);
      if (session === undefined) continue;
      const projectMembership = getProjectMembership(database, row.id);
      const key = projectMembership?.projectId ?? null;
      const items = summaries.get(key) ?? [];
      items.push({ session, membership: this.workspaceMembership(row.id) });
      summaries.set(key, items);
    }
    return {
      schemaVersion: 1,
      projects: projectRows.map((row) => {
        const project = parseProject(row);
        return { project, roots: getProjectRoots(database, project.id), sessions: summaries.get(project.id) ?? [] };
      }),
      unclassified: summaries.get(null) ?? [],
    };
  }

  /** Returns a static canonical transcript plus its immutable derivation lineage. */
  async readCanonicalDashboardSession(logicalSessionId: string,
  ): Promise<CanonicalDashboardSessionDetail | undefined> {
    const database = this.database;
    const canonical = new SqliteCanonicalRepository(database);
    const session = await canonical.getCanonicalSession(logicalSessionId as never);
    if (session === undefined) return undefined;
    const nativeReferences = await new SqliteNativeSessionReferenceRepository(database)
      .getReferenceIndex(logicalSessionId as never);
    if (nativeReferences === undefined) {
      throw new Error(`Native reference index lost canonical session ${logicalSessionId}`);
    }
    const membership = this.workspaceMembership(logicalSessionId);
    const projectMembership = getProjectMembership(database, logicalSessionId);
    const events = (database.prepare(
      `SELECT event_json FROM canonical_events
       WHERE logical_session_id = ? ORDER BY sequence, id`,
    ).all(logicalSessionId) as unknown as CanonicalEventRow[]).map((row) => canonicalEventV1Schema.parse(JSON.parse(row.event_json)));
    const parentRow = database.prepare(
      `SELECT child_session_id, parent_session_id, base_version_id, derivation_kind,
              trigger_run_id, trigger_operation_id, created_at
       FROM session_derivations WHERE child_session_id = ?`,
    ).get(logicalSessionId) as DerivationRow | undefined;
    const childRows = database.prepare(
      `SELECT child_session_id, parent_session_id, base_version_id, derivation_kind,
              trigger_run_id, trigger_operation_id, created_at
       FROM session_derivations WHERE parent_session_id = ? ORDER BY created_at, child_session_id`,
    ).all(logicalSessionId) as unknown as DerivationRow[];
    const relation = async (row: DerivationRow): Promise<CanonicalLineageRelation | null> => {
      const relatedId = row.child_session_id === logicalSessionId ? row.parent_session_id : row.child_session_id;
      const related = await canonical.getCanonicalSession(relatedId as never);
      return related === undefined ? null : { derivation: parseDerivation(row), session: related };
    };
    const parent = parentRow === undefined ? null : await relation(parentRow);
    const children = (await Promise.all(childRows.map(relation))).filter((item): item is CanonicalLineageRelation => item !== null);
    return {
      schemaVersion: 1,
      session,
      membership,
      workspace: getWorkspace(database, membership?.workspaceId ?? null),
      projectMembership,
      project: getProject(database, projectMembership?.projectId ?? null),
      projectRoots: getProjectRoots(database, projectMembership?.projectId ?? null),
      nativeReferences,
      events: events.map((event) => ({ ...event,
        readableText: event.source.platform === "dsh"
          ? readRc1CanonicalEventText(event as never)
          : typeof event.content === "string" ? event.content : null,
      })) as never,
      parent,
      children,
      headMetadata: session.headVersionId === null ? null : readVersionMetadataSnapshot(database, session.headVersionId),
    };
  }

  async readRecentlyDeleted(): Promise<readonly RecentlyDeletedSession[]> {
    const database = this.database;
    const canonical = new SqliteCanonicalRepository(database);
    const ids = database.prepare(
      `SELECT id FROM logical_sessions WHERE tombstoned_at IS NOT NULL ORDER BY tombstoned_at DESC, id`,
    ).all() as unknown as IdRow[];
    const result: RecentlyDeletedSession[] = [];
    for (const { id } of ids) {
      const session = await canonical.getCanonicalSession(id as never);
      if (session === undefined) continue;
      const row = database.prepare(
        `SELECT logical_session_id, operation_id, checkpoint_id, previous_workspace_id, deleted_at, retention_until, restored_at
         FROM session_tombstones WHERE logical_session_id = ? AND restored_at IS NULL`,
      ).get(id) as TombstoneRow | undefined;
      result.push({
        session,
        tombstone: row === undefined ? null : sessionTombstoneSchema.parse({
          schemaVersion: 1, logicalSessionId: row.logical_session_id, operationId: row.operation_id,
          checkpointId: row.checkpoint_id, previousWorkspaceId: row.previous_workspace_id,
          deletedAt: row.deleted_at, retentionUntil: row.retention_until, restoredAt: row.restored_at,
        }) as never,
        pendingOperations: this.pendingOperations(id),
      });
    }
    return result;
  }

  readRunCenter(): readonly RunCenterItem[] {
    const database = this.database;
    const rows = database.prepare(
      `SELECT id, lease_id, branch_id, instance_id, profile_id, dsh_version, adapter_id,
              state, started_at, heartbeat_at, checkpoint_id
       FROM projection_runs ORDER BY started_at DESC, id`,
    ).all() as unknown as RunRow[];
    return rows.map((row) => {
      const modes = Object.fromEntries((database.prepare(
        "SELECT mode, COUNT(*) AS count FROM projection_sessions WHERE run_id = ? GROUP BY mode",
      ).all(row.id) as unknown as Array<{ readonly mode: string; readonly count: number }>).map((item) => [item.mode, item.count]));
      const projectedSessions = Object.values(modes).reduce((sum, count) => sum + count, 0);
      const hiddenSessions = (modes.hidden ?? 0) + (modes["recovery-only"] ?? 0);
      const pending = (database.prepare("SELECT COUNT(*) AS count FROM run_operations WHERE run_id = ? AND status = 'pending'").get(row.id) as { readonly count: number }).count;
      const latestStages = Object.fromEntries((database.prepare(
        `SELECT e.stage, e.state, e.at, e.error_code, e.diagnostic_detail_ref
         FROM run_status_events e
         JOIN (SELECT stage, MAX(sequence) AS sequence FROM run_status_events WHERE run_id = ? GROUP BY stage) latest
           ON latest.stage = e.stage AND latest.sequence = e.sequence
         WHERE e.run_id = ?`,
      ).all(row.id, row.id) as unknown as Array<{ readonly stage: string; readonly state: string; readonly at: string; readonly error_code: string | null; readonly diagnostic_detail_ref: string | null }>).map((item) => [item.stage, {
        state: item.state, at: item.at, errorCode: item.error_code, diagnosticDetailRef: item.diagnostic_detail_ref,
      }]));
      return {
        run: projectionRunSchema.parse({ schemaVersion: 1, id: row.id, leaseId: row.lease_id, branchId: row.branch_id, instanceId: row.instance_id, profileId: row.profile_id, dshVersion: row.dsh_version, adapterId: row.adapter_id, state: row.state, startedAt: row.started_at, heartbeatAt: row.heartbeat_at, checkpointId: row.checkpoint_id }) as never,
        projectedSessions,
        hiddenSessions,
        pendingOperations: pending,
        modes: modes as never,
        latestStages: latestStages as never,
      };
    });
  }

  /** Exact run/native identity; never guess from titles or obsolete platform bindings. */
  resolveProjectionSessionIdentity(runId: string, nativeSessionId: string) {
    const database = this.database;
    const row = database.prepare(`
      SELECT ps.logical_session_id, ls.display_title, ls.tombstoned_at
      FROM projection_sessions ps
      JOIN projection_runs pr ON pr.id = ps.run_id
      JOIN logical_sessions ls ON ls.id = ps.logical_session_id
      WHERE ps.run_id = ? AND ps.native_session_id = ?
        AND pr.state IN ('preparing', 'running', 'draining')
        AND ls.authority_scope IS NOT NULL
    `).get(runId, nativeSessionId) as { logical_session_id: string; display_title: string; tombstoned_at: string | null } | undefined;
    return row === undefined ? undefined : {
      logicalSessionId: row.logical_session_id,
      title: row.display_title,
      status: row.tombstoned_at === null ? "active" : "deleted",
    };
  }
}
