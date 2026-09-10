import { Context } from "@deepseek-ai/cordis";
import { tmpdir } from "node:os";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { PersistenceCoordinator, SessionPersistenceRevision, type PersistenceBackend, type StoredPrefix } from "@deepseek-ai/dsh-session-persistence";
import { describe, expect, it, vi } from "vitest";
import { SessionPersistenceProjection } from "../src/projection-runtime.js";

describe("RC1 empty projection materialization", () => {
  it("N02/N05: registers persistent native metadata without create, append, or body hydration", async () => {
    const create = vi.fn(), append = vi.fn(), ensureMaterialized = vi.fn();
    const header = { version: 0, id: "native-ready", createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: tmpdir() };
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
  it.each([false, true])("uses official create/announce/materialize/borrow without any fake event (failure=%s)", async (fail) => {
    const ctx = new Context();
    const sessions = new SessionStore(ctx);
    const records = new Map<string, StoredPrefix>();
    const backend: PersistenceBackend = {
      name: "empty-projection-fixture",
      loadStored: async id => structuredClone(records.get(id)),
      readStoredRevision: async id => records.get(id)?.revision,
      materializeHeader: vi.fn(async storage => {
        if (fail) throw new Error("fixture materialize failure");
        records.set(storage.meta.id, { ...structuredClone(storage), events: [], revision: SessionPersistenceRevision("fixture:0") });
      }),
      appendBatch: vi.fn(async () => { throw new Error("empty projection must not invent events"); }),
      commitRepair: vi.fn(async () => { throw new Error("empty projection needs no repair"); }),
      list: async () => [...records.values()].map(value => structuredClone(value.meta)),
    };
    const coordinator = new PersistenceCoordinator(ctx, backend);
    const status = vi.fn();
    const overlay = new SessionPersistenceProjection({
      sessions,
      sessionPersistence: {
        create: coordinator.create.bind(coordinator), append: coordinator.append.bind(coordinator),
        list: backend.list, ensureMaterialized: coordinator.ensureMaterialized.bind(coordinator),
      },
      workspaceRegistry: { replaceHeaderIndex: async () => {}, list: () => [],
        create: async (path: string, title: string) => ({ id: "fixture-workspace", path, title, setTitle: async () => {}, attachSession: async () => {} }), delete: vi.fn() },
      sessionProjectionCache: { table: { get: () => undefined, put: async () => {} } },
    } as never, "projection:run-empty", status);
    const metadata = { nativeSessionId: "native-empty", updatedAt: "2026-09-05T00:00:00.000Z", hot: true, eventCount: 0,
      payload: { header: { version: 0, id: "native-empty", createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: tmpdir() }, inheritedEventCount: 0, title: "Empty" } };
    const registrationId = await overlay.attach({ type: "catalog", schemaVersion: 2, runId: "run-empty", hotLimit: 1, sessions: [metadata] });
    try {
      await overlay.beginHydration(registrationId, metadata);
      // Reproduce RC1: create registers metadata but no readable artifact exists.
      expect(records.size).toBe(0);
      await expect(coordinator.borrowSession("native-empty" as never)).rejects.toThrow(/not found/);
      if (fail) {
        await expect(overlay.finishHydration(registrationId, "native-empty", 0)).rejects.toThrow("fixture materialize failure");
        expect(overlay.isHydrated(registrationId, "native-empty")).toBe(false);
      } else {
        await overlay.finishHydration(registrationId, "native-empty", 0);
        expect(overlay.isHydrated(registrationId, "native-empty")).toBe(true);
        expect(status).toHaveBeenCalledWith("runtime.empty-session.materialized", { nativeSessionId: "native-empty", eventCount: 0 });
        const observed = await coordinator.borrowSession("native-empty" as never);
        try { expect(observed.inspection.events).toEqual([]); }
        finally { observed[Symbol.dispose](); }
      }
      expect(sessions.get("native-empty" as never)).toBeUndefined();
      expect(backend.appendBatch).not.toHaveBeenCalled();
      expect(backend.commitRepair).not.toHaveBeenCalled();
    } finally { await ctx.fiber.dispose(); }
  });
});
