/**
 * The instance-side "add this workspace to sessionmaintenance" entry.
 *
 * Joining is an explicit operator act: nothing here runs by itself — the menu plugin's
 * workspace entry is the only thing that creates an intent, and it reaches this plugin through
 * the bridge in `workspace-bridge.ts`. The Engine may be down when the user clicks — in fact the
 * whole point of the flow is that the instance can run without it — so an intent that cannot be
 * delivered is kept locally and handed over once the Engine returns. Losing the click, or letting
 * the failure reach the interface as an error, would both make the entry useless.
 */

export interface WorkspaceJoinIntent {
  /** The instance's own workspace identity; the identity itself is resolved by the host. */
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** The workspace's directory, which is what the Engine maps sessions from. */
  readonly workspacePath: string;
  readonly requestedAt: string;
}

/** What the caller reports back to the user; never throws its way into the UI. */
export type WorkspaceJoinOutcome =
  | { readonly status: "delivered"; readonly message: string }
  | { readonly status: "deferred"; readonly message: string }
  | { readonly status: "failed"; readonly message: string };

/** Somewhere to keep intents while the Engine is away. */
export interface PendingIntentStore {
  list(): Promise<readonly WorkspaceJoinIntent[]>;
  save(intents: readonly WorkspaceJoinIntent[]): Promise<void>;
}

/** The identity of an intent: one workspace of one instance, whatever else differs. */
export function intentKey(intent: Pick<WorkspaceJoinIntent, "workspaceId">): string {
  return JSON.stringify([intent.workspaceId]);
}

/**
 * Keeps the intents in memory, with the browser's storage as the durable copy.
 *
 * Storage is best effort on purpose: a browser that refuses it (private mode, a
 * full quota) must still let the user click, so the intent survives in memory for
 * this session and the delivery attempt happens either way.
 */
export class BrowserPendingIntentStore implements PendingIntentStore {
  private memory: readonly WorkspaceJoinIntent[] = [];

  constructor(private readonly key = "dsh-session-maintenance:pending-workspace-joins") {}

  private storage(): Storage | undefined {
    try { return typeof window === "undefined" ? undefined : window.localStorage; }
    catch { return undefined; }
  }

  async list(): Promise<readonly WorkspaceJoinIntent[]> {
    const storage = this.storage();
    // No usable storage means the in-memory copy is the only truth there is.
    if (storage === undefined) return this.memory;
    const raw = storage.getItem(this.key);
    if (raw === null) return this.memory;
    try {
      const parsed: unknown = JSON.parse(raw);
      // Storage held something unusable, so nothing valid was ever queued there.
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is WorkspaceJoinIntent => typeof item === "object" && item !== null
        && typeof (item as WorkspaceJoinIntent).workspaceId === "string");
    } catch { return []; }
  }

  async save(intents: readonly WorkspaceJoinIntent[]): Promise<void> {
    this.memory = intents;
    try { this.storage()?.setItem(this.key, JSON.stringify(intents)); } catch { /* in-memory copy still holds it */ }
  }
}

/** A store that forgets, for callers that have nowhere to keep anything. */
export class VolatilePendingIntentStore implements PendingIntentStore {
  private intents: readonly WorkspaceJoinIntent[] = [];
  async list(): Promise<readonly WorkspaceJoinIntent[]> { return this.intents; }
  async save(intents: readonly WorkspaceJoinIntent[]): Promise<void> { this.intents = intents; }
}

export interface WorkspaceJoinQueueOptions {
  readonly store: PendingIntentStore;
  /**
   * Hands one intent to the Engine through the workspace bridge. It must throw when delivery is
   * merely impossible for now (the Engine is not running); the queue turns that into a deferred
   * outcome rather than an error, and keeps the intent for the next attempt.
   */
  readonly deliver: (intent: WorkspaceJoinIntent) => Promise<string>;
  readonly report?: (message: string) => void;
  readonly clock?: () => string;
}

/**
 * Queues a join intent and tries to deliver it.
 *
 * Clicking twice is one intent: the key is the workspace, so a second click
 * replaces the first copy instead of queueing a second one. Delivery of everything
 * pending is attempted in order, and the first unreachable Engine stops the run
 * without discarding anything — the rest stays queued for the next attempt.
 */
export class WorkspaceJoinQueue {
  private readonly clock: () => string;
  private readonly report: (message: string) => void;

  constructor(private readonly options: WorkspaceJoinQueueOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.report = options.report ?? (() => undefined);
  }

  /**
   * The user clicked the entry: remember the intent, then try to hand it over.
   *
   * `flush: false` records the intent without attempting delivery. That is what a caller who has
   * *just* seen delivery fail needs — otherwise recording the intent and retrying it would recurse
   * into each other, each attempt queueing another.
   */
  async requestJoin(intent: Omit<WorkspaceJoinIntent, "requestedAt"> & { readonly requestedAt?: string },
    options: { readonly flush?: boolean } = {}): Promise<WorkspaceJoinOutcome> {
    const complete: WorkspaceJoinIntent = { ...intent, requestedAt: intent.requestedAt ?? this.clock() };
    const pending = await this.options.store.list();
    const key = intentKey(complete);
    const kept = pending.filter(item => intentKey(item) !== key);
    await this.options.store.save([...kept, complete]);
    if (options.flush === false) return { status: "deferred", message: "维护引擎当前不可用；已记为待办，引擎启动后会自动交付。" };
    return this.flush();
  }

  /** Hand over everything queued, stopping at the first Engine that is not there. */
  async flush(): Promise<WorkspaceJoinOutcome> {
    let pending = await this.options.store.list();
    const remaining: WorkspaceJoinIntent[] = [];
    let delivered = 0;
    let deferred: WorkspaceJoinOutcome | undefined;
    for (const intent of pending) {
      if (deferred !== undefined) { remaining.push(intent); continue; }
      try {
        await this.options.deliver(intent);
        delivered += 1;
      } catch (error) {
        deferred = { status: "deferred", message: "维护引擎当前不可用；已记为待办，引擎启动后会自动交付。" };
        this.report(`[dsh-session-maintenance] 工作区加入待办：${error instanceof Error ? error.message : String(error)}`);
        remaining.push(intent);
      }
    }
    pending = remaining;
    await this.options.store.save(pending);
    if (deferred !== undefined) return deferred;
    if (delivered === 0) return { status: "delivered", message: "没有待交付的工作区加入请求。" };
    return { status: "delivered", message: pending.length === 0
      ? `已把 ${delivered} 个工作区交给维护引擎。`
      : `已交付 ${delivered} 个工作区；仍有 ${pending.length} 个待办。` };
  }
}
