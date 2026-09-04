export const MIGRATION_007 = `
ALTER TABLE logical_sessions ADD COLUMN authority_scope TEXT
  CHECK (authority_scope IN ('codex', 'maintenance'));
ALTER TABLE logical_sessions ADD COLUMN origin_kind TEXT
  CHECK (origin_kind IN ('codex-mirror', 'maintenance-native', 'codex-derived'));
ALTER TABLE logical_sessions ADD COLUMN head_version_id TEXT REFERENCES session_versions(id);
ALTER TABLE logical_sessions ADD COLUMN archived_at TEXT;
ALTER TABLE logical_sessions ADD COLUMN tombstoned_at TEXT;
ALTER TABLE logical_sessions ADD COLUMN updated_at TEXT;

UPDATE logical_sessions
SET head_version_id = canonical_version_id,
    archived_at = CASE WHEN archived = 1 THEN created_at ELSE NULL END,
    updated_at = created_at;

CREATE TABLE canonical_events (
  id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'user-message', 'assistant-message', 'system-message', 'reasoning',
    'tool-call', 'tool-result', 'annotation', 'sticker', 'obsidian-reference',
    'attachment', 'system-metadata', 'opaque-unknown'
  )),
  content_digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE (logical_session_id, sequence)
) STRICT;

CREATE TABLE session_derivations (
  child_session_id TEXT PRIMARY KEY REFERENCES logical_sessions(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL REFERENCES logical_sessions(id),
  base_version_id TEXT NOT NULL REFERENCES session_versions(id),
  derivation_kind TEXT NOT NULL CHECK (derivation_kind IN ('dsh-continuation')),
  trigger_run_id TEXT NOT NULL,
  trigger_operation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK (child_session_id <> parent_session_id)
) STRICT;

CREATE TRIGGER session_derivations_source_guard
BEFORE INSERT ON session_derivations
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM session_versions
      WHERE id = NEW.base_version_id AND logical_session_id = NEW.parent_session_id
    )
    THEN RAISE(ABORT, 'derivation base version must belong to parent session')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM logical_sessions
      WHERE id = NEW.child_session_id
        AND authority_scope = 'maintenance'
        AND origin_kind = 'codex-derived'
    )
    THEN RAISE(ABORT, 'derivation child must be a maintenance codex-derived session')
  END;
END;

CREATE TRIGGER session_derivations_immutable
BEFORE UPDATE ON session_derivations
BEGIN
  SELECT RAISE(ABORT, 'session derivations are immutable');
END;

CREATE TABLE logical_workspaces (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES logical_workspaces(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(name) > 0),
  sort_key TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE TABLE workspace_memberships (
  logical_session_id TEXT PRIMARY KEY REFERENCES logical_sessions(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES logical_workspaces(id) ON DELETE SET NULL,
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;

CREATE TABLE session_aliases (
  alias_kind TEXT NOT NULL CHECK (alias_kind IN ('dsh-session', 'dsh-workspace', 'legacy-reference')),
  instance_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  logical_session_id TEXT REFERENCES logical_sessions(id) ON DELETE CASCADE,
  logical_workspace_id TEXT REFERENCES logical_workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (alias_kind, instance_id, native_id),
  CHECK ((logical_session_id IS NOT NULL) <> (logical_workspace_id IS NOT NULL))
) STRICT;

CREATE TABLE session_tombstones (
  logical_session_id TEXT PRIMARY KEY REFERENCES logical_sessions(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
  previous_workspace_id TEXT REFERENCES logical_workspaces(id) ON DELETE SET NULL,
  deleted_at TEXT NOT NULL,
  retention_until TEXT NOT NULL,
  restored_at TEXT
) STRICT;

CREATE INDEX canonical_events_session_sequence_idx
  ON canonical_events(logical_session_id, sequence);
CREATE INDEX session_derivations_parent_idx
  ON session_derivations(parent_session_id, created_at);
CREATE INDEX logical_workspaces_parent_sort_idx
  ON logical_workspaces(parent_id, sort_key, id);
CREATE INDEX workspace_memberships_workspace_order_idx
  ON workspace_memberships(workspace_id, display_order, logical_session_id);
CREATE INDEX session_aliases_session_idx
  ON session_aliases(logical_session_id);
CREATE INDEX session_aliases_workspace_idx
  ON session_aliases(logical_workspace_id);
`;
