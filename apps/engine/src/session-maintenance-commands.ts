import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CanonicalDashboardSessionDetail,
  CanonicalSessionMaintenancePatch,
  CanonicalSessionDeleteResult,
  CanonicalSessionRestoreResult,
  ProjectionRunRepository,
} from "@linmu/dsh-session-contracts";
import { advanceCanonicalSessionMetadata } from "@linmu/dsh-session-store";
import type { StatusLog } from "@linmu/dsh-session-status-log";
import type { SessionMaintenanceQueries } from "./session-maintenance-queries.js";

interface TombstoneRow {
  readonly logical_session_id: string;
  readonly operation_id: string;
  readonly checkpoint_id: string;
  readonly previous_workspace_id: string | null;
  readonly deleted_at: string;
  readonly retention_until: string;
  readonly restored_at: string | null;
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

/** Canonical maintenance commands own identity, state transitions and their receipts. */
export class SessionMaintenanceCommands {
  constructor(
    private readonly database: DatabaseSync,
    private readonly queries: SessionMaintenanceQueries,
    private readonly statusLog: StatusLog,
    private readonly runs: ProjectionRunRepository,
    private readonly clock: () => string,
  ) {
    if (queries.database !== database) throw new Error("Maintenance commands and queries must share one transaction connection");
  }

  async deleteProjectedSession(runId: string, nativeSessionId: string) {
    const run = await this.runs.getProjectionRun(runId as never);
    if (run === undefined) return undefined;
    const span = await this.statusLog.start({
      runId: run.id, leaseId: run.leaseId, profileId: run.profileId, adapterId: run.adapterId,
      dshVersion: run.dshVersion, stage: "run.shutdown-recovery", logicalSessionId: null,
      nativeSessionId: nativeSessionId as never, operationId: null, diagnosticDetailRef: "diag:session-delete",
    });
    // Logging may yield. Resolve the current identity only after it, inside the
    // same synchronous write transaction as pending-write/head checks and deletion.
    const receipt = transaction(this.database, () => {
      const resolution = this.queries.resolveProjectionSessionIdentity(runId, nativeSessionId);
      if (resolution === undefined) return undefined;
      const deletion = this.deleteWithinTransaction(resolution.logicalSessionId);
      return deletion === undefined ? undefined : { resolution, deletion };
    });
    if (receipt === undefined) {
      await this.statusLog.fail(span, { errorCode: "SESSION_NOT_MAPPED" });
    } else {
      await this.statusLog.succeed(span, { diagnosticDetailRef: `diag:session-delete:${receipt.deletion.logicalSessionId}:${receipt.deletion.state}` });
    }
    return receipt;
  }

  async deleteSession(logicalSessionId: string): Promise<CanonicalSessionDeleteResult | undefined> {
    const activeRows = this.database.prepare(
      `SELECT DISTINCT pr.id, pr.lease_id, pr.profile_id, pr.adapter_id, pr.dsh_version
       FROM projection_runs pr JOIN projection_sessions ps ON ps.run_id = pr.id
       WHERE ps.logical_session_id = ? AND pr.state IN ('preparing','running','draining','verifying','recovery-required','recovering')`,
    ).all(logicalSessionId) as unknown as Array<{ readonly id: string; readonly lease_id: string; readonly profile_id: string; readonly adapter_id: string; readonly dsh_version: string }>;
    const spans = [];
    for (const run of activeRows) spans.push(await this.statusLog.start({
      runId: run.id as never,
      leaseId: run.lease_id as never,
      profileId: run.profile_id,
      adapterId: run.adapter_id as never,
      dshVersion: run.dsh_version,
      stage: "run.shutdown-recovery",
      logicalSessionId: logicalSessionId as never,
      nativeSessionId: null,
      operationId: null,
      diagnosticDetailRef: "diag:session-delete",
    }));
    const result = transaction(this.database, () => this.deleteWithinTransaction(logicalSessionId));
    if (result === undefined) {
      for (const span of spans) await this.statusLog.fail(span, { errorCode: "SESSION_NOT_FOUND" });
    } else {
      for (const span of spans) {
        if (result.state === "pending-delete") await this.statusLog.fail(span, { errorCode: "DELETE_PENDING_WRITES", diagnosticDetailRef: "diag:session-delete-pending" });
        else await this.statusLog.succeed(span, { diagnosticDetailRef: "diag:session-delete-hidden" });
      }
    }
    return result;
  }

