/** Adds the MCSF v1 `other` intersection fallback without rewriting legacy rows. */
export const MIGRATION_011 = `
PRAGMA defer_foreign_keys = ON;

ALTER TABLE canonical_events RENAME TO canonical_events_v10;

CREATE TABLE canonical_events (
  id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'user-message', 'assistant-message', 'system-message', 'reasoning',
    'tool-call', 'tool-result', 'annotation', 'sticker', 'obsidian-reference',
    'attachment', 'system-metadata', 'other', 'opaque-unknown'
  )),
  content_digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE (logical_session_id, sequence)
) STRICT;

INSERT INTO canonical_events (
  id, logical_session_id, sequence, kind, content_digest, event_json
)
SELECT id, logical_session_id, sequence, kind, content_digest, event_json
FROM canonical_events_v10
ORDER BY logical_session_id, sequence;

DROP TABLE canonical_events_v10;

CREATE INDEX canonical_events_session_sequence_idx
  ON canonical_events(logical_session_id, sequence);
`;
