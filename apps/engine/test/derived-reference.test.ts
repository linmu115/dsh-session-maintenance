import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { resolveDerivedReference } from '../src/derived-reference.js';
it('recovers only a uniquely verified descendant in the same running projection', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE session_derivations(child_session_id TEXT,parent_session_id TEXT);
      CREATE TABLE projection_sessions(run_id TEXT,logical_session_id TEXT,native_session_id TEXT,mode TEXT);
      CREATE TABLE logical_sessions(id TEXT,tombstoned_at TEXT,archived_at TEXT,archived INTEGER);
      INSERT INTO session_derivations VALUES('child','parent'),('other','parent'),('foreign','parent');
      INSERT INTO logical_sessions VALUES('child',NULL,NULL,0),('other',NULL,NULL,0),('foreign',NULL,NULL,0);
      INSERT INTO projection_sessions VALUES('run','child','native-child','derived'),('run','other','native-other','derived'),('foreign-run','foreign','native-foreign','derived');`);
    expect(await resolveDerivedReference(db,'run','parent',async id => id==='child')).toEqual({logicalSessionId:'child',nativeSessionId:'native-child'});
    expect(await resolveDerivedReference(db,'run','parent',async () => true)).toBeUndefined();
    expect(await resolveDerivedReference(db,'run','parent',async () => false)).toBeUndefined();
    expect(await resolveDerivedReference(db,'run','unrelated',async () => true)).toBeUndefined();
  } finally { db.close(); }
});
