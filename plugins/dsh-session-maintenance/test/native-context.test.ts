import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceNativeContext, nativeContextReady } from '../src/native-context.js';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const order: string[] = [];
  const flush = vi.fn(async () => { order.push('durable-flush'); });
  const fetchMock = vi.fn(async (_url: string | URL | Request, _input?: RequestInit) => { order.push('http'); return new Response(JSON.stringify({ recorded: true }), { status: 200 }); });
  vi.stubGlobal('fetch', fetchMock);
  const host = new MaintenanceNativeContext({ current: async () => ({ origin: 'http://127.0.0.1:9999', token: 'test-local-token' }) }, 'bound-run', flush);
  return { host, flush, fetchMock, order };
}
describe('current-run native context host', () => {
  it('requires a ready matching scope/version and stops at the live capability gate after disable', async () => {
    const row = { scope: { instanceId: 'copy', profileId: 'web', namespace: 'annotation-context' }, pluginVersion: 'new-core', configured: true, enabled: true, status: 'ready' } as never;
    expect(nativeContextReady([row], 'copy', 'web', 'new-core')).toBe(true);
    expect(nativeContextReady([row], 'other', 'web', 'new-core')).toBe(false);
    expect(nativeContextReady([row], 'copy', 'web', 'old-core')).toBe(false);
    expect(nativeContextReady([{ ...(row as object), status: 'missing-adapter' } as never], 'copy', 'web', 'new-core')).toBe(false);
    const f = fixture(), guard = vi.fn(async () => { throw new Error('adapter disabled'); });
    const gated = new MaintenanceNativeContext({ current: async () => ({ origin: 'http://127.0.0.1:9999', token: 'test' }) }, 'run', f.flush, guard);
    await expect(gated.request('native', 'status', { executionId: 'turn:1:2' })).rejects.toThrow('adapter disabled');
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it('binds run, target, actor and current execution instead of accepting model scope fields', async () => {
    const f = fixture();
    await f.host.request('native-A', 'release', { executionId: 'turn:1:2', operationId: 'op', expectedRevision: 1, materialIds: ['m'] });
    const input = JSON.parse(f.fetchMock.mock.calls[0]![1]!.body as string);
    expect(input).toMatchObject({ runId: 'bound-run', targetNativeSessionId: 'native-A', actor: 'model', executionId: 'turn:1:2' });
    for (const key of ['runId', 'targetNativeSessionId', 'nativeSessionId', 'ownerSessionId', 'actor', 'instanceId', 'profileId'])
      await expect(f.host.request('native-A', 'release', { executionId: 'turn:1:2', [key]: 'other' })).rejects.toThrow('cannot be overridden');
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });
  it('flushes native replacement evidence before sending a durable applied receipt', async () => {
    const f = fixture();
    await f.host.request('native-A', 'release-receipt', { executionId: 'turn:1:2', operationId: 'op', state: 'applied', surfaceEventSeqs: [9], sourceEventSeqs: [3], releasedBytes: 700 });
    expect(f.order).toEqual(['durable-flush', 'http']);
    expect(JSON.parse(f.fetchMock.mock.calls[0]![1]!.body as string).actor).toBe('host');
    f.flush.mockRejectedValueOnce(new Error('not durable'));
    await expect(f.host.request('native-A', 'release-receipt', { executionId: 'turn:1:2' })).rejects.toThrow('not durable');
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });
  it('separates user previews and user pin authority from model operations', async () => {
    const f = fixture();
    await f.host.requestAsUser('native-A', 'pin', { operationId: 'pin-op', expectedRevision: 1, materialIds: ['m'], pinned: true });
    expect(JSON.parse(f.fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ actor: 'user', executionId: 'user:native-A' });
    expect(() => f.host.request('native-A', 'user-read', {})).toThrow('not a model read capability');
    expect(() => f.host.requestAsUser('native-A', 'release-receipt', {})).toThrow('native execution host');
    await f.host.requestAsUser('native-A', 'user-read', { referenceId: 'reference', userRequestId: 'request' });
    expect(f.flush).toHaveBeenCalledExactlyOnceWith('native-A');
  });
  it('does not fetch after cancellation or convert a failed engine receipt into success', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.host.request('native-A', 'status', { executionId: 'turn:1:2' }, controller.signal)).rejects.toThrow();
    expect(f.fetchMock).not.toHaveBeenCalled();
    f.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'CONTEXT_REVISION_CONFLICT', message: 'Refresh current context state' } }), { status: 409 }));
    await expect(f.host.request('native-A', 'status', { executionId: 'turn:1:2' })).rejects.toMatchObject({ code: 'CONTEXT_REVISION_CONFLICT', status: 409 });
  });
});
