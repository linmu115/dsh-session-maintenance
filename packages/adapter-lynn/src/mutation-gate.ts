import { AsyncLocalStorage } from 'node:async_hooks';
/** Plugin-owned mutation admission, including asynchronous writes queued before the barrier. */
export class PluginMutationGate {
  private readonly owner = new AsyncLocalStorage<{ active: boolean; ids: ReadonlySet<string> }>();
  private reserved = new Set<string>();
  private quarantine = new Set<string>();
  private pending = new Map<Promise<unknown>, string>();
  instrument(target: any, method: string): () => void {
    if (typeof target?.[method] !== 'function') throw new Error(`Lynn: unsupported mutation port ${method}`);
    const descriptor = Object.getOwnPropertyDescriptor(target, method), old = target[method].bind(target);
    const next = (...args: any[]) => {
      const id = method === 'ready' ? args[1] ?? '' : typeof args[0] === 'string' ? args[0] : args[0]?.sessionId ?? args[0]?.document?.sessionId ?? '';
      const owner = this.owner.getStore();
      if ((this.reserved.has(id) || this.quarantine.has(id) || !id && (this.reserved.size || this.quarantine.size))
        && !(owner?.active && (owner.ids.has(id) || !id))) return Promise.reject(new Error('LYNN_BUSY: plugin data is being synchronized'));
      const work = Promise.resolve().then(() => old(...args)); this.pending.set(work, id);
      void work.finally(() => this.pending.delete(work)).catch(() => {}); return work;
    };
    Object.defineProperty(target, method, { configurable: true, writable: true, value: next });
    return () => { if (Object.getOwnPropertyDescriptor(target, method)?.value === next) {
      if (descriptor) Object.defineProperty(target, method, descriptor); else delete target[method];
    } };
  }
  async exclusive<T>(sessionIds: readonly string[], work: () => Promise<T>): Promise<T> {
    const ids = new Set(sessionIds);
    if ([...ids].some(id => this.reserved.has(id))) throw new Error('LYNN_BUSY: another plugin synchronization is active');
    ids.forEach(id => this.reserved.add(id)); const owner = { active: true, ids };
    try {
      await Promise.allSettled([...this.pending].filter(([, id]) => !id || ids.has(id)).map(([work]) => work));
      const result = await this.owner.run(owner, work); ids.forEach(id => this.quarantine.delete(id)); return result;
    } catch (error) { ids.forEach(id => this.quarantine.add(id)); throw error; }
    finally { owner.active = false; ids.forEach(id => this.reserved.delete(id)); }
  }
}
