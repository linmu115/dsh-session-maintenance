import { sessionSyncIntents, type ObservedSession, type SessionObservation, type SyncIntent } from "./client/session-change-report.js";

/**
 * The instance side reporting its own archive/delete changes **without a page being open**.
 *
 * The client half already does this from the sidebar, and it is the right place *when the operator
 * is looking at the instance*: the sidebar's list is the live view. But the operator's rule is that
 * the instance is the authority for as long as the Engine runs, and a rule that only holds while a
 * browser tab exists is not the rule: closing the page (or never opening it) would silently stop
 * every change from reaching the source.
 *
 * So the same intent rules run in the instance's own process, against the two records the host owns:
 *
 *   * `workspaceRegistry.archivedSessionIds` — the instance's archive state;
 *   * `sessionPersistence.list()` — the sessions the instance actually stores. A session that
 *     disappears from that list had its storage removed, which is a deletion; a *move* rewrites the
 *     session's file and keeps it listed, so a move is never mistaken for a deletion.
 *
 * Detection is the shared `sessionSyncIntents` diff, so both halves report the same things for the
 * same change, and the first observation is a baseline rather than an intent: a restart must not turn
 * "the source overwrote this at start" into "the operator deleted this".
 *
 * Scope is enforced before anything is pushed — an intent for a session this instance has not mapped
 * is dropped, not attempted — and failures are kept for the next pass instead of being reported and
 * forgotten, because nothing else will notice the change again.
 */

/** The host records this needs; only the parts it uses, so the module stays testable. */
export interface HostSessionSyncHost {
  readonly workspaceRegistry: { readonly archivedSessionIds: readonly string[] };
  readonly sessionPersistence: { list(): Promise<readonly { readonly id: string }[]> };
}

export interface HostSessionSyncOptions {
  readonly host: HostSessionSyncHost;
  /** Only while the Engine is reachable; the caller decides how that is answered. */
  readonly engineReady: () => Promise<boolean>;
  /** Whether this instance has mapped the session's workspace; unmapped sessions are never pushed. */
  readonly mapped: (sessionId: string) => Promise<boolean>;
  /** Push one intent; the returned text is the Engine's own answer, for the log. */
  readonly report: (intent: SyncIntent, archived: boolean) => Promise<string>;
  readonly onFeedback?: (message: string) => void;
  /** How long between safety passes; a test injects a shorter one. */
  readonly intervalMs?: number;
  /** Bound on retained intents, so a host that never becomes reachable cannot grow unbounded. */
  readonly maxPending?: number;
}

/** What one pass observed and did. */
export interface HostSessionSyncPass {
  readonly observed: number;
  readonly intents: number;
  readonly reported: number;
  readonly skippedUnmapped: number;
  readonly pending: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PENDING = 500;

export class HostSessionSync {
  private previous: SessionObservation | undefined;
  /** Intent per session, newest wins: the source only needs the state the instance ended at. */
  private readonly pending = new Map<string, SyncIntent & { archived: boolean }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private disposed = false;
  private reportedFailure = false;

  constructor(private readonly options: HostSessionSyncOptions) {}

  /** Observe once, then keep observing. Returns a disposer. */
  start(): () => void {
    this.schedule(0);
    return () => { this.dispose(); };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One pass, exposed so a caller (and a test) can drive it without the timer. */
  async pass(): Promise<HostSessionSyncPass> {
    const current = await this.observe();
    const previous = this.previous;
    this.previous = current;
    let intentCount = 0;
    // The first observation is the baseline: it says what the instance holds now, not what changed.
    if (previous !== undefined) {
      for (const intent of sessionSyncIntents(previous, current)) {
        this.remember(intent, current.get(intent.sessionId)?.archived === true);
        intentCount += 1;
      }
    }
    const flush = await this.flush();
    return { observed: current.size, intents: intentCount, ...flush, pending: this.pending.size };
  }

  /** The instance's own two records, as one observation. */
  private async observe(): Promise<SessionObservation> {
    const archived = new Set(this.options.host.workspaceRegistry.archivedSessionIds.map(String));
    const observed = new Map<string, ObservedSession>();
    for (const item of await this.options.host.sessionPersistence.list()) {
      const id = String(item.id);
      if (id.length === 0) continue;
      observed.set(id, { sessionId: id, archived: archived.has(id) });
    }
    return observed;
  }

  private remember(intent: SyncIntent, archived: boolean): void {
    const limit = this.options.maxPending ?? DEFAULT_MAX_PENDING;
    if (!this.pending.has(intent.sessionId) && this.pending.size >= limit) return;
    this.pending.set(intent.sessionId, { ...intent, archived });
  }

  /** Push what can be pushed; keep what cannot, so nothing is reported and then forgotten. */
  private async flush(): Promise<{ reported: number; skippedUnmapped: number }> {
    if (this.pending.size === 0) return { reported: 0, skippedUnmapped: 0 };
    if (!(await this.options.engineReady().catch(() => false))) return { reported: 0, skippedUnmapped: 0 };
    let reported = 0;
    let skippedUnmapped = 0;
    for (const intent of [...this.pending.values()]) {
      // Scope first: a session outside the instance's bound workspaces is not this instance's to
      // report, and the Engine would only have to refuse it.
      if (!(await this.options.mapped(intent.sessionId).catch(() => false))) {
        this.pending.delete(intent.sessionId);
        skippedUnmapped += 1;
        continue;
      }
      try {
        // The push is its own statement on purpose: inside an optional call's argument it would be
        // skipped entirely whenever no feedback sink is configured, and the intent would be counted
        // as sent while never leaving the process.
        const answer = await this.options.report(intent, intent.archived);
        this.pending.delete(intent.sessionId);
        reported += 1;
        this.options.onFeedback?.(answer);
      } catch (error) {
        if (!this.reportedFailure) {
          this.reportedFailure = true;
          this.options.onFeedback?.(`[dsh-session-maintenance] 实例侧变更暂未回传真源，将自动重试：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (this.pending.size === 0) this.reportedFailure = false;
    return { reported, skippedUnmapped };
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.cycle(); }, delayMs);
    this.timer.unref?.();
  }

  private cycle(): Promise<void> {
    if (this.running !== undefined) return this.running;
    this.running = this.pass().then(result => {
      if (result.reported > 0) this.options.onFeedback?.(`[dsh-session-maintenance] 已把 ${result.reported} 项实例侧变更回传真源`);
    }).catch(error => {
      // A host record that cannot be read is not a reason to stop: the next pass is the retry.
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        this.options.onFeedback?.(`[dsh-session-maintenance] 无法读取实例侧会话记录，稍后重试：${error instanceof Error ? error.message : String(error)}`);
      }
    }).finally(() => {
      this.running = undefined;
      this.schedule(this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    });
    return this.running;
  }
}
