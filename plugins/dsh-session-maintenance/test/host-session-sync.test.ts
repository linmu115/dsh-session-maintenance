import { expect, it, vi } from 'vitest';
import { HostSessionSync, type HostSessionSyncHost } from '../src/host-session-sync.js';

/**
 * The instance's half of "实例为准" that must not depend on a browser page.
 *
 * The defect this pins: the only page-independent channel was the run-scoped graph bridge, so with
 * every page closed an archive or a deletion in the instance never reached the source at all.
 */
function host(options: { stored?: readonly string[]; archived?: readonly string[] } = {}) {
  let stored = [...(options.stored ?? [])];
  let archived = [...(options.archived ?? [])];
  const value: HostSessionSyncHost = {
    get workspaceRegistry() { return { archivedSessionIds: archived }; },
    sessionPersistence: { list: async () => stored.map(id => ({ id })) },
  };
  return {
    host: value,
    setStored: (next: readonly string[]) => { stored = [...next]; },
    setArchived: (next: readonly string[]) => { archived = [...next]; },
  };
}

const ready = async () => true;

it('prioritizes a live turn during the startup sweep and retains another flush arriving during its request', async () => {
  const fake = host({ stored: ['old-a', 'old-b', 'new-turn'] }), pushed: string[] = [];
  let again = true;
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true, trackContent: true,
    syncState: async () => ({ epoch: 'epoch', phase: 'active', policyRevision: 1 }),
    report: async intent => {
      pushed.push(intent.sessionId);
      if (intent.sessionId === 'old-a') sync.markDirty('new-turn');
      if (intent.sessionId === 'new-turn' && again) { again = false; sync.markDirty('new-turn'); }
      return 'ok';
    } });
  expect((await sync.pass()).pending).toBe(1);
  expect(pushed).toEqual(['old-a', 'new-turn', 'old-b']);
  await sync.pass();
  expect(pushed).toEqual(['old-a', 'new-turn', 'old-b', 'new-turn']);
  sync.dispose();
});

it('reports a plugin-only edit even when the native conversation log does not change', async () => {
  const fake = host({ stored: ['session-a'] }), pushed: string[] = [];
  let revision = 'before';
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true,
    trackContent: true, additionalRevision: async () => revision, report: async intent => { pushed.push(intent.kind); return 'ok'; } });
  await sync.pass(); revision = 'after'; await sync.pass(); await sync.pass();
  expect(pushed).toEqual(['refresh']);
});

it('reports a deletion the instance made, without any page being open', async () => {
  const fake = host({ stored: ['session-a', 'session-b'] });
  const pushed: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true,
    report: async intent => { pushed.push(`${intent.kind}:${intent.sessionId}`); return 'ok'; } });
  expect((await sync.pass()).intents).toBe(0);          // first pass is the baseline only
  fake.setStored(['session-a']);
  const result = await sync.pass();
  expect(result.intents).toBe(1);
  expect(pushed).toEqual(['delete:session-b']);
  expect(result.pending).toBe(0);
});

it('reports an archive flip with the state the instance now shows', async () => {
  const fake = host({ stored: ['session-a'], archived: [] });
  const pushed: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true,
    report: async (intent, archived) => { pushed.push(`${intent.kind}:${intent.sessionId}:${String(archived)}`); return 'ok'; } });
  await sync.pass();
  fake.setArchived(['session-a']);
  await sync.pass();
  fake.setArchived([]);
  await sync.pass();
  expect(pushed).toEqual(['archive:session-a:true', 'archive:session-a:false']);
});

it('never pushes a session this instance has not mapped', async () => {
  const fake = host({ stored: ['bound', 'foreign'] });
  const pushed: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready,
    mapped: async sessionId => sessionId === 'bound',
    report: async intent => { pushed.push(intent.sessionId); return 'ok'; } });
  await sync.pass();
  fake.setStored(['bound']);
  const result = await sync.pass();
  expect(pushed).toEqual([]);
  expect(result.skippedUnmapped).toBe(1);
  expect(result.pending).toBe(0);
});

