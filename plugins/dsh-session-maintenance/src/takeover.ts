import { instanceSyncRequestListSchema, takeoverRequestListSchema,
  type InstanceSyncDecision, type InstanceSyncRequest, type TakeoverHandoff, type TakeoverRequest } from '@linmu/dsh-session-contracts';
import { maintenanceStateRoot } from './config.js';
import { InstanceLeasePublisher, type InstanceLeaseIdentity } from './instance-lease.js';

/**
 * The instance asking the Engine whether a run is waiting for it.
 *
 * The Engine starts after the instance, so the instance cannot be told: it asks.
 * Polling has to survive every kind of absence — no state root, no descriptor,
 * no Engine listening, an Engine that answers with an error — because none of
 * those is a reason for a running DSH instance to fail. Every failure is
 * reported and retried on the next tick; nothing here is fatal.
 */

export interface TakeoverPollerOptions {
  readonly identity: Pick<InstanceLeaseIdentity, 'instanceId' | 'profileId'>;
  /** Resolves the Engine connection; throws while the Engine is absent. */
  readonly connection: () => Promise<{ readonly origin: string; readonly token: string }>;
  /** Publishes the lease, so an attached instance stops advertising itself as free. */
  readonly publisher: Pick<InstanceLeasePublisher, 'publish'>;
  /** Receives a claimed handoff. The Engine decides what the run means; this only delivers it. */
  readonly attach: (handoff: TakeoverHandoff) => Promise<void>;
  /**
   * Asks the user whether to carry out a requested synchronisation. Absent,
   * throwing or unanswered all count as a decline: nothing may act for the user,
   * and silence is never consent.
   */
  readonly confirm?: (request: InstanceSyncRequest) => Promise<boolean> | boolean;
  /** How long a request may wait for the user before it is reported as expired. */
  readonly confirmTimeoutMs?: number;
  readonly intervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly report?: (message: string) => void;
  readonly clock?: () => string;
  /** Where the Engine keeps handshakes; `undefined` means the instance cannot be discovered. */
  readonly stateRoot?: string | undefined;
}

