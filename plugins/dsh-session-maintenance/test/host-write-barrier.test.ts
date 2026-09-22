import { expect, it, vi } from 'vitest';
import { HostWriteBarrier } from '@linmu/dsh-instance-integration-dsh/host-write-barrier';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(timeoutMs = 100) {
  const live = new Map<string, unknown>(), trace: string[] = [];
  const runtime = { sessions: { get: (id: string) => live.get(id), prepare: (id: string) => ({ id }), enter: (session: { id: string }) => live.set(session.id, session),
    flush: async () => { trace.push('flush'); return true; } },
    sessionPersistence: { open: async () => ({ close: async () => { trace.push('close'); } }), create: async () => ({ close: async () => {} }) } };
  const barrier = new HostWriteBarrier(runtime, { timeoutMs, pollMs: 1 });
  return { live, trace, runtime, barrier };
}
it('drains existing sessions and handles, excludes new admission, refreshes before release, and keeps other sessions usable', async () => {
  const f = fixture(), writer = await f.runtime.sessionPersistence.open();
  // Open with the actual target identity so the handle participates in the fence.
  await writer.close();
  const active = await (f.runtime.sessionPersistence.open as any)('one', 'write'); f.live.set('one', { id: 'one' });
  const entered = deferred(), finish = deferred();
  const work = f.barrier.withAccess(['one'], async () => { f.trace.push('write'); entered.resolve(); await finish.promise; },
    async () => { f.trace.push('refresh'); }, async () => { f.trace.push('release'); });
  expect(() => f.runtime.sessions.prepare('one')).toThrow('DSH_BUSY');
  expect(f.runtime.sessions.prepare('other')).toEqual({ id: 'other' });
  await expect((f.runtime.sessionPersistence.open as any)('one', 'write')).rejects.toThrow('DSH_BUSY');
  expect(f.trace).not.toContain('write');
  f.live.delete('one'); await active.close(); await entered.promise;
  expect(() => f.barrier.dispose()).toThrow('BUSY'); finish.resolve(); await work;
  expect(f.trace.slice(-4)).toEqual(['close', 'write', 'refresh', 'release']);
  expect(f.runtime.sessions.prepare('one')).toEqual({ id: 'one' }); f.barrier.dispose();
});
it('times out without writing or detaching a live session', async () => {
  const f = fixture(2); f.live.set('one', { id: 'one' }); const write = vi.fn();
  await expect(f.barrier.withAccess(['one'], write, async () => {})).rejects.toThrow('DSH_BUSY');
  expect(write).not.toHaveBeenCalled(); expect(f.live.has('one')).toBe(true);
  expect(f.runtime.sessions.prepare('one')).toEqual({ id: 'one' }); f.barrier.dispose();
});
it('refreshes and releases after a write failure; failed refresh remains fenced until recovery', async () => {
  const f = fixture(); let broken = true;
  await expect(f.barrier.withAccess(['one'], async () => { throw new Error('write failed'); }, async () => {
    if (broken) throw new Error('refresh failed');
  })).rejects.toThrow('refresh failed');
  expect(() => f.runtime.sessions.prepare('one')).toThrow('DSH_BUSY');
  broken = false; await f.barrier.withAccess(['one'], async () => {}, async () => {});
  expect(f.runtime.sessions.prepare('one')).toEqual({ id: 'one' }); f.barrier.dispose();
});
it('does not treat a failed writer close as released', async () => {
  const f = fixture(2);
  const original = f.runtime.sessionPersistence.open;
  f.barrier.dispose();
  f.runtime.sessionPersistence.open = async () => ({ close: async () => { throw new Error('close failed'); } });
  const barrier = new HostWriteBarrier(f.runtime, { timeoutMs: 2, pollMs: 1 });
  const writer = await (f.runtime.sessionPersistence.open as any)('one', 'write');
  await expect(writer.close()).rejects.toThrow('close failed');
  await expect(barrier.withAccess(['one'], async () => {}, async () => {})).rejects.toThrow('DSH_BUSY');
  barrier.dispose(); f.runtime.sessionPersistence.open = original;
});

it('keeps the old recovery and full scope after release fails, before admitting another operation', async () => {
  const f = fixture(), release = vi.fn(async () => { if (broken) throw new Error('release failed'); });
  let broken = true;
  await expect(f.barrier.withAccess(['one', 'two'], async () => {}, async () => { f.trace.push('old refresh'); }, release)).rejects.toThrow('release failed');
  expect(() => f.runtime.sessions.prepare('two')).toThrow('DSH_BUSY');
  await expect(f.barrier.withAccess(['one'], async () => {}, async () => {})).rejects.toThrow('RECOVERY_SCOPE');
  const next = vi.fn(async () => { f.trace.push('new work'); });
  await expect(f.barrier.withAccess(['one', 'two'], next, async () => {})).rejects.toThrow('release failed');
  expect(next).not.toHaveBeenCalled();
  broken = false;
  await f.barrier.withAccess(['one', 'two'], next, async () => {});
  expect(f.trace.slice(-2)).toEqual(['old refresh', 'new work']);
  expect(release).toHaveBeenCalledTimes(3);
  expect(f.runtime.sessions.prepare('two')).toEqual({ id: 'two' }); f.barrier.dispose();
});

it('drains host flush callbacks before taking plugin admission, then retains it through refresh and release', async () => {
  const f = fixture(); f.live.set('one', { id: 'one' }); let protectedScope = false;
  f.runtime.sessions.flush = async () => { expect(protectedScope).toBe(false); f.trace.push('flush-plugin-write'); f.live.delete('one'); return true; };
  await f.barrier.withAccess(['one'], async () => { expect(protectedScope).toBe(true); },
    async () => { expect(protectedScope).toBe(true); }, async () => { expect(protectedScope).toBe(true); },
    async work => { protectedScope = true; try { return await work(); } finally { protectedScope = false; } });
  expect(f.trace).toContain('flush-plugin-write'); expect(protectedScope).toBe(false); f.barrier.dispose();
});
it('does not quarantine plugins when host drain failed before any mutation', async () => {
  const f = fixture(2); f.live.set('one', { id: 'one' }); const pluginAccess = vi.fn(async work => work());
  await expect(f.barrier.withAccess(['one'], async () => {}, async () => {}, async () => {}, pluginAccess)).rejects.toThrow('DSH_BUSY');
  expect(pluginAccess).not.toHaveBeenCalled(); f.live.delete('one');
  await f.barrier.withAccess(['one'], async () => {}, async () => {}, async () => {}, pluginAccess);
  expect(pluginAccess).toHaveBeenCalledTimes(1); f.barrier.dispose();
});