it('keeps a failed intent for the next pass instead of reporting it once and forgetting it', async () => {
  const fake = host({ stored: ['session-a', 'session-b'] });
  let fail = true;
  const pushed: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true,
    report: async intent => { pushed.push(intent.sessionId); if (fail) throw new Error('引擎暂时拒绝'); return 'ok'; } });
  await sync.pass();
  fake.setStored(['session-a']);
  const first = await sync.pass();
  expect(first.reported).toBe(0);
  expect(first.pending).toBe(1);
  fail = false;
  const second = await sync.pass();
  expect(second.reported).toBe(1);
  expect(pushed).toEqual(['session-b', 'session-b']);
});

it('sends nothing while the Engine is not reachable, and keeps the intent for when it is', async () => {
  const fake = host({ stored: ['session-a', 'session-b'] });
  let reachable = false;
  const pushed: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: async () => reachable, mapped: async () => true,
    report: async intent => { pushed.push(intent.sessionId); return 'ok'; } });
  await sync.pass();
  fake.setStored(['session-a']);
  expect((await sync.pass()).reported).toBe(0);
  expect(pushed).toEqual([]);
  reachable = true;
  expect((await sync.pass()).reported).toBe(1);
  expect(pushed).toEqual(['session-b']);
});

it('treats a moved session as a move, not a deletion', async () => {
  // A move rewrites the session's file under another project directory; it stays stored.
  const fake = host({ stored: ['session-a'] });
  const pushed: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true,
    report: async intent => { pushed.push(intent.kind); return 'ok'; } });
  await sync.pass();
  fake.setStored(['session-a']);
  expect((await sync.pass()).intents).toBe(0);
  expect(pushed).toEqual([]);
});

it('keeps observing after a pass that could not read the host records at all', async () => {
  const feedback = vi.fn();
  let broken = true;
  const sync = new HostSessionSync({
    host: { workspaceRegistry: { archivedSessionIds: [] },
      sessionPersistence: { list: async () => {
        if (broken) throw new Error('存储暂不可读');
        return [{ id: 'session-a' }];
      } } },
    engineReady: ready, mapped: async () => true, report: async () => 'ok',
    onFeedback: feedback, intervalMs: 1,
  });
  const stop = sync.start();
  await vi.waitFor(() => { expect(feedback).toHaveBeenCalled(); });
  expect(String(feedback.mock.calls[0]![0])).toContain('无法读取实例侧会话记录');
  broken = false;
  stop();
  expect((await sync.pass()).observed).toBe(1);
});

it('discovers newly created sessions while alignment is blocked, without sending archive or deletion mutations', async () => {
  const fake = host({ stored: ['old'] }), intents: string[] = [];
  let phase: 'blocked' | 'active' = 'blocked';
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true, trackContent: true,
    syncState: async () => ({ epoch: 'epoch', policyRevision: 1, phase }),
    report: async intent => { intents.push(intent.kind + ':' + intent.sessionId); return 'ok'; } });
  await sync.pass(); fake.setStored(['new']); fake.setArchived(['new']); await sync.pass();
  expect(intents).toEqual(['discover:old', 'discover:new']);
  phase = 'active'; await sync.pass();
  expect(intents.at(-1)).toBe('refresh:new'); expect(intents.some(item => item.startsWith('delete:'))).toBe(false);
});
it('prioritizes dirty sessions during blocked startup discovery instead of the old corpus', async () => {
  const fake = host({ stored: ['old-1', 'old-2', 'recent'] });
  const pushed: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true, trackContent: true,
    syncState: async () => ({ epoch: 'new-epoch', policyRevision: 1, phase: 'blocked' }),
    report: async intent => { pushed.push(intent.kind + ':' + intent.sessionId); return 'ok'; } });
  sync.markDirty('recent');
  try { await sync.pass(); expect(pushed[0]).toBe('discover:recent'); }
  finally { sync.dispose(); }
});

it('abandons a stale discovery sweep and retries its dirty session in the new epoch', async () => {
  const fake = host({ stored: ['recent', 'old-1', 'old-2'] });
  let epoch = 'before'; const sent: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true, trackContent: true,
    syncState: async () => ({ epoch, policyRevision: 1, phase: 'blocked' }),
    report: async (intent, _archived, observedEpoch) => {
      sent.push(observedEpoch + ':' + intent.sessionId);
      if (epoch === 'before') { epoch = 'after'; throw new Error('stale epoch'); } return 'ok';
    } });
  try {
    await expect(sync.pass()).rejects.toThrow('stale epoch');
    expect(sent).toEqual(['before:recent']);
    await sync.pass(); expect(sent[1]).toBe('after:recent');
  } finally { sync.dispose(); }
});

