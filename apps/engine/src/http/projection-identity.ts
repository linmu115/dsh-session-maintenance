import type { DatabaseSync } from "node:sqlite";

/** Exact run/native identity; never guess from titles or obsolete platform bindings. */
export function resolveProjectionSessionIdentity(database: DatabaseSync, runId: string, nativeSessionId: string) {
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
