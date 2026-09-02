import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Alpha2ProjectionPersistenceOverlay,
  Alpha2SessionPersistenceProjection,
  normalizeProjectionRuntimeDescriptor,
  ProjectionRuntimeRegistrar,
  RuntimeBrokerPluginClient,
} from "../src/projection-runtime.js";

describe("DSH projection runtime", () => {
  it("loads by runId and loopback endpoint and attaches the projected Alpha2 catalog", async () => {
    const catalog = {
      type: "catalog" as const,
      schemaVersion: 2 as const,
      runId: "run-alpha2-projection",
      hotLimit: 200,
      sessions: [{
        nativeSessionId: "native-alpha2",
        updatedAt: "2026-08-31T00:00:00.000Z",
        hot: true,
        eventCount: 0,
        payload: { header: { version: 0, id: "native-alpha2", createdAt: 1 }, events: [] },
      }],
    };
    const transport = { stream: vi.fn(async function* () {
      yield { type: "catalog-begin" as const, schemaVersion: 2 as const, runId: catalog.runId, hotLimit: 200, sessionCount: 1 };
      yield { type: "catalog-sessions" as const, sessions: catalog.sessions };
      yield { type: "catalog-end" as const, sessionCount: 1 };
      yield { type: "session-begin" as const, nativeSessionId: "native-alpha2" };
      yield { type: "session-end" as const, nativeSessionId: "native-alpha2", eventCount: 0 };
    }) };
    const overlay = new Alpha2ProjectionPersistenceOverlay();
    const attach = vi.spyOn(overlay, "attach");
    const detach = vi.spyOn(overlay, "detach");
    const registrar = new ProjectionRuntimeRegistrar({
      transport,
      overlay,
      clock: () => "2026-08-31T00:00:00.000Z",
    });
    const descriptor = {
      runId: catalog.runId,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    };
    const registration = await registrar.attach(descriptor);
    expect(transport.stream).toHaveBeenCalledWith(descriptor);
    expect(attach).toHaveBeenCalledWith(catalog);
    expect(overlay.list(registration.registrationId)).toEqual(["native-alpha2"]);
    expect(overlay.inspect(registration.registrationId, "native-alpha2")).toMatchObject({ header: { version: 0 } });
    expect(JSON.stringify(transport.stream.mock.calls)).not.toMatch(/projectionRoot|sessions[/\\]/u);
    await expect(registrar.drain(registration.registrationId, catalog.runId)).resolves.toMatchObject({ pendingOperations: 0 });
    expect(overlay.isDraining(registration.registrationId)).toBe(true);
    await registrar.detach(registration.registrationId, catalog.runId);
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

  it("registers every catalog header, hydrates only hot sessions at startup, and single-flights a cold click", async () => {
    const runId = "run-hot-cold";
    const hot = { nativeSessionId: "native-hot", updatedAt: "2026-09-01T02:00:00.000Z", hot: true, eventCount: 2,
      payload: { logicalSessionId: "logical-hot", baseVersionId: "version-hot", projectId: "project-hot", projectTitle: "Hot project", title: "Hot title", header: { version: 0, id: "native-hot", createdAt: 2 }, events: [] } };
    const cold = { nativeSessionId: "native-cold", updatedAt: "2026-09-01T01:00:00.000Z", hot: false, eventCount: 1,
      payload: { logicalSessionId: "logical-cold", baseVersionId: "version-cold", projectId: "project-cold", projectTitle: "Cold project", title: "Cold title", header: { version: 0, id: "native-cold", createdAt: 1 }, events: [] } };
    const catalog = { type: "catalog" as const, schemaVersion: 2 as const, runId, hotLimit: 1, sessions: [hot, cold] };
    const create = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const replaceHeaderIndex = vi.fn(async () => undefined);
    const attached: string[] = [];
    const createWorkspace = vi.fn(async (path: string, title?: string) => ({
      id: `workspace-${title}`,
      path,
      title: title ?? "",
      setTitle: vi.fn(async () => undefined),
      attachSession: vi.fn(async (sessionId: string) => { attached.push(sessionId); }),
    }));
    const deleteWorkspace = vi.fn(async () => true);
    const projectionCache = new Map<string, unknown>();
    const status = vi.fn();
    const persistenceRoot = await mkdtemp(join(tmpdir(), "dsh-maintenance-projection-"));
    let coldStreams = 0;
    const transport = { stream: vi.fn(async function* (_descriptor: unknown, nativeSessionId?: string) {
      if (nativeSessionId === undefined) {
        yield { type: "catalog-begin" as const, schemaVersion: 2 as const, runId, hotLimit: 1, sessionCount: 2 };
        yield { type: "catalog-sessions" as const, sessions: catalog.sessions.slice(0, 1) };
        yield { type: "catalog-sessions" as const, sessions: catalog.sessions.slice(1) };
        yield { type: "catalog-end" as const, sessionCount: 2 };
        yield { type: "session-begin" as const, nativeSessionId: hot.nativeSessionId };
        yield { type: "events" as const, nativeSessionId: hot.nativeSessionId, events: [{ seq: 0 }, { seq: 1 }] };
        yield { type: "session-end" as const, nativeSessionId: hot.nativeSessionId, eventCount: 2 };
      } else {
        coldStreams += 1;
        await Promise.resolve();
        yield { type: "session-begin" as const, nativeSessionId };
        yield { type: "events" as const, nativeSessionId, events: [{ seq: 0 }] };
        yield { type: "session-end" as const, nativeSessionId, eventCount: 1 };
      }
    }) };
    const overlay = new Alpha2SessionPersistenceProjection({
      sessionPersistence: { root: persistenceRoot, create, append, list: async () => [] },
      workspaceRegistry: {
        replaceHeaderIndex,
        list: () => [{
          id: "workspace-stale-run",
          path: join(tmpdir(), "old-projection", "projection", ".maintenance-projects", "project-hot"),
          title: "Old projected workspace",
          setTitle: vi.fn(async () => undefined),
          attachSession: vi.fn(async () => undefined),
        }],
        create: createWorkspace,
        delete: deleteWorkspace,
      },
      sessionProjectionCache: {
        table: {
          get: (id: string) => projectionCache.get(id),
          put: async (id: string, value: unknown) => { projectionCache.set(id, value); },
        },
      },
    }, `projection:${runId}`, status);
    const registrar = new ProjectionRuntimeRegistrar({ transport, overlay });
    const descriptor = { runId, maintenanceEndpoint: "http://127.0.0.1:41781" };

    await registrar.attach(descriptor);
    expect(replaceHeaderIndex).toHaveBeenCalledWith([
      expect.objectContaining({ id: "native-hot" }),
      expect.objectContaining({ id: "native-cold" }),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: "native-hot" }));
    expect(createWorkspace).toHaveBeenCalledTimes(2);
    expect(deleteWorkspace).toHaveBeenCalledWith("workspace-stale-run");
    expect(attached).toEqual(expect.arrayContaining(["native-hot", "native-cold"]));
    expect(projectionCache.get("native-hot")).toMatchObject({
      rows: {
        title: { ver: 1, seq: 1, val: "Hot title" },
        sessionListMetadata: { ver: 1, seq: 1, val: { blank: false } },
      },
    });
    expect(status).toHaveBeenCalledWith("runtime.workspace.index", expect.objectContaining({ sessions: 2, managedCwds: 2 }));
    expect(status).toHaveBeenCalledWith("runtime.workspace.reconcile", expect.objectContaining({ attachedSessions: 2, failures: 0 }));
    expect(status).toHaveBeenCalledWith("runtime.projection-cache.seed", expect.objectContaining({ titles: 2, metadata: 2 }));
    expect(registrar.coldSessionIds(runId)).toEqual(["native-cold"]);

    await Promise.all([registrar.hydrate(descriptor, "native-cold"), registrar.hydrate(descriptor, "native-cold")]);
    expect(coldStreams).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenLastCalledWith("native-cold", [{ seq: 0 }]);
    expect(registrar.coldSessionIds(runId)).toEqual([]);
    await rm(persistenceRoot, { recursive: true, force: true });
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
          session: { logicalSessionId: "logical-alpha2-live", baseVersionId: "version-alpha2-live" },
        });
      }
      if (url.pathname.endsWith("/append")) {
        appendAttempts += 1;
        if (appendAttempts === 1) return json({ error: { message: "synthetic transient failure" } }, 503);
        const operation = body.operation as {
          readonly nativeRevision: number;
          readonly payload: { readonly logicalSessionId: string };
        };
        return json({
          schemaVersion: 1,
          receipt: {
            status: "committed",
            logicalSessionId: appendAttempts === 2 ? "logical-alpha2-derived" : operation.payload.logicalSessionId,
            canonicalVersionId: `version-committed-${operation.nativeRevision}`,
          },
        });
      }
      if (url.pathname.endsWith("/flush")) return json({ schemaVersion: 1, pendingOperations: 0 });
      if (url.pathname.endsWith("/drain")) return json({ schemaVersion: 1, state: "drained", pendingOperations: 0 });
      return json({ error: { message: `unexpected route ${url.pathname}` } }, 404);
    }) as typeof fetch;
    const registrar = new ProjectionRuntimeRegistrar({
      transport: { stream: vi.fn(async function* () {
        yield { type: "catalog-begin" as const, schemaVersion: 2 as const, runId, hotLimit: 200, sessionCount: 0 };
        yield { type: "catalog-end" as const, sessionCount: 0 };
      }) },
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
    expect(appends).toHaveLength(2);
    expect(appends.map((request) => {
      const operation = request.body.operation as {
        readonly nativeRevision: number;
        readonly payload: {
          readonly logicalSessionId: string;
          readonly baseVersionId: string | null;
          readonly events: unknown[];
        };
      };
      return {
        revision: operation.nativeRevision,
        logicalSessionId: operation.payload.logicalSessionId,
        baseVersionId: operation.payload.baseVersionId,
        events: operation.payload.events,
      };
    })).toEqual([
      { revision: 2, logicalSessionId: "logical-alpha2-live", baseVersionId: "version-alpha2-live", events: [first, second] },
      { revision: 2, logicalSessionId: "logical-alpha2-live", baseVersionId: "version-alpha2-live", events: [first, second] },
    ]);
    expect(appends[0]!.body.operation).toEqual(appends[1]!.body.operation);
    expect(requests.some((request) => request.path.endsWith("/drain"))).toBe(true);
    expect(requests.some((request) => request.path.endsWith("/close"))).toBe(false);
  });

  it("batches streamed Alpha2 events that arrive while a durable append is in flight", async () => {
    const endpoint = "http://127.0.0.1:41781";
    const runId = "run-alpha2-stream-batch";
    const nativeSessionId = "native-alpha2-stream-batch";
    const appends: Array<Record<string, unknown>> = [];
    let releaseFirstAppend!: () => void;
    const firstAppendBlocked = new Promise<void>((resolve) => { releaseFirstAppend = resolve; });
    let firstAppendStarted!: () => void;
    const firstAppendObserved = new Promise<void>((resolve) => { firstAppendStarted = resolve; });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url.pathname.endsWith("/attach")) return json({ schemaVersion: 1, runId, state: "running" });
      if (url.pathname.endsWith("/append")) {
        appends.push(body);
        if (appends.length === 1) {
          firstAppendStarted();
          await firstAppendBlocked;
        }
        const operation = body.operation as { readonly nativeRevision: number };
        return json({
          schemaVersion: 1,
          receipt: {
            status: "committed",
            logicalSessionId: "logical-alpha2-stream-batch",
            canonicalVersionId: `version-${operation.nativeRevision}`,
          },
        });
      }
      if (url.pathname.endsWith("/flush")) return json({ schemaVersion: 1, pendingOperations: 0 });
      return json({ error: { message: `unexpected route ${url.pathname}` } }, 404);
    }) as typeof fetch;
    const catalogSession = {
      nativeSessionId,
      updatedAt: "2026-09-01T00:00:00.000Z",
      hot: true,
      eventCount: 0,
      payload: {
        logicalSessionId: "logical-alpha2-stream-batch",
        baseVersionId: "version-0",
        title: "Stream batch fixture",
        header: { version: 0, id: nativeSessionId, createdAt: 1 },
        events: [],
      },
    };
    const registrar = new ProjectionRuntimeRegistrar({
      transport: { stream: vi.fn(async function* () {
        yield { type: "catalog-begin" as const, schemaVersion: 2 as const, runId, hotLimit: 200, sessionCount: 1 };
        yield { type: "catalog-sessions" as const, sessions: [catalogSession] };
        yield { type: "catalog-end" as const, sessionCount: 1 };
      }) },
      overlay: new Alpha2ProjectionPersistenceOverlay(),
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
    const events = Array.from({ length: 201 }, (_, seq) => ({
      seq,
      type: "assistant/chunk",
      data: { text: `chunk-${seq}` },
    }));

    await client.attach();
    client.observe(nativeSessionId, events[0]!, header, [events[0]!]);
    await firstAppendObserved;
    for (let seq = 1; seq < events.length; seq += 1) {
      client.observe(nativeSessionId, events[seq]!, header, events.slice(0, seq + 1));
    }
    releaseFirstAppend();
    await client.flush(nativeSessionId);

    expect(appends).toHaveLength(2);
    expect(appends.map((body) => {
      const operation = body.operation as {
        readonly nativeRevision: number;
        readonly payload: { readonly events: unknown[] };
      };
      return { revision: operation.nativeRevision, eventCount: operation.payload.events.length };
    })).toEqual([
      { revision: 1, eventCount: 1 },
      { revision: 201, eventCount: 200 },
    ]);
    expect(appends.flatMap((body) => {
      const operation = body.operation as { readonly payload: { readonly events: unknown[] } };
      return operation.payload.events;
    })).toEqual(events);
  });

  it("coalesces the Alpha2 restore boundary and preparation prelude until the first real continuation", async () => {
    const endpoint = "http://127.0.0.1:41781";
    const runId = "run-alpha2-resume-prelude";
    const nativeSessionId = "native-alpha2-resume";
    const requests: Array<{ readonly path: string; readonly body: Record<string, unknown> }> = [];
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/attach")) return json({ schemaVersion: 1, runId, state: "running" });
      if (url.pathname.endsWith("/append")) return json({ schemaVersion: 1, receipt: { status: "committed" } });
      if (url.pathname.endsWith("/flush")) return json({ schemaVersion: 1, pendingOperations: 0 });
      return json({ error: { message: `unexpected route ${url.pathname}` } }, 404);
    }) as typeof fetch;
    const seed = [
      { seq: 0, type: "user/message", data: { text: "seed" } },
      { seq: 1, type: "assistant/message", data: { text: "answer" } },
    ];
    const catalogSession = {
      nativeSessionId,
      updatedAt: "2026-09-01T00:00:00.000Z",
      hot: false,
      eventCount: seed.length,
      payload: {
        logicalSessionId: "logical-alpha2-resume",
        baseVersionId: "version-alpha2-resume",
        title: "Resume fixture",
        header: { version: 0, id: nativeSessionId, createdAt: 1 },
        events: [],
      },
    };
    const registrar = new ProjectionRuntimeRegistrar({
      transport: { stream: vi.fn(async function* () {
        yield { type: "catalog-begin" as const, schemaVersion: 2 as const, runId, hotLimit: 0, sessionCount: 1 };
        yield { type: "catalog-sessions" as const, sessions: [catalogSession] };
        yield { type: "catalog-end" as const, sessionCount: 1 };
      }) },
      overlay: new Alpha2ProjectionPersistenceOverlay(),
    });
    const client = new RuntimeBrokerPluginClient({
      connection: { current: async () => ({ origin: endpoint, token: "t".repeat(32) }) },
      registrar,
      clientId: "client-plugin-test",
      runId,
      temporaryPersistenceRootId: `projection:${runId}`,
      maintenanceEndpoint: endpoint,
      fetchImpl,
    });
    const header = { version: 0, id: nativeSessionId, cwd: "D:/synthetic/project" };
    const marker = { seq: 2, type: "session/end-seed", data: {} };
    const permission = { seq: 3, type: "permission/preset", data: { preset: "workspace-write" } };
    const sandbox = { seq: 4, type: "sandbox/mode", data: { mode: "workspace-write" } };
    const approval = { seq: 5, type: "approval/policy", data: { policy: "ask" } };
    const continuation = { seq: 6, type: "user/message", data: { text: "continue" } };

    await client.attach();
    client.observe(nativeSessionId, permission, header, [...seed, marker, permission]);
    client.observe(nativeSessionId, sandbox, header, [...seed, marker, permission, sandbox]);
    client.observe(nativeSessionId, approval, header, [...seed, marker, permission, sandbox, approval]);
    await client.flush(nativeSessionId);
    expect(requests.filter((request) => request.path.endsWith("/append"))).toHaveLength(0);

    client.observe(nativeSessionId, continuation, header, [...seed, marker, permission, sandbox, approval, continuation]);
    await client.flush(nativeSessionId);
    const appends = requests.filter((request) => request.path.endsWith("/append"));
    expect(appends).toHaveLength(1);
    const operation = appends[0]!.body.operation as {
      readonly nativeRevision: number;
      readonly payload: { readonly events: unknown[] };
    };
    expect(operation.nativeRevision).toBe(7);
    expect(operation.payload.events).toEqual([marker, permission, sandbox, approval, continuation]);
    expect(requests.some((request) => request.path.endsWith("/sessions"))).toBe(false);
  });
});