/** Cap the backoff so an instance recovers promptly once the Engine appears. */
const MAX_INTERVAL_MS = 30_000;
/** A user who has not answered within this window has not approved anything. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;

export class TakeoverPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private failures = 0;
  private readonly claimed = new Set<string>();
  private readonly decided = new Set<string>();
  private readonly reported = new Set<string>();
  private readonly intervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly report: (message: string) => void;

  constructor(private readonly options: TakeoverPollerOptions) {
    this.intervalMs = options.intervalMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.report = options.report ?? (() => undefined);
  }

  /** What the instance believes is waiting; used by tests and by the settings surface. */
  claimedTickets(): readonly string[] { return [...this.claimed]; }

  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true; this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick(); }, delayMs);
    this.timer.unref?.();
  }

  /** One poll: never throws, so a host can call it directly in a test or on a timer. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.poll();
      this.failures = 0;
      this.schedule(this.intervalMs);
    } catch (error) {
      this.failures += 1;
      this.reportOnce(`[dsh-session-maintenance] 暂未取得引擎的接管请求：${error instanceof Error ? error.message : String(error)}`);
      this.schedule(Math.min(this.intervalMs * 2 ** Math.min(this.failures, 4), MAX_INTERVAL_MS));
    }
  }

  private async poll(): Promise<void> {
    const connection = await this.options.connection();
    const query = new URLSearchParams({ instanceId: this.options.identity.instanceId, profileId: this.options.identity.profileId });
    const response = await this.fetchImpl(`${connection.origin}/v1/integrations/takeovers?${query}`, {
      headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`引擎以 ${response.status} 拒绝了接管请求查询`);
    const parsed = takeoverRequestListSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('接管请求列表不是受支持的格式');
    this.reported.clear();
    for (const request of parsed.data.takeovers) {
      if (this.claimed.has(request.ticketId)) continue;
      await this.claim(request);
    }
    // The user-facing channel: the Engine asks, the user answers. It runs after
    // the tickets so a handshake is never delayed by someone thinking.
    await this.answerSyncRequests(connection);
  }

  /**
   * Put each pending synchronisation request to the user and report the answer.
   *
   * The Engine cannot synchronise an already running instance by itself, so it
   * asks instead of acting, and only an explicit approval is reported as
   * `approved`. A decline is reported as `declined`; an unanswered request
   * becomes `expired` — the same outcome as a decline, which is what keeps a
   * silent user from being treated as consenting. A decision that cannot be
   * delivered is retried next tick; the request stays pending until it is.
   */
  private async answerSyncRequests(connection: { readonly origin: string; readonly token: string }): Promise<void> {
    const query = new URLSearchParams({ instanceId: this.options.identity.instanceId, profileId: this.options.identity.profileId });
    const response = await this.fetchImpl(`${connection.origin}/v1/integrations/sync-requests?${query}`, {
      headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;
    const parsed = instanceSyncRequestListSchema.safeParse(await response.json());
    if (!parsed.success) return;
    for (const request of parsed.data.requests) {
      if (this.decided.has(request.requestId)) continue;
      const decision = await this.askUser(request);
      await this.reportDecision(connection, request, decision);
    }
  }

  /** One request, one answer; anything other than a clear yes is not an approval. */
  private async askUser(request: InstanceSyncRequest): Promise<InstanceSyncDecision> {
    if (this.options.confirm === undefined) {
      this.reportOnce(`[dsh-session-maintenance] 引擎请求同步（${request.requestId}），但此实例没有可用的确认入口；已按拒绝处理。`);
      return 'declined';
    }
    const timeoutMs = this.options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // `null` means the user never answered, which is reported as `expired`;
      // `false` means the user said no. Neither is ever an approval.
      const answer = await Promise.race<boolean | null>([
        Promise.resolve(this.options.confirm(request)).then(value => value === true, error => {
          this.reportOnce(`[dsh-session-maintenance] 同步确认无法完成：${error instanceof Error ? error.message : String(error)}`);
          return false;
        }),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); }),
      ]);
      return answer === true ? 'approved' : answer === null ? 'expired' : 'declined';
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async reportDecision(connection: { readonly origin: string; readonly token: string },
    request: InstanceSyncRequest, decision: InstanceSyncDecision): Promise<void> {
    const response = await this.fetchImpl(`${connection.origin}/v1/integrations/sync-requests/${encodeURIComponent(request.requestId)}/decision`, {
      method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, requestId: request.requestId, instanceId: this.options.identity.instanceId,
        profileId: this.options.identity.profileId, decision,
        detail: decision === 'approved' ? '用户已确认执行同步' : decision === 'declined' ? '用户拒绝了同步' : '用户未在期限内确认',
        decidedAt: (this.options.clock ?? (() => new Date().toISOString()))() }),
      signal: AbortSignal.timeout(10_000),
    });
    // A refusal is final for this request; a transport failure is retried next tick.
    if (response.status === 409 || response.status === 404) {
      this.decided.add(request.requestId);
      this.reportOnce(`[dsh-session-maintenance] 同步请求 ${request.requestId} 的决定未被接受（${response.status}）。`);
      return;
    }
    if (!response.ok) throw new Error(`引擎以 ${response.status} 拒绝了同步决定`);
    this.decided.add(request.requestId);
  }

  /**
   * Claim one prepared run and hand it to the attach path.
   *
   * A refusal is not retried forever: the ticket is recorded as seen either way,
   * because a ticket the Engine refuses (already claimed, wrong instance) will
   * never become claimable. A transport failure is different — that one is left
   * for the next tick.
   */
  private async claim(request: TakeoverRequest): Promise<void> {
    const connection = await this.options.connection();
    const response = await this.fetchImpl(`${connection.origin}${request.claimPath}`, {
      method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, ticketId: request.ticketId, instanceId: this.options.identity.instanceId,
        profileId: this.options.identity.profileId, pid: process.pid }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 409) {
      this.claimed.add(request.ticketId);
      this.reportOnce(`[dsh-session-maintenance] 接管票据 ${request.ticketId} 已被拒绝或已被领取。`);
      return;
    }
    if (!response.ok) throw new Error(`引擎以 ${response.status} 拒绝了接管票据 ${request.ticketId}`);
    const body = await response.json() as { handoff?: unknown };
    const handoff = body.handoff as TakeoverHandoff | undefined;
    if (handoff === undefined || handoff.ticketId !== request.ticketId) throw new Error('接管回执与票据不一致');
    this.claimed.add(request.ticketId);
    // Only now is the instance attached in the Engine's eyes, and the lease says so.
    await this.options.publisher.publish('attached', handoff.runId);
    await this.options.attach(handoff);
  }

  private reportOnce(message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    this.report(message);
  }
}

/**
 * Start polling when the instance can locate the Engine's state root.
 *
 * A missing state root is not an error: it means this instance was started
 * without the installer's registration, so there is nothing to poll and the
 * instance simply runs without a takeover channel.
 */
export function startTakeoverPolling(options: Omit<TakeoverPollerOptions, 'stateRoot'> & {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): TakeoverPoller | undefined {
  const environment = options.environment ?? process.env;
  const stateRoot = maintenanceStateRoot('primary', environment);
  if (stateRoot === undefined) return undefined;
  const poller = new TakeoverPoller({ ...options, stateRoot });
  poller.start();
  return poller;
}
