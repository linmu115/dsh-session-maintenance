import { randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { IntegrationError, hostWorkspaceSyncSchema, hostWorkspaceSyncReceiptSchema, pluginDataRecordSchema, type PluginDataRecord, type HostWorkspaceSyncRequest } from '@linmu/dsh-session-contracts';
import { v3NativeSessionId } from '@linmu/dsh-session-adapter-0-1-5';
import { inspectInstanceLease } from './instance-lease.js';
import { readDeclaredProfileIdentity } from './profile-identity.js';
import { writeBackRunIdentity, type InstanceWriteBackOptions, type InstanceWriteBackRequest } from './instance-write-back.js';

export const HOST_WORKSPACE_SYNC_PATH = '/dsh-session-maintenance/instance/workspace-sync';
const compress = promisify(gzip);

/** The published Maintenance identity is not necessarily the profile directory name. */
export async function resolveHostProfileRoot(homeRoot: string, instanceId: string, profileId: string): Promise<string | null> {
  const profilesRoot = join(homeRoot, 'profiles');
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(profilesRoot, entry.name);
    const declared = await readDeclaredProfileIdentity(root);
    if (declared.declared && declared.instanceId === instanceId && declared.profileId === profileId) matches.push(root);
  }
  if (matches.length > 1) throw new IntegrationError('SYNC_HOST_PROFILE_AMBIGUOUS', '多个配置目录声明了相同的宿主身份，无法确定同步目标。');
  return matches[0] ?? null;
}

