export const MIGRATION_020 = `
CREATE TABLE retention_batches (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  batch_json TEXT NOT NULL CHECK(json_valid(batch_json))
) STRICT;
`;
