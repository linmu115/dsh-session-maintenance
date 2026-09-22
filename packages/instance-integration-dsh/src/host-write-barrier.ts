import { AsyncLocalStorage } from 'node:async_hooks';

export interface HostWriteHandle { close(): Promise<void> }
export interface HostBarrierRuntime {
  sessions: { get(id: string): unknown; prepare(...args: any[]): any; enter(...args: any[]): any; flush(session: any): Promise<boolean> };
  sessionPersistence: { open(...args: any[]): Promise<any>; create(...args: any[]): Promise<any> };
}

/** Installed before admitting agents. Existing writers drain; no live session is forcibly detached. */
export class HostWriteBarrier {
  private readonly owner = new AsyncLocalStorage<{ ids: ReadonlySet<string>; active: boolean }>();
  private readonly reserved = new Set<string>();
  private readonly writers = new Map<string, number>();
  private readonly quarantine = new Set<string>();
  private readonly recovery = new Map<string, { ids: ReadonlySet<string>; finish: () => Promise<void> }>();
  private readonly patches: { verify(): void; restore(): void }[] = [];
  private disposed = false;
  constructor(private readonly runtime: HostBarrierRuntime, private readonly options: { timeoutMs?: number; pollMs?: number } = {}) {
    const patch = (target: any, name: string, wrap: (old: (...args: any[]) => any) => (...args: any[]) => any) => {
      if (typeof target[name] !== 'function') throw new Error(`HOST_BARRIER_UNSUPPORTED: ${name}`);
      const descriptor = Object.getOwnPropertyDescriptor(target, name), next = wrap(target[name].bind(target));
      Object.defineProperty(target, name, { configurable: true, writable: true, value: next });
      const verify = () => { if (Object.getOwnPropertyDescriptor(target, name)?.value !== next) throw new Error(`HOST_BARRIER_CHANGED: ${name}`); };
      this.patches.push({ verify, restore: () => { verify(); if (descriptor) Object.defineProperty(target, name, descriptor); else delete target[name]; } });
    };
    try {
      patch(runtime.sessions, 'prepare', old => (id, ...args) => { if (typeof id === 'string') this.admit(id); return old(id, ...args); });
      patch(runtime.sessions, 'enter', old => (session, ...args) => { this.admit(session.id); return old(session, ...args); });
      patch(runtime.sessionPersistence, 'open', old => (id, access, ...args) => access === 'write'
        ? this.track(id, () => old(id, access, ...args)) : old(id, access, ...args));
      patch(runtime.sessionPersistence, 'create', old => (header, ...args) => this.track(header.id, () => old(header, ...args)));
    } catch (error) { this.patches.reverse().forEach(patch => patch.restore()); throw error; }
  }
  private admit(id: string): void {
    if (this.disposed) throw new Error('HOST_BARRIER_DISPOSED');
    const owner = this.owner.getStore();
    if ((this.reserved.has(id) || this.quarantine.has(id)) && !(owner?.active && owner.ids.has(id))) throw new Error('DSH_BUSY: session is being synchronized');
  }
  private async track(id: string, open: () => Promise<any>) {
    this.admit(id);
    this.writers.set(id, (this.writers.get(id) ?? 0) + 1);
    let handle: any;
    try { handle = await open(); } catch (error) { this.writers.set(id, this.writers.get(id)! - 1); throw error; }
    const close = handle.close.bind(handle); let released = false;
    handle.close = async () => {
      await close(); // A failed close still owns its writer; never manufacture a release.
      if (!released) { released = true; this.writers.set(id, this.writers.get(id)! - 1); }
    };
    return handle;
  }
  async withAccess<T>(sessionIds: readonly string[], work: () => Promise<T>, refresh: () => Promise<void>, release: () => Promise<void> = async () => {}, protect: (work: () => Promise<T>) => Promise<T> = work => work()): Promise<T> {
    const ids = new Set(sessionIds);
    if (this.disposed || [...ids].some(id => this.reserved.has(id))) throw new Error('DSH_BUSY: another synchronization owns this scope');
    const recoveries = new Set([...ids].flatMap(id => this.recovery.get(id) ? [this.recovery.get(id)!] : []));
    if ([...recoveries].some(recovery => [...recovery.ids].some(id => !ids.has(id)))) throw new Error('HOST_RECOVERY_SCOPE_REQUIRED');
    this.patches.forEach(patch => patch.verify());
    ids.forEach(id => this.reserved.add(id));
    const owner = { ids, active: true };
    let entered = false;
    try {
      const deadline = Date.now() + (this.options.timeoutMs ?? 30_000);
      for (const id of ids) { const live = this.runtime.sessions.get(id); if (live && !await this.runtime.sessions.flush(live)) throw new Error('HOST_FLUSH_UNAVAILABLE'); }
      while ([...ids].some(id => this.runtime.sessions.get(id) !== undefined || (this.writers.get(id) ?? 0) > 0)) {
        if (Date.now() >= deadline) throw new Error('DSH_BUSY: existing sessions have not drained');
        await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 25));
      }
      // Plugin admission starts AFTER ordinary host flush listeners have finished. It remains held
      // through refresh and release, so neither flush deadlocks nor premature plugin writes occur.
      return await protect(() => this.owner.run(owner, async () => {
        entered = true;
        let mutated = false;
        try {
          this.patches.forEach(patch => patch.verify());
          for (const recovery of recoveries) {
            await recovery.finish();
            recovery.ids.forEach(id => { this.quarantine.delete(id); this.recovery.delete(id); });
          }
          mutated = true;
          return await work();
        } finally {
          try {
            try { if (mutated) await refresh(); }
            finally { await release(); }
          } catch (error) {
            const recovery = { ids, finish: async () => { try { await refresh(); } finally { await release(); } } };
            ids.forEach(id => { this.quarantine.add(id); this.recovery.set(id, recovery); });
            throw error;
          }
        }
      }));
    } finally {
      try { if (!entered) await release(); }
      finally { owner.active = false; ids.forEach(id => this.reserved.delete(id)); }
    }
  }

  dispose(): void {
    if (this.reserved.size || this.quarantine.size) throw new Error('HOST_BARRIER_BUSY: drain or recover before unloading');
    this.patches.forEach(patch => patch.verify());
    this.patches.reverse().forEach(patch => patch.restore()); this.disposed = true;
  }
}
