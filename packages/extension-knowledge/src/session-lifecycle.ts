import type { DatabaseSync } from 'node:sqlite';
import type { ExtensionDataAdapter, SessionLifecycleAdapter, SessionLifecycleState } from '@linmu/dsh-session-contracts';
import { SessionGraphStore } from './session-graph-store.js';

/** Graph/archive coupling belongs to the business adapter and can be omitted entirely. */
export function knowledgeLifecycleAdapters(database: DatabaseSync, enabled: readonly ExtensionDataAdapter[]): readonly SessionLifecycleAdapter[] {
  if (!enabled.some(adapter => adapter.namespace === 'thoughtdag')) return [];
  const store = new SessionGraphStore(database);
  const reconcile = (state: SessionLifecycleState) => {
    if (!state.deleted) store.reconcileSessionArchive(state.logicalSessionId, state.archivedAt);
  };
  return [{ id: 'knowledge-session-lifecycle', sessionChanged: reconcile,
    initialize: sessions => {
      const archivedOwners = new Set((database.prepare(`SELECT DISTINCT json_extract(content_json,'$.body.ownerSessionId') AS id
        FROM extension_objects WHERE namespace='thoughtdag' AND json_extract(content_json,'$.body.archivedAt') IS NOT NULL`)
        .all() as { id: string | null }[]).flatMap(row => row.id === null ? [] : [row.id]));
      for (const state of sessions) if (state.archivedAt !== null || archivedOwners.has(state.logicalSessionId)) reconcile(state);
    } }];
}
