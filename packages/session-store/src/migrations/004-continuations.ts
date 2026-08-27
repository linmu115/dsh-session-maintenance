export const MIGRATION_004 = `
CREATE TABLE continuation_jobs (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id) ON DELETE CASCADE,
  source_version_ids_json TEXT NOT NULL,
  target_preset_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'checkpoint', 'structured-summary')),
  handoff_object_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'prepared', 'creating', 'started', 'verifying', 'completed', 'failed', 'manual-review'
  )),
  codex_thread_id TEXT UNIQUE,
  codex_turn_id TEXT,
  error_code TEXT,
  verification_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX continuation_jobs_status_idx ON continuation_jobs(status, updated_at);
CREATE INDEX continuation_jobs_logical_idx ON continuation_jobs(logical_session_id, created_at);
`;
