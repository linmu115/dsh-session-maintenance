import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceGraph } from "../src/session-graph.js";
import { InMemoryProjectionPersistenceOverlay, ProjectionRuntimeRegistrar, RuntimeBrokerPluginClient } from "../src/projection-runtime.js";

afterEach(() => vi.unstubAllGlobals());
describe("maintenanceGraph host boundary", () => {
  it("retains an explicitly chosen empty session once without appending fictitious messages", async () => {
    const requests: string[] = [], runId = "graph-empty-run";
    const registrar = new ProjectionRuntimeRegistrar({
      transport: { stream: async function* () {
        yield { type: "catalog-begin" as const, schemaVersion: 2 as const, runId, hotLimit: 0, sessionCount: 0 };
        yield { type: "catalog-end" as const, sessionCount: 0 };
      } }, overlay: new InMemoryProjectionPersistenceOverlay(),
    });
    const client = new RuntimeBrokerPluginClient({ connection: { current: async () => ({ origin: "http://127.0.0.1:1234", token: "fixture" }) },
      registrar, runId, clientId: "graph-fixture", temporaryPersistenceRootId: "projection:graph", maintenanceEndpoint: "http://127.0.0.1:1234",
      fetchImpl: (async (url: string, _init: RequestInit) => {
        requests.push(url);
        return new Response(JSON.stringify(url.endsWith("/sessions")
          ? { session: { logicalSessionId: "logical-empty", baseVersionId: null } }
          : { schemaVersion: 1, runId, state: "running", pendingOperations: 0 }));
      }) as typeof fetch });
    const header = { version: 3, id: "native-empty", createdAt: 1, delegationDepth: 0, isSeeded: false };
    await expect(client.retainExplicitSession("native-empty", header)).rejects.toThrow("not accepting");
    await client.attach();
    await client.retainExplicitSession("native-empty", header, { inheritedEventCount: 0 });
    await client.retainExplicitSession("native-empty", header, { inheritedEventCount: 0 });
    await client.flush("native-empty");
    expect(requests.filter(url => url.endsWith("/sessions"))).toHaveLength(1);
    expect(requests.some(url => url.endsWith("/append"))).toBe(false);
  });
  it("binds every request to the host run and registers before resolving explicitly created sessions", async () => {
    const order: string[] = [], requests: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get("authorization") });
      order.push("request");
      return new Response(JSON.stringify({ logicalSessionId: "logical", nativeSessionId: "native", title: "title" }));
    });
    const graph = new MaintenanceGraph({ current: async () => ({ origin: "http://127.0.0.1:1234", token: "fixture-private" }) },
      "bound-run", async native => { expect(native).toBe("native"); order.push("registered"); });
    expect(graph.protocolVersion).toBe(2);
    await graph.created("native");
    expect(order).toEqual(["registered", "request"]);
    expect(requests[0].body).toEqual({ runId: "bound-run", target: { nativeSessionId: "native" } });
    await graph.directory("workspace", "cursor");
    await graph.preview("logical", undefined, { sourceVersionId: "version", sourceAnchorId: "reply" });
    await graph.relations("logical", "last-object");
    await graph.ensure("logical");
    await graph.load("main-graph");
    await graph.disclosures("main-graph", "last-receipt");
    await graph.sourceMarkers("native");
    await graph.revokeSource("native", "source-ref");
    await graph.setSessionArchived("native", true);
    expect(requests.every(request => request.body.runId === "bound-run" && request.authorization === "Bearer fixture-private")).toBe(true);
    expect(requests[2].body.selection).toEqual({ sourceVersionId: "version", sourceAnchorId: "reply" });
    expect(requests[3].body).toEqual({ runId:"bound-run", logicalSessionId:"logical", after:"last-object" });
    expect(requests.at(-2).body).toEqual({ runId: "bound-run", nativeSessionId: "native", referenceId: "source-ref" });
    expect(requests.at(-1).body).toEqual({ runId: "bound-run", nativeSessionId: "native", archived: true });
  });
  it("does not resolve an unregistered session or hide an Engine rejection", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "来源版本已改变", code: "GRAPH_SESSION_NOT_FOUND" } }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const graph = new MaintenanceGraph({ current: async () => ({ origin: "http://127.0.0.1:1234", token: "fixture" }) },
      "run", async () => { throw new Error("not registered"); });
    await expect(graph.created("native")).rejects.toThrow("not registered");
    expect(fetch).not.toHaveBeenCalled();
    await expect(graph.preview("logical")).rejects.toThrow("来源版本已改变");
    await expect(graph.resolve({ nativeSessionId: "missing" })).rejects.toMatchObject({ code: "GRAPH_SESSION_NOT_FOUND", status: 409 });
  });
});
