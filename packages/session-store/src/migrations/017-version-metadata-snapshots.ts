export const MIGRATION_017 = `
CREATE TABLE version_metadata_snapshots (
  version_id TEXT PRIMARY KEY REFERENCES session_versions(id) ON DELETE CASCADE,
  metadata_json TEXT,
  availability TEXT NOT NULL CHECK (availability IN ('available', 'unknown')),
  provenance TEXT NOT NULL CHECK (provenance IN ('captured', 'reconstructed-current', 'reconstructed-body', 'unavailable')),
  first_persisted_at TEXT,
  CHECK ((availability = 'unknown' AND metadata_json IS NULL AND provenance = 'unavailable') OR
         (availability = 'available' AND metadata_json IS NOT NULL AND provenance <> 'unavailable' AND json_valid(metadata_json)))
) STRICT;

-- Old origin/observation dates do not prove when this installation first saved a version.
INSERT INTO version_metadata_snapshots (version_id, metadata_json, availability, provenance, first_persisted_at)
SELECT id, NULL, 'unknown', 'unavailable', NULL FROM session_versions;

-- All writers, including legacy imports, acquire a trusted local clock at actual insertion.
CREATE TRIGGER session_version_metadata_created AFTER INSERT ON session_versions BEGIN
  INSERT INTO version_metadata_snapshots (version_id, metadata_json, availability, provenance, first_persisted_at)
  VALUES (NEW.id, NULL, 'unknown', 'unavailable', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER version_metadata_immutable BEFORE UPDATE ON version_metadata_snapshots
WHEN (OLD.availability = 'available' AND
      (NEW.metadata_json IS NOT OLD.metadata_json OR NEW.availability IS NOT OLD.availability OR NEW.provenance IS NOT OLD.provenance))
  OR NEW.version_id IS NOT OLD.version_id OR NEW.first_persisted_at IS NOT OLD.first_persisted_at
BEGIN
  SELECT RAISE(ABORT, 'Version metadata snapshot is immutable');
END;
`;
