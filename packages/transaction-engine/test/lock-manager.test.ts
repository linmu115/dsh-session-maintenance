import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RootWriteLockManager } from "../src/index.js";

describe("RootWriteLockManager", () => {
  it("serializes one root and permits different roots concurrently", async () => {
    const manager = new RootWriteLockManager();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = manager.withLock("dsh-a", "root-a", async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });
    const second = manager.withLock("dsh-a", "root-a", async () => {
      order.push("second");
    });
    const other = manager.withLock("dsh-b", "root-b", async () => {
      order.push("other");
    });
    await other;
    expect(order).toEqual(["first-start", "other"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "other", "first-end", "second"]);
  });

  it("does not steal a persisted lock owned by another manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-lock-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new RootWriteLockManager(root).withLock("dsh-a", "root-a", () => gate);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      new RootWriteLockManager(root).withLock("dsh-a", "root-a", async () => undefined),
    ).rejects.toMatchObject({ code: "TRANSACTION_IN_PROGRESS" });
    release();
    await first;
    await rm(root, { recursive: true, force: true });
  });
});
