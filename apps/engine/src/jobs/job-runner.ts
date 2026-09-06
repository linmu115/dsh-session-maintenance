import { AsyncResource } from "node:async_hooks";
import {
  SessionMaintenanceError,
  type CodexImportRequest,
  type JobRef,
  type JsonValue,
  type RecoverTransactionRequest,
  type ReadOnlyEngine,
  type RestoreTransactionRequest,
  type WriteEngine,
} from "@linmu/dsh-session-contracts";

import { JobStore } from "./job-store.js";

export class JobRunner {
  private readonly active = new Set<string>();
  private started = false;
  private readonly scheduler = new AsyncResource("maintenance-job-scheduler");

  private readonly imports = new Map<string, AbortController>();
  private readonly importWork = new Set<Promise<void>>();
  private readonly otherWork = new Set<Promise<void>>();
  private stopping = false;
  constructor(readonly engine: ReadOnlyEngine & WriteEngine & {
    runWrite?: <T>(scope: string, operation: () => T | Promise<T>) => Promise<T>;
    importCodex?: (request: CodexImportRequest, signal?: AbortSignal, progress?: (current: number, message: string) => void | Promise<void>) => Promise<JsonValue>;
  }, readonly store: JobStore) {}


  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.store.recoverable()) {
      if (this.store.cancellationRequested(job.ref.id)) { this.store.fail(job.ref.id, "JOB_CANCELLED", "Cancelled before restart"); continue; }
      if (job.ref.status === "running") this.store.markRequeued(job.ref.id);
      if (job.request.kind === "codex-import") this.scheduleImport(job.ref.id, job.request);
      else if (job.request.kind === "scan") this.scheduleScan(job.ref.id, job.request.instanceIds);
      else if (job.request.kind === "apply") this.scheduleApply(job.ref.id, job.request.planId);
      else this.store.fail(job.ref.id, "RECOVERY_REQUIRED", "Interrupted restore requires a new scoped confirmation");
    }
  }

  enqueueCodexImport(request: CodexImportRequest): JobRef {
    if (this.stopping) throw new Error("JOB_RUNNER_STOPPING");
    const job = this.store.createCodexImport(request);
    if (job.status === "queued" || job.status === "running") this.scheduleImport(job.id, request);
    return job;
  }

  async cancelCodexImport(id: string): Promise<JobRef> {
    const job = this.store.get(id);
    if (job?.request.kind !== "codex-import") throw new Error("IMPORT_JOB_NOT_FOUND");
    // Signal first: cancellation must be observable while another bounded commit
    // owns the queue. Persist its restart intent through that same queue next.
    this.imports.get(id)?.abort(new Error("JOB_CANCELLED"));
    await this.mutate(() => this.store.requestCancellation(id));
    return this.store.get(id)!.ref;
  }

  resumeCodexImport(id: string): JobRef {
    const job = this.store.get(id);
    if (job?.request.kind !== "codex-import") throw new Error("IMPORT_JOB_NOT_FOUND");
    if (this.active.has(id)) throw new Error("IMPORT_JOB_ACTIVE");
    if (job.ref.status === "completed") return job.ref;
    this.store.markRequeued(id);
    this.scheduleImport(id, job.request);
    return this.store.get(id)!.ref;
  }

  async waitForImport(id: string): Promise<JsonValue> {
    const events = this.store.listEvents(id);
    const stored = this.store.get(id);
    if (stored?.ref.status === "completed") return stored.result!;
    if (stored?.ref.status === "failed") throw new Error(JSON.stringify(stored.result));
    for await (const event of this.store.subscribe(id, events.at(-1)?.sequence ?? -1)) {
      if (event.type === "queued") throw new Error("JOB_INTERRUPTED: job is persisted for restart");
      if (event.type === "failed") throw new Error(`${event.code}: ${event.message}`);
      if (event.type === "completed") return event.result;
    }
    throw new Error("IMPORT_JOB_NOT_FOUND");
  }

  async stopImports(): Promise<void> {
    this.stopping = true;
    for (const controller of this.imports.values()) controller.abort(new Error("JOB_INTERRUPTED"));
    await Promise.all([...this.importWork, ...this.otherWork]);
  }

  private scheduleImport(id: string, request: CodexImportRequest): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    const controller = new AbortController();
    this.imports.set(id, controller);
    const work = this.scheduler.runInAsyncScope(() => Promise.resolve().then(async () => {
      try {
        if (this.store.cancellationRequested(id)) controller.abort(new Error("JOB_CANCELLED"));
        controller.signal.throwIfAborted();
        await this.mutate(() => this.store.markRunning(id));
        if (this.engine.importCodex === undefined) throw new Error("IMPORT_NOT_AVAILABLE");
        const result = await this.engine.importCodex(request, controller.signal, (current, message) => this.mutate(() => this.store.progress(id, current, undefined, message)));
        await this.mutate(() => this.store.complete(id, result));
      } catch (error) {
        const interrupted = controller.signal.aborted && (controller.signal.reason as Error)?.message === "JOB_INTERRUPTED";
        if (interrupted) await this.mutate(() => this.store.markRequeued(id));
        else await this.mutate(() => this.store.fail(id, controller.signal.aborted ? "JOB_CANCELLED" : "IMPORT_FAILED", error instanceof Error ? error.message : "Import failed"));
      } finally {
        this.active.delete(id);
        this.imports.delete(id);
      }
    }));
    this.importWork.add(work);
    void work.then(() => this.importWork.delete(work), () => this.importWork.delete(work));
  }

  enqueueScan(instanceIds: readonly string[]): JobRef {
    const job = this.store.createScan(instanceIds);
    this.scheduleScan(job.id, instanceIds);
    return job;
  }

  enqueueApply(planId: string): JobRef {
    const job = this.store.createApply(planId);
    this.scheduleApply(job.id, planId);
    return job;
  }

  enqueueRestore(request: RestoreTransactionRequest): JobRef {
    const job = this.store.createRestore(request.transactionId);
    this.scheduleRestore(job.id, request);
    return job;
  }

  enqueueRecover(request: RecoverTransactionRequest): JobRef {
    const job = this.store.createRecover(request.transactionId);
    this.scheduleRecover(job.id, request);
    return job;
  }

  private scheduleScan(id: string, instanceIds: readonly string[]): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    this.trackOther(this.scheduler.runInAsyncScope(() => Promise.resolve().then(() => this.runScan(id, instanceIds))));
  }

  private scheduleApply(id: string, planId: string): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    this.trackOther(this.scheduler.runInAsyncScope(() => Promise.resolve().then(() => this.runApply(id, planId))));
  }

  private scheduleRestore(id: string, request: RestoreTransactionRequest): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    this.trackOther(this.scheduler.runInAsyncScope(() => Promise.resolve().then(() => this.runRestore(id, request))));
  }

  private scheduleRecover(id: string, request: RecoverTransactionRequest): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    this.trackOther(this.scheduler.runInAsyncScope(() => Promise.resolve().then(() => this.runRecover(id, request))));
  }

  private trackOther(work: Promise<void>): void {
    this.otherWork.add(work);
    void work.then(() => this.otherWork.delete(work), () => this.otherWork.delete(work));
  }

  private mutate<T>(operation: () => T): Promise<T> {
    return this.engine.runWrite === undefined ? Promise.resolve(operation()) : this.engine.runWrite("job-status", operation);
  }

  private async runScan(id: string, instanceIds: readonly string[]): Promise<void> {
    try {
      await this.mutate(() => this.store.markRunning(id));
      await this.mutate(() => this.store.progress(id, 0, instanceIds.length, "Scanning registered instances"));
      const result = await this.engine.scan({ instanceIds });
      await this.mutate(() => this.store.progress(id, instanceIds.length, instanceIds.length, "Scan complete"));
      await this.mutate(() => this.store.complete(id, result as unknown as JsonValue));
    } catch (error) {
      const code = error instanceof SessionMaintenanceError ? error.code : "UNEXPECTED_ERROR";
      await this.mutate(() => this.store.fail(id, code, error instanceof Error ? error.message : "Unknown scan failure"));
    } finally {
      this.active.delete(id);
    }
  }

  private async runApply(id: string, planId: string): Promise<void> {
    await this.runOperation(id, "Applying safe plan", () => this.engine.applyPlan({ planId }));
  }

  private async runRestore(id: string, request: RestoreTransactionRequest): Promise<void> {
    await this.runOperation(id, "Restoring transaction", () => this.engine.restoreTransaction(request));
  }

  private async runRecover(id: string, request: RecoverTransactionRequest): Promise<void> {
    await this.runOperation(id, "Recovering interrupted transaction", () => this.engine.recoverTransaction(request));
  }

  private async runOperation(id: string, message: string, operation: () => Promise<unknown>): Promise<void> {
    try {
      await this.mutate(() => this.store.markRunning(id));
      await this.mutate(() => this.store.progress(id, 0, 1, message));
      const result = await operation();
      await this.mutate(() => this.store.progress(id, 1, 1, `${message} complete`));
      await this.mutate(() => this.store.complete(id, result as JsonValue));
    } catch (error) {
      const code = error instanceof SessionMaintenanceError ? error.code : "UNEXPECTED_ERROR";
      await this.mutate(() => this.store.fail(id, code, error instanceof Error ? error.message : "Unknown operation failure"));
    } finally {
      this.active.delete(id);
    }
  }
}
