import { describe, expect, it, vi } from "vitest";

import { installLazyProjectionPersistence } from "../src/lazy-persistence.js";

describe("Alpha2 lazy persistence seam", () => {
  it("hydrates a cold session once before concurrent native history reads and restores the backend", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let cold = true;
    const hydrate = vi.fn(async () => {
      await gate;
      cold = false;
    });
    const borrowSession = vi.fn(async (id: string) => `borrow:${id}`);
    const inspect = vi.fn(async (id: string) => `inspect:${id}`);
    const readFrom = vi.fn(async (id: string) => `read:${id}`);
    const list = vi.fn(async () => [{ id: "hot-session", createdAt: 2 }, { id: "dynamic-session", createdAt: 3 }]);
    const persistence = { borrowSession, inspect, readFrom, list };
    const stages: string[] = [];
    const restore = installLazyProjectionPersistence(persistence, {
      coldSessionIds: () => cold ? ["cold-session"] : [],
      sessionHeaders: () => [
        { id: "hot-session", createdAt: 1, cwd: "projected-hot" },
        { id: "cold-session", createdAt: 1, cwd: "projected-cold" },
      ],
      hydrate,
    } as never, (stage) => stages.push(stage));

    const first = persistence.borrowSession("cold-session");
    const second = persistence.inspect("cold-session");
    await expect(persistence.list()).resolves.toEqual([
      { id: "hot-session", createdAt: 2 },
      { id: "cold-session", createdAt: 1, cwd: "projected-cold" },
      { id: "dynamic-session", createdAt: 3 },
    ]);
    expect(borrowSession).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["borrow:cold-session", "inspect:cold-session"]);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(stages).toEqual(["lazy.catalog.ready", "lazy.borrow.request", "lazy.materialize.commit"]);

    restore();
    await expect(persistence.list()).resolves.toEqual([
      { id: "hot-session", createdAt: 2 },
      { id: "dynamic-session", createdAt: 3 },
    ]);
    await expect(persistence.readFrom("cold-session")).resolves.toBe("read:cold-session");
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the native read when materialization fails", async () => {
    const borrowSession = vi.fn(async () => "unreachable");
    const failure = new Error("stream interrupted");
    const persistence = { borrowSession, inspect: vi.fn(), readFrom: vi.fn(), list: vi.fn(async () => []) };
    installLazyProjectionPersistence(persistence as never, {
      coldSessionIds: () => ["cold-session"],
      sessionHeaders: () => [{ id: "cold-session" }],
      hydrate: async () => { throw failure; },
    } as never);

    await expect(persistence.borrowSession("cold-session")).rejects.toThrow("stream interrupted");
    expect(borrowSession).not.toHaveBeenCalled();
  });
});
