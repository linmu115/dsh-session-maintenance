import type { Context } from '@deepseek-ai/cordis';
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain';
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace';
import type { MaintenanceGraph } from './session-graph.js';

type ArchiveWriter = Pick<MaintenanceGraph, 'setSessionArchived'>;
interface PendingArchive { nativeSessionId: string; archived: boolean; reported: boolean }

/** Replays durable archive intent; a failed archive must precede any later unarchive. */
export class WorkspaceArchiveSync {
  private archived = new Set<string>();
  private readonly pending = new Map<string, PendingArchive[]>();
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private retryDelay = 1000;

  constructor(private readonly writer: ArchiveWriter, private readonly reportRetry: () => void = () => {}) {}

  observe(archivedSessionIds: readonly string[]): void {
    if (this.disposed) return;
    const next = new Set(archivedSessionIds);
    let changed = false;
    for (const id of new Set([...this.archived, ...next])) {
      if (this.archived.has(id) === next.has(id)) continue;
      const queue = this.pending.get(id) ?? [];
      queue.push({ nativeSessionId: id, archived: next.has(id), reported: false });
      this.pending.set(id, queue);
      changed = true;
    }
    this.archived = next;
    if (changed) void this.flush();
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.disposed) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = Promise.resolve().then(async () => {
      // Retry each failing head only once per pass, so unrelated sessions can progress.
      const attempted = new Set<PendingArchive>();
      while (!this.disposed) {
        const item = [...this.pending.values()].map(queue => queue[0]!).find(value => !attempted.has(value));
        if (!item) break;
        attempted.add(item);
        try {
          await this.writer.setSessionArchived(item.nativeSessionId, item.archived);
          const queue = this.pending.get(item.nativeSessionId)!;
          queue.shift();
          if (!queue.length) this.pending.delete(item.nativeSessionId);
        } catch {
          if (!item.reported) {
            item.reported = true;
            try { this.reportRetry(); } catch { /* Diagnostics cannot discard durable retry intent. */ }
          }
        }
      }
    }).finally(() => {
      this.running = undefined;
      if (this.disposed || !this.pending.size) { this.retryDelay = 1000; return; }
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.retryDelay);
      this.timer.unref?.();
      this.retryDelay = Math.min(30000, this.retryDelay * 2);
    });
    return this.running;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // An already issued transaction settles before Runtime Broker drains this run.
    await this.running;
  }
}

/** Observe the official RC2 post-durability domain feed without wrapping workspace methods. */
export function registerWorkspaceArchiveBridge(ctx: Context, writer: ArchiveWriter, reportRetry?: () => void) {
  const sync = new WorkspaceArchiveSync(writer, reportRetry);
  const off = ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'workspace' || change.table !== '' || change.key !== '' || change.operation !== 'put') return;
    const parsed = workspaceDomainState.safeParse(change.value);
    if (!parsed.success) return;
    // The domain emits before WorkspaceRegistry swaps its cached state, so read the committed payload.
    sync.observe(parsed.data.archivedSessionIds.map(String));
  });
  // Replay archived sessions after cold startup. Absence is not an instruction to unarchive Engine data.
  sync.observe(ctx.workspaceRegistry.archivedSessionIds.map(String));
  let detached = false;
  const dispose = async () => {
    if (!detached) { detached = true; off(); }
    await sync.dispose();
  };
  ctx.effect(() => dispose, 'dsh-session-maintenance: durable workspace archives');
  return { flush: () => sync.flush(), dispose };
}
