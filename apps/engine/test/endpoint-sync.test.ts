import { expect, it, vi } from 'vitest';
import { EndpointSyncCoordinator } from '../src/endpoint-sync.js';
import { commitEndpointSessionChange } from '../src/endpoint-session-commands.js';
import { ensurePlatformSessionBinding } from '../src/platform-session-binding.js';
import type { PlatformBinding } from '@linmu/dsh-session-contracts';

function fixture() {
  let revision = 1, failures: string[] = [];
  const commit = vi.fn(async () => ({ logicalSessionId: 'logical-one', outcome: 'updated' as const }));
  let tail = Promise.resolve();
  const coordinator = new EndpointSyncCoordinator({
    exclusive: work => { const result = tail.then(work); tail = result.then(() => undefined, () => undefined); return result; },
    revision: () => revision, align: async () => ({ written: 0, unchanged: 1, skippedOutOfScope: 0, failures }), commit,
  });
  return { coordinator, commit, revision: () => { revision++; }, fail: () => { failures = ['adapter failed']; } };
}
const command = (epoch: string) => ({ epoch, profileId: 'profile', sessionId: 'native-one', change: { kind: 'archive' as const, archived: true } });

it('refuses writes before alignment and only activates an entirely successful alignment', async () => {
  const f = fixture();
  await expect(f.coordinator.commit('endpoint', command(f.coordinator.status('endpoint').epoch))).rejects.toMatchObject({ code: 'SYNC_NOT_ALIGNED' });
  f.fail(); await f.coordinator.align('endpoint');
  expect(f.coordinator.status('endpoint').phase).toBe('blocked');
  expect(f.commit).not.toHaveBeenCalled();
});
it('invalidates previously observed changes when an endpoint is realigned', async () => {
  const f = fixture(); await f.coordinator.align('endpoint'); const old = f.coordinator.status('endpoint').epoch;
  await f.coordinator.align('endpoint');
  await expect(f.coordinator.commit('endpoint', command(old))).rejects.toMatchObject({ code: 'SYNC_STALE_EPOCH' });
  await f.coordinator.commit('endpoint', command(f.coordinator.status('endpoint').epoch));
  expect(f.commit).toHaveBeenCalledTimes(1);
});
it('rechecks policy revision within the same write scope as submission', async () => {
  const f = fixture(); await f.coordinator.align('endpoint'); const epoch = f.coordinator.status('endpoint').epoch;
  f.revision(); await expect(f.coordinator.commit('endpoint', command(epoch))).rejects.toMatchObject({ code: 'SYNC_SCOPE_CHANGED' });
  expect(f.commit).not.toHaveBeenCalled();
});
it('does not confuse epochs between endpoints', async () => {
  const f = fixture(); await f.coordinator.align('one'); await f.coordinator.align('two');
  await expect(f.coordinator.commit('two', command(f.coordinator.status('one').epoch))).rejects.toMatchObject({ code: 'SYNC_STALE_EPOCH' });
});
it('retries when a host appears after startup, coalesces polls and never aligns an active unchanged scope', async () => {
  vi.useFakeTimers();
  try {
    let online=false;
    const align=vi.fn(async()=>({written:0,unchanged:0,skippedOutOfScope:0,failures:online?[]:['offline']}));
    const f=new EndpointSyncCoordinator({exclusive:work=>work(),revision:()=>1,align,commit:async()=>({logicalSessionId:'one',outcome:'updated'})});
    await Promise.all([f.ensureAligned('one'),f.ensureAligned('one')]);
    expect(align).toHaveBeenCalledTimes(1);expect(f.status('one').phase).toBe('blocked');
    online=true;await f.ensureAligned('one');expect(align).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);await f.ensureAligned('one');
    expect(f.status('one').phase).toBe('active');await f.ensureAligned('one');expect(align).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it.each(['archive', 'delete', 'refresh'] as const)('enforces selection at the %s write boundary', async kind => {
  const update = vi.fn(), remove = vi.fn(), refresh = vi.fn();
  await expect(commitEndpointSessionChange({ endpointId: 'endpoint', command: { ...command('epoch'), change: kind === 'archive' ? { kind, archived: true } : { kind } },
    resolve: async () => 'logical-one', selected: () => false, update, remove, refresh })).resolves.toMatchObject({ outcome: 'out-of-scope' });
  expect(update).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});
it('binds stored sessions idempotently without resetting their common version', async () => {
  let binding: PlatformBinding | undefined;
  const repository = { findBinding: async () => binding, bindPlatformSession: vi.fn(async (value: PlatformBinding) => { binding = value; return true; }) };
  const input = { repository, key: { platform: 'dsh' as const, instanceId: 'endpoint', sessionId: 'native' }, logicalSessionId: 'logical',
    contract: { adapter: 'fixture', platformVersion: '1', schemaFingerprint: 'format' } };
  await ensurePlatformSessionBinding({ ...input, checkOnly: true }); expect(binding).toBeUndefined();
  await ensurePlatformSessionBinding(input); binding = { ...binding!, lastCommonVersionId: 'later-version' };
  await ensurePlatformSessionBinding(input); expect(binding.lastCommonVersionId).toBe('later-version');
  expect(repository.bindPlatformSession).toHaveBeenCalledTimes(1);
  await expect(ensurePlatformSessionBinding({ ...input, logicalSessionId: 'different', checkOnly: true })).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
});

it('admits insert-only discovery during a blocked or slow alignment, while preserving stale-epoch and destructive-write guards', async () => {
  let finish!: () => void;
  const aligned = new Promise<void>(resolve => { finish = resolve; });
  const commit = vi.fn(async () => ({ logicalSessionId: 'new', outcome: 'updated' as const }));
  const f = new EndpointSyncCoordinator({ exclusive: work => work(), revision: () => 1,
    align: async () => { await aligned; return { written: 0, unchanged: 0, skippedOutOfScope: 0, failures: ['busy'] }; }, commit });
  const job = f.align('one'); await Promise.resolve();
  const epoch = f.status('one').epoch;
  await expect(f.commit('one', { ...command(epoch), change: { kind: 'discover' } })).resolves.toMatchObject({ outcome: 'updated' });
  await expect(f.commit('one', command(epoch))).rejects.toMatchObject({ code: 'SYNC_NOT_ALIGNED' });
  finish(); await job;
  await expect(f.commit('one', { ...command('stale'), change: { kind: 'discover' } })).rejects.toMatchObject({ code: 'SYNC_STALE_EPOCH' });
  expect(f.progress('one')).toMatchObject({ phase: 'blocked', failures: ['busy'] });
  await f.close();
});
it('coalesces a save during alignment into the newest revision and drains background work at shutdown', async () => {
  let revision = 1, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const revisions: number[] = [];
  const f = new EndpointSyncCoordinator({ exclusive: work => work(), revision: () => revision,
    align: async () => { revisions.push(revision); if (revisions.length === 1) await gate; return { written: 0, unchanged: 0, skippedOutOfScope: 0, failures: [] }; },
    commit: async () => ({ logicalSessionId: 'one', outcome: 'updated' }) });
  const pending = f.align('one'); await Promise.resolve(); revision = 2; f.requestAlignment('one');
  release(); await pending;
  expect(revisions).toEqual([1, 2]); expect(f.status('one')).toMatchObject({ phase: 'active', policyRevision: 2 });
  await f.close(); f.requestAlignment('one'); expect(revisions).toHaveLength(2);
});
it('discovery never updates an existing binding, even when selected', async () => {
  const refresh = vi.fn();
  await expect(commitEndpointSessionChange({ endpointId: 'one', command: { ...command('e'), change: { kind: 'discover' } },
    resolve: async () => 'existing', selected: () => true, update: vi.fn(), remove: vi.fn(), refresh }))
    .resolves.toMatchObject({ outcome: 'already-present' });
  expect(refresh).not.toHaveBeenCalled();
});

it('lets an adapter refresh a proven original session while keeping projected discovery insert-only', async () => {
  const update = vi.fn(), remove = vi.fn(), refresh = vi.fn();
  let proven = false;
  const refreshDiscovered = vi.fn(async () => proven);
  const input = { endpointId: 'one', command: { ...command('e'), change: { kind: 'discover' as const } },
    resolve: async () => 'existing', selected: () => true, update, remove, refresh, refreshDiscovered };
  expect((await commitEndpointSessionChange(input)).outcome).toBe('already-present');
  proven = true;
  expect((await commitEndpointSessionChange(input)).outcome).toBe('updated');
  expect(refresh).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  refreshDiscovered.mockRejectedValueOnce(new Error('native prefix changed'));
  await expect(commitEndpointSessionChange(input)).rejects.toThrow('native prefix changed');
});

it('publishes the queued epoch synchronously so the poll response remains valid when discovery arrives', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = new EndpointSyncCoordinator({ exclusive: work => work(), revision: () => 1,
    align: async () => { await gate; return { written: 0, unchanged: 0, skippedOutOfScope: 0, failures: ['busy'] }; },
    commit: async () => ({ logicalSessionId: 'new', outcome: 'updated' }) });
  f.requestAlignment('one'); const returned = f.status('one');
  await Promise.resolve(); expect(f.status('one').epoch).toBe(returned.epoch);
  await expect(f.commit('one', { ...command(returned.epoch), change: { kind: 'discover' } })).resolves.toMatchObject({ outcome: 'updated' });
  release(); await f.close();
});
