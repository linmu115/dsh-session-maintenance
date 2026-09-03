/** Adds the terminal diagnostic emitted after a retained cache is refreshed. */
export const MIGRATION_016 = `
PRAGMA defer_foreign_keys = ON;

DROP INDEX run_status_events_time_idx;
DROP INDEX run_status_events_run_idx;
DROP INDEX run_status_events_logical_idx;
DROP INDEX run_status_events_operation_idx;
DROP INDEX run_status_events_stage_idx;
DROP INDEX run_status_events_span_idx;

ALTER TABLE run_status_events RENAME TO run_status_events_v15;

CREATE TABLE run_status_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES projection_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  at TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  dsh_version TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'run.lease', 'projection.materialize', 'projection.delta-apply',
    'projection.cache-retained', 'runtime.persistence.attach',
    'runtime.event.received', 'runtime.wal.durable',
    'runtime.canonical.committed', 'runtime.session.flush',
    'session.append.commit', 'session.derivation.create',
    'projection.cross-version.verify', 'reference.index',
    'reference.roundtrip.verify', 'run.shutdown-recovery', 'adapter.evidence'
  )),
  state TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed')),
  logical_session_id TEXT REFERENCES logical_sessions(id),
  native_session_id TEXT,
  operation_id TEXT,
  parent_event_id TEXT REFERENCES run_status_events(id),
  span_id TEXT NOT NULL,
  error_code TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  diagnostic_detail_ref TEXT,
  event_json TEXT NOT NULL,
  UNIQUE (run_id, sequence)
) STRICT;

INSERT INTO run_status_events (
  id, run_id, sequence, at, lease_id, profile_id, adapter_id, dsh_version,
  stage, state, logical_session_id, native_session_id, operation_id,
  parent_event_id, span_id, error_code, duration_ms, diagnostic_detail_ref,
  event_json
)
SELECT
  id, run_id, sequence, at, lease_id, profile_id, adapter_id, dsh_version,
  stage, state, logical_session_id, native_session_id, operation_id,
  parent_event_id, span_id, error_code, duration_ms, diagnostic_detail_ref,
  event_json
FROM run_status_events_v15
ORDER BY sequence;

DROP TABLE run_status_events_v15;

CREATE INDEX run_status_events_time_idx ON run_status_events(at, id);
CREATE INDEX run_status_events_run_idx ON run_status_events(run_id, sequence);
CREATE INDEX run_status_events_logical_idx ON run_status_events(logical_session_id, at);
CREATE INDEX run_status_events_operation_idx ON run_status_events(operation_id, at);
CREATE INDEX run_status_events_stage_idx ON run_status_events(stage, at);
CREATE INDEX run_status_events_span_idx ON run_status_events(span_id, at, id);
`;
