import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  canonicalEventV1Schema,
  logicalWorkspaceSchema,
  sessionDerivationSchema,
  sessionTombstoneSchema,
  projectionRunSchema,
  workspaceMembershipSchema,
  type CanonicalDashboardSessionDetail,
  type CanonicalDashboardSessionSummary,
  type CanonicalLineageRelation,
  type CanonicalWorkspaceDirectory,
  type CanonicalSessionDeleteResult,
  type CanonicalSessionMaintenancePatch,
  type CanonicalSessionRestoreResult,
  type RecentlyDeletedSession,
  type RunCenterItem,
  type LogicalWorkspace,
  type SessionDerivation,
  type WorkspaceMembership,
} from "@linmu/dsh-session-contracts";
import { SqliteCanonicalRepository } from "@linmu/dsh-session-store";

const ASSET = /^\/dashboard\/assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/u;

export const DASHBOARD_CANONICAL_MIGRATION_PREVIEW_PATH = "/v1/migrations/canonical/preview";
export const DASHBOARD_CANONICAL_WORKSPACES_PATH = "/v1/canonical/workspaces";

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

function getMembership(database: DatabaseSync, logicalSessionId: string): WorkspaceMembership | null {
  return parseMembership(database.prepare(
    `SELECT logical_session_id, workspace_id, display_order, pinned, archived, revision
     FROM workspace_memberships WHERE logical_session_id = ?`,
  ).get(logicalSessionId) as MembershipRow | undefined);
}

function getWorkspace(database: DatabaseSync, id: string | null): LogicalWorkspace | null {
  if (id === null) return null;
  const row = database.prepare(
    `SELECT id, parent_id, name, sort_key, deleted_at, created_at, updated_at
     FROM logical_workspaces WHERE id = ?`,
  ).get(id) as WorkspaceRow | undefined;
  return row === undefined ? null : parseWorkspace(row);
}

/** Reads only Maintenance's stable canonical tables; no platform home is opened. */
export async function readCanonicalWorkspaceDirectory(database: DatabaseSync): Promise<CanonicalWorkspaceDirectory> {
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
    const membership = getMembership(database, row.id);
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

/** Returns a static canonical transcript plus its immutable derivation lineage. */
export async function readCanonicalDashboardSession(
  database: DatabaseSync,
  logicalSessionId: string,
): Promise<CanonicalDashboardSessionDetail | undefined> {
  const canonical = new SqliteCanonicalRepository(database);
  const session = await canonical.getCanonicalSession(logicalSessionId as never);
  if (session === undefined) return undefined;
  const membership = getMembership(database, logicalSessionId);
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
    events: events as never,
    parent,
    children,
  };
}

