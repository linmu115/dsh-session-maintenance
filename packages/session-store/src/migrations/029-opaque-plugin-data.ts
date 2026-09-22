export const MIGRATION_029 = `CREATE TABLE IF NOT EXISTS session_plugin_data (
      session_id TEXT NOT NULL, namespace TEXT NOT NULL, record_id TEXT NOT NULL, digest TEXT NOT NULL,
      record_json TEXT NOT NULL, PRIMARY KEY(session_id,namespace,record_id));
      CREATE TABLE IF NOT EXISTS session_plugin_data_versions (
      session_id TEXT NOT NULL, namespace TEXT NOT NULL, record_id TEXT NOT NULL, digest TEXT NOT NULL,
      record_json TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(session_id,namespace,record_id,digest));
CREATE TABLE IF NOT EXISTS session_plugin_data_heads (session_id TEXT NOT NULL, version_id TEXT NOT NULL, namespace TEXT NOT NULL, record_id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(session_id,version_id,namespace,record_id));`;
