import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { pluginDataRecordSchema, type PluginDataRecord } from '@linmu/dsh-session-contracts';

/** Opaque snapshots and immutable revisions. No host layout or plugin business fields. */
export class SqlitePluginData {
  constructor(private readonly database: DatabaseSync) {}
  read(sessionId: string): PluginDataRecord[] {
    return (this.database.prepare('SELECT record_json FROM session_plugin_data WHERE session_id=? ORDER BY namespace,record_id')
      .all(sessionId) as { record_json: string }[]).map(row => pluginDataRecordSchema.parse(JSON.parse(row.record_json)));
  }
  pin(sessionId: string, versionId: string): void {
    this.database.prepare(`INSERT INTO session_plugin_data_heads SELECT session_id,?,namespace,record_id,digest FROM session_plugin_data WHERE session_id=?
      ON CONFLICT(session_id,version_id,namespace,record_id) DO UPDATE SET digest=excluded.digest`).run(versionId, sessionId);
  }
  readVersion(sessionId: string, versionId: string): PluginDataRecord[] {
    return (this.database.prepare(`SELECT v.record_json FROM session_plugin_data_heads h JOIN session_plugin_data_versions v
      ON v.session_id=h.session_id AND v.namespace=h.namespace AND v.record_id=h.record_id AND v.digest=h.digest
      WHERE h.session_id=? AND h.version_id=? ORDER BY h.namespace,h.record_id`).all(sessionId, versionId) as {record_json: string}[])
      .map(row => pluginDataRecordSchema.parse(JSON.parse(row.record_json)));
  }
  fork(parentSessionId: string, baseVersionId: string, childSessionId: string): void {
    this.retain(childSessionId, this.readVersion(parentSessionId, baseVersionId));
  }
  retain(sessionId: string, records: readonly PluginDataRecord[]): void {
    const validated = records.map(record => pluginDataRecordSchema.parse(record));
    const keys = validated.map(record => JSON.stringify([record.namespace, record.recordId]));
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate plugin record');
    this.database.exec('SAVEPOINT opaque_plugin_data');
    try {
      for (const record of validated) {
        const json = JSON.stringify(record), digest = createHash('sha256').update(json).digest('hex');
        this.database.prepare('INSERT OR IGNORE INTO session_plugin_data_versions VALUES (?,?,?,?,?,?)').run(sessionId, record.namespace, record.recordId, digest, json, new Date().toISOString());
        this.database.prepare(`INSERT INTO session_plugin_data VALUES (?,?,?,?,?) ON CONFLICT(session_id,namespace,record_id)
          DO UPDATE SET digest=excluded.digest,record_json=excluded.record_json`).run(sessionId, record.namespace, record.recordId, digest, json);
      }
      const head = this.database.prepare('SELECT head_version_id FROM logical_sessions WHERE id=?').get(sessionId)?.head_version_id;
      if (typeof head === 'string') this.pin(sessionId, head);
      this.database.exec('RELEASE opaque_plugin_data');
    } catch (error) { this.database.exec('ROLLBACK TO opaque_plugin_data; RELEASE opaque_plugin_data'); throw error; }
  }
}