it('retries a just-flushed session before the rest of a bounded startup sweep', async () => {
  const fake = host({ stored: ['recent', 'old-1', 'old-2', 'old-3'] });
  const sent: string[] = []; let unstable = true;
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true,
    trackContent: true, maxReportsPerPass: 2,
    syncState: async () => ({ epoch: 'same', policyRevision: 1, phase: 'blocked' }),
    report: async intent => { sent.push(intent.sessionId); if (intent.sessionId === 'recent' && unstable) throw new Error('not flushed'); return 'ok'; } });
  try {
    sync.markDirty('recent');
    expect((await sync.pass()).pending).toBe(3);
    unstable = false;
    await sync.pass(); await sync.pass();
    expect(sent).toEqual(['recent', 'old-1', 'recent', 'old-2', 'old-3']);
  } finally { sync.dispose(); }
});

it('keeps ordinary changes flowing when another session cannot supply a plugin revision', async () => {
  const fake = host({ stored: ['damaged-plugin', 'recent'] }); const sent: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true, trackContent: true,
    syncState: async () => ({ epoch: 'same', policyRevision: 1, phase: 'active' }),
    additionalRevision: async id => { if (id === 'damaged-plugin') throw new Error('plugin cannot read old log'); return 'plugin-v1'; },
    report: async intent => { sent.push(intent.sessionId); return 'ok'; } });
  try { await sync.pass(); sent.length = 0; sync.markDirty('recent'); await sync.pass(); expect(sent).toEqual(['recent']); }
  finally { sync.dispose(); }
});

it('does not starve new edits behind a full batch of permanently rejected historical rows', async () => {
  const old = Array.from({ length: 10 }, (_, index) => `old-${index}`), fake = host({ stored: old });
  const sent: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true, trackContent: true,
    syncState: async () => ({ epoch: 'same', policyRevision: 1, phase: 'active' }),
    report: async intent => { sent.push(intent.sessionId); if (intent.sessionId.startsWith('old-')) throw new Error('old prefix refused'); return 'ok'; } });
  try {
    await sync.pass(); sent.length = 0; fake.setStored([...old, 'new']); sync.markDirty('new');
    await sync.pass(); expect(sent[0]).toBe('new'); expect(sent).toContain('old-8'); expect(sent).toContain('old-9');
  } finally { sync.dispose(); }
});

it('prioritizes an archive observation over an unfinished initial history sweep', async () => {
  const old = Array.from({ length: 20 }, (_, index) => `old-${index}`), fake = host({ stored: [...old, 'archived-now'] });
  const sent: Array<{ id: string; archived: boolean }> = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true, trackContent: true,
    maxReportsPerPass: 2, syncState: async () => ({ epoch: 'same', policyRevision: 1, phase: 'active' }),
    report: async (intent, archived) => { sent.push({ id: intent.sessionId, archived }); return 'ok'; } });
  try {
    await sync.pass(); sent.length = 0; fake.setArchived(['archived-now']);
    await sync.pass(); expect(sent[0]).toEqual({ id: 'archived-now', archived: true });
  } finally { sync.dispose(); }
});

it('backs off failed history retries while allowing a new notification to wake the queue', async () => {
  vi.useFakeTimers();
  const fake = host({ stored: ['old'] }); const sent: string[] = [];
  const sync = new HostSessionSync({ host: fake.host, engineReady: ready, mapped: async () => true, trackContent: true,
    syncState: async () => ({ epoch: 'same', policyRevision: 1, phase: 'active' }),
    report: async intent => { sent.push(intent.sessionId); if (intent.sessionId === 'old') throw new Error('bad historical prefix'); return 'ok'; } });
  const stop = sync.start();
  try {
    await vi.advanceTimersByTimeAsync(1000); expect(sent).toEqual(['old']);
    fake.setStored(['old', 'new']); sync.markDirty('new');
    await vi.advanceTimersByTimeAsync(200); expect(sent[1]).toBe('new');
  } finally { stop(); vi.useRealTimers(); }
});