function pendingOperations(database: DatabaseSync, logicalSessionId: string): number {
  const row = database.prepare(
    `SELECT COUNT(*) AS count FROM run_operations ro
     JOIN projection_runs pr ON pr.id = ro.run_id
     WHERE ro.logical_session_id = ? AND ro.status = 'pending'
       AND pr.state IN ('preparing', 'running', 'draining', 'verifying', 'recovery-required', 'recovering')`,
  ).get(logicalSessionId) as { readonly count: number };
  return row.count;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export async function updateCanonicalDashboardSession(
  database: DatabaseSync,
  logicalSessionId: string,
  patch: CanonicalSessionMaintenancePatch,
  at: string,
): Promise<CanonicalDashboardSessionDetail | undefined> {
  const exists = database.prepare("SELECT id FROM logical_sessions WHERE id = ? AND authority_scope IS NOT NULL").get(logicalSessionId);
  if (exists === undefined) return undefined;
  transaction(database, () => {
    if (patch.title !== undefined || patch.tags !== undefined || patch.archived !== undefined) {
      const row = database.prepare("SELECT display_title, labels_json, archived_at FROM logical_sessions WHERE id = ?").get(logicalSessionId) as { readonly display_title: string; readonly labels_json: string; readonly archived_at: string | null };
      const archivedAt = patch.archived === undefined ? row.archived_at : patch.archived ? at : null;
      database.prepare(
        `UPDATE logical_sessions SET display_title = ?, labels_json = ?, archived = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
      ).run(patch.title ?? row.display_title, JSON.stringify(patch.tags ?? JSON.parse(row.labels_json)), archivedAt === null ? 0 : 1, archivedAt, at, logicalSessionId);
    }
    if (patch.workspaceId !== undefined || patch.displayOrder !== undefined || patch.pinned !== undefined || patch.archived !== undefined) {
      const current = getMembership(database, logicalSessionId);
      database.prepare(
        `INSERT INTO workspace_memberships (logical_session_id, workspace_id, display_order, pinned, archived, revision)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(logical_session_id) DO UPDATE SET workspace_id = excluded.workspace_id,
           display_order = excluded.display_order, pinned = excluded.pinned,
           archived = excluded.archived, revision = excluded.revision`,
      ).run(
        logicalSessionId,
        patch.workspaceId === undefined ? current?.workspaceId ?? null : patch.workspaceId,
        patch.displayOrder ?? current?.displayOrder ?? 0,
        (patch.pinned ?? current?.pinned ?? false) ? 1 : 0,
        (patch.archived ?? current?.archived ?? false) ? 1 : 0,
        (current?.revision ?? 0) + 1,
      );
    }
  });
  return readCanonicalDashboardSession(database, logicalSessionId);
}

export function deleteLogicalWorkspace(database: DatabaseSync, workspaceId: string, at: string): boolean {
  return transaction(database, () => {
    const result = database.prepare("UPDATE logical_workspaces SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, at, workspaceId);
    if (Number(result.changes) === 0) return false;
    database.prepare("UPDATE workspace_memberships SET workspace_id = NULL, revision = revision + 1 WHERE workspace_id = ?").run(workspaceId);
    database.prepare("UPDATE logical_workspaces SET parent_id = NULL, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL").run(at, workspaceId);
    return true;
  });
}

export function deleteCanonicalDashboardSession(
  database: DatabaseSync,
  logicalSessionId: string,
  at: string,
  retentionUntil: string,
): CanonicalSessionDeleteResult | undefined {
  const row = database.prepare("SELECT head_version_id FROM logical_sessions WHERE id = ? AND authority_scope IS NOT NULL").get(logicalSessionId) as { readonly head_version_id: string | null } | undefined;
  if (row === undefined) return undefined;
  const pending = pendingOperations(database, logicalSessionId);
  if (pending > 0) {
    transaction(database, () => {
      database.prepare("UPDATE logical_sessions SET tombstoned_at = ?, updated_at = ? WHERE id = ?").run(at, at, logicalSessionId);
      database.prepare(
        `UPDATE projection_sessions SET mode = 'recovery-only' WHERE logical_session_id = ?
         AND run_id IN (SELECT id FROM projection_runs WHERE state IN ('preparing','running','draining','verifying','recovery-required','recovering'))`,
      ).run(logicalSessionId);
    });
    return { logicalSessionId, state: "pending-delete", checkpointId: null, pendingOperations: pending };
  }
  return transaction(database, () => {
    const existing = database.prepare("SELECT checkpoint_id FROM session_tombstones WHERE logical_session_id = ? AND restored_at IS NULL").get(logicalSessionId) as { readonly checkpoint_id: string } | undefined;
    if (existing !== undefined) return { logicalSessionId, state: "deleted", checkpointId: existing.checkpoint_id, pendingOperations: 0 };
    const membership = getMembership(database, logicalSessionId);
    const checkpointId = `checkpoint-delete-${randomUUID()}`;
    const operationId = `operation-delete-${randomUUID()}`;
    database.prepare(
      `INSERT INTO checkpoints (id, name, description, refs_json, backup_transaction_ids_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(checkpointId, "删除前自动 Checkpoint", `删除逻辑会话 ${logicalSessionId} 前自动建立`, JSON.stringify(row.head_version_id === null ? {} : { [`session:${logicalSessionId}`]: row.head_version_id }), "[]", "maintenance-dashboard", at);
    database.prepare(
      `INSERT INTO session_tombstones (logical_session_id, operation_id, checkpoint_id, previous_workspace_id, deleted_at, retention_until, restored_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(logical_session_id) DO UPDATE SET operation_id = excluded.operation_id,
         checkpoint_id = excluded.checkpoint_id, previous_workspace_id = excluded.previous_workspace_id,
         deleted_at = excluded.deleted_at, retention_until = excluded.retention_until, restored_at = NULL`,
    ).run(logicalSessionId, operationId, checkpointId, membership?.workspaceId ?? null, at, retentionUntil);
    database.prepare("UPDATE logical_sessions SET tombstoned_at = ?, updated_at = ? WHERE id = ?").run(at, at, logicalSessionId);
    database.prepare(
      `INSERT INTO workspace_memberships (logical_session_id, workspace_id, display_order, pinned, archived, revision)
       VALUES (?, NULL, 0, 0, 1, ?)
       ON CONFLICT(logical_session_id) DO UPDATE SET workspace_id = NULL, display_order = 0,
         pinned = 0, archived = 1, revision = excluded.revision`,
    ).run(logicalSessionId, (membership?.revision ?? 0) + 1);
    database.prepare("UPDATE projection_sessions SET mode = 'hidden' WHERE logical_session_id = ?").run(logicalSessionId);
    return { logicalSessionId, state: "deleted", checkpointId, pendingOperations: 0 };
  });
}

export function restoreCanonicalDashboardSession(
  database: DatabaseSync,
  logicalSessionId: string,
  at: string,
): CanonicalSessionRestoreResult | undefined {
  const session = database.prepare("SELECT authority_scope, tombstoned_at, archived_at FROM logical_sessions WHERE id = ?").get(logicalSessionId) as { readonly authority_scope: "codex" | "maintenance" | null; readonly tombstoned_at: string | null; readonly archived_at: string | null } | undefined;
  if (session === undefined || session.tombstoned_at === null) return undefined;
  return transaction(database, () => {
    const tombstone = database.prepare(
      `SELECT logical_session_id, operation_id, checkpoint_id, previous_workspace_id, deleted_at, retention_until, restored_at
       FROM session_tombstones WHERE logical_session_id = ?`,
    ).get(logicalSessionId) as TombstoneRow | undefined;
    const current = getMembership(database, logicalSessionId);
    const workspaceId = tombstone?.previous_workspace_id ?? current?.workspaceId ?? null;
    if (tombstone !== undefined) database.prepare("UPDATE session_tombstones SET restored_at = ? WHERE logical_session_id = ?").run(at, logicalSessionId);
    database.prepare("UPDATE logical_sessions SET tombstoned_at = NULL, updated_at = ? WHERE id = ?").run(at, logicalSessionId);
    database.prepare(
      `INSERT INTO workspace_memberships (logical_session_id, workspace_id, display_order, pinned, archived, revision)
       VALUES (?, ?, 0, 0, ?, ?)
       ON CONFLICT(logical_session_id) DO UPDATE SET workspace_id = excluded.workspace_id,
         display_order = 0, pinned = 0, archived = excluded.archived, revision = excluded.revision`,
    ).run(logicalSessionId, workspaceId, session.archived_at === null ? 0 : 1, (current?.revision ?? 0) + 1);
    database.prepare("UPDATE projection_sessions SET mode = ? WHERE logical_session_id = ? AND mode IN ('hidden','recovery-only')").run(session.authority_scope === "codex" ? "codex-read-until-write" : "maintenance-write", logicalSessionId);
    return { logicalSessionId, state: "restored", workspaceId };
  });
}

export async function readRecentlyDeleted(database: DatabaseSync): Promise<readonly RecentlyDeletedSession[]> {
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
      pendingOperations: pendingOperations(database, id),
    });
  }
  return result;
}

export function readRunCenter(database: DatabaseSync): readonly RunCenterItem[] {
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

function headers(response: ServerResponse, contentType: string, cacheControl: string): void {
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", cacheControl);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}

function mediaType(name: string): string {
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export async function serveDashboardAsset(
  request: IncomingMessage,
  response: ServerResponse,
  dashboardRoot: string,
): Promise<boolean> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/dashboard") {
    response.statusCode = 308;
    response.setHeader("location", "/dashboard/");
    response.setHeader("cache-control", "no-store");
    response.end();
    return true;
  }
  let file: string;
  let contentType: string;
  let cacheControl: string;
  if (path === "/dashboard/") {
    file = join(dashboardRoot, "index.html");
    contentType = "text/html; charset=utf-8";
    cacheControl = "no-store";
  } else {
    const match = ASSET.exec(path);
    if (match === null) return false;
    file = join(dashboardRoot, "assets", match[1]!);
    contentType = mediaType(match[1]!);
    cacheControl = "public, max-age=31536000, immutable";
  }
  try {
    const body = await readFile(file);
    response.statusCode = 200;
    headers(response, contentType, cacheControl);
    response.setHeader("content-length", String(body.byteLength));
    response.end(method === "HEAD" ? undefined : body);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    response.statusCode = code === "ENOENT" ? 404 : 500;
    headers(response, "application/json; charset=utf-8", "no-store");
    response.end(JSON.stringify({ error: { code: code === "ENOENT" ? "NOT_FOUND" : "DASHBOARD_ASSET_ERROR" } }));
  }
  return true;
}
