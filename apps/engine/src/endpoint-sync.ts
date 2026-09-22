import { randomUUID } from 'node:crypto';
import type { EndpointSyncCommand, EndpointSyncReceipt, EndpointSyncStatus, WorkspaceWriteBackSummary } from '@linmu/dsh-session-contracts';
import { IntegrationError } from '@linmu/dsh-session-contracts';

/** Endpoint jobs own external waits; the shared writer only owns canonical commits. */
export class EndpointSyncCoordinator {
  private readonly states = new Map<string, EndpointSyncStatus>();
  private readonly boot = randomUUID();
  private readonly failures = new Map<string, readonly string[]>();
  private readonly pending = new Map<string, Promise<WorkspaceWriteBackSummary>>();
  private readonly retryAfter = new Map<string, number>();
  private closing = false;
  constructor(private readonly ports: {
    readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>;
    readonly revision: (endpointId: string) => number;
    readonly align: (endpointId: string) => Promise<WorkspaceWriteBackSummary>;
    readonly commit: (endpointId: string, command: EndpointSyncCommand) => Promise<Omit<EndpointSyncReceipt, 'epoch'>>;
  }) {}

  status(endpointId: string): EndpointSyncStatus {
    return this.states.get(endpointId) ?? { epoch: this.boot, phase: 'aligning', policyRevision: this.ports.revision(endpointId) };
  }
  progress(endpointId: string) {
    const { phase, policyRevision } = this.status(endpointId);
    return { phase, policyRevision, failures: [...this.failures.get(endpointId) ?? []] };
  }
  requestAlignment(endpointId: string): void { void this.ensureAligned(endpointId).catch(() => {}); }
  async ensureAligned(endpointId: string): Promise<void> {
    if (this.closing) return;
    const current = this.status(endpointId), revision = this.ports.revision(endpointId);
    if (current.phase === 'active' && current.policyRevision === revision) return;
    if (this.pending.has(endpointId)) { await this.pending.get(endpointId); return; }
    if (current.policyRevision === revision && Date.now() < (this.retryAfter.get(endpointId) ?? 0)) return;
    await this.align(endpointId);
  }
  align(endpointId: string): Promise<WorkspaceWriteBackSummary> {
    const existing = this.pending.get(endpointId);
    if (existing) return existing;
    if (this.closing) return Promise.reject(new IntegrationError('SYNC_STOPPING', '维护引擎正在收尾。', 503));
    // Publish the epoch before returning to the poller. Returning the previous blocked epoch
    // would make every first discovery request stale when the retry starts on the next microtask.
    const initialEpoch = randomUUID();
    this.states.set(endpointId, { epoch: initialEpoch, phase: 'aligning', policyRevision: this.ports.revision(endpointId) });
    // Install the promise before any adapter code can reenter this coordinator.
    const task = Promise.resolve().then(async () => {
      let result: WorkspaceWriteBackSummary, first = true;
      do {
        const epoch = first ? initialEpoch : randomUUID(), policyRevision = this.ports.revision(endpointId);
        first = false;
        this.states.set(endpointId, { epoch, phase: 'aligning', policyRevision });
        // Keep the last failure visible while retrying; replace it only with a new result.
        try { result = await this.ports.align(endpointId); }
        catch (error) {
          result = { written: 0, unchanged: 0, skippedOutOfScope: 0,
            failures: [error instanceof Error ? error.message : '对齐未完成。'] };
        }
        this.failures.set(endpointId, result.failures);
        this.states.set(endpointId, { epoch, policyRevision,
          phase: result.failures.length === 0 && this.ports.revision(endpointId) === policyRevision ? 'active' : 'blocked' });
        // A save during the request queues the newest durable selection, never a stale success.
      } while (!this.closing && this.status(endpointId).policyRevision !== this.ports.revision(endpointId));
      return result;
    }).finally(() => { this.pending.delete(endpointId); this.retryAfter.set(endpointId, Date.now() + 30_000); });
    this.pending.set(endpointId, task);
    return task;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending.values()]);
  }
  commit(endpointId: string, command: EndpointSyncCommand): Promise<EndpointSyncReceipt> {
    return this.ports.exclusive(async () => {
      const state = this.status(endpointId);
      if (state.phase !== 'active' && command.change.kind !== 'discover')
        throw new IntegrationError('SYNC_NOT_ALIGNED', '已有会话的对齐尚未完成，变更暂未提交。', 409);
      if (command.epoch !== state.epoch) throw new IntegrationError('SYNC_STALE_EPOCH', '同步世代已更新，请重新观察当前会话。', 409);
      if (state.policyRevision !== this.ports.revision(endpointId)) throw new IntegrationError('SYNC_SCOPE_CHANGED', '同步范围已变更，等待重新读取。', 409);
      return { ...await this.ports.commit(endpointId, command), epoch: state.epoch };
    });
  }
}