export async function readHostPluginData(input: { stateRoot: string; instanceId: string; profileId: string; homeRoot: string; sessionId: string }, transport: typeof fetch = fetch): Promise<PluginDataRecord[]> {
  const lease = await inspectInstanceLease(input.stateRoot, { instanceId: input.instanceId, profileId: input.profileId,
    expectedHomeRoot: input.homeRoot, profileRoot: await resolveHostProfileRoot(input.homeRoot, input.instanceId, input.profileId) });
  if (!lease.process || !lease.runtimeUrl || lease.state === 'stopping') throw new IntegrationError('PLUGIN_HOST_UNAVAILABLE', '插件原数据读取需要已核验的运行宿主。');
  const origin = new URL(lease.runtimeUrl);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password) throw new IntegrationError('PLUGIN_HOST_INVALID', '插件宿主地址不可信。');
  const descriptor = JSON.parse(await readFile(join(input.stateRoot, 'connection.json'), 'utf8'));
  if (typeof descriptor.token !== 'string' || descriptor.token.length < 32) throw new IntegrationError('PLUGIN_HOST_AUTH_UNAVAILABLE', '插件宿主认证未就绪。');
  const query = { schemaVersion: 1, instanceId: input.instanceId, profileId: input.profileId, homeRoot: input.homeRoot,
    sessionId: input.sessionId, pid: lease.process.pid, processStartedAt: lease.process.startedAt };
  const response = await transport(new URL(HOST_WORKSPACE_SYNC_PATH + '/plugin-data', origin), { method: 'POST',
    headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' }, body: JSON.stringify(query),
    signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new IntegrationError('PLUGIN_HOST_CAPTURE_FAILED', `插件原数据读取未完成（HTTP ${response.status}）。`);
  const result = await response.json() as Record<string, unknown>;
  if (Object.entries(query).some(([key, value]) => result[key] !== value) || !Array.isArray(result.records)) throw new IntegrationError('PLUGIN_HOST_RECEIPT_MISMATCH', '插件数据回执不属于本次会话。');
  return result.records.map(record => pluginDataRecordSchema.parse(record));
}

/** No physical write happens in the caller. A timed-out caller cannot retain a stale filesystem lease. */
export async function synchronizeThroughHost(options: InstanceWriteBackOptions & { withStoreAccess?: <T>(work: () => Promise<T>) => Promise<T> }, request: InstanceWriteBackRequest,
  transport: typeof fetch = fetch) {
  const inspection = await inspectInstanceLease(options.stateRoot, { instanceId: request.instanceId, profileId: request.profileId,
    expectedHomeRoot: request.instanceHome, profileRoot: await resolveHostProfileRoot(request.instanceHome, request.instanceId, request.profileId) });
  if (!inspection.process || !inspection.runtimeUrl || inspection.state === 'stopping') throw new IntegrationError('SYNC_HOST_UNAVAILABLE', '尚未取得正在运行的宿主身份，请重新检查实例。');
  const processIdentity = inspection.process;
  const origin = new URL(inspection.runtimeUrl);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password)
    throw new IntegrationError('SYNC_HOST_UNAVAILABLE', '宿主地址未通过本地身份检查。');
  const descriptor = JSON.parse(await readFile(join(options.stateRoot, 'connection.json'), 'utf8'));
  if (descriptor.schemaVersion !== 1 || typeof descriptor.token !== 'string' || descriptor.token.length < 32) throw new IntegrationError('SYNC_HOST_AUTH_UNAVAILABLE', '同步认证尚未就绪。');
  const inStore = options.withStoreAccess ?? (<T>(work: () => Promise<T>) => work());
  const { body, scoped } = await inStore(async () => {
  const projection = structuredClone(await options.loadProjection(writeBackRunIdentity(request.instanceId, request.profileId)));
  const selection = options.selectionFor(request.instanceId);
  const selected = (workspaceId: string | null) => selection.selection.kind === 'all' || (workspaceId === null
    ? selection.selection.includeUnassigned : selection.selection.workspaceIds.includes(workspaceId));
  const scoped = { ...projection, sessions: projection.sessions.filter(item => selected(item.workspaceId)) };
  for (const item of scoped.sessions) await options.bindIdentity?.(String(v3NativeSessionId(item.session.id)), item.session.id, true);
  const body: HostWorkspaceSyncRequest = { schemaVersion: 1, operationId: randomUUID(), instanceId: request.instanceId, profileId: request.profileId,
    homeRoot: request.instanceHome, pid: processIdentity.pid, processStartedAt: processIdentity.startedAt,
    workspaceRoot: options.workspaceRoot, projection: scoped,
    selection: hostWorkspaceSyncSchema.shape.selection.parse({ revision: selection.revision, selection: selection.selection }),
    workspaceNames: [...await options.workspaceNames()] };
  hostWorkspaceSyncSchema.parse(body);
  return { body, scoped };
  });
  const json = JSON.stringify(body);
  // Keep small requests compatible with older hosts; large snapshots retain their full identity context.
  const compressed = Buffer.byteLength(json) > 1024 * 1024;
  const payload = compressed ? new Uint8Array(await compress(json)) : json;
  const response = await transport(new URL(HOST_WORKSPACE_SYNC_PATH, origin), { method: 'POST', headers: {
    authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json', ...(compressed ? { 'content-encoding': 'gzip' } : {}) }, body: payload, signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { reason?: unknown };
    const reason = typeof detail.reason === 'string' && /^(?:SYNC_HOST_[A-Z_]+|HOST_[A-Z_]+|DSH_BUSY|LYNN_BUSY)$/.test(detail.reason) ? detail.reason : 'HOST_SYNC_INCOMPLETE';
    const hint = response.status === 413 ? '本次对齐数据超过宿主接收上限，需要更新宿主 adapter 或缩小单次传输。'
      : reason === 'DSH_BUSY' ? '目标会话仍被宿主占用，已保留原文件，稍后自动重试。'
      : reason === 'SYNC_HOST_CHANGED_DURING_DRAIN' ? '落盘期间会话发生变化，已停止回写，稍后重试。' : '宿主对齐未完成，将自动重试。';
    throw new IntegrationError('SYNC_HOST_REJECTED', `${hint}（HTTP ${response.status}，${reason}）`);
  }
  const parsed = hostWorkspaceSyncReceiptSchema.safeParse(await response.json());
  if (!parsed.success) throw new IntegrationError('SYNC_HOST_RECEIPT_INVALID', '宿主回执格式不完整，未确认同步完成。');
  const result = parsed.data;
  if (result.schemaVersion !== 1 || result.operationId !== body.operationId || result.instanceId !== body.instanceId || result.profileId !== body.profileId
    || result.pid !== body.pid || result.processStartedAt !== body.processStartedAt || !Array.isArray(result.bindings) || !result.summary)
    throw new IntegrationError('SYNC_HOST_RECEIPT_MISMATCH', '宿主回执与当前操作身份不符。');
  const expected = new Map(scoped.sessions.map(item => [String(v3NativeSessionId(item.session.id)), String(item.session.id)]));
  const seen = new Set<string>();
  for (const binding of result.bindings) {
    if (seen.has(binding.nativeSessionId) || expected.get(binding.nativeSessionId) !== binding.logicalSessionId)
      throw new IntegrationError('SYNC_HOST_BINDING_MISMATCH', '宿主回执包含重复或不属于本次范围的会话。');
    seen.add(binding.nativeSessionId);
  }
  if (result.summary.written + result.summary.unchanged > seen.size || seen.size !== expected.size || result.summary.failures.length)
    throw new IntegrationError('SYNC_HOST_INCOMPLETE', '宿主尚未确认本次范围内的全部会话。');
  // Validate the entire receipt before committing even the first identity.
  await inStore(async () => {
    const policyNow = options.selectionFor(request.instanceId);
    const current = await options.loadProjection(writeBackRunIdentity(request.instanceId, request.profileId));
    const latest = new Map(current.sessions.map(item => [String(item.session.id), item]));
    if (policyNow.revision !== body.selection.revision || scoped.sessions.some(item => JSON.stringify(latest.get(String(item.session.id))) !== JSON.stringify(item)))
      throw new IntegrationError('SYNC_SOURCE_CHANGED', '对齐期间真源或范围发生变化，将按最新版本重新同步。');
    for (const binding of result.bindings) await options.bindIdentity?.(binding.nativeSessionId, binding.logicalSessionId, true);
    for (const binding of result.bindings) await options.bindIdentity?.(binding.nativeSessionId, binding.logicalSessionId, false);
  });
  const { workspaceFolders, pluginData, ...summary } = result.summary;
  return { ...summary, ...(workspaceFolders === undefined ? {} : { workspaceFolders }),
    ...(pluginData === undefined ? {} : { pluginData }) };
}
