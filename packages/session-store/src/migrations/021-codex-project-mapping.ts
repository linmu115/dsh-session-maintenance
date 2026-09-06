export const MIGRATION_021 = `
CREATE TABLE codex_project_mapping_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE codex_project_mapping_removals (
  logical_session_id TEXT PRIMARY KEY REFERENCES logical_sessions(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  workspace_json TEXT CHECK (workspace_json IS NULL OR json_valid(workspace_json))
) STRICT;
`;
