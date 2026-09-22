import { isDeepStrictEqual } from 'node:util';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostWorkspaceSyncSchema, hostPluginDataCaptureSchema, type HostWorkspaceSyncRequest, type HostWorkspaceSyncReceipt, type LogicalWorkspaceId } from '@linmu/dsh-session-contracts';
import { HostWriteBarrier, type HostBarrierRuntime } from '@linmu/dsh-instance-integration-dsh/host-write-barrier';
import { inspectUnchangedInstanceSessions, writeBackInstanceWorkspaces } from '@linmu/dsh-instance-integration-dsh/instance-write-back';
import { HOST_WORKSPACE_SYNC_PATH } from '@linmu/dsh-instance-integration-dsh/host-workspace-sync';
import { v3NativeSessionId } from '@linmu/dsh-session-adapter-0-1-5';
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache';
import type { InstanceLeaseIdentity } from './instance-lease.js';
import type { EngineConnectionProvider } from './engine-proxy.js';
import { PluginDataMappingRegistry } from '@linmu/dsh-session-adapter-host';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionId } from '@deepseek-ai/dsh-session';

const decompress = promisify(gunzip);
/** Bound decompression before JSON parsing; authentication is checked by the caller first. */
export async function decodeHostSyncPayload(bytes: Buffer, encoding: string | undefined, limit = 256 * 1024 * 1024): Promise<unknown> {
  if (encoding !== undefined && encoding !== 'identity' && encoding !== 'gzip') throw new Error('HOST_CONTENT_ENCODING_UNSUPPORTED');
  let decoded: Buffer;
  try { decoded = encoding === 'gzip' ? await decompress(bytes, { maxOutputLength: limit }) : bytes; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error('HOST_BODY_TOO_LARGE');
    throw new Error('HOST_PAYLOAD_INVALID');
  }
  if (decoded.length > limit) throw new Error('HOST_BODY_TOO_LARGE');
  return JSON.parse(decoded.toString('utf8'));
}

