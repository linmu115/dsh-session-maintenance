export const MIGRATION_019 = `
CREATE TABLE retention_roots (
  id TEXT PRIMARY KEY,
  root_json TEXT NOT NULL CHECK(json_valid(root_json))
) STRICT;
CREATE TABLE retention_sources (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES retention_roots(id),
  object_root_id TEXT NOT NULL REFERENCES retention_roots(id),
  source_json TEXT NOT NULL CHECK(json_valid(source_json))
) STRICT;
CREATE TABLE retention_resources (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES retention_roots(id),
  resource_json TEXT NOT NULL CHECK(json_valid(resource_json))
) STRICT;
`;
