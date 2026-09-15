/** Rebuildable directory index only; extension bodies and object revisions are unchanged. */
export const MIGRATION_024 = `
CREATE TABLE extension_object_owners (
 instance_id TEXT NOT NULL, profile_id TEXT NOT NULL, namespace TEXT NOT NULL, object_id TEXT NOT NULL,
 object_revision INTEGER NOT NULL, extractor_version TEXT NOT NULL,
 owner_session_id TEXT, object_kind TEXT NOT NULL, parent_object_id TEXT,
 read_only INTEGER NOT NULL CHECK(read_only IN (0,1)), ownership_reason TEXT, canonical_reference_id TEXT,
 PRIMARY KEY(instance_id,profile_id,namespace,object_id)
) STRICT;
CREATE INDEX extension_object_owners_directory ON extension_object_owners(instance_id,profile_id,owner_session_id,namespace,object_id);
CREATE INDEX extension_object_owners_parent ON extension_object_owners(instance_id,profile_id,namespace,parent_object_id);
`;
