import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationMirrorSync, AnnotationMirrorSyncResult } from '@linmu/dsh-session-contracts';
import { AnnotationMirror, registerAnnotationMirror, type AnnotationMirrorSource } from '../src/annotation-mirror.js';
import { MaintenanceExtensionBridge } from '../src/extension-data.js';

type Entry = AnnotationMirrorSync['entries'][number];
const entry = (referenceId: string, state: Entry['state'] = 'pending'): Entry => ({ referenceId, setId: 'set', sourceType: 'dsh-message', state,
  selectedText: state === 'deleted' ? '' : 'bounded excerpt', userComment: '', source: state === 'deleted' ? {} : { nativeSessionId: 'source-native', upstreamReferenceId: `authority-${referenceId}` } });
const connection = { current: async () => ({ origin: 'http://127.0.0.1:17653', token: 'fixture-host-token' }) };
const instances: AnnotationMirror[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(mirror => mirror.dispose())); vi.useRealTimers(); });
function changed() { const error = new Error('changed'); error.name = 'AnnotationDirectoryChangedError'; return error; }

function directory(initial: Record<string, { revision: number; entries: Entry[] }>) {
  const sessions = new Map(Object.entries(initial));
  let listener: Parameters<AnnotationMirrorSource['subscribe']>[0] | undefined;
  const off = vi.fn(() => { listener = undefined; });
  const source: AnnotationMirrorSource = {
    protocolVersion: 1,
    listSessions: vi.fn(async input => {
      input?.signal?.throwIfAborted();
      const ids = [...sessions.keys()].sort(), generation = ids.join(',');
      const cursor = input?.after ? JSON.parse(input.after) as { generation: string; offset: number } : undefined;
      if (cursor && cursor.generation !== generation) throw changed();
      const start = cursor?.offset ?? 0, limit = input?.limit ?? 50;
      return { items: ids.slice(start, start + limit).map(nativeSessionId => ({ nativeSessionId, sourceRevision: sessions.get(nativeSessionId)!.revision })),
        nextCursor: start + limit < ids.length ? JSON.stringify({ generation, offset: start + limit }) : null };
    }),
    listEntries: vi.fn(async input => {
      input.signal?.throwIfAborted();
      const state = sessions.get(input.nativeSessionId)!;
      const cursor = input.after ? JSON.parse(input.after) as { revision: number; offset: number } : undefined;
      if (cursor && cursor.revision !== state.revision) throw changed();
      const start = cursor?.offset ?? 0, limit = input.limit ?? 50;
      return { nativeSessionId: input.nativeSessionId, sourceRevision: state.revision, items: structuredClone(state.entries.slice(start, start + limit)),
        nextCursor: start + limit < state.entries.length ? JSON.stringify({ revision: state.revision, offset: start + limit }) : null };
    }),
    subscribe: fn => { listener = fn; return off; },
  };
  return { source, sessions, off, update(id: string, revision: number, entries: Entry[], notify = true) {
    sessions.set(id, { revision, entries }); if (notify) listener?.({ nativeSessionId: id, sourceRevision: revision });
  } };
}
function acknowledge(request: AnnotationMirrorSync, status: AnnotationMirrorSyncResult['items'][number]['status'] = 'saved'): Response {
  return Response.json({ items: request.entries.map(entry => ({ referenceId: entry.referenceId, objectId: `mirror-${entry.referenceId}`, revision: 1,
    sourceRevision: request.sourceRevision, status })) });
}
function start(source: AnnotationMirrorSource, handler?: (request: AnnotationMirrorSync, init: RequestInit) => Promise<Response> | Response) {
  const calls: AnnotationMirrorSync[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as AnnotationMirrorSync; calls.push(body);
    return handler ? handler(body, init!) : acknowledge(body);
  });
  const connect = vi.fn(async () => {}), reportRetry = vi.fn();
  const mirror = new AnnotationMirror({ source, connection, runId: 'run-fixture', fetchImpl: fetchImpl as typeof fetch, connect, reportRetry });
  instances.push(mirror); mirror.start();
  return { mirror, calls, fetchImpl, connect, reportRetry };
}

