import { afterEach, expect, it, vi } from 'vitest';
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain';
import { registerWorkspaceArchiveBridge, WorkspaceArchiveSync } from '../src/workspace-archive-bridge.js';

afterEach(() => { vi.useRealTimers(); });
const result = (nativeSessionId: string, archived: boolean) => Promise.resolve({ logicalSessionId: 'logical-' + nativeSessionId, archived });

function host(archivedSessionIds: string[] = []) {
  let listener: ((change: DomainChanged) => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  const off = vi.fn(() => { listener = undefined; });
  const ctx = {
    workspaceRegistry: { archivedSessionIds },
    on: vi.fn((event: string, fn: typeof listener) => { expect(event).toBe('domain/changed'); listener = fn; return off; }),
    effect: (fn: () => () => Promise<void>) => { release = fn(); },
  };
  return { ctx, off, emit: (change: DomainChanged) => listener?.(change), release: () => release?.() };
}
function state(archivedSessionIds: string[]): DomainChanged {
  return { domain: 'workspace', table: '', key: '', operation: 'put', value: { initialized: true, workspaceIds: [], archivedSessionIds } };
}

it('replays every durable archived session at cold startup and never infers an unarchive from absence', async () => {
  const fixture = host(['first', 'second']);
  const write = vi.fn(result);
  const bridge = registerWorkspaceArchiveBridge(fixture.ctx as never, { setSessionArchived: write });
  await bridge.flush();
  expect(write.mock.calls).toEqual([['first', true], ['second', true]]);
  await bridge.dispose();
  const restarted = registerWorkspaceArchiveBridge(fixture.ctx as never, { setSessionArchived: write });
  await restarted.flush();
  expect(write.mock.calls).toEqual([['first', true], ['second', true], ['first', true], ['second', true]]);
  await restarted.dispose();
  const empty = host();
  const noArchive = registerWorkspaceArchiveBridge(empty.ctx as never, { setSessionArchived: write });
  await noArchive.flush();expect(write).toHaveBeenCalledTimes(4);await noArchive.dispose();
});

it('uses the committed global event while the WorkspaceRegistry cache is still stale', async () => {
  const fixture = host();const write = vi.fn(result);
  const bridge = registerWorkspaceArchiveBridge(fixture.ctx as never, { setSessionArchived: write });
  fixture.emit(state(['newly-archived']));
  expect(fixture.ctx.workspaceRegistry.archivedSessionIds).toEqual([]);
  await bridge.flush();expect(write).toHaveBeenCalledWith('newly-archived', true);
  fixture.emit(state(['newly-archived']));await bridge.flush();expect(write).toHaveBeenCalledTimes(1);
  fixture.emit(state([]));await bridge.flush();expect(write.mock.calls).toEqual([['newly-archived', true], ['newly-archived', false]]);
  await bridge.dispose();
});

it('recovers an unsynchronized archive from the same durable registry after a failed run is unloaded', async () => {
  vi.useFakeTimers();const fixture = host(['offline-archive']);
  const unavailable = vi.fn().mockRejectedValue(new Error('offline'));
  const first = registerWorkspaceArchiveBridge(fixture.ctx as never, { setSessionArchived: unavailable });
  await first.flush();await first.dispose();
  const recovered = vi.fn(result);
  const second = registerWorkspaceArchiveBridge(fixture.ctx as never, { setSessionArchived: recovered });
  await second.flush();expect(recovered.mock.calls).toEqual([['offline-archive', true]]);
  await vi.advanceTimersByTimeAsync(60000);expect(unavailable).toHaveBeenCalledTimes(1);await second.dispose();
});

it('ignores unrelated records, global deletes and invalid snapshots', async () => {
  const fixture = host(['kept']);const write = vi.fn(result);
  const bridge = registerWorkspaceArchiveBridge(fixture.ctx as never, { setSessionArchived: write });
  await bridge.flush();write.mockClear();
  fixture.emit({ ...state([]), domain: 'another-domain' });
  fixture.emit({ ...state([]), table: 'workspaces', key: 'workspace-1' });
  fixture.emit({ domain: 'workspace', table: '', key: '', operation: 'deleted' });
  fixture.emit({ domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: 'invalid' } });
  await bridge.flush();expect(write).not.toHaveBeenCalled();await bridge.dispose();
});

it('retries failed archive transactions without blocking another session or dropping the later unarchive', async () => {
  vi.useFakeTimers();let online = false;
  const write = vi.fn(async (id: string, archived: boolean) => {
    if (id === 'first' && archived && !online) throw new Error('Engine offline');
    return result(id, archived);
  });
  const report = vi.fn();const sync = new WorkspaceArchiveSync({ setSessionArchived: write }, report);
  sync.observe(['first', 'second']);await sync.flush();
  expect(write.mock.calls).toEqual([['first', true], ['second', true]]);
  sync.observe(['second']);await sync.flush();
  expect(write.mock.calls).toEqual([['first', true], ['second', true], ['first', true]]);
  expect(report).toHaveBeenCalledTimes(1);
  online = true;await vi.advanceTimersByTimeAsync(2000);
  expect(write.mock.calls.slice(-2)).toEqual([['first', true], ['first', false]]);
  const completed = write.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);
  expect(write).toHaveBeenCalledTimes(completed);await sync.dispose();
});

it('preserves rapid true-false-true transitions while an archive request is in flight', async () => {
  let complete!: () => void;
  const write = vi.fn(result).mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ logicalSessionId: 'logical-first', archived: true }); }));
  const sync = new WorkspaceArchiveSync({ setSessionArchived: write });
  sync.observe(['first']);await Promise.resolve();
  sync.observe([]);sync.observe(['first']);
  expect(write).toHaveBeenCalledTimes(1);
  complete();await sync.flush();
  expect(write.mock.calls).toEqual([['first', true], ['first', false], ['first', true]]);
  await sync.dispose();
});

it('clears retry timers and detaches its observer on plugin unload', async () => {
  vi.useFakeTimers();const fixture = host(['first']);const write = vi.fn().mockRejectedValue(new Error('offline'));
  const bridge = registerWorkspaceArchiveBridge(fixture.ctx as never, { setSessionArchived: write });
  await bridge.flush();await fixture.release();
  expect(fixture.off).toHaveBeenCalledTimes(1);
  fixture.emit(state(['first', 'second']));await vi.advanceTimersByTimeAsync(60000);
  expect(write).toHaveBeenCalledTimes(1);await bridge.dispose();expect(fixture.off).toHaveBeenCalledTimes(1);
});

it('waits for an issued transaction before disposal completes and does not send queued work afterwards', async () => {
  let complete!: () => void;const write = vi.fn(result).mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ logicalSessionId: 'logical-first', archived: true }); }));
  const sync = new WorkspaceArchiveSync({ setSessionArchived: write });
  sync.observe(['first', 'second']);await Promise.resolve();
  let disposed = false;const done = sync.dispose().then(() => { disposed = true; });
  await Promise.resolve();expect(disposed).toBe(false);
  complete();await done;expect(disposed).toBe(true);expect(write.mock.calls).toEqual([['first', true]]);
});
