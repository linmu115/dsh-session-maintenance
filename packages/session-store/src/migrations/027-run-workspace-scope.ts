export const MIGRATION_027 = `
CREATE TABLE projection_run_workspace_scopes (
  run_id TEXT PRIMARY KEY REFERENCES projection_runs(id),
  instance_id TEXT NOT NULL,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json))
) STRICT;
`;
