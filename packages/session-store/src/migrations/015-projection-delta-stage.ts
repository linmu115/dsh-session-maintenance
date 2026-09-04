/** Adds delta-projection diagnostics and journals shared workspace/project definition changes. */
export const MIGRATION_015 = `
PRAGMA defer_foreign_keys = ON;

CREATE TRIGGER canonical_change_workspace_definition_update
AFTER UPDATE OF parent_id, name, sort_key, deleted_at ON logical_workspaces
WHEN OLD.parent_id IS NOT NEW.parent_id
 OR OLD.name IS NOT NEW.name
 OR OLD.sort_key IS NOT NEW.sort_key
 OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  SELECT logical_session_id, 'workspace-updated', NEW.updated_at
  FROM workspace_memberships
  WHERE workspace_id = NEW.id;
END;

CREATE TRIGGER canonical_change_project_definition_update
AFTER UPDATE OF name, source_platform, source_project_id, sort_key, deleted_at ON logical_projects
WHEN OLD.name IS NOT NEW.name
 OR OLD.source_platform IS NOT NEW.source_platform
 OR OLD.source_project_id IS NOT NEW.source_project_id
 OR OLD.sort_key IS NOT NEW.sort_key
 OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  SELECT logical_session_id, 'project-updated', NEW.updated_at
  FROM project_memberships
  WHERE project_id = NEW.id;
END;

CREATE TRIGGER canonical_change_project_root_insert
AFTER INSERT ON project_roots
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  SELECT logical_session_id, 'project-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM project_memberships
  WHERE project_id = NEW.project_id;
END;

CREATE TRIGGER canonical_change_project_root_update
AFTER UPDATE ON project_roots
WHEN OLD.project_id IS NOT NEW.project_id
 OR OLD.root_path IS NOT NEW.root_path
 OR OLD.normalized_root_path IS NOT NEW.normalized_root_path
 OR OLD.ordinal IS NOT NEW.ordinal
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  SELECT logical_session_id, 'project-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM project_memberships
  WHERE project_id IN (OLD.project_id, NEW.project_id);
END;

CREATE TRIGGER canonical_change_project_root_delete
AFTER DELETE ON project_roots
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  SELECT logical_session_id, 'project-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM project_memberships
  WHERE project_id = OLD.project_id;
END;

DROP INDEX run_status_events_time_idx;
DROP INDEX run_status_events_run_idx;
DROP INDEX run_status_events_logical_idx;
DROP INDEX run_status_events_operation_idx;
DROP INDEX run_status_events_stage_idx;
DROP INDEX run_status_events_span_idx;

ALTER TABLE run_status_events RENAME TO run_status_events_v14;

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
    'runtime.persistence.attach', 'runtime.event.received',
    'runtime.wal.durable', 'runtime.canonical.committed',
    'runtime.session.flush', 'session.append.commit',
    'session.derivation.create', 'projection.cross-version.verify',
    'reference.index', 'reference.roundtrip.verify',
    'run.shutdown-recovery', 'adapter.evidence'
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
FROM run_status_events_v14
ORDER BY sequence;

DROP TABLE run_status_events_v14;

CREATE INDEX run_status_events_time_idx ON run_status_events(at, id);
CREATE INDEX run_status_events_run_idx ON run_status_events(run_id, sequence);
CREATE INDEX run_status_events_logical_idx ON run_status_events(logical_session_id, at);
CREATE INDEX run_status_events_operation_idx ON run_status_events(operation_id, at);
CREATE INDEX run_status_events_stage_idx ON run_status_events(stage, at);
CREATE INDEX run_status_events_span_idx ON run_status_events(span_id, at, id);
`;
