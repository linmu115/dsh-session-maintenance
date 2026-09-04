import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface InternalCodexReconcileResult {
  readonly requested: number;
  readonly matched: number;
  readonly alreadyTombstoned: number;
  readonly tombstoned: number;
  readonly checkpointId: string | null;
  readonly logicalSessionIds: readonly string[];
}

interface CandidateRow {
  readonly logical_session_id: string;
  readonly head_version_id: string | null;
  readonly tombstoned_at: string | null;
  readonly workspace_id: string | null;
  readonly membership_revision: number | null;
}

function transaction<T>(database: DatabaseSync, run: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the first failure */ }
    throw error;
  }
}

/**
 * Recoverably removes Codex implementation-detail threads from every DSH
 * projection. The Codex source is read-only and remains untouched.
 */
export function reconcileInternalCodexSessions(
  database: DatabaseSync,
  internalSessionIds: readonly string[],
  input: {
    readonly apply: boolean;
    readonly at: string;
    readonly retentionUntil: string;
  },
): InternalCodexReconcileResult {
  if (!Number.isFinite(Date.parse(input.at)) || Date.parse(input.retentionUntil) <= Date.parse(input.at)) {
    throw new TypeError("Internal Codex reconciliation requires a valid retention interval");
  }
  const activeRuns = database.prepare(
    `SELECT COUNT(*) AS count FROM projection_runs
      WHERE state IN ('preparing','running','draining','verifying','recovery-required','recovering')`,
  ).get() as { readonly count: number };
  if (input.apply && Number(activeRuns.count) !== 0) {
    throw new Error("Internal Codex reconciliation requires every projection run to be stopped");
  }

  const uniqueIds = [...new Set(internalSessionIds)].sort();
  const select = database.prepare(
    `SELECT b.logical_session_id, s.head_version_id, s.tombstoned_at,
            wm.workspace_id, wm.revision AS membership_revision
       FROM platform_bindings b
       JOIN logical_sessions s ON s.id = b.logical_session_id
       LEFT JOIN workspace_memberships wm ON wm.logical_session_id = s.id
      WHERE b.platform = 'codex' AND b.session_id = ?
        AND s.authority_scope = 'codex' AND s.origin_kind = 'codex-mirror'`,
  );
  const candidates = uniqueIds.flatMap((sessionId) => {
    const row = select.get(sessionId) as CandidateRow | undefined;
    return row === undefined ? [] : [row];
  });
  const active = candidates.filter((row) => row.tombstoned_at === null);
  const result = {
    requested: uniqueIds.length,
    matched: candidates.length,
    alreadyTombstoned: candidates.length - active.length,
    tombstoned: input.apply ? active.length : 0,
    checkpointId: null as string | null,
    logicalSessionIds: active.map((row) => row.logical_session_id),
  };
  if (!input.apply || active.length === 0) return result;

  return transaction(database, () => {
    const checkpointId = `checkpoint-codex-internal-${randomUUID()}`;
    const refs = Object.fromEntries(active.flatMap((row) =>
      row.head_version_id === null ? [] : [[`session:${row.logical_session_id}`, row.head_version_id]],
    ));
    database.prepare(
      `INSERT INTO checkpoints
        (id, name, description, refs_json, backup_transaction_ids_json, created_by, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?)`,
    ).run(
      checkpointId,
      "Codex 内部线程清理前 Checkpoint",
      `从 DSH 投影解除 ${active.length} 个 Codex Guardian/worker 内部线程`,
      JSON.stringify(refs),
      "codex-adapter-reconcile",
      input.at,
    );

    const tombstone = database.prepare(
      `INSERT INTO session_tombstones
        (logical_session_id, operation_id, checkpoint_id, previous_workspace_id,
         deleted_at, retention_until, restored_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    );
    const updateSession = database.prepare(
      "UPDATE logical_sessions SET tombstoned_at = ?, updated_at = ? WHERE id = ? AND tombstoned_at IS NULL",
    );
    const updateMembership = database.prepare(
      `INSERT INTO workspace_memberships
        (logical_session_id, workspace_id, display_order, pinned, archived, revision)
       VALUES (?, NULL, 0, 0, 1, ?)
       ON CONFLICT(logical_session_id) DO UPDATE SET workspace_id = NULL, display_order = 0,
         pinned = 0, archived = 1, revision = excluded.revision`,
    );
    const hideProjection = database.prepare(
      "UPDATE projection_sessions SET mode = 'hidden' WHERE logical_session_id = ?",
    );
    for (const row of active) {
      tombstone.run(
        row.logical_session_id,
        `operation-codex-internal-${randomUUID()}`,
        checkpointId,
        row.workspace_id,
        input.at,
        input.retentionUntil,
      );
      if (Number(updateSession.run(input.at, input.at, row.logical_session_id).changes) !== 1) {
        throw new Error(`Internal Codex session changed during reconciliation: ${row.logical_session_id}`);
      }
      updateMembership.run(row.logical_session_id, Number(row.membership_revision ?? 0) + 1);
      hideProjection.run(row.logical_session_id);
    }
    return { ...result, checkpointId };
  });
}
