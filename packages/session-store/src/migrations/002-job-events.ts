export const MIGRATION_002 = `
CREATE TABLE job_events (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, sequence)
) STRICT;

CREATE INDEX job_events_created_idx ON job_events(job_id, created_at);
`;
