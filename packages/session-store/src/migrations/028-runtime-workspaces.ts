export const MIGRATION_028 = `
ALTER TABLE projection_run_workspace_scopes ADD COLUMN cache_revision INTEGER;

CREATE TABLE runtime_workspace_bindings (
  instance_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES logical_projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES logical_workspaces(id) ON DELETE CASCADE,
  PRIMARY KEY (instance_id, project_id)
) STRICT;

CREATE TABLE runtime_workspace_registrations (
  run_id TEXT NOT NULL REFERENCES projection_runs(id) ON DELETE CASCADE,
  native_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES logical_projects(id),
  workspace_id TEXT NOT NULL REFERENCES logical_workspaces(id),
  requested_workspace_id TEXT,
  PRIMARY KEY (run_id, native_session_id)
) STRICT;
`;
