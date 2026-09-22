import type { SessionLifecycleAdapter, SessionLifecycleState } from '@linmu/dsh-session-contracts';

/** The core publishes state changes without knowing which business modules consume them. */
export class SessionLifecycle {
  constructor(private readonly adapters: readonly SessionLifecycleAdapter[] = []) {
    if (new Set(adapters.map(adapter => adapter.id)).size !== adapters.length) throw new Error('Duplicate lifecycle adapter');
  }
  initialize(sessions: readonly SessionLifecycleState[]): void {
    for (const adapter of this.adapters) adapter.initialize?.(sessions);
  }
  changed(state: SessionLifecycleState): void {
    for (const adapter of this.adapters) adapter.sessionChanged(state);
  }
}
