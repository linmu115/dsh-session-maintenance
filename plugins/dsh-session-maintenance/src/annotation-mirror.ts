import { annotationMirrorSyncSchema, type AnnotationMirrorSync, type AnnotationMirrorSyncResult } from '@linmu/dsh-session-contracts';
import type { EngineConnectionProvider } from './engine-proxy.js';

type Query = { after?: string; limit?: number; signal?: AbortSignal };
/** Structural subset of the optional Core host API; no runtime Core dependency. */
export interface AnnotationMirrorSource {
  readonly protocolVersion: 1;
  listSessions(input?: Query): Promise<{ readonly items: readonly { nativeSessionId: string; sourceRevision: number }[]; readonly nextCursor: string | null }>;
  listEntries(input: Query & { nativeSessionId: string }): Promise<{
    readonly nativeSessionId: string; readonly sourceRevision: number;
    readonly items: readonly AnnotationMirrorSync['entries'][number][]; readonly nextCursor: string | null;
  }>;
  subscribe(listener: (change: { nativeSessionId: string; sourceRevision: number }) => void): () => void;
}
interface PendingSession { desiredRevision: number; generation: number; after?: string; pageRevision?: number; failures: number; retryAt: number }
interface MirrorOptions {
  source: AnnotationMirrorSource; runId: string; connection: EngineConnectionProvider;
  connect?: (signal: AbortSignal) => Promise<void>; fetchImpl?: typeof fetch; reportRetry?: () => void;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const retryDelay = (failures: number) => Math.min(30000, 1000 * 2 ** Math.min(5, failures - 1));

function* batches(request: AnnotationMirrorSync): Generator<AnnotationMirrorSync> {
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...request, entries: [] }));
  let bytes = baseBytes, entries: AnnotationMirrorSync['entries'] = [];
  for (const entry of request.entries) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (entries.length && bytes + size > 480 * 1024) { yield { ...request, entries }; entries = []; bytes = baseBytes; }
    if (bytes + size > 480 * 1024) throw new Error('Annotation mirror entry exceeds request budget');
    entries.push(entry); bytes += size;
  }
  if (entries.length) yield { ...request, entries };
}

/** A disposable mirror queue. Durable Core records are replayed after every restart. */
export class AnnotationMirror {
  private readonly pending = new Map<string, PendingSession>();
  private readonly controller = new AbortController();
  private scanAfter: string | undefined;
  private scanComplete = false;
  private scanFailures = 0;
  private scanRetryAt = 0;
  private connected = false;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private off: (() => void) | undefined;
  private started = false;

