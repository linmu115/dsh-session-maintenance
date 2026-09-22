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
