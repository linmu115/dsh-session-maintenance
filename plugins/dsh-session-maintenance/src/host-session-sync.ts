import { sessionSyncIntents, type ObservedSession, type SessionObservation, type SyncIntent } from "./client/session-change-report.js";
import type { EndpointSyncStatus } from '@linmu/dsh-session-contracts';

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
  readonly syncState?: () => Promise<EndpointSyncStatus>;
  readonly trackContent?: boolean;
  readonly additionalRevision?: (sessionId: string) => Promise<string>;
  readonly host: HostSessionSyncHost;
  /** Only while the Engine is reachable; the caller decides how that is answered. */
  readonly engineReady: () => Promise<boolean>;
  /** Whether this instance has mapped the session's workspace; unmapped sessions are never pushed. */
  readonly mapped: (sessionId: string) => Promise<boolean>;
  /** Push one intent; the returned text is the Engine's own answer, for the log. */
  readonly report: (intent: SyncIntent, archived: boolean, epoch?: string) => Promise<string | { readonly message: string; readonly skipped: boolean }>;
  readonly onFeedback?: (message: string) => void;
  /** How long between safety passes; a test injects a shorter one. */
  readonly intervalMs?: number;
  /** Bound on retained intents, so a host that never becomes reachable cannot grow unbounded. */
  readonly maxPending?: number;
  readonly maxReportsPerPass?: number;
}

/** What one pass observed and did. */
export interface HostSessionSyncPass {
  readonly observed: number;
  readonly intents: number;
  readonly reported: number;
  readonly skippedUnmapped: number;
  readonly pending: number;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_PENDING = 500;

export class HostSessionSync {
  private epoch: string | undefined;
  private readonly dirty = new Set<string>();
  private readonly retries = new Set<string>();
  private previous: SessionObservation | undefined;
  /** Intent per session, newest wins: the source only needs the state the instance ended at. */
  private readonly pending = new Map<string, SyncIntent & { archived: boolean }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private disposed = false;
  private reportedFailure = false;
  private active = false;
  private readonly revisionFailures = new Set<string>();

