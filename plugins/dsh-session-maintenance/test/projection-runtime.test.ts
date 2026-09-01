import { describe, expect, it, vi } from "vitest";

import {
  Alpha2ProjectionPersistenceOverlay,
  normalizeProjectionRuntimeDescriptor,
  ProjectionRuntimeRegistrar,
  RuntimeBrokerPluginClient,
} from "../src/projection-runtime.js";

describe("DSH projection runtime", () => {
  it("loads by runId and loopback endpoint and attaches the projected Alpha2 catalog", async () => {
    const snapshot = {
      schemaVersion: 1 as const,
      runId: "run-alpha2-projection",
      sessions: [{ nativeSessionId: "native-alpha2", payload: { header: { version: 0 }, events: [] } }],
    };
    const transport = { load: vi.fn(async () => snapshot) };
    const overlay = new Alpha2ProjectionPersistenceOverlay();
    const attach = vi.spyOn(overlay, "attach");
    const detach = vi.spyOn(overlay, "detach");
    const registrar = new ProjectionRuntimeRegistrar({
      transport,
      overlay,
      clock: () => "2026-08-31T00:00:00.000Z",
    });
    const descriptor = {
      runId: snapshot.runId,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    };
    const registration = await registrar.attach(descriptor);
    expect(transport.load).toHaveBeenCalledWith(descriptor);
    expect(attach).toHaveBeenCalledWith(snapshot);
    expect(overlay.list(registration.registrationId)).toEqual(["native-alpha2"]);
    expect(overlay.inspect(registration.registrationId, "native-alpha2")).toMatchObject({ header: { version: 0 } });
    expect(JSON.stringify(transport.load.mock.calls)).not.toMatch(/projectionRoot|sessions[/\\]/u);
    await expect(registrar.drain(registration.registrationId, snapshot.runId)).resolves.toMatchObject({ pendingOperations: 0 });
    expect(overlay.isDraining(registration.registrationId)).toBe(true);
    await registrar.detach(registration.registrationId, snapshot.runId);
    expect(detach).toHaveBeenCalledWith("projection:run-alpha2-projection");
  });

  it("rejects path-shaped run IDs and non-loopback or path-bearing endpoints", () => {
    expect(() => normalizeProjectionRuntimeDescriptor({
      runId: "D:/profile/sessions",
      maintenanceEndpoint: "http://127.0.0.1:41781",
    })).toThrow("runId");
    expect(() => normalizeProjectionRuntimeDescriptor({
      runId: "run-safe",
      maintenanceEndpoint: "https://example.com/projection",
    })).toThrow("loopback");
    expect(() => normalizeProjectionRuntimeDescriptor({
      runId: "run-safe",
      maintenanceEndpoint: "http://127.0.0.1:41781/profile/sessions",
    })).toThrow("without credentials or a projection path");
  });

  it("registers a live-created session once, preserves event order across retry, and drains without closing the run", async () => {
    const endpoint = "http://127.0.0.1:41781";
    const runId = "run-alpha2-live-session";
    const nativeSessionId = "native-alpha2-live";
    const requests: Array<{ readonly path: string; readonly body: Record<string, unknown> }> = [];
    let appendAttempts = 0;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/attach")) return json({ schemaVersion: 1, runId, state: "running" });
      if (url.pathname.endsWith("/sessions")) {
        return json({
          schemaVersion: 1,
          session: { logicalSessionId: "logical-alpha2-live", baseVersionId: null },
        });
      }
      if (url.pathname.endsWith("/append")) {
        appendAttempts += 1;
        if (appendAttempts === 1) return json({ error: { message: "synthetic transient failure" } }, 503);
        return json({ schemaVersion: 1, receipt: { status: "committed" } });
      }
      if (url.pathname.endsWith("/flush")) return json({ schemaVersion: 1, pendingOperations: 0 });
      if (url.pathname.endsWith("/drain")) return json({ schemaVersion: 1, state: "drained", pendingOperations: 0 });
      return json({ error: { message: `unexpected route ${url.pathname}` } }, 404);
    }) as typeof fetch;
    const registrar = new ProjectionRuntimeRegistrar({
      transport: { load: vi.fn(async () => ({ schemaVersion: 1 as const, runId, sessions: [] })) },
      overlay: new Alpha2ProjectionPersistenceOverlay(),
      clock: () => "2026-09-01T00:00:00.000Z",
    });
    const client = new RuntimeBrokerPluginClient({
      connection: { current: async () => ({ origin: endpoint, token: "t".repeat(32) }) },
      registrar,
      clientId: "client-plugin-test",
      runId,
      temporaryPersistenceRootId: `projection:${runId}`,
      maintenanceEndpoint: endpoint,
      clock: () => "2026-09-01T00:00:01.000Z",
      fetchImpl,
    });
    const header = { version: 0, id: nativeSessionId, cwd: "D:/synthetic/project" };
    const first = { seq: 0, type: "message", message: "first" };
    const second = { seq: 1, type: "message", message: "second" };

    await client.attach();
    client.observe(nativeSessionId, first, header, [first]);
    client.observe(nativeSessionId, second, header, [first, second]);
    await client.flush(nativeSessionId);
    await client.drain("2026-09-01T00:00:02.000Z");

    expect(requests.filter((request) => request.path.endsWith("/sessions"))).toHaveLength(1);
    const appends = requests.filter((request) => request.path.endsWith("/append"));
    expect(appends).toHaveLength(3);
    expect(appends.map((request) => {
      const operation = request.body.operation as { readonly nativeRevision: number; readonly payload: { readonly events: unknown[] } };
      return { revision: operation.nativeRevision, events: operation.payload.events };
    })).toEqual([
      { revision: 1, events: [first] },
      { revision: 1, events: [first] },
      { revision: 2, events: [second] },
    ]);
    expect(requests.some((request) => request.path.endsWith("/drain"))).toBe(true);
    expect(requests.some((request) => request.path.endsWith("/close"))).toBe(false);
  });
});
