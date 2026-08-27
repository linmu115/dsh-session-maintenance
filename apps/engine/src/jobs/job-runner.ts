import {
  SessionMaintenanceError,
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

  constructor(readonly engine: ReadOnlyEngine & WriteEngine, readonly store: JobStore) {}

  start(): void {
    for (const job of this.store.recoverable()) {
      if (job.ref.status === "running") this.store.markRequeued(job.ref.id);
      if (job.request.kind === "scan") this.scheduleScan(job.ref.id, job.request.instanceIds);
      else if (job.request.kind === "apply") this.scheduleApply(job.ref.id, job.request.planId);
      else this.store.fail(job.ref.id, "RECOVERY_REQUIRED", "Interrupted restore requires a new scoped confirmation");
    }
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
    queueMicrotask(() => void this.runScan(id, instanceIds));
  }

  private scheduleApply(id: string, planId: string): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    queueMicrotask(() => void this.runApply(id, planId));
  }

  private scheduleRestore(id: string, request: RestoreTransactionRequest): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    queueMicrotask(() => void this.runRestore(id, request));
  }

  private scheduleRecover(id: string, request: RecoverTransactionRequest): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    queueMicrotask(() => void this.runRecover(id, request));
  }

  private async runScan(id: string, instanceIds: readonly string[]): Promise<void> {
    try {
      this.store.markRunning(id);
      this.store.progress(id, 0, instanceIds.length, "Scanning registered instances");
      const result = await this.engine.scan({ instanceIds });
      this.store.progress(id, instanceIds.length, instanceIds.length, "Scan complete");
      this.store.complete(id, result as unknown as JsonValue);
    } catch (error) {
      const code = error instanceof SessionMaintenanceError ? error.code : "UNEXPECTED_ERROR";
      this.store.fail(id, code, error instanceof Error ? error.message : "Unknown scan failure");
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
      this.store.markRunning(id);
      this.store.progress(id, 0, 1, message);
      const result = await operation();
      this.store.progress(id, 1, 1, `${message} complete`);
      this.store.complete(id, result as JsonValue);
    } catch (error) {
      const code = error instanceof SessionMaintenanceError ? error.code : "UNEXPECTED_ERROR";
      this.store.fail(id, code, error instanceof Error ? error.message : "Unknown operation failure");
    } finally {
      this.active.delete(id);
    }
  }
}
