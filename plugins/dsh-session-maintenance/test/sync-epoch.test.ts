import { expect, it, vi } from 'vitest';
import { HostSessionSync } from '../src/host-session-sync.js';
import { RestrictedEngineProxy } from '../src/engine-proxy.js';
import { rc2HostSessionSync } from '../src/rc2-persistence.js';

it('reads actual RC2 snapshot headers and revisions', async () => {
  const host = rc2HostSessionSync({ workspaceRegistry: { archivedSessionIds: [] },
    sessionPersistence: { list: async () => [{ header: { id: 'native-one', cwd: 'fixture' }, revision: 'revision-4' }] } } as never);
  expect(await host.sessionPersistence.list()).toEqual([{ id: 'native-one', cwd: 'fixture', revision: 'revision-4' }]);
});
it('discards an offline deletion when a new epoch restores the session', async () => {
  let stored = ['one'], epoch = 'epoch-1', online = true;
  const report = vi.fn(async () => 'ok');
  const sync = new HostSessionSync({ host: { workspaceRegistry: { archivedSessionIds: [] }, sessionPersistence: { list: async () => stored.map(id => ({ id })) } },
    syncState: async () => { if (!online) throw new Error('offline'); return { epoch, phase: 'active', policyRevision: 1 }; },
    engineReady: async () => online, mapped: async () => true, report });
  await sync.pass(); online = false; stored = [];
  await expect(sync.pass()).rejects.toThrow('offline');
  epoch = 'epoch-2'; online = true; stored = ['one']; await sync.pass();
  expect(report).not.toHaveBeenCalled();
});
it('retains an archive change after a transient identity failure', async () => {
  let archived: string[] = [], failed = true; const report = vi.fn(async () => 'ok');
  const sync = new HostSessionSync({ host: { get workspaceRegistry() { return { archivedSessionIds: archived }; }, sessionPersistence: { list: async () => [{ id: 'one' }] } },
    syncState: async () => ({ epoch: 'same', phase: 'active', policyRevision: 1 }), engineReady: async () => true,
    mapped: async () => { if (failed) throw new Error('temporary'); return true; }, report });
  await sync.pass(); archived = ['one']; expect((await sync.pass()).pending).toBe(1);
  failed = false; expect((await sync.pass()).reported).toBe(1); expect(report).toHaveBeenCalledTimes(1);
});
it('reports new sessions, flushes and revision changes without a browser', async () => {
  let rows = [{ id: 'one', revision: 'r1' }]; const report = vi.fn(async () => 'ok');
  const sync = new HostSessionSync({ host: { workspaceRegistry: { archivedSessionIds: [] }, sessionPersistence: { list: async () => rows } },
    syncState: async () => ({ epoch: 'same', phase: 'active', policyRevision: 1 }), trackContent: true,
    engineReady: async () => true, mapped: async () => false, report });
  await sync.pass(); expect(report).toHaveBeenCalledWith({ kind: 'refresh', sessionId: 'one', archived: false }, false, 'same');
  report.mockClear(); rows = [{ id: 'one', revision: 'r2' }, { id: 'new', revision: 'r1' }]; await sync.pass();
  expect(report.mock.calls).toHaveLength(2); sync.markDirty('one'); await sync.pass(); expect(report.mock.calls).toHaveLength(3);
});
it('accepts archive booleans and only invokes the scoped mutation endpoint with the observed epoch', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const proxy = new RestrictedEngineProxy({ connectionId: 'fixture', dshInstanceId: 'endpoint', profileId: 'profile' },
    { current: async () => ({ origin: 'http://127.0.0.1:4000', token: 'x'.repeat(43) }) }, async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ receipt: { epoch: 'observed-epoch', logicalSessionId: 'logical', outcome: 'updated', archived: true } }));
    });
  await proxy.invoke({ operation: 'set-archived', sessionId: 'native', archived: true, epoch: 'observed-epoch' });
  expect(calls).toEqual([{ path: '/v1/instances/endpoint/sync-changes', body: { profileId: 'profile', epoch: 'observed-epoch', sessionId: 'native', change: { kind: 'archive', archived: true } } }]);
});
it('admits selected sessions in plain operation without a Launcher run', async () => {
  const proxy = new RestrictedEngineProxy({ connectionId: 'fixture', dshInstanceId: 'endpoint', profileId: 'profile' },
    { current: async () => ({ origin: 'http://127.0.0.1:4000', token: 'x'.repeat(43) }) }, async url => new Response(JSON.stringify(
      String(url).includes('/availability') ? { availability: { status: 'offline' } } : { resolution: { logicalSessionId: 'logical' } })));
  expect((await proxy.invoke({ operation: 'session-mapped', sessionId: 'native' })).mapped).toBe(true);
});
