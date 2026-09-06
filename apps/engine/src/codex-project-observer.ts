import type { RegisteredInstance } from "@linmu/dsh-session-contracts";
import type { CodexProjectScopeProvider } from "./codex-canonical-import.js";
import type { CodexImportService } from "./codex-import-service.js";

export interface CodexProjectObserverStatus {
  readonly state: "stopped" | "idle" | "syncing" | "error";
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
}

/** Polls native project membership and selected rollout fingerprints without overlapping passes. */
export class CodexProjectObserver {
  private running = false;
  private lifecycle = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private controller = new AbortController();
  private state: CodexProjectObserverStatus = { state: "stopped", lastSyncAt: null, lastError: null };
  private readonly intervalMs: number;

  constructor(private readonly input: {
    readonly instances: readonly RegisteredInstance[];
    readonly projectScope: CodexProjectScopeProvider;
    readonly importService: Pick<CodexImportService, "runChanged" | "clearChangeCache">;
    readonly intervalMs?: number;
    readonly clock?: () => string;
    readonly onStatus?: (status: CodexProjectObserverStatus) => void;
    readonly onError?: (error: unknown) => void;
  }) {
    this.intervalMs = Math.max(250, Math.min(60_000, Number.isFinite(input.intervalMs) ? input.intervalMs! : 2_000));
  }

  snapshot(): CodexProjectObserverStatus { return { ...this.state }; }

  async start(): Promise<void> {
    if (this.running) return;
    const lifecycle = ++this.lifecycle;
    if (this.active !== undefined) await this.active.catch(() => undefined);
    if (lifecycle !== this.lifecycle) return;
    this.running = true;
    this.controller = new AbortController();
    this.input.importService.clearChangeCache();
    this.update({ ...this.state, state: "idle", lastError: null });
    this.schedule(0, lifecycle);
  }

  async stop(): Promise<void> {
    const lifecycle = ++this.lifecycle;
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller.abort(new Error("CODEX_PROJECT_OBSERVER_STOPPED"));
    await this.active?.catch(() => undefined);
    if (lifecycle !== this.lifecycle) return;
    this.input.importService.clearChangeCache();
    this.update({ ...this.state, state: "stopped" });
  }

  /** Public for focused deterministic fixture tests; concurrent callers share one pass. */
  tick(): Promise<void> {
    if (this.active !== undefined) return this.active;
    const signal = this.controller.signal;
    const pass = async () => {
      signal.throwIfAborted();
      this.update({ ...this.state, state: "syncing" });
      try {
        for (const instance of this.input.instances) {
          signal.throwIfAborted();
          if (instance.platform !== "codex") continue;
          const scope = await this.input.projectScope(instance, signal);
          signal.throwIfAborted();
          if (scope === undefined) {
            this.input.importService.clearChangeCache(instance.id);
            continue;
          }
          await this.input.importService.runChanged(instance.id, signal);
        }
        signal.throwIfAborted();
        this.update({ state: "idle", lastSyncAt: (this.input.clock ?? (() => new Date().toISOString()))(), lastError: null });
      } catch (error) {
        if (!signal.aborted) {
          this.update({ ...this.state, state: "error", lastError: error instanceof Error ? error.message.slice(0, 240) : "Codex project observation failed" });
          this.input.onError?.(error);
        }
        throw error;
      }
    };
    this.active = pass().finally(() => { this.active = undefined; });
    return this.active;
  }

  private update(status: CodexProjectObserverStatus): void {
    this.state = status;
    this.input.onStatus?.(this.snapshot());
  }

  private schedule(delay: number, lifecycle = this.lifecycle): void {
    if (!this.running || lifecycle !== this.lifecycle) return;
    this.timer = setTimeout(() => {
      if (!this.running || lifecycle !== this.lifecycle) return;
      this.timer = undefined;
      void this.tick().catch(() => undefined).finally(() => this.schedule(this.intervalMs, lifecycle));
    }, delay);
    this.timer.unref?.();
  }
}
