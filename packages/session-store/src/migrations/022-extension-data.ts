export const MIGRATION_022 = `
CREATE TABLE extension_connections (
 instance_id TEXT NOT NULL, profile_id TEXT NOT NULL, namespace TEXT NOT NULL,
 plugin_version TEXT NOT NULL, writer_id TEXT NOT NULL,
 configured INTEGER NOT NULL CHECK(configured IN (0,1)), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 PRIMARY KEY(instance_id,profile_id,namespace)
) STRICT;
CREATE TABLE extension_objects (
 instance_id TEXT NOT NULL, profile_id TEXT NOT NULL, namespace TEXT NOT NULL, object_id TEXT NOT NULL,
 writer_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), schema_version INTEGER NOT NULL,
 title TEXT NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), updated_at TEXT NOT NULL,
 bytes INTEGER NOT NULL, digest TEXT NOT NULL, content_json TEXT NOT NULL,
 PRIMARY KEY(instance_id,profile_id,namespace,object_id)
) STRICT;
CREATE TABLE extension_conflicts (
 id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, profile_id TEXT NOT NULL, namespace TEXT NOT NULL,
 object_id TEXT NOT NULL, digest TEXT NOT NULL, conflict_json TEXT NOT NULL,
 UNIQUE(instance_id,profile_id,namespace,object_id,digest)
) STRICT;
CREATE INDEX extension_conflicts_scope ON extension_conflicts(instance_id,profile_id,namespace,object_id);
`;
