import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePluginData } from '../src/plugin-data.js';
import { MIGRATION_029 } from '../src/migrations/029-opaque-plugin-data.js';
it('keeps unknown JSON and revisions losslessly, retains absent plugins, and forks the pinned snapshot', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(MIGRATION_029); db.exec("CREATE TABLE logical_sessions (id TEXT, head_version_id TEXT); INSERT INTO logical_sessions VALUES ('source','v1'),('child','child-v1')");
    const store = new SqlitePluginData(db), record = { namespace: 'future-plugin', dataType: 'arbitrary', recordId: 'r', value: { nested: [null, true, 'unknown'], unrecognized: { x: 42 } } };
    store.retain('source', [record]); db.exec("UPDATE logical_sessions SET head_version_id='v2' WHERE id='source'");
    store.retain('source', [{ ...record, value: { newer: true } }]); store.retain('source', []);
    store.fork('source', 'v1', 'child'); expect(store.read('child')).toEqual([record]);
    expect(store.read('source')[0]!.value).toEqual({ newer: true });
    expect(() => store.retain('source', [record, record])).toThrow('Duplicate');
    expect(store.read('source')[0]!.value).toEqual({ newer: true });
    expect(db.prepare('SELECT COUNT(*) n FROM session_plugin_data_versions').get()!.n).toBe(3);
  } finally { db.close(); }
});
