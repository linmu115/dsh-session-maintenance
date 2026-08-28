export const MIGRATION_006 = `
CREATE TABLE binding_workspaces (
  binding_id TEXT PRIMARY KEY REFERENCES platform_bindings(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL
) STRICT;

CREATE INDEX binding_workspaces_workspace_idx ON binding_workspaces(workspace_id);
`;