/** RC2-only binding. All native service and archive knowledge stays on the host side. */
export function createHostWorkspaceSync(input: { runtime: HostBarrierRuntime & Record<string, any>; identity: InstanceLeaseIdentity;
  stateRoot: string; connection: EngineConnectionProvider; timeoutMs?: number; pluginData?: PluginDataMappingRegistry }) {
  const ctx = input.runtime, storage = ctx.sessionPersistence as any;
  if (!(storage instanceof JsonlPersistence) || typeof storage.acquireWriteLease !== 'function' || typeof storage.list !== 'function'
    || typeof ctx.workspaceRegistry?.enqueueOperation !== 'function' || typeof ctx.workspaceRegistry?.setState !== 'function')
    throw new Error('SYNC_HOST_UNSUPPORTED');
  const barrier = new HostWriteBarrier(ctx, input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs });
  const pluginData = input.pluginData ?? new PluginDataMappingRegistry();
  const apply = async (body: HostWorkspaceSyncRequest, stage: (value: string) => void = () => {}): Promise<HostWorkspaceSyncReceipt> => {
    stage('identity');
    hostWorkspaceSyncSchema.parse(body);
    const identity = input.identity;
    if (body.instanceId !== identity.instanceId || body.profileId !== identity.profileId || body.pid !== identity.pid
      || body.processStartedAt !== identity.processStartedAt || resolve(body.homeRoot) !== resolve(identity.homeRoot)
      || body.projection.run.instanceId !== identity.instanceId || body.projection.run.profileId !== identity.profileId)
      throw new Error('SYNC_HOST_IDENTITY_MISMATCH');
    if (await realpath(storage.config.root) !== await realpath(join(identity.homeRoot, 'sessions'))) throw new Error('SYNC_HOST_STORAGE_MISMATCH');
    const selected = (id: string | null) => body.selection.selection.kind === 'all' || (id === null
      ? body.selection.selection.includeUnassigned : body.selection.selection.workspaceIds.includes(id));
    if (body.projection.sessions.some(item => !selected(item.workspaceId) || item.events.some(event => event.logicalSessionId !== item.session.id && item.session.originKind !== 'codex-derived')))
      throw new Error('SYNC_HOST_SCOPE_MISMATCH');
    const allIds = body.projection.sessions.map(item => String(v3NativeSessionId(item.session.id)));
    if (new Set(allIds).size !== allIds.length) throw new Error('SYNC_HOST_DUPLICATE_SESSION');
    stage('inspect');
    const unchanged = new Set<string>();
    const evidence = await inspectUnchangedInstanceSessions({ stateRoot: input.stateRoot, workspaceRoot: body.workspaceRoot,
      instanceHome: identity.homeRoot, instanceId: identity.instanceId, projection: body.projection, names: new Map(body.workspaceNames) });
    for (const item of body.projection.sessions) {
      const id = String(v3NativeSessionId(item.session.id)), confirm = evidence.get(id);
      if (!confirm) continue;
      const actual = await pluginData.capture({ endpointId: identity.instanceId, sessionId: id, context: { profileId: identity.profileId } });
      const expected = item.pluginData ?? [];
      // Missing source data never requests deletion of extra host-owned records.
      const same = expected.every(record => actual.some(other => other.namespace === record.namespace
        && other.dataType === record.dataType && other.recordId === record.recordId && isDeepStrictEqual(other.value, record.value)));
      if (!same) continue;
      await confirm(); unchanged.add(id);
    }
    const projection = { ...body.projection, sessions: body.projection.sessions.filter(item => !unchanged.has(String(v3NativeSessionId(item.session.id)))) };
    const ids = projection.sessions.map(item => String(v3NativeSessionId(item.session.id)));
    if (new Set(ids).size !== ids.length) throw new Error('SYNC_HOST_DUPLICATE_SESSION');
    const bindings: HostWorkspaceSyncReceipt['bindings'] = body.projection.sessions.filter(item => unchanged.has(String(v3NativeSessionId(item.session.id))))
      .map(item => ({ nativeSessionId: String(v3NativeSessionId(item.session.id)), logicalSessionId: String(item.session.id) }));
    const mapping = pluginData.begin();
    const held: { release(): Promise<void> }[] = [];
    const before = new Map<string, string>((await storage.list()).filter((row: any) => ids.includes(row.header.id))
      .map((row: any) => [row.header.id, JSON.stringify(row.revision)]));
    const refresh = async () => {
      stage('refresh');
      const domain = ctx.storageDomain.get(projectionCacheDomainSpec.name);
      if (!domain) throw new Error('SYNC_HOST_CACHE_UNAVAILABLE');
      const table = domain.table('sessions');
      for (const id of ids) {
        await table.delete(id);
        const snapshot = await storage.stat(SessionId(id));
        if (snapshot) {
          const workspace = await ctx.workspaceRegistry.create(snapshot.header.cwd);
          await workspace.attachSession(id);
          await ctx.sessionQuery.readSession(id);
        }
      }
      await mapping.verify();
    };
    stage('drain');
    const summary = await barrier.withAccess(ids, async () => {
        stage('materialize');
        return await writeBackInstanceWorkspaces({ stateRoot: input.stateRoot, workspaceRoot: body.workspaceRoot, pluginData: mapping,
          backupRoot: join(input.stateRoot, 'backups', 'write-back'), journalPath: join(input.stateRoot, 'logs', 'instance-write-back.jsonl'),
          selectionFor: () => body.selection, memberships: async () => new Map(body.projection.sessions.map(item => [item.session.id, item.workspaceId])),
          workspaceNames: async () => new Map(body.workspaceNames), loadProjection: async () => projection,
          withWriteAccess: work => work(),
          withNativeLocks: async (sessions, work) => {
            stage('lock');
            const current = await storage.list(), keys = new Set<string>();
            for (const header of [...current.filter((row: any) => ids.includes(row.header.id)).map((row: any) => row.header),
              ...sessions.map(session => (session.payload as any).header)]) {
              const key = JSON.stringify([header.id, resolve(header.cwd)]); if (keys.has(key)) continue; keys.add(key);
              held.push(await storage.acquireWriteLease(header));
            }
            const after = new Map<string, string>((await storage.list()).filter((row: any) => ids.includes(row.header.id))
              .map((row: any) => [row.header.id, JSON.stringify(row.revision)]));
            if (ids.some(id => before.get(id) !== after.get(id))) throw new Error('SYNC_HOST_CHANGED_DURING_DRAIN');
            stage('write');
            const result = await work();
            stage('plugin-restore');
            for (const item of projection.sessions) {
              const nativeId = String(v3NativeSessionId(item.session.id));
              const header = (sessions.find(session => session.nativeSessionId === nativeId)?.payload as any)?.header;
              if (!header) continue;
              for (const record of item.pluginData ?? []) await mapping.map(record, { endpointId: identity.instanceId, sessionId: nativeId,
                context: { profileId: identity.profileId, cwd: header.cwd,
                  identities: body.projection.sessions.flatMap(session => session.events.filter(event => event.logicalSessionId === session.session.id).map(event => ({ endpointId: event.source.instanceId,
                    sourceSessionId: String(event.source.sessionId), targetSessionId: String(v3NativeSessionId(session.session.id)) }))),
                  sessions: body.projection.sessions.map(session => ({ logicalSessionId: session.session.id, nativeSessionId: String(v3NativeSessionId(session.session.id)) })) } });
            }
            return result;
          },
          synchronizeArchived: async changes => {
            await ctx.workspaceRegistry.enqueueOperation(async () => {
              const next = new Set<string>(ctx.workspaceRegistry.state.archivedSessionIds);
              for (const item of changes) item.archived ? next.add(item.nativeSessionId) : next.delete(item.nativeSessionId);
              await ctx.workspaceRegistry.setState({ ...ctx.workspaceRegistry.state, archivedSessionIds: [...next] });
            });
          },
          bindIdentity: async (nativeSessionId, logicalSessionId, checkOnly) => { if (!checkOnly) bindings.push({ nativeSessionId, logicalSessionId }); },
        }, { instanceId: identity.instanceId, profileId: identity.profileId, instanceHome: identity.homeRoot, sessionsRoot: storage.config.root });
    }, refresh, async () => {
      const releasing = held.splice(0).reverse();
      const results = await Promise.allSettled(releasing.map(lock => lock.release()));
      results.forEach((result, index) => { if (result.status === 'rejected') held.push(releasing[index]!); });
      if (results.some(result => result.status === 'rejected')) throw new Error('SYNC_HOST_LOCK_RELEASE_FAILED');
    }, action => pluginData.withAccess(ids.map(sessionId => ({ endpointId: identity.instanceId, sessionId, context: { profileId: identity.profileId } })), action));
    return { schemaVersion: 1, operationId: body.operationId, instanceId: identity.instanceId, profileId: identity.profileId,
      pid: identity.pid, processStartedAt: identity.processStartedAt, summary: { ...summary, unchanged: summary.unchanged + unchanged.size, pluginData: mapping.counts }, bindings };
  };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    let failureStage = 'request';
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method !== 'POST' || ![HOST_WORKSPACE_SYNC_PATH, HOST_WORKSPACE_SYNC_PATH + '/plugin-data'].includes(path)) return send(404, { code: 'NOT_FOUND' });
      if (request.headers.origin || request.headers['sec-fetch-site']) return send(403, { code: 'HOST_ONLY' });
      const expected = Buffer.from(`Bearer ${(await input.connection.current()).token}`), actual = Buffer.from(request.headers.authorization ?? '');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return send(401, { code: 'UNAUTHORIZED' });
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 64 * 1024 * 1024) return send(413, { code: 'BODY_TOO_LARGE' }); chunks.push(bytes); }
      const json = await decodeHostSyncPayload(Buffer.concat(chunks), request.headers['content-encoding']);
      if (path.endsWith('/plugin-data')) {
        const query = hostPluginDataCaptureSchema.parse(json), identity = input.identity;
        if (query.instanceId !== identity.instanceId || query.profileId !== identity.profileId || query.pid !== identity.pid
          || query.processStartedAt !== identity.processStartedAt || resolve(query.homeRoot) !== resolve(identity.homeRoot)) throw new Error('SYNC_HOST_IDENTITY_MISMATCH');
        return send(200, { ...query, records: await pluginData.capture({ endpointId: identity.instanceId, sessionId: query.sessionId,
          context: { profileId: identity.profileId } }) });
      }
      const body = hostWorkspaceSyncSchema.parse(json) as unknown as HostWorkspaceSyncRequest;
      return send(200, await apply(body, value => { failureStage = value; }));
    } catch (error) {
      // Only bounded, recognized codes leave this process; never return paths, payloads or tokens.
      const raw = error instanceof Error ? error.message : '';
      const candidate = raw.split(':', 1)[0]!;
      const reason = /^(?:SYNC_HOST_[A-Z_]+|HOST_[A-Z_]+|DSH_BUSY|LYNN_BUSY)$/.test(candidate) ? candidate : 'HOST_SYNC_INCOMPLETE';
      return send(reason === 'HOST_BODY_TOO_LARGE' ? 413 : 409, { code: 'HOST_SYNC_INCOMPLETE', reason, stage: failureStage });
    }
  };
  return { apply, handler, pluginData, dispose: () => barrier.dispose() };
}
