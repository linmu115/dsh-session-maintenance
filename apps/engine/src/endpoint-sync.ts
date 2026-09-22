import { randomUUID } from 'node:crypto';
import type { EndpointSyncCommand, EndpointSyncReceipt, EndpointSyncStatus, WorkspaceWriteBackSummary } from '@linmu/dsh-session-contracts';
import { IntegrationError } from '@linmu/dsh-session-contracts';

/** Authority and retry rules only. The ports own persistence and all external-system behavior. */
export class EndpointSyncCoordinator {
  private readonly states = new Map<string, EndpointSyncStatus>();
  private readonly boot = randomUUID();
  constructor(private readonly ports: {
    readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>;
    readonly revision: (endpointId: string) => number;
    readonly align: (endpointId: string) => Promise<WorkspaceWriteBackSummary>;
    readonly commit: (endpointId: string, command: EndpointSyncCommand) => Promise<Omit<EndpointSyncReceipt, 'epoch'>>;
  }) {}

  status(endpointId: string): EndpointSyncStatus {
    return this.states.get(endpointId) ?? { epoch: this.boot, phase: 'aligning', policyRevision: this.ports.revision(endpointId) };
  }

  /** New epochs invalidate all previous observations before the adapter touches external state. */
  align(endpointId: string): Promise<WorkspaceWriteBackSummary> {
    return this.ports.exclusive(async () => {
      const epoch = randomUUID(), policyRevision = this.ports.revision(endpointId);
      this.states.set(endpointId, { epoch, phase: 'aligning', policyRevision });
      try {
        const result = await this.ports.align(endpointId);
        this.states.set(endpointId, { epoch, policyRevision,
          phase: result.failures.length === 0 && this.ports.revision(endpointId) === policyRevision ? 'active' : 'blocked' });
        return result;
      } catch (error) {
        this.states.set(endpointId, { epoch, policyRevision, phase: 'blocked' });
        throw error;
      }
    });
  }

  commit(endpointId: string, command: EndpointSyncCommand): Promise<EndpointSyncReceipt> {
    return this.ports.exclusive(async () => {
      const state = this.status(endpointId);
      if (state.phase !== 'active') throw new IntegrationError('SYNC_NOT_ALIGNED', '同步对齐尚未完成，变更暂未提交。', 409);
      if (command.epoch !== state.epoch) throw new IntegrationError('SYNC_STALE_EPOCH', '同步世代已更新，请重新观察当前会话。', 409);
      if (state.policyRevision !== this.ports.revision(endpointId)) throw new IntegrationError('SYNC_SCOPE_CHANGED', '同步范围已变更，等待重新对齐。', 409);
      return { ...await this.ports.commit(endpointId, command), epoch: state.epoch };
    });
  }
}
