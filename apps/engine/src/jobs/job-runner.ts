import { SessionMaintenanceError, type JobRef, type JsonValue, type ReadOnlyEngine } from "@linmu/dsh-session-contracts";

import { JobStore } from "./job-store.js";

export class JobRunner {
  private readonly active = new Set<string>();

  constructor(readonly engine: ReadOnlyEngine, readonly store: JobStore) {}

  start(): void {
    for (const job of this.store.recoverable()) {
      if (job.request.kind !== "scan" || job.request.instanceIds === undefined) {
        this.store.fail(job.ref.id, "RECOVERY_REQUIRED", "Interrupted job kind requires manual recovery");
        continue;
      }
      if (job.ref.status === "running") this.store.markRequeued(job.ref.id);
      this.schedule(job.ref.id, job.request.instanceIds);
    }
  }

  enqueueScan(instanceIds: readonly string[]): JobRef {
    const job = this.store.createScan(instanceIds);
    this.schedule(job.id, instanceIds);
    return job;
  }

  private schedule(id: string, instanceIds: readonly string[]): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    queueMicrotask(() => void this.runScan(id, instanceIds));
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
}
