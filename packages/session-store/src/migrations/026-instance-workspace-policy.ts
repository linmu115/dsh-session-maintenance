export const MIGRATION_026 = `
CREATE TABLE instance_workspace_policies (
  instance_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
  updated_at TEXT NOT NULL
) STRICT;
`;
