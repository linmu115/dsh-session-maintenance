import { Context } from '@deepseek-ai/cordis';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { v3NativeSessionId } from '@linmu/dsh-session-adapter-0-1-5';
import type { HostWorkspaceSyncRequest, LogicalSessionId } from '@linmu/dsh-session-contracts';
import { createHostWorkspaceSync, decodeHostSyncPayload, pluginIdentityContext } from '../src/host-workspace-sync.js';
import { readEndpointSnapshot } from '@linmu/dsh-instance-integration-dsh/endpoint-snapshot';
const at = '2026-09-22T01:00:00.000Z';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'host-sync-SYNTHETIC-')), homeRoot = join(root, 'home'), sessionsRoot = join(homeRoot, 'sessions');
  await mkdir(sessionsRoot, { recursive: true }); await mkdir(join(homeRoot, 'storages'));
  const id = 'logical-one' as LogicalSessionId, nativeId = String(v3NativeSessionId(id));
  let state = { archivedSessionIds: [nativeId] };
  const persist = () => writeFile(join(homeRoot, 'storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, tables: { workspaces: {} }, global: state }));
  await persist();
  const official = new Context(); await official.plugin(JsonlPersistence, { root: sessionsRoot, compression: 'zstd' });
  const storage = (official as any).sessionPersistence;
  const live = new Map(), cache = new Map(), read = async (id: string) => { const handle = await storage.open(id, 'read'); try { return await handle.read(); } finally { await handle.close(); } };
  const runtime = { sessionPersistence: storage, sessions: { get: (id: string) => live.get(id), prepare: (id: string) => ({ id }), enter: (s: any) => live.set(s.id, s), flush: async () => true },
    workspaceRegistry: { get state() { return state; }, enqueueOperation: async (work: () => Promise<void>) => work(), setState: async (next: typeof state) => { state = next; await persist(); },
      indexHeader: async (_header: any) => {},
      create: async (_path: string) => ({ attachSession: async (_id: string) => {} }) },
    sessionProjectionCache: { hydratePrepared: () => {}, write: async (session: any) => { cache.set(session.id, true); } },
    storageDomain: { get: () => ({ table: () => ({ get: (id: string) => cache.get(id), delete: async (id: string) => { cache.delete(id); } }) }) }, sessionQuery: {
      observeSession: async (id: string) => { const value = await read(id); return { ...value, header: (await storage.stat(id)).header, inheritedEventCount: 0, [Symbol.dispose]() {} }; } } };
  const identity = { instanceId: 'synthetic-instance', profileId: 'web', homeRoot, pid: process.pid, processStartedAt: at, runtimeUrl: null };
  const sync = createHostWorkspaceSync({ runtime, identity, stateRoot: join(root, 'maintenance'), connection: { current: async () => ({ origin: 'http://127.0.0.1:1', token: 'synthetic-secret-'.repeat(3) }) }, timeoutMs: 10 });
  const request = { schemaVersion: 1, operationId: 'operation-one', ...identity, workspaceRoot: join(root, 'workspaces'),
    selection: { revision: 1, selection: { kind: 'ids', workspaceIds: ['w'], includeUnassigned: false } }, workspaceNames: [['w', 'Synthetic']],
    projection: { run: { id: 'sync', instanceId: identity.instanceId, profileId: identity.profileId }, workspaces: [], sessions: [{
      session: { schemaVersion: 1, id, authorityScope: 'maintenance', originKind: 'maintenance-native', headVersionId: 'version-one', title: 'Synthetic', tags: [], archivedAt: null,
        tombstonedAt: null, createdAt: at, updatedAt: at }, workspaceId: 'w', projectRoot: join(root, 'workspaces', 'Synthetic'),
      events: [{ schemaVersion: 1, id: 'event-one', logicalSessionId: id, sequence: 0, kind: 'user-message', role: 'user', content: { text: 'Synthetic hello' }, contentDigest: 'sha256:synthetic',
        source: { platform: 'dsh', instanceId: identity.instanceId, sessionId: nativeId, eventId: '0', cursor: '0' }, extensions: { nativeFormatVersion: 3 },
        rawPayload: { seq: 0, time: Date.parse(at), type: 'user/message', surfaceOp: 'append', data: { id: 'event-one', role: 'user', content: [{ type: 'text', text: 'Synthetic hello' }], source: { kind: 'user' } } } }],
    }] } };
  const { runtimeUrl: _, ...body } = request;
  return { root, sync, runtime, storage, live, nativeId, body: body as unknown as HostWorkspaceSyncRequest, read,
    cleanup: async () => { sync.dispose(); await official.fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
}
it('writes under the official kernel lock, restores archive state, reads through host persistence, and releases for ordinary writers', async () => {
  const f = await fixture();
  try {
    const result = await f.sync.apply(f.body);
    expect(result.summary.failures).toEqual([]); expect(result.summary.written).toBe(1);
    expect(result.bindings).toEqual([{ nativeSessionId: f.nativeId, logicalSessionId: 'logical-one' }]);
    expect((await f.read(f.nativeId)).events[0].data.content[0].text).toBe('Synthetic hello');
    expect(f.runtime.workspaceRegistry.state.archivedSessionIds).toEqual([]);
    const writer = await f.storage.open(f.nativeId, 'write'); await writer.close();
    const second = await f.sync.apply({ ...f.body, operationId: 'operation-two' }); expect(second.summary.written).toBe(0);
  } finally { await f.cleanup(); }
});
it('recovers a failed refresh before a retry skips already-written sessions', async () => {
  const f = await fixture();
  const original = f.runtime.sessionQuery.observeSession;
  let broken = true, reads = 0;
  f.runtime.sessionQuery.observeSession = async id => { reads++; if (broken) throw new Error('cache refresh failed'); return original(id); };
  try {
    await expect(f.sync.apply(f.body)).rejects.toMatchObject({ message: 'SYNC_HOST_REFRESH_REPLAY_FAILED', cause: { message: 'cache refresh failed' } });
    broken = false;
    const next = await f.sync.apply({ ...f.body, operationId: 'recovery-retry' });
    expect(next.summary.failures).toEqual([]); expect(next.summary.unchanged).toBe(1);
    expect(reads).toBeGreaterThan(1);
    const writer = await f.storage.open(f.nativeId, 'write'); await writer.close();
  } finally { broken = false; await f.cleanup(); }
});

it('keeps the original native identity on its owning endpoint across alignment and archive restoration', async () => {
  const f = await fixture();
  try {
    const originalId = 'session-native-owner';
    const session = f.body.projection.sessions[0]!;
    const body = { ...f.body, projection: { ...f.body.projection,
      run: { ...f.body.projection.run, id: `write-back-${f.body.instanceId}` },
      sessions: [{ ...session, events: session.events.map(event => ({ ...event, source: { ...event.source, sessionId: originalId } })) }] } } as HostWorkspaceSyncRequest;
    const receipt = await f.sync.apply(body);
    expect(receipt.bindings).toEqual([{ nativeSessionId: originalId, logicalSessionId: session.session.id }]);
    expect((await f.storage.list()).map((row: any) => row.header.id)).toEqual([originalId]);
    expect((await f.sync.apply(body)).summary.written).toBe(0);
    const renamed = { ...body, projection: { ...body.projection, sessions: body.projection.sessions.map(item => ({ ...item,
      session: { ...item.session, title: 'Maintenance renamed' } })) } };
    await f.sync.apply(renamed);
    expect((await f.read(originalId)).events.at(-1).data.title).toBe('Maintenance renamed');
    const writer = await f.storage.open(originalId, 'write');
    const beforeAppend = (await f.read(originalId)).events;
    await writer.append([{ seq: beforeAppend.length, time: Date.parse(at) + 2, type: 'user/message', surfaceOp: 'append',
      data: { id: 'after-rename', role: 'user', content: [{ type: 'text', text: 'continued after Maintenance rename' }], source: { kind: 'user' } } }]);
    await writer.flush(); await writer.close();
    const snapshot = await readEndpointSnapshot({ homeRoot: f.body.homeRoot, endpointId: f.body.instanceId,
      nativeSessionId: originalId, logicalSessionId: session.session.id, projection: renamed.projection,
      stateRoot: join(f.root, 'maintenance'), workspaceRoot: f.body.workspaceRoot,
      folders: [{ workspaceId: 'w', path: join(f.body.workspaceRoot, 'Synthetic') }] });
    const continued = { ...renamed, projection: { ...renamed.projection, sessions: [{ ...renamed.projection.sessions[0]!, events: snapshot.events }] } };
    expect((await f.sync.apply(continued)).summary.failures).toEqual([]);
    expect((await f.read(originalId)).events.map((event: any) => event.seq)).toEqual([0, 1, 2, 3]);
    expect((await f.read(originalId)).events.at(-1).data.id).toBe('after-rename');
    // Archive changes must use the latest complete canonical revision.
    body.projection = continued.projection;
    const archived = { ...body, projection: { ...body.projection, sessions: body.projection.sessions.map(item => ({ ...item, session: { ...item.session, archivedAt: at } })) } };
    await f.sync.apply(archived);
    expect(f.runtime.workspaceRegistry.state.archivedSessionIds).toContain(originalId);
    await f.sync.apply(body);
    expect(f.runtime.workspaceRegistry.state.archivedSessionIds).not.toContain(originalId);
    expect((await f.storage.list()).map((row: any) => row.header.id)).toEqual([originalId]);
  } finally { await f.cleanup(); }
});
it('respects an existing kernel lock and succeeds after its owner releases it', async () => {
  const f = await fixture(); let lock: { release(): Promise<void> } | undefined;
  try {
    await f.sync.apply(f.body);
    (f.body.projection.sessions[0]!.session as any).archivedAt = at;
    lock = await f.storage.acquireWriteLease((await f.storage.stat(f.nativeId)).header);
    await expect(f.sync.apply({ ...f.body, operationId: 'contended' })).rejects.toThrow();
    expect((await f.read(f.nativeId)).events).toHaveLength(1);
    await lock!.release(); lock = undefined;
    expect((await f.sync.apply({ ...f.body, operationId: 'retry' })).summary.failures).toEqual([]);
  } finally { await lock?.release(); await f.cleanup(); }
});
it('does not overwrite new conversation data produced while the host is draining', async () => {
  const f = await fixture();
  try {
    await f.sync.apply(f.body);
    (f.body.projection.sessions[0]!.session as any).archivedAt = at;
    const writer = await f.storage.open(f.nativeId, 'write'); f.live.set(f.nativeId, { id: f.nativeId });
    f.runtime.sessions.flush = async () => {
      await writer.append([{ seq: 1, time: Date.parse(at) + 1, type: 'user/message', surfaceOp: 'append',
        data: { id: 'new-turn', role: 'user', content: [{ type: 'text', text: 'new data while draining' }], source: { kind: 'user' } } }]);
      await writer.flush(); await writer.close(); f.live.delete(f.nativeId); return true;
    };
    await expect(f.sync.apply({ ...f.body, operationId: 'changed' })).rejects.toThrow('CHANGED_DURING_DRAIN');
    expect((await f.read(f.nativeId)).events).toHaveLength(2);
  } finally { await f.cleanup(); }
});
it('retains plugin source data and restores it only through a plugin adapter to its normal storage', async () => {
  const f = await fixture();
  try {
    const session = f.body.projection.sessions[0]!, original = session.events[0]!;
    const pluginEvent = { ...original, id: 'plugin-one', sequence: 1, kind: 'system-metadata' as const, role: 'system' as const,
      content: { key: 'checkpoint', state: { nested: [null, 'plugin-owned'] } },
      extensions: { nativeFormatVersion: 3, extensionNamespace: 'gpt-compat', dshEventType: 'context/checkpoint' },
      rawPayload: { seq: 1, time: Date.parse(at), type: 'context/checkpoint', data: { key: 'checkpoint', state: { nested: [null, 'plugin-owned'] } } } };
    const body = { ...f.body, projection: { ...f.body.projection, sessions: [{ ...session, events: [original, pluginEvent,
      { ...original, id: 'second-user', sequence: 2, rawPayload: { ...(original.rawPayload as any), seq: 2, data: { ...(original.rawPayload as any).data, id: 'second-user' } } },
    ] }] } };
    const before = JSON.stringify(body);
    expect((await f.sync.apply(body)).summary.failures).toEqual([]);
    expect((await f.read(f.nativeId)).events.map((event: any) => [event.seq, event.type])).toEqual([[0, 'user/message'], [1, 'user/message']]);
    const writer = await f.storage.open(f.nativeId, 'write');
    await writer.append([{ seq: 2, time: Date.parse(at), type: 'user/message', surfaceOp: 'append',
      data: { id: 'continued', role: 'user', content: [{ type: 'text', text: 'continued without plugin' }], source: { kind: 'user' } } }]);
    await writer.flush(); await writer.close();
    const snapshot = await readEndpointSnapshot({ homeRoot: body.homeRoot, endpointId: body.instanceId, nativeSessionId: f.nativeId,
      logicalSessionId: session.session.id, projection: body.projection, stateRoot: join(f.root, 'maintenance'), workspaceRoot: body.workspaceRoot,
      folders: [{ workspaceId: 'w', path: join(body.workspaceRoot, 'Synthetic') }] });
    expect(snapshot.events.slice(0, 3)).toEqual(body.projection.sessions[0]!.events);
    expect(snapshot.events).toHaveLength(4);
    expect((snapshot.events[3]!.rawPayload as any).seq).toBe(2);
    expect((snapshot.events[3]!.extensions.nativeProjectionEvent as any).seq).toBe(3);
    const continuedBody = { ...body, projection: { ...body.projection, sessions: [{ ...body.projection.sessions[0]!, events: snapshot.events }] } };
    expect((await f.sync.apply({ ...continuedBody, operationId: 'continued' })).summary.failures).toEqual([]);
    expect((await f.read(f.nativeId)).events).toHaveLength(3);
    const path = join(f.root, 'plugin-owned-checkpoint.json');
    f.sync.pluginData.register({ namespace: 'gpt-compat', handshake: async type => type === 'context/checkpoint',
      restore: async (record, target) => {
        expect(target.sessionId).toBe(f.nativeId); expect(target.endpointId).toBe(body.instanceId);
        expect((target.context as any).cwd).toBe(join(body.workspaceRoot, 'Synthetic'));
        await writeFile(path, JSON.stringify(record.value)); return { kind: 'plugin-storage', receiptId: record.recordId };
      },
      verify: async record => JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) === JSON.stringify(record.value) });
    expect((await f.sync.apply({ ...continuedBody, operationId: 'plugin-present' })).summary.failures).toEqual([]);
    expect(JSON.parse(await readFile(path, 'utf8')).data.state.nested).toEqual([null, 'plugin-owned']);
    expect(JSON.stringify(body)).toBe(before);
  } finally { await f.cleanup(); }
});
it('rejects another host identity and an out-of-scope request before creating files', async () => {
  const f = await fixture(); try {
    await expect(f.sync.apply({ ...f.body, pid: process.pid + 1 })).rejects.toThrow('IDENTITY_MISMATCH');
    await expect(f.sync.apply({ ...f.body, selection: { revision: 1, selection: { kind: 'ids', workspaceIds: [], includeUnassigned: false } } })).rejects.toThrow('SCOPE_MISMATCH');
    expect(await f.storage.list()).toEqual([]);
  } finally { await f.cleanup(); }
});
it('authenticates host-only HTTP requests and returns matching operation receipts', async () => {
  const f = await fixture(), server = createServer((req, res) => { void f.sync.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/dsh-session-maintenance/instance/workspace-sync`;
  try {
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    const headers = { authorization: `Bearer ${'synthetic-secret-'.repeat(3)}`, 'content-type': 'application/json' };
    expect((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'http://localhost' }, body: '{}' })).status).toBe(403);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(f.body) }); expect(response.status).toBe(200);
    expect((await response.json()).operationId).toBe(f.body.operationId);
    const zipped = await fetch(url, { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: gzipSync(JSON.stringify(f.body)) });
    expect(zipped.status).toBe(200);
    expect((await zipped.json()).operationId).toBe(f.body.operationId);
    f.live.set(f.nativeId, { id: f.nativeId });
    (f.body.projection.sessions[0]!.session as any).archivedAt = at;
    const refused = await fetch(url, { method: 'POST', headers, body: JSON.stringify(f.body) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: 'HOST_SYNC_INCOMPLETE', reason: 'DSH_BUSY', stage: 'drain' });
    f.live.delete(f.nativeId);

  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

it('decodes compressed snapshots losslessly and bounds decompression before JSON parsing', async () => {
  const value = { plugin: { unknown: ['原样保留', null, { nested: true }] } };
  expect(await decodeHostSyncPayload(gzipSync(JSON.stringify(value)), 'gzip')).toEqual(value);
  await expect(decodeHostSyncPayload(gzipSync('x'.repeat(4096)), 'gzip', 1024)).rejects.toThrow('HOST_BODY_TOO_LARGE');
  await expect(decodeHostSyncPayload(Buffer.alloc(4096), undefined, 1024)).rejects.toThrow('HOST_BODY_TOO_LARGE');
  await expect(decodeHostSyncPayload(Buffer.from('bad'), 'gzip')).rejects.toThrow('HOST_PAYLOAD_INVALID');
  await expect(decodeHostSyncPayload(Buffer.from('{}'), 'br')).rejects.toThrow('HOST_CONTENT_ENCODING_UNSUPPORTED');
});

it('acknowledges an exact unchanged live session without waiting for it to detach or interrupting its writer', async () => {
  const f = await fixture();
  try {
    await f.sync.apply(f.body);
    f.live.set(f.nativeId, { id: f.nativeId });
    const writer = await f.storage.open(f.nativeId, 'write');
    const result = await f.sync.apply({ ...f.body, operationId: 'unchanged-live' });
    expect(result.summary).toMatchObject({ written: 0, unchanged: 1, failures: [] });
    expect(f.live.has(f.nativeId)).toBe(true);
    await writer.append([{ seq: 1, time: Date.parse(at) + 1, type: 'user/message', surfaceOp: 'append',
      data: { id: 'after-check', role: 'user', content: [{ type: 'text', text: 'still writable' }], source: { kind: 'user' } } }]);
    await writer.flush(); await writer.close(); f.live.delete(f.nativeId);
    expect((await f.read(f.nativeId)).events).toHaveLength(2);
  } finally { await f.cleanup(); }
});

it('bounds plugin identity context by sessions for a long multi-turn history', async () => {
  const f = await fixture();
  try {
    const item = f.body.projection.sessions[0]!, event = item.events[0]!;
    const projection = { ...f.body.projection, sessions: [{ ...item,
      events: Array.from({ length: 20000 }, (_, sequence) => ({ ...event, sequence })) }] };
    const context = pluginIdentityContext(projection);
    expect(context.identities).toEqual([{ endpointId: event.source.instanceId, sourceSessionId: event.source.sessionId, targetSessionId: f.nativeId }]);
    expect(context.sessions).toHaveLength(1);
  } finally { await f.cleanup(); }
});
it('checks plugin conflicts before changing any native session bytes', async () => {
  const f = await fixture();
  try {
    await f.sync.apply(f.body);
    const before = await f.read(f.nativeId);
    let blocked = true, writes = 0;
    f.sync.pluginData.register({ namespace: 'fixture-plugin', handshake: async () => true,
      validate: async () => { if (blocked) throw new Error('PLUGIN_SOURCE_CONFLICT'); },
      restore: async record => { writes++; return { kind: 'plugin-storage', receiptId: record.recordId }; },
      verify: async () => true });
    const item = f.body.projection.sessions[0]!;
    const request = { ...f.body, projection: { ...f.body.projection, sessions: [{ ...item,
      session: { ...item.session, title: 'Changed title' },
      pluginData: [{ namespace: 'fixture-plugin', dataType: 'fixture', recordId: '1', value: { changed: true } }] }] } };
    await expect(f.sync.apply(request)).rejects.toThrow('PLUGIN_SOURCE_CONFLICT');
    expect(await f.read(f.nativeId)).toEqual(before); expect(writes).toBe(0);
    blocked = false;
    expect((await f.sync.apply(request)).summary.failures).toEqual([]);
    expect(writes).toBe(1);
  } finally { await f.cleanup(); }
});

it('does not mistake query-only interrupted-turn closers for a persisted runtime tail', async () => {
  const f = await fixture();
  try {
    await f.sync.apply(f.body);
    const original = f.runtime.sessionQuery.observeSession;
    f.runtime.sessionQuery.observeSession = async id => {
      const value = await original(id);
      return { ...value, events: [...value.events, { seq: value.events.length, time: Date.parse(at), type: 'turn/end', data: {} }] };
    };
    (f.body.projection.sessions[0]!.session as any).archivedAt = at;
    expect((await f.sync.apply(f.body)).summary.failures).toEqual([]);
    expect((await f.read(f.nativeId)).events).toHaveLength(1);
  } finally { await f.cleanup(); }
});

it('refreshes the RC2 workspace header index before attaching a moved session', async () => {
  const f = await fixture(), headers = new Map<string, string>();
  f.runtime.workspaceRegistry.indexHeader = async header => { headers.set(header.id, header.cwd); };
  f.runtime.workspaceRegistry.create = async path => ({ attachSession: async id => { expect(headers.get(id)).toBe(path); } });
  try {
    await f.sync.apply(f.body);
    const previous = headers.get(f.nativeId);
    const moved = { ...f.body, workspaceNames: [['moved', 'Moved']],
      selection: { revision: 2, selection: { kind: 'ids', workspaceIds: ['moved'], includeUnassigned: false } },
      projection: { ...f.body.projection, sessions: f.body.projection.sessions.map(item => ({ ...item, workspaceId: 'moved',
        projectRoot: join(f.body.workspaceRoot, 'Moved') })) } } as HostWorkspaceSyncRequest;
    expect((await f.sync.apply(moved)).summary.failures).toEqual([]);
    expect(headers.get(f.nativeId)).not.toBe(previous);
    expect(headers.get(f.nativeId)).toBe((await f.storage.stat(f.nativeId)).header.cwd);
  } finally { await f.cleanup(); }
});

it('preserves a persisted runtime tail that predates the alignment request', async () => {
  const f = await fixture();
  try {
    await f.sync.apply(f.body);
    const writer = await f.storage.open(f.nativeId, 'write');
    await writer.append([{ seq: 1, time: Date.parse(at) + 1, type: 'user/message', surfaceOp: 'append',
      data: { id: 'new-tail', role: 'user', content: [{ type: 'text', text: 'must survive restart' }], source: { kind: 'user' } } }]);
    await writer.flush(); await writer.close();
    const before = await f.read(f.nativeId);
    await expect(f.sync.apply(f.body)).rejects.toThrow('SYNC_HOST_NATIVE_AHEAD');
    expect(await f.read(f.nativeId)).toEqual(before);
  } finally { await f.cleanup(); }
});
