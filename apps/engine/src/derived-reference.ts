/** A stale parent binding may move only to one verified descendant in the same run. */
export async function resolveDerivedReference(
  database: { prepare(sql: string): { all(...params: string[]): unknown[] } },
  runId: string, parentId: string,
  verify: (logicalSessionId: string, nativeSessionId: string) => Promise<boolean>,
): Promise<{ logicalSessionId: string; nativeSessionId: string } | undefined> {
  const candidates = database.prepare(`WITH RECURSIVE descendants(id) AS (
    SELECT child_session_id FROM session_derivations WHERE parent_session_id=?
    UNION SELECT d.child_session_id FROM session_derivations d JOIN descendants p ON d.parent_session_id=p.id
  ) SELECT DISTINCT ps.logical_session_id logicalSessionId,ps.native_session_id nativeSessionId
    FROM projection_sessions ps JOIN descendants d ON d.id=ps.logical_session_id
    JOIN logical_sessions s ON s.id=ps.logical_session_id
    WHERE ps.run_id=? AND ps.mode NOT IN ('hidden','recovery-only') AND s.tombstoned_at IS NULL
    AND s.archived_at IS NULL AND s.archived=0 LIMIT 33`).all(parentId, runId) as { logicalSessionId: string; nativeSessionId: string }[];
  if (candidates.length > 32) return undefined;
  let match: typeof candidates[number] | undefined;
  for (const candidate of candidates) {
    if (!await verify(candidate.logicalSessionId, candidate.nativeSessionId)) continue;
    if (match) return undefined; // Ambiguous descendants require explicit selection.
    match = candidate;
  }
  return match;
}
