/**
 * Adds the lightweight MCSF change journal used by persistent native
 * projections. Rows contain identity and change class only; session bodies stay
 * in the canonical object store.
 */
export const MIGRATION_012 = `
CREATE TABLE canonical_change_log (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  logical_session_id TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN (
    'session-created', 'content-updated', 'metadata-updated',
    'workspace-updated', 'project-updated', 'branch-created',
    'tombstone-updated'
  )),
  changed_at TEXT NOT NULL
) STRICT;

CREATE INDEX canonical_change_log_session_revision_idx
  ON canonical_change_log(logical_session_id, revision);

-- Existing canonical sessions form the revision-zero baseline for a new
-- projection cache. This is one lightweight row per session, never per event.
INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
SELECT id, 'session-created', COALESCE(updated_at, created_at)
FROM logical_sessions
WHERE authority_scope IS NOT NULL AND origin_kind IS NOT NULL
ORDER BY COALESCE(updated_at, created_at), id;

CREATE TRIGGER canonical_change_session_insert
AFTER INSERT ON logical_sessions
WHEN NEW.authority_scope IS NOT NULL AND NEW.origin_kind IS NOT NULL
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.id, 'session-created', COALESCE(NEW.updated_at, NEW.created_at));
END;

CREATE TRIGGER canonical_change_session_content
AFTER UPDATE OF head_version_id ON logical_sessions
WHEN NEW.authority_scope IS NOT NULL
 AND OLD.head_version_id IS NOT NEW.head_version_id
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.id, 'content-updated', COALESCE(NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

CREATE TRIGGER canonical_change_session_metadata
AFTER UPDATE OF display_title, labels_json, archived_at, authority_scope, origin_kind ON logical_sessions
WHEN NEW.authority_scope IS NOT NULL
 AND (
   OLD.display_title IS NOT NEW.display_title
   OR OLD.labels_json IS NOT NEW.labels_json
   OR OLD.archived_at IS NOT NEW.archived_at
   OR OLD.authority_scope IS NOT NEW.authority_scope
   OR OLD.origin_kind IS NOT NEW.origin_kind
 )
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.id, 'metadata-updated', COALESCE(NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

CREATE TRIGGER canonical_change_session_tombstone
AFTER UPDATE OF tombstoned_at ON logical_sessions
WHEN NEW.authority_scope IS NOT NULL
 AND OLD.tombstoned_at IS NOT NEW.tombstoned_at
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.id, 'tombstone-updated', COALESCE(NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

CREATE TRIGGER canonical_change_workspace_insert
AFTER INSERT ON workspace_memberships
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.logical_session_id, 'workspace-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER canonical_change_workspace_update
AFTER UPDATE ON workspace_memberships
WHEN OLD.workspace_id IS NOT NEW.workspace_id
 OR OLD.display_order IS NOT NEW.display_order
 OR OLD.pinned IS NOT NEW.pinned
 OR OLD.archived IS NOT NEW.archived
 OR OLD.revision IS NOT NEW.revision
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.logical_session_id, 'workspace-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER canonical_change_workspace_delete
AFTER DELETE ON workspace_memberships
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (OLD.logical_session_id, 'workspace-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER canonical_change_project_insert
AFTER INSERT ON project_memberships
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.logical_session_id, 'project-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER canonical_change_project_update
AFTER UPDATE ON project_memberships
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.revision IS NOT NEW.revision
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.logical_session_id, 'project-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER canonical_change_project_delete
AFTER DELETE ON project_memberships
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (OLD.logical_session_id, 'project-updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER canonical_change_derivation_insert
AFTER INSERT ON session_derivations
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.child_session_id, 'branch-created', NEW.created_at);
END;

CREATE TRIGGER canonical_change_tombstone_insert
AFTER INSERT ON session_tombstones
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.logical_session_id, 'tombstone-updated', NEW.deleted_at);
END;

CREATE TRIGGER canonical_change_tombstone_update
AFTER UPDATE ON session_tombstones
WHEN OLD.operation_id IS NOT NEW.operation_id
 OR OLD.checkpoint_id IS NOT NEW.checkpoint_id
 OR OLD.previous_workspace_id IS NOT NEW.previous_workspace_id
 OR OLD.deleted_at IS NOT NEW.deleted_at
 OR OLD.retention_until IS NOT NEW.retention_until
 OR OLD.restored_at IS NOT NEW.restored_at
BEGIN
  INSERT INTO canonical_change_log (logical_session_id, change_kind, changed_at)
  VALUES (NEW.logical_session_id, 'tombstone-updated', COALESCE(NEW.restored_at, NEW.deleted_at));
END;
`;
