export const MAINTENANCE_SCHEMA_VERSION = 6 as const;

export const MIGRATION_001 = `
CREATE TABLE logical_sessions (
  id TEXT PRIMARY KEY,
  display_title TEXT NOT NULL,
  canonical_version_id TEXT REFERENCES session_versions(id),
  sync_mode TEXT NOT NULL CHECK (sync_mode IN ('continuation', 'native-mirror', 'paused')),
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  labels_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE session_versions (
  id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id) ON DELETE CASCADE,
  body_object TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE version_parents (
  version_id TEXT NOT NULL REFERENCES session_versions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal IN (0, 1)),
  parent_id TEXT NOT NULL REFERENCES session_versions(id),
  PRIMARY KEY (version_id, ordinal),
  UNIQUE (version_id, parent_id)
) STRICT;

CREATE TABLE platform_bindings (
  id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('codex', 'dsh')),
  instance_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  adapter_contract_json TEXT NOT NULL,
  last_common_version_id TEXT REFERENCES session_versions(id),
  status TEXT NOT NULL CHECK (status IN ('read-only', 'writable', 'busy', 'incompatible')),
  UNIQUE (platform, instance_id, session_id)
) STRICT;

CREATE TABLE platform_refs (
  binding_id TEXT PRIMARY KEY REFERENCES platform_bindings(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES session_versions(id),
  observed_at TEXT NOT NULL,
  fingerprint_json TEXT NOT NULL
) STRICT;

CREATE TABLE sync_plans (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE scan_cursors (
  instance_id TEXT PRIMARY KEY,
  cursor_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE match_candidates (
  id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id) ON DELETE CASCADE,
  left_binding_id TEXT NOT NULL REFERENCES platform_bindings(id) ON DELETE CASCADE,
  right_key_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'low', 'conflict')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  backup_transaction_ids_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  request_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX session_versions_logical_idx ON session_versions(logical_session_id);
CREATE INDEX version_parents_parent_idx ON version_parents(parent_id);
CREATE INDEX platform_bindings_logical_idx ON platform_bindings(logical_session_id);
CREATE INDEX match_candidates_logical_idx ON match_candidates(logical_session_id);
`;
