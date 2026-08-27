import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { SessionMaintenanceError } from "@linmu/dsh-session-contracts";

function isExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

export class RootWriteLockManager {
  readonly locksRoot: string | undefined;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(locksRoot?: string) {
    this.locksRoot = locksRoot;
  }

  withLock<T>(instanceId: string, rootIdentity: string, action: () => Promise<T>): Promise<T> {
    const key = `${instanceId}\u0000${rootIdentity}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.runLocked(key, instanceId, action));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.finally(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return run;
  }

  async clearStaleLockAfterInspection(
    instanceId: string,
    rootIdentity: string,
    inspectJournal: () => Promise<boolean>,
  ): Promise<void> {
    if (this.locksRoot === undefined) return;
    const path = this.pathFor(instanceId, rootIdentity);
    let owner: { readonly pid: number; readonly startToken: string };
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<typeof owner>;
      if (
        !Number.isSafeInteger(parsed.pid) ||
        typeof parsed.startToken !== "string" ||
        parsed.startToken.length < 8
      ) {
        throw new Error("invalid lock owner record");
      }
      owner = parsed as typeof owner;
    } catch (error) {
      throw new SessionMaintenanceError(
        "RECOVERY_REQUIRED",
        `Persisted lock cannot be proven stale: ${instanceId}`,
        { cause: error },
      );
    }
    if (processAppearsAlive(owner.pid)) {
      throw new SessionMaintenanceError(
        "TRANSACTION_IN_PROGRESS",
        `Persisted lock owner still appears active: ${instanceId}`,
      );
    }
    if (!(await inspectJournal())) {
      throw new SessionMaintenanceError(
        "RECOVERY_REQUIRED",
        `Persisted lock journal requires manual review: ${instanceId}`,
      );
    }
    const quarantine = `${path}.recovery-${randomUUID()}`;
    try {
      await rename(path, quarantine);
      await unlink(quarantine);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { readonly code?: unknown }).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }

  private async runLocked<T>(
    key: string,
    instanceId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const lockPath = await this.acquireFile(key, instanceId);
    try {
      return await action();
    } finally {
      if (lockPath !== undefined) await unlink(lockPath).catch(() => undefined);
    }
  }

  private async acquireFile(key: string, instanceId: string): Promise<string | undefined> {
    if (this.locksRoot === undefined) return undefined;
    await mkdir(this.locksRoot, { recursive: true });
    const path = this.pathForKey(key);
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({
            instanceId,
            pid: process.pid,
            startToken: randomUUID(),
            startedAt: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      return path;
    } catch (error) {
      if (isExists(error)) {
        throw new SessionMaintenanceError(
          "TRANSACTION_IN_PROGRESS",
          `A persisted write lock already exists for instance: ${instanceId}`,
        );
      }
      throw error;
    }
  }

  private pathFor(instanceId: string, rootIdentity: string): string {
    return this.pathForKey(`${instanceId}\u0000${rootIdentity}`);
  }

  private pathForKey(key: string): string {
    if (this.locksRoot === undefined) throw new Error("Persisted locks are disabled");
    const name = createHash("sha256").update(key).digest("hex");
    return join(this.locksRoot, `${name}.lock`);
  }
}

function processAppearsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ESRCH"
    );
  }
}
