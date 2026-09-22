import { Context } from '@deepseek-ai/cordis';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { v3NativeSessionId } from '@linmu/dsh-session-adapter-0-1-5';
import type { HostWorkspaceSyncRequest, LogicalSessionId } from '@linmu/dsh-session-contracts';
import { createHostWorkspaceSync } from '../src/host-workspace-sync.js';
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
      create: async (_path: string) => ({ attachSession: async (_id: string) => {} }) },
    storageDomain: { get: () => ({ table: () => ({ delete: async (id: string) => { cache.delete(id); } }) }) }, sessionQuery: { readSession: read } };
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
it('respects an existing kernel lock and succeeds after its owner releases it', async () => {
  const f = await fixture(); let lock: { release(): Promise<void> } | undefined;
  try {
    await f.sync.apply(f.body);
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
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
