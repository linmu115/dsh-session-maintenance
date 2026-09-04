export const MIGRATION_008 = `
CREATE TABLE adapter_registrations (
  adapter_id TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL,
  package_location TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE adapter_verification_runs (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL REFERENCES adapter_registrations(adapter_id) ON DELETE CASCADE,
  dsh_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'compatible', 'experimental', 'failed')),
  result_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE projection_runs (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE,
  branch_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  dsh_version TEXT NOT NULL,
  adapter_id TEXT NOT NULL REFERENCES adapter_registrations(adapter_id),
  state TEXT NOT NULL CHECK (state IN (
    'preparing', 'running', 'draining', 'verifying', 'closed',
    'recovery-required', 'recovering', 'recovered', 'quarantined', 'cleanup-pending'
  )),
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  checkpoint_id TEXT REFERENCES checkpoints(id)
) STRICT;

CREATE UNIQUE INDEX projection_runs_active_writer_branch_idx
  ON projection_runs(branch_id)
  WHERE state IN (
    'preparing', 'running', 'draining', 'verifying',
    'recovery-required', 'recovering', 'cleanup-pending'
  );

CREATE TABLE projection_sessions (
  run_id TEXT NOT NULL REFERENCES projection_runs(id) ON DELETE CASCADE,
  native_session_id TEXT NOT NULL,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id),
  base_version_id TEXT REFERENCES session_versions(id),
  mode TEXT NOT NULL CHECK (mode IN (
    'maintenance-write', 'codex-read-until-write', 'hidden', 'recovery-only'
  )),
  native_revision INTEGER NOT NULL CHECK (native_revision >= 0),
  last_committed_operation_id TEXT,
  derived_child_session_id TEXT REFERENCES logical_sessions(id),
  PRIMARY KEY (run_id, native_session_id),
  UNIQUE (run_id, logical_session_id)
) STRICT;

CREATE TABLE projection_workspaces (
  run_id TEXT NOT NULL REFERENCES projection_runs(id) ON DELETE CASCADE,
  logical_workspace_id TEXT NOT NULL REFERENCES logical_workspaces(id),
  native_workspace_id TEXT NOT NULL,
  native_revision INTEGER NOT NULL CHECK (native_revision >= 0),
  PRIMARY KEY (run_id, logical_workspace_id),
  UNIQUE (run_id, native_workspace_id)
) STRICT;

CREATE TABLE run_operations (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES projection_runs(id) ON DELETE CASCADE,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id),
  native_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'failed', 'quarantined')),
  canonical_version_id TEXT REFERENCES session_versions(id),
  projection_revision INTEGER NOT NULL CHECK (projection_revision >= 0),
  committed_at TEXT,
  receipt_json TEXT NOT NULL,
  FOREIGN KEY (run_id, native_session_id)
    REFERENCES projection_sessions(run_id, native_session_id)
) STRICT;

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
    'run.lease', 'projection.materialize', 'runtime.persistence.attach',
    'session.append.commit', 'session.derivation.create',
    'projection.cross-version.verify', 'reference.roundtrip.verify',
    'run.shutdown-recovery'
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

CREATE INDEX adapter_verification_runs_adapter_idx
  ON adapter_verification_runs(adapter_id, started_at DESC);
CREATE INDEX projection_sessions_logical_idx
  ON projection_sessions(logical_session_id, run_id);
CREATE INDEX run_operations_run_idx
  ON run_operations(run_id, logical_session_id, operation_id);
CREATE INDEX run_status_events_time_idx
  ON run_status_events(at, id);
CREATE INDEX run_status_events_run_idx
  ON run_status_events(run_id, sequence);
CREATE INDEX run_status_events_logical_idx
  ON run_status_events(logical_session_id, at);
CREATE INDEX run_status_events_operation_idx
  ON run_status_events(operation_id, at);
CREATE INDEX run_status_events_stage_idx
  ON run_status_events(stage, at);
CREATE INDEX run_status_events_span_idx
  ON run_status_events(span_id, at, id);
`;
