export const MIGRATION_023 = `
CREATE TABLE context_read_executions (
 execution_key TEXT PRIMARY KEY,
 run_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','closed')),
 used_bytes INTEGER NOT NULL CHECK(used_bytes >= 0),
 limit_bytes INTEGER NOT NULL CHECK(limit_bytes >= 0)
) STRICT, WITHOUT ROWID;
CREATE INDEX context_read_executions_run ON context_read_executions(run_id);
`;
