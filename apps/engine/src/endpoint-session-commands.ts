import { IntegrationError } from '@linmu/dsh-session-contracts';
import type { EndpointSyncCommand, EndpointSyncReceipt, CanonicalSessionMaintenancePatch, CanonicalSessionDeleteResult } from '@linmu/dsh-session-contracts';

/** Called under the coordinator's write scope. Identity and selection are checked at commit time. */
export async function commitEndpointSessionChange(input: {
  readonly endpointId: string; readonly command: EndpointSyncCommand;
  readonly resolve: (endpointId: string, sessionId: string) => Promise<string | undefined>;
  readonly selected: (endpointId: string, logicalSessionId: string) => boolean;
  readonly acceptsIdentity?: (endpointId: string, sessionId: string, logicalSessionId: string) => Promise<boolean>;
  readonly update: (id: string, patch: CanonicalSessionMaintenancePatch) => Promise<unknown>;
  readonly remove: (id: string) => Promise<CanonicalSessionDeleteResult | undefined>;
  readonly refresh?: (endpointId: string, sessionId: string, logicalSessionId: string | undefined) => Promise<string>;
  /** Opt-in adapter proof: refresh only an original endpoint session with an unchanged prefix. */
  readonly refreshDiscovered?: (endpointId: string, sessionId: string, logicalSessionId: string) => Promise<boolean>;
}): Promise<Omit<EndpointSyncReceipt, 'epoch'>> {
  const { endpointId, command } = input;
  const id = await input.resolve(endpointId, command.sessionId);
  if (id !== undefined && input.acceptsIdentity && !await input.acceptsIdentity(endpointId, command.sessionId, id))
    return { logicalSessionId: id, outcome: 'out-of-scope' };
  // A new session has no identity yet; its adapter resolves a selected logical workspace before import.
  if (id !== undefined && !input.selected(endpointId, id)) return { logicalSessionId: id, outcome: 'out-of-scope' };
  if (command.change.kind === 'discover' && id !== undefined) return { logicalSessionId: id,
    outcome: await input.refreshDiscovered?.(endpointId, command.sessionId, id) ? 'updated' : 'already-present' };
  if (command.change.kind === 'refresh' || command.change.kind === 'discover') {
    if (!input.refresh) throw new IntegrationError('SYNC_REFRESH_UNAVAILABLE', '当前 adapter 尚未提供内容同步。', 503);
    try { return { logicalSessionId: await input.refresh(endpointId, command.sessionId, id), outcome: 'updated' }; }
    catch (error) {
      if ((error as { code?: string })?.code === 'SESSION_NOT_SYNCED') return { logicalSessionId: id ?? null, outcome: 'out-of-scope' };
      throw error;
    }
  }
  if (!id) throw new IntegrationError('SESSION_NOT_MAPPED', '会话身份尚未映射，请稍后重试。', 409);
  if (command.change.kind === 'archive') {
    if (await input.update(id, { archived: command.change.archived }) === undefined)
      throw new IntegrationError('SESSION_NOT_FOUND', '会话已不存在。', 404);
    return { logicalSessionId: id, outcome: 'updated', archived: command.change.archived };
  }
  const receipt = await input.remove(id);
  if (!receipt) throw new IntegrationError('SESSION_NOT_FOUND', '会话已不存在。', 404);
  return { logicalSessionId: id, outcome: receipt.state, pendingOperations: receipt.pendingOperations };
}
