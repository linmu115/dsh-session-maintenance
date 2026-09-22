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
