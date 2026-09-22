import { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { SessionProjectionCache } from '@deepseek-ai/dsh-session-projection-cache';

/** RC2's point observation restores the inherited prefix plus its appended tail.
 * readSession uses the fork constructor and rejects that same valid persisted log.
 * The observation also avoids a full corpus listing for each verification read.
 */
export async function readHostSession(query: Pick<SessionQueryEngine, 'observeSession'>, id: string) {
  const cut = await query.observeSession(SessionId(id), { projectionMode: 'none' });
  try { return { session: cut.header, inheritedEventCount: cut.inheritedEventCount, events: cut.events }; }
  finally { cut[Symbol.dispose](); }
}

/** Rebuild the durable cold-list projection, not only a disposable read lease. */
export async function refreshHostSession(query: Pick<SessionQueryEngine, 'observeSession'>,
  cache: Pick<SessionProjectionCache, 'hydratePrepared' | 'write'>, id: string) {
  const snapshot = await readHostSession(query, id);
  const session = Session.fromRestore(SessionId(id), structuredClone(snapshot.events) as never,
    snapshot.session, snapshot.inheritedEventCount, 'detached');
  cache.hydratePrepared(session, snapshot.events);
  await cache.write(session);
}