  async updateSession(
    logicalSessionId: string,
    patch: CanonicalSessionMaintenancePatch,
  ): Promise<CanonicalDashboardSessionDetail | undefined> {
    const database = this.database;
    const at = this.clock();
    const updated = transaction(database, () => {
      const exists = database.prepare("SELECT id FROM logical_sessions WHERE id = ? AND authority_scope IS NOT NULL").get(logicalSessionId);
      if (exists === undefined) return undefined;
      if (patch.title !== undefined || patch.tags !== undefined || patch.archived !== undefined) {
        advanceCanonicalSessionMetadata(database, { logicalSessionId, patch, appliedAt: at });
      }
      if (patch.workspaceId !== undefined || patch.displayOrder !== undefined || patch.pinned !== undefined || patch.archived !== undefined) {
        const current = this.queries.workspaceMembership(logicalSessionId);
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
      return true;
    });
    if (!updated) return undefined;
    return this.queries.readCanonicalDashboardSession(logicalSessionId);
  }

  deleteWorkspace(workspaceId: string): boolean {
    const database = this.database;
    const at = this.clock();
    return transaction(database, () => {
      const result = database.prepare("UPDATE logical_workspaces SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, at, workspaceId);
      if (Number(result.changes) === 0) return false;
      database.prepare("UPDATE workspace_memberships SET workspace_id = NULL, revision = revision + 1 WHERE workspace_id = ?").run(workspaceId);
      database.prepare("UPDATE logical_workspaces SET parent_id = NULL, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL").run(at, workspaceId);
      return true;
    });
  }

  private deleteWithinTransaction(
    logicalSessionId: string,
  ): CanonicalSessionDeleteResult | undefined {
    const database = this.database;
    const at = this.clock();
    const retentionUntil = new Date(Date.parse(at) + 30 * 24 * 60 * 60 * 1000).toISOString();
    const row = database.prepare("SELECT head_version_id FROM logical_sessions WHERE id = ? AND authority_scope IS NOT NULL").get(logicalSessionId) as { readonly head_version_id: string | null } | undefined;
    if (row === undefined) return undefined;
    const pending = this.queries.pendingOperations(logicalSessionId);
    if (pending > 0) {
      database.prepare("UPDATE logical_sessions SET tombstoned_at = ?, updated_at = ? WHERE id = ?").run(at, at, logicalSessionId);
      database.prepare(
        `UPDATE projection_sessions SET mode = 'recovery-only' WHERE logical_session_id = ?
         AND run_id IN (SELECT id FROM projection_runs WHERE state IN ('preparing','running','draining','verifying','recovery-required','recovering'))`,
      ).run(logicalSessionId);
      return { logicalSessionId, state: "pending-delete", checkpointId: null, pendingOperations: pending };
    }
    const existing = database.prepare("SELECT checkpoint_id FROM session_tombstones WHERE logical_session_id = ? AND restored_at IS NULL").get(logicalSessionId) as { readonly checkpoint_id: string } | undefined;
    if (existing !== undefined) return { logicalSessionId, state: "deleted", checkpointId: existing.checkpoint_id, pendingOperations: 0 };
    const membership = this.queries.workspaceMembership(logicalSessionId);
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
  }

  restoreSession(
    logicalSessionId: string,
  ): CanonicalSessionRestoreResult | undefined {
    const database = this.database;
    const at = this.clock();
    return transaction(database, () => {
      const session = database.prepare("SELECT authority_scope, tombstoned_at, archived_at FROM logical_sessions WHERE id = ?").get(logicalSessionId) as { readonly authority_scope: "codex" | "maintenance" | null; readonly tombstoned_at: string | null; readonly archived_at: string | null } | undefined;
      if (session === undefined || session.tombstoned_at === null) return undefined;
      const tombstone = database.prepare(
        `SELECT logical_session_id, operation_id, checkpoint_id, previous_workspace_id, deleted_at, retention_until, restored_at
         FROM session_tombstones WHERE logical_session_id = ?`,
      ).get(logicalSessionId) as TombstoneRow | undefined;
      const current = this.queries.workspaceMembership(logicalSessionId);
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

}