  constructor(private readonly options: MirrorOptions) {}

  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.off = this.options.source.subscribe(change => {
      this.observe(change.nativeSessionId, change.sourceRevision);
      void this.flush();
    });
    void this.flush();
  }

  private observe(id: string, revision: number): void {
    if (this.controller.signal.aborted || !id || !Number.isSafeInteger(revision) || revision < 0) return;
    const current = this.pending.get(id);
    if (!current) this.pending.set(id, { desiredRevision: revision, generation: 0, failures: 0, retryAt: 0 });
    else if (revision > current.desiredRevision) {
      current.desiredRevision = revision; current.generation++;
      delete current.after; delete current.pageRevision;
      current.failures = 0; current.retryAt = 0;
    }
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = Promise.resolve().then(() => this.pass()).catch(() => {
      // Disposing aborts all awaits; no late response can consume pending intent.
    }).finally(() => { this.running = undefined; this.schedule(); });
    return this.running;
  }

  private async pass(): Promise<void> {
    const signal = this.controller.signal;
    if (!this.scanComplete && this.scanRetryAt <= Date.now()) {
      try {
        const page = await abortable(this.options.source.listSessions({ limit: 50, ...(this.scanAfter ? { after: this.scanAfter } : {}), signal }), signal);
        signal.throwIfAborted();
        if (page.items.length > 50 || page.nextCursor === this.scanAfter) throw new Error('Invalid annotation session page');
        for (const item of page.items) this.observe(item.nativeSessionId, item.sourceRevision);
        this.scanAfter = page.nextCursor ?? undefined; this.scanComplete = page.nextCursor === null;
        this.scanFailures = 0; this.scanRetryAt = 0;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && error.name === 'AnnotationDirectoryChangedError') this.scanAfter = undefined;
        this.scanRetryAt = Date.now() + retryDelay(++this.scanFailures);
        this.report(this.scanFailures);
      }
    }
    // Each pass reads at most 50 session headers and one <=50-entry page per queued session.
    const ready = [...this.pending].filter(([, state]) => state.retryAt <= Date.now()).slice(0, 50);
    for (const [id, state] of ready) {
      signal.throwIfAborted();
      await this.syncSession(id, state);
    }
  }

  private async syncSession(nativeSessionId: string, state: PendingSession): Promise<void> {
    const signal = this.controller.signal, generation = state.generation;
    try {
      let page;
      try {
        page = await abortable(this.options.source.listEntries({ nativeSessionId, limit: 50, ...(state.after ? { after: state.after } : {}), signal }), signal);
      } catch (error) {
        if (error instanceof Error && error.name === 'AnnotationDirectoryChangedError') { delete state.after; delete state.pageRevision; }
        throw error;
      }
      signal.throwIfAborted();
      if (state.generation !== generation) return;
      if (page.nativeSessionId !== nativeSessionId || !Number.isSafeInteger(page.sourceRevision) || page.sourceRevision < state.desiredRevision
        || (state.pageRevision !== undefined && page.sourceRevision !== state.pageRevision)) {
        delete state.after; delete state.pageRevision; throw new Error('Annotation revision changed; reread required');
      }
      if (page.items.length > 50 || page.nextCursor === state.after) throw new Error('Invalid annotation entry page');
      if (page.items.length) {
        const request = annotationMirrorSyncSchema.parse({ runId: this.options.runId, nativeSessionId, sourceRevision: page.sourceRevision, entries: page.items });
        for (const batch of batches(request)) {
          const result = await this.send(batch);
          signal.throwIfAborted();
          const receipts = new Map(result.items.map(item => [item.referenceId, item]));
          if (receipts.size !== batch.entries.length || result.items.length !== batch.entries.length) throw new Error('Incomplete annotation mirror acknowledgement');
          for (const entry of batch.entries) {
            const receipt = receipts.get(entry.referenceId);
            if (receipt?.status === 'stale') { delete state.after; delete state.pageRevision; throw new Error('Stale annotation revision; reread required'); }
            if (!receipt || !['saved', 'unchanged'].includes(receipt.status) || !Number.isSafeInteger(receipt.sourceRevision) || receipt.sourceRevision < page.sourceRevision
              || typeof receipt.objectId !== 'string' || !receipt.objectId || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) throw new Error('Annotation mirror write is not durably acknowledged');
          }
          if (state.generation !== generation) return;
        }
      }
      if (state.generation !== generation) return;
      state.failures = 0; state.retryAt = 0;
      if (page.nextCursor === null) this.pending.delete(nativeSessionId);
      else { state.after = page.nextCursor; state.pageRevision = page.sourceRevision; state.desiredRevision = page.sourceRevision; }
    } catch {
      signal.throwIfAborted();
      if (state.generation !== generation) return;
      state.retryAt = Date.now() + retryDelay(++state.failures);
      this.report(state.failures);
    }
  }

  private async send(request: AnnotationMirrorSync): Promise<AnnotationMirrorSyncResult> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]);
    try {
      if (!this.connected) { await abortable(this.options.connect?.(signal) ?? Promise.resolve(), signal); this.connected = true; }
      const connection = await abortable(this.options.connection.current(), signal);
      signal.throwIfAborted();
      const response = await abortable((this.options.fetchImpl ?? fetch)(`${connection.origin}/v1/extensions/annotation-sync`, {
        method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request), signal,
      }), signal);
      if (!response.ok) throw new Error(`Annotation mirror request failed (${response.status})`);
      const result: unknown = await abortable(response.json(), signal);
      if (!result || typeof result !== 'object' || !('items' in result) || !Array.isArray(result.items)) throw new Error('Invalid annotation mirror acknowledgement');
      return result as AnnotationMirrorSyncResult;
    } catch (error) { this.connected = false; throw error; }
  }

  private report(failures: number): void {
    if (failures === 1) { try { this.options.reportRetry?.(); } catch { /* A diagnostic is not an acknowledgement. */ } }
  }

  private schedule(): void {
    if (this.controller.signal.aborted) return;
    const due = [...this.pending.values()].map(state => state.retryAt);
    if (!this.scanComplete) due.push(this.scanRetryAt);
    if (!due.length) return;
    const earliest = due.reduce((value, next) => Math.min(value, next), Infinity);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, Math.max(25, earliest - Date.now()));
    this.timer.unref?.();
  }

  async dispose(): Promise<void> {
    this.controller.abort(); this.off?.(); this.off = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }
}

export interface AnnotationMirrorContext {
  inject?(services: readonly string[], callback: (ctx: {
    annotationCoreHost?: { referenceDirectory?: AnnotationMirrorSource };
    effect(callback: () => () => Promise<void>, label?: string): void;
  }) => void): void;
}
export function registerAnnotationMirror(ctx: AnnotationMirrorContext,
  options: Omit<MirrorOptions, 'source'> & { plugins: readonly { namespace: string }[] }): void {
  if (!options.plugins.some(plugin => plugin.namespace === 'annotation-records')) return;
  ctx.inject?.(['annotationCoreHost'], scope => {
    const source = scope.annotationCoreHost?.referenceDirectory;
    if (source?.protocolVersion !== 1) return;
    scope.effect(() => {
      const mirror = new AnnotationMirror({ ...options, source }); mirror.start();
      return () => mirror.dispose();
    }, 'dsh-session-maintenance: annotation record mirror');
  });
}
