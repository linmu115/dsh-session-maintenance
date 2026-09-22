import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IntegrationError, hostWorkspaceSyncSchema, hostWorkspaceSyncReceiptSchema, type HostWorkspaceSyncRequest } from '@linmu/dsh-session-contracts';
import { v3NativeSessionId } from '@linmu/dsh-session-adapter-0-1-5';
import { inspectInstanceLease } from './instance-lease.js';
import { writeBackRunIdentity, type InstanceWriteBackOptions, type InstanceWriteBackRequest } from './instance-write-back.js';

export const HOST_WORKSPACE_SYNC_PATH = '/dsh-session-maintenance/instance/workspace-sync';

/** No physical write happens in the caller. A timed-out caller cannot retain a stale filesystem lease. */
export async function synchronizeThroughHost(options: InstanceWriteBackOptions, request: InstanceWriteBackRequest,
  transport: typeof fetch = fetch) {
  const inspection = await inspectInstanceLease(options.stateRoot, { instanceId: request.instanceId, profileId: request.profileId,
    expectedHomeRoot: request.instanceHome, profileRoot: join(request.instanceHome, 'profiles', request.profileId) });
  if (!inspection.process || !inspection.runtimeUrl || inspection.state === 'stopping') throw new IntegrationError('SYNC_HOST_UNAVAILABLE', '尚未取得正在运行的宿主身份，请重新检查实例。');
  const origin = new URL(inspection.runtimeUrl);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password)
    throw new IntegrationError('SYNC_HOST_UNAVAILABLE', '宿主地址未通过本地身份检查。');
  const descriptor = JSON.parse(await readFile(join(options.stateRoot, 'connection.json'), 'utf8'));
  if (descriptor.schemaVersion !== 1 || typeof descriptor.token !== 'string' || descriptor.token.length < 32) throw new IntegrationError('SYNC_HOST_AUTH_UNAVAILABLE', '同步认证尚未就绪。');
  const projection = await options.loadProjection(writeBackRunIdentity(request.instanceId, request.profileId));
  const selection = options.selectionFor(request.instanceId);
  const selected = (workspaceId: string | null) => selection.selection.kind === 'all' || (workspaceId === null
    ? selection.selection.includeUnassigned : selection.selection.workspaceIds.includes(workspaceId));
  const scoped = { ...projection, sessions: projection.sessions.filter(item => selected(item.workspaceId)) };
  for (const item of scoped.sessions) await options.bindIdentity?.(String(v3NativeSessionId(item.session.id)), item.session.id, true);
  const body: HostWorkspaceSyncRequest = { schemaVersion: 1, operationId: randomUUID(), instanceId: request.instanceId, profileId: request.profileId,
    homeRoot: request.instanceHome, pid: inspection.process.pid, processStartedAt: inspection.process.startedAt,
    workspaceRoot: options.workspaceRoot, projection: scoped, selection: hostWorkspaceSyncSchema.shape.selection.parse(selection), workspaceNames: [...await options.workspaceNames()] };
  hostWorkspaceSyncSchema.parse(body);
  const response = await transport(new URL(HOST_WORKSPACE_SYNC_PATH, origin), { method: 'POST', headers: {
    authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok) throw new IntegrationError('SYNC_HOST_REJECTED', `宿主未完成同步（HTTP ${response.status}），请检查宿主后重试。`);
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
  for (const binding of result.bindings) {
    await options.bindIdentity?.(binding.nativeSessionId, binding.logicalSessionId, false);
  }
  const { workspaceFolders, pluginData, ...summary } = result.summary;
  return { ...summary, ...(workspaceFolders === undefined ? {} : { workspaceFolders }),
    ...(pluginData === undefined ? {} : { pluginData }) };
}