  constructor(private readonly options: HostSessionSyncOptions) {}
  /** Host flush/event notification. The core never receives host event types. */
  markDirty(sessionId: string): void {
    this.dirty.add(sessionId);
    // A new turn must not sit behind a complete startup history sweep.
    if (this.options.trackContent &&
      (this.pending.has(sessionId) || this.pending.size < (this.options.maxPending ?? DEFAULT_MAX_PENDING)))
      this.remember({ kind: this.active ? 'refresh' : 'discover', sessionId }, this.previous?.get(sessionId)?.archived === true);
    if (!this.running && !this.disposed) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.schedule(200);
    }
  }

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
    let state: EndpointSyncStatus | undefined;
    if (this.options.syncState) {
      state = await this.options.syncState();
      const wasActive = this.active;
      this.active = state.phase === 'active';
      if (state.epoch !== this.epoch || this.active !== wasActive) {
        this.previous = undefined; this.pending.clear(); this.retries.clear(); this.epoch = state.epoch;
      }
      if (state.phase !== 'active') {
        // Insert-only discovery cannot change an existing canonical session or infer deletions.
        const current = await this.observe(false);
        let reported = 0, skippedUnmapped = 0;
        for (const id of new Set([...this.dirty, ...current.keys()])) {
          if (this.previous?.has(id) && !this.dirty.has(id)) continue;
          if (!this.pending.has(id) && this.pending.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) {
            const result = await this.flush(); reported += result.reported; skippedUnmapped += result.skippedUnmapped;
          }
          this.remember({ kind: 'discover', sessionId: id }, current.get(id)?.archived === true);
        }
        this.previous = current;
        const result = await this.flush(); reported += result.reported; skippedUnmapped += result.skippedUnmapped;
        return { observed: current.size, intents: current.size, reported, skippedUnmapped, pending: this.pending.size };
      }
    }
    const current = await this.observe();
    for (const [id, intent] of this.pending) if (intent.kind === 'delete' && current.has(id)) this.pending.delete(id);
    const previous = this.previous;
    let intentCount = 0;
    let reported = 0, skippedUnmapped = 0;
    const flushBatch = async () => { const result = await this.flush(); reported += result.reported; skippedUnmapped += result.skippedUnmapped; };
    // The first observation is the baseline: it says what the instance holds now, not what changed.
    if (previous !== undefined) {
      for (const intent of sessionSyncIntents(previous, current)) {
        if (!this.pending.has(intent.sessionId) && this.pending.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) await flushBatch();
        this.remember(intent, current.get(intent.sessionId)?.archived === true);
        this.dirty.add(intent.sessionId);
        intentCount += 1;
      }
      if (this.options.trackContent) {
        for (const [id, item] of current) {
          if (!previous.has(id) || previous.get(id)?.revision !== item.revision || this.dirty.has(id)) {
            if (!this.pending.has(id) && this.pending.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) await flushBatch();
            this.remember({ kind: 'refresh', sessionId: id }, item.archived); intentCount += 1;
          }
        }
      }
    }
    // A session can change between successful alignment and this first observation. Refreshing
    // current rows closes that gap without inventing deletions from a previous epoch's baseline.
    if (previous === undefined && state && this.options.trackContent) {
      for (const [id, item] of current) {
        if (!this.pending.has(id) && this.pending.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) await flushBatch();
        this.remember({ kind: 'refresh', sessionId: id }, item.archived); intentCount += 1;
      }
    }
    this.previous = current;
    await flushBatch();
    return { observed: current.size, intents: intentCount, reported, skippedUnmapped, pending: this.pending.size };
  }

  /** The instance's own two records, as one observation. */
  private async observe(includeRevision = true): Promise<SessionObservation> {
    const archived = new Set(this.options.host.workspaceRegistry.archivedSessionIds.map(String));
    const observed = new Map<string, ObservedSession>();
    for (const item of await this.options.host.sessionPersistence.list()) {
      const id = String(item.id);
      if (id.length === 0) continue;
      let pluginRevision: string | undefined;
      if (this.options.trackContent && includeRevision) {
        try { pluginRevision = await this.options.additionalRevision?.(id); this.revisionFailures.delete(id); }
        catch {
          if (!this.revisionFailures.has(id)) this.options.onFeedback?.(`[dsh-session-maintenance] 插件快照暂不可读，保留原数据并继续观察其他会话：${id}`);
          this.revisionFailures.add(id);
        }
      }
      observed.set(id, { sessionId: id, archived: archived.has(id), ...(this.options.trackContent && includeRevision ? { revision: JSON.stringify([item, pluginRevision]) } : {}) });
    }
    return observed;
  }

  private remember(intent: SyncIntent, archived: boolean): void {
    const limit = this.options.maxPending ?? DEFAULT_MAX_PENDING;
    if (!this.pending.has(intent.sessionId) && this.pending.size >= limit) {
      throw new Error(`同步待处理记录达到 ${limit} 项，下一轮将重新观察`);
    }
    this.pending.set(intent.sessionId, { ...intent, archived });
  }

  /** Push what can be pushed; keep what cannot, so nothing is reported and then forgotten. */
  private async flush(): Promise<{ reported: number; skippedUnmapped: number }> {
    if (this.pending.size === 0) return { reported: 0, skippedUnmapped: 0 };
    if (!(await this.options.engineReady().catch(() => false))) return { reported: 0, skippedUnmapped: 0 };
    let reported = 0;
    let skippedUnmapped = 0;
    const attempted = new Set<string>();
    let retried = false;
    while (!this.disposed && attempted.size < (this.options.maxReportsPerPass ?? 8)) {
      const candidates = [...this.pending.values()].filter(intent => !attempted.has(intent.sessionId));
      // Failed old rows cannot monopolize every slot in a bounded batch.
      const retryId = retried ? undefined : [...this.retries].find(id => candidates.some(intent => intent.sessionId === id));
      const intent = candidates.find(intent => this.dirty.has(intent.sessionId))
        ?? candidates.find(intent => intent.sessionId === retryId)
        ?? candidates.find(intent => !this.retries.has(intent.sessionId));
      if (!intent) break;
      if (this.retries.has(intent.sessionId)) retried = true;
      attempted.add(intent.sessionId);
      this.dirty.delete(intent.sessionId);
      // Scope first: a session outside the instance's bound workspaces is not this instance's to
      // report, and the Engine would only have to refuse it.
      try {
        // A transient identity error must remain pending. New sessions are scoped by the refresh command.
        if (intent.kind !== 'refresh' && intent.kind !== 'discover' && !(await this.options.mapped(intent.sessionId))) {
          this.pending.delete(intent.sessionId); this.retries.delete(intent.sessionId); skippedUnmapped += 1; continue;
        }
        // The push is its own statement on purpose: inside an optional call's argument it would be
        // skipped entirely whenever no feedback sink is configured, and the intent would be counted
        // as sent while never leaving the process.
        const answer = await this.options.report(intent, intent.archived, this.epoch);
        // A flush notification may have queued a newer revision during this request.
        if (this.pending.get(intent.sessionId) === intent) this.pending.delete(intent.sessionId);
        this.retries.delete(intent.sessionId);
        if (typeof answer !== 'string' && answer.skipped) skippedUnmapped += 1;
        else reported += 1;
        this.options.onFeedback?.(typeof answer === 'string' ? answer : answer.message);
      } catch (error) {
        this.retries.delete(intent.sessionId); this.retries.add(intent.sessionId);
        if (this.options.syncState) {
          const latest = await this.options.syncState().catch(() => undefined);
          if (latest && latest.epoch !== this.epoch) {
            // Abort the obsolete sweep instead of sending every remaining row with
            // a rejected epoch. Keep the failed and newly queued changes first.
            for (const id of this.pending.keys()) this.dirty.add(id);
            throw error;
          }
        }
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
      const freshPending = [...this.pending.keys()].some(id => !this.retries.has(id));
      this.schedule(this.dirty.size || freshPending ? 200 : this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    });
    return this.running;
  }
}
