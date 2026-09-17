export const MIGRATION_025 = `
CREATE TABLE learning_bindings (
 id TEXT PRIMARY KEY,
 logical_session_id TEXT NOT NULL UNIQUE REFERENCES logical_sessions(id),
 codex_instance_id TEXT NOT NULL,
 codex_thread_id TEXT NOT NULL,
 data_json TEXT NOT NULL,
 body_revision INTEGER NOT NULL DEFAULT 0,
 UNIQUE(codex_instance_id,codex_thread_id)
) STRICT;
CREATE TABLE learning_handoffs (
 id TEXT PRIMARY KEY,
 binding_id TEXT NOT NULL REFERENCES learning_bindings(id),
 data_json TEXT NOT NULL,
 created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER learning_body_revision AFTER UPDATE OF head_version_id,archived_at,tombstoned_at ON logical_sessions
WHEN (SELECT body_hash FROM session_versions WHERE id=OLD.head_version_id)
  IS NOT (SELECT body_hash FROM session_versions WHERE id=NEW.head_version_id)
 OR OLD.archived_at IS NOT NEW.archived_at OR OLD.tombstoned_at IS NOT NEW.tombstoned_at
BEGIN
 UPDATE learning_bindings SET body_revision=body_revision+1 WHERE logical_session_id=NEW.id;
END;
`;