describe('Core annotation directory mirror', () => {
  it('backfills in bounded pages using the native target, and sends no request for absence', async () => {
    vi.useFakeTimers();
    const source = directory({ target: { revision: 8, entries: Array.from({ length: 53 }, (_, i) => entry(`reference-${i}`)) }, empty: { revision: 2, entries: [] } });
    const fixture = start(source.source); await fixture.mirror.flush();
    expect(fixture.calls.map(call => call.entries.length)).toEqual([50]);
    await vi.advanceTimersByTimeAsync(25);
    expect(fixture.calls.map(call => call.entries.length)).toEqual([50, 3]);
    expect(fixture.calls.every(call => call.nativeSessionId === 'target' && call.sourceRevision === 8 && call.runId === 'run-fixture')).toBe(true);
    expect(fixture.calls[0]!.entries[0]!.source.upstreamReferenceId).toBe('authority-reference-0');
    expect(fixture.connect).toHaveBeenCalledTimes(1);
    expect(fixture.fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:17653/v1/extensions/annotation-sync');
    expect(fixture.fetchImpl.mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer fixture-host-token' });
  });

  it('backfills session catalogs beyond the first page without requesting whole aggregates', async () => {
    vi.useFakeTimers();
    const data = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`session-${String(i).padStart(2, '0')}`, { revision: 1, entries: [entry(`reference-${i}`)] }]));
    const source = directory(data), fixture = start(source.source); await fixture.mirror.flush();
    expect(fixture.calls).toHaveLength(50); await vi.advanceTimersByTimeAsync(25);
    expect(fixture.calls).toHaveLength(55);
    expect(source.source.listSessions).toHaveBeenCalledTimes(2);
    expect(vi.mocked(source.source.listSessions).mock.calls.every(([input]) => input?.limit === 50)).toBe(true);
  });

  it('splits multibyte excerpts by the HTTP byte budget while retaining the same source revision', async () => {
    vi.useFakeTimers();
    const entries = Array.from({ length: 50 }, (_, i) => ({ ...entry(`ref-${i}`), selectedText: '中'.repeat(4000), userComment: '评'.repeat(2000) }));
    const source = directory({ target: { revision: 8, entries } }), fixture = start(source.source);
    await fixture.mirror.flush();
    expect(fixture.calls.length).toBeGreaterThan(1);
    expect(fixture.calls.flatMap(call => call.entries)).toEqual(entries);
    expect(fixture.calls.every(call => call.sourceRevision === 8 && Buffer.byteLength(JSON.stringify(call)) <= 480 * 1024)).toBe(true);
    expect(source.source.listEntries).toHaveBeenCalledTimes(1);
  });

  it('synchronizes committed edits and explicit textless tombstones but never treats missing entries as deletes', async () => {
    vi.useFakeTimers(); const source = directory({ target: { revision: 1, entries: [entry('ref')] } });
    const fixture = start(source.source); await fixture.mirror.flush();
    source.update('target', 2, [entry('ref', 'sent')]); await fixture.mirror.flush();
    source.update('target', 3, []); await fixture.mirror.flush();
    expect(fixture.calls).toHaveLength(2);
    source.update('target', 4, [entry('ref', 'deleted')]); await fixture.mirror.flush();
    expect(fixture.calls.at(-1)!.entries).toEqual([entry('ref', 'deleted')]);
  });

  it('retries failed requests with backoff while allowing an unrelated session to progress', async () => {
    vi.useFakeTimers(); let online = false;
    const source = directory({ a: { revision: 1, entries: [entry('a')] }, b: { revision: 1, entries: [entry('b')] } });
    const fixture = start(source.source, request => { if (request.nativeSessionId === 'a' && !online) throw new Error('offline'); return acknowledge(request); });
    await fixture.mirror.flush(); expect(fixture.calls.map(call => call.nativeSessionId)).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(999); expect(fixture.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(fixture.calls.map(call => call.nativeSessionId)).toEqual(['a', 'b', 'a']);
    online = true; await vi.advanceTimersByTimeAsync(1999); expect(fixture.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1); expect(fixture.calls).toHaveLength(4);
    expect(fixture.reportRetry).toHaveBeenCalledTimes(1);
  });

  it.each(['deferred', 'conflict'] as const)('retains a page after %s acknowledgements and retries unknown native mappings', async status => {
    vi.useFakeTimers(); let ready = false;
    const source = directory({ target: { revision: 1, entries: [entry('ref')] } });
    const fixture = start(source.source, request => acknowledge(request, ready ? 'unchanged' : status));
    await fixture.mirror.flush(); ready = true; await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.calls).toHaveLength(2); expect(fixture.calls[1]).toEqual(fixture.calls[0]);
    await vi.advanceTimersByTimeAsync(60000); expect(fixture.calls).toHaveLength(2);
  });

  it('requires complete per-entry durable receipts before advancing to the next page', async () => {
    vi.useFakeTimers(); let valid = false;
    const source = directory({ target: { revision: 3, entries: Array.from({ length: 51 }, (_, i) => entry(`ref-${i}`)) } });
    const fixture = start(source.source, request => valid ? acknowledge(request) : Response.json({ items: [] }));
    await fixture.mirror.flush(); expect(fixture.calls).toHaveLength(1);
    valid = true; await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.calls[1]).toEqual(fixture.calls[0]);
    await vi.advanceTimersByTimeAsync(25); expect(fixture.calls.at(-1)!.entries).toHaveLength(1);
  });

  it('rereads after a stale receipt instead of acknowledging an old source revision', async () => {
    vi.useFakeTimers(); let stale = true;
    const source = directory({ target: { revision: 2, entries: [entry('ref')] } });
    const fixture = start(source.source, request => acknowledge(request, stale ? 'stale' : 'saved'));
    await fixture.mirror.flush(); stale = false; await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.calls).toHaveLength(2);
    expect(vi.mocked(source.source.listEntries).mock.calls.every(([input]) => input.after === undefined)).toBe(true);
  });

  it('rereads changed entry pagination and never sends a mixed revision page', async () => {
    vi.useFakeTimers(); const entries = Array.from({ length: 51 }, (_, i) => entry(`ref-${i}`));
    const source = directory({ target: { revision: 1, entries } });
    const fixture = start(source.source); await fixture.mirror.flush();
    source.update('target', 2, [entry('new-before-page'), ...entries], false);
    await vi.advanceTimersByTimeAsync(25); expect(fixture.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); expect(fixture.calls[1]!.sourceRevision).toBe(2);
    expect(fixture.calls[1]!.entries[0]!.referenceId).toBe('new-before-page');
  });

  it('restarts a changed session catalog so sessions inserted before its cursor are not missed', async () => {
    vi.useFakeTimers(); const data = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`b-${i}`, { revision: 1, entries: [entry(`ref-${i}`)] }]));
    const source = directory(data), fixture = start(source.source); await fixture.mirror.flush();
    source.update('a-new', 1, [entry('new')], false);
    await vi.advanceTimersByTimeAsync(25); await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.calls.some(call => call.nativeSessionId === 'a-new')).toBe(true);
  });

  it('cannot let an old in-flight acknowledgement consume a newer committed edit', async () => {
    vi.useFakeTimers(); let release!: () => void, started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const source = directory({ target: { revision: 1, entries: [entry('ref')] } });
    let first = true;
    const fixture = start(source.source, request => {
      if (!first) return acknowledge(request);
      first = false; started(); return new Promise<Response>(resolve => { release = () => resolve(acknowledge(request)); });
    });
    await begun; source.update('target', 2, [entry('ref', 'deleted')]); release(); await fixture.mirror.flush();
    await vi.advanceTimersByTimeAsync(25);
    expect(fixture.calls.map(call => call.sourceRevision)).toEqual([1, 2]);
    expect(fixture.calls[1]!.entries[0]!.state).toBe('deleted');
  });

  it('recovers unacknowledged work from the same durable directory after restart', async () => {
    vi.useFakeTimers(); const source = directory({ target: { revision: 7, entries: [entry('ref', 'deleted')] } });
    const failed = start(source.source, () => { throw new Error('offline'); }); await failed.mirror.flush(); await failed.mirror.dispose();
    const recovered = start(source.source); await recovered.mirror.flush();
    expect(recovered.calls).toEqual(failed.calls);
  });

  it('aborts pending I/O and retry timers on dispose, ignoring a late successful response', async () => {
    vi.useFakeTimers(); let release!: () => void, started!: () => void; let signal: AbortSignal | undefined;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const source = directory({ target: { revision: 1, entries: Array.from({ length: 51 }, (_, i) => entry(`ref-${i}`)) } });
    const fixture = start(source.source, (request, init) => { signal = init.signal!; started(); return new Promise(resolve => { release = () => resolve(acknowledge(request)); }); });
    await begun; await fixture.mirror.dispose(); expect(signal?.aborted).toBe(true); expect(source.off).toHaveBeenCalledTimes(1);
    release(); source.update('target', 2, [entry('later')]); await vi.advanceTimersByTimeAsync(60000);
    expect(fixture.calls).toHaveLength(1);
  });

  it('only injects the optional Core host when annotation-records is explicitly configured', async () => {
    const inject = vi.fn(), options = { plugins: [{ namespace: 'annotation-upstream' }], connection, runId: 'run' };
    registerAnnotationMirror({ inject }, options); expect(inject).not.toHaveBeenCalled();
    registerAnnotationMirror({ inject }, { ...options, plugins: [{ namespace: 'annotation-records' }] });
    expect(inject).toHaveBeenCalledWith(['annotationCoreHost'], expect.any(Function));
    const effect = vi.fn(); inject.mock.calls[0]![1]({ effect, annotationCoreHost: {} }); expect(effect).not.toHaveBeenCalled();
  });

  it('binds the configured optional capability to its scope and aborts the real connection bridge on unload', async () => {
    const source = directory({ target: { revision: 1, entries: [entry('ref')] } });
    const plugins = [{ namespace: 'annotation-records', pluginVersion: '0.3.12-rc2.10', writerId: 'dsh-annotation-core' }];
    let release!: () => Promise<void>, finish!: () => void, begun!: () => void, signal: AbortSignal | undefined;
    const connected = new Promise<void>(resolve => { begun = resolve; });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init!.signal!; begun();
      return new Promise<Response>(resolve => { finish = () => resolve(Response.json({ ok: true })); });
    });
    const extensions = new MaintenanceExtensionBridge(connection, { instanceId: 'fixture', profileId: 'web' }, plugins, fetchImpl as typeof fetch);
    const send = vi.fn();
    registerAnnotationMirror({ inject: (_names, setup) => setup({ annotationCoreHost: { referenceDirectory: source.source },
      effect: callback => { release = callback(); } }) },
    { plugins, connection, runId: 'run', connect: signal => extensions.connect(signal), fetchImpl: send as unknown as typeof fetch });
    await connected; await release(); finish();
    expect(signal?.aborted).toBe(true); expect(source.off).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  });
});
