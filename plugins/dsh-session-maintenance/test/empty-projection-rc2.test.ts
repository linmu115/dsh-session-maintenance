import { Context } from "@deepseek-ai/cordis";
import { tmpdir } from "node:os";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { rc2ProjectionContext } from "../src/rc2-persistence.js";
import { describe, expect, it, vi } from "vitest";
import { SessionPersistenceProjection } from "../src/projection-runtime.js";

describe("RC2 empty projection materialization", () => {
  it("N02/N05: registers persistent native metadata without create, append, or body hydration", async () => {
    const create = vi.fn(), append = vi.fn(), ensureMaterialized = vi.fn();
    const header = { version: 3, id: "native-ready", createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: tmpdir() };
    const put = vi.fn();
    const overlay = new SessionPersistenceProjection({
      sessionPersistence: { create, append, ensureMaterialized, list: async () => [header] },
      workspaceRegistry: { replaceHeaderIndex: async () => {}, list: () => [],
        create: async (path: string, title: string) => ({ id: "fixture", path, title, attachSession: async () => {} }) },
      sessionProjectionCache: { table: { get: () => undefined, put } },
    } as never, "projection:native-run");
    const metadata = { nativeSessionId: header.id, updatedAt: "2026-09-10T00:00:00Z", hot: false, eventCount: 0,
      payload: { header, inheritedEventCount: 0, title: "Empty native history", tags: ["fixture"] } };
    const id = await overlay.attach({ type: "catalog", schemaVersion: 2, runId: "native-run", hotLimit: 0,
      nativeMode: "persistent-native-v1", sessions: [metadata] });
    expect(overlay.isHydrated(id, header.id)).toBe(true);
    await overlay.beginHydration(id, metadata);
    expect(create).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled(); expect(ensureMaterialized).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalled();
  });
  it.each([false, true])("materializes V3 empty history through an official writer (failure=%s)", async fail => {
    const root = await mkdtemp(join(tmpdir(), "maintenance-empty-rc2-"));
    const ctx = new Context();
    await ctx.plugin(JsonlSessionPersistence, { root, compression: "zstd" });
    const storage = ctx.sessionPersistence;
    const append = vi.fn();
    if (fail) {
      const create = storage.create.bind(storage);
      vi.spyOn(storage, "create").mockImplementation(async (...args) => {
        const handle = await create(...args);
        handle.flush = async () => { throw new Error("fixture materialize failure"); };
        return handle;
      });
    }
    const put = vi.fn(async () => {});
    const context = rc2ProjectionContext({ sessionPersistence: storage,
      workspaceRegistry: { replaceHeaderIndex: async () => {}, list: () => [],
        create: async () => ({ id: "fixture", attachSession: async () => {}, setTitle: async () => {} }), delete: vi.fn() },
      sessionProjectionCache: { table: { get: () => undefined, put } },
    } as never);
    const originalAppend = context.sessionPersistence.append.bind(context.sessionPersistence);
    context.sessionPersistence.append = async (...args) => { append(...args); return originalAppend(...args); };
    const overlay = new SessionPersistenceProjection(context, "projection:empty-rc2");
    const header = { version: 3, id: "empty-rc2", createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: root };
    const metadata = { nativeSessionId: header.id, updatedAt: "2026-09-12T00:00:00.000Z", hot: true, eventCount: 0,
      payload: { header, inheritedEventCount: 0, title: "Empty" } };
    const registration = await overlay.attach({ type: "catalog", schemaVersion: 2, runId: "empty-rc2", hotLimit: 1, sessions: [metadata] });
    try {
      await overlay.beginHydration(registration, metadata);
      if (fail) {
        await expect(overlay.finishHydration(registration, header.id, 0)).rejects.toThrow("fixture materialize failure");
        expect(overlay.isHydrated(registration, header.id)).toBe(false);
      } else {
        await overlay.finishHydration(registration, header.id, 0);
        expect(overlay.isHydrated(registration, header.id)).toBe(true);
        const reader = await storage.open(header.id as never, "read");
        try { expect(reader.header.version).toBe(3); expect((await reader.read()).events).toEqual([]); }
        finally { await reader.close(); }
      }
      expect(append).not.toHaveBeenCalled();
    } finally { await overlay.detach(registration); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
