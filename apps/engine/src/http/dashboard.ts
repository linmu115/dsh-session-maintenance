import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  canonicalEventV1Schema,
  logicalWorkspaceSchema,
  sessionDerivationSchema,
  workspaceMembershipSchema,
  type CanonicalDashboardSessionDetail,
  type CanonicalDashboardSessionSummary,
  type CanonicalLineageRelation,
  type CanonicalWorkspaceDirectory,
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
