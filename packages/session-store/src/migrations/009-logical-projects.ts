export const MIGRATION_009 = `
CREATE TABLE logical_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) > 0),
  source_platform TEXT NOT NULL CHECK (source_platform IN ('codex', 'maintenance')),
  source_project_id TEXT,
  sort_key TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX logical_projects_source_idx
  ON logical_projects(source_platform, source_project_id)
  WHERE source_project_id IS NOT NULL;

CREATE TABLE project_roots (
  project_id TEXT NOT NULL REFERENCES logical_projects(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  normalized_root_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (project_id, normalized_root_path),
  UNIQUE (project_id, ordinal)
) STRICT;

CREATE INDEX project_roots_normalized_idx
  ON project_roots(normalized_root_path, project_id);

CREATE TABLE project_memberships (
  logical_session_id TEXT PRIMARY KEY REFERENCES logical_sessions(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES logical_projects(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;

CREATE INDEX project_memberships_project_idx
  ON project_memberships(project_id, logical_session_id);
`;
