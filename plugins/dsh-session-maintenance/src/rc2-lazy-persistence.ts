import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import type { RuntimeBrokerPluginClient } from './projection-runtime.js';
import type { LazyHydrationStage } from './lazy-persistence.js';

/** RC2 open hydrates before acquisition; list/stat remain lightweight snapshot reads. */
export function installRc2LazyProjectionPersistence(
  persistence: SessionPersistence,
  runtime: RuntimeBrokerPluginClient,
  status: (stage: LazyHydrationStage, id?: string, error?: unknown) => void = () => {},
): () => void {
  const names = ['open', 'list', 'stat'] as const;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(persistence, name)]));
  for (const name of names) if (typeof persistence[name] !== 'function') throw new Error(`RC2 persistence requires ${name}`);
  const open = persistence.open.bind(persistence), list = persistence.list.bind(persistence), stat = persistence.stat.bind(persistence);
  const pending = new Map<string, Promise<void>>();
  let disposed = false;
  const snapshots = () => new Map(runtime.sessionHeaders().map(value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('RC2 lazy catalog contains an invalid V3 header');
    const record = value as { readonly [key: string]: unknown };
    if (typeof record.id !== 'string' || record.version !== 3)
      throw new Error('RC2 lazy catalog contains an invalid V3 header');
    const header = structuredClone(value) as unknown as SessionPersistenceSnapshot['header'];
    return [header.id, { header, revision: `maintenance-cold:${JSON.stringify(header)}` as SessionPersistenceSnapshot['revision'] }];
  }));
  const hydrate = (id: string) => {
    let task = pending.get(id);
    if (task !== undefined) return task;
    status('lazy.borrow.request', id);
    task = runtime.hydrate(id).then(() => { status('lazy.materialize.commit', id); }, error => {
      status('lazy.materialize.failed', id, error); throw error;
    }).finally(() => pending.delete(id));
    pending.set(id, task); return task;
  };
  const replacements: Pick<SessionPersistence, 'open' | 'list' | 'stat'> = {
    async open(id, access, options) {
      if (disposed) throw new Error('Projection persistence has been detached');
      options?.signal?.throwIfAborted();
      if (runtime.coldSessionIds().includes(id)) await hydrate(id);
      if (disposed) throw new Error('Projection persistence detached during hydration');
      options?.signal?.throwIfAborted();
      return open(id, access, options);
    },
    async list(options) {
      const merged = snapshots();
      for (const row of await list(options)) merged.set(row.header.id, row);
      return [...merged.values()];
    },
    async stat(id: SessionId, options) {
      options?.signal?.throwIfAborted();
      const cold = runtime.coldSessionIds().includes(id) ? snapshots().get(id) : undefined;
      return cold ?? stat(id, options);
    },
  };
  for (const name of names) Object.defineProperty(persistence, name, { configurable: true, writable: true,
    enumerable: descriptors.get(name)?.enumerable ?? false, value: replacements[name] });
  status('lazy.catalog.ready');
  return () => {
    if (disposed) return; disposed = true;
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor === undefined) delete (persistence as unknown as Record<string, unknown>)[name];
      else Object.defineProperty(persistence, name, descriptor);
    }
  };
}
