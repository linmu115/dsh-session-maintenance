import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createProxyHandler, FileConnectionProvider, RestrictedEngineProxy, type EngineConnectionProvider } from "../src/engine-proxy.js";

const config = { connectionId: "primary", dshInstanceId: "dsh-fixture", profileId: "web" };
const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("restricted Engine proxy", () => {
  it("rejects cross-origin and simple-form mutations before Engine is contacted", async () => {
    let called = 0;
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:43123", token: "x".repeat(43) }) };
    const proxy = new RestrictedEngineProxy(config, provider, async () => { called++; return new Response("{}"); });
    const server = createServer(createProxyHandler(proxy));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${address.port}/dsh-session-maintenance/api`;
    try {
      const body = JSON.stringify({ operation: "delete-session", sessionId: "native-1" });
      expect((await fetch(endpoint, { method: "POST", body, headers: { "content-type": "text/plain" } })).status).toBe(415);
      expect((await fetch(endpoint, { method: "POST", body, headers: { "content-type": "application/json", origin: "http://untrusted.example" } })).status).toBe(403);
      expect(called).toBe(0);
      await expect(proxy.invoke({ operation: "delete-session", sessionId: "native-1", instanceId: "other-instance" })).rejects.toThrow("当前实例");
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it.each(["deleted", "pending-delete"] as const)("deletes through current-run identity and reports the exact %s receipt", async (state) => {
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:43123", token: "x".repeat(43) }) };
    const calls: Array<[string, string | undefined]> = [];
    const proxy = new RestrictedEngineProxy(config, provider, async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push([path, init?.method]);
      return new Response(JSON.stringify({ resolution: { logicalSessionId: "logical-mirror", title: "Same title", status: "active" },
        deletion: { logicalSessionId: "logical-mirror", state, pendingOperations: state === "deleted" ? 0 : 2 } }));
    }, "run-rc1");
    const result = await proxy.invoke({ operation: "delete-session", sessionId: "native-mirror" });
    expect(calls).toEqual([
      ["/v1/projection-runs/run-rc1/sessions/native-mirror", "DELETE"],
    ]);
    expect(result.deletion?.state).toBe(state);
    expect(result.message).toContain(state === "deleted" ? "真源已删除" : "待现有写入收尾");
    expect(result.url).toBeUndefined();
    expect(result.message).toContain("Codex 原始会话未修改");
  });

  it("never deletes when the selected run has no native mapping and never falls back to an old binding", async () => {
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:43123", token: "x".repeat(43) }) };
    const methods: string[] = [];
    const proxy = new RestrictedEngineProxy(config, provider, async (_input, init) => {
      methods.push(init!.method!);
      return new Response(JSON.stringify({ error: { message: "Session is not mapped in the active projection run" } }), { status: 404 });
    }, "run-current");
    await expect(proxy.invoke({ operation: "delete-session", sessionId: "native-stale" })).rejects.toThrow("not mapped");
    expect(methods).toEqual(["DELETE"]);
    await expect(proxy.invoke({ operation: "delete-session", sessionId: "native-stale", runId: "run-other" } as never)).rejects.toThrow("未允许字段");
  });

  it("does not claim success from a mismatched canonical deletion receipt", async () => {
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:43123", token: "x".repeat(43) }) };
    const proxy = new RestrictedEngineProxy(config, provider, async () => new Response(JSON.stringify({ resolution: { logicalSessionId: "ls-1" },
      deletion: { logicalSessionId: "ls-2", state: "deleted", pendingOperations: 0 } })), "run-current");
    await expect(proxy.invoke({ operation: "delete-session", sessionId: "native-1" })).rejects.toThrow("匹配的真源删除回执");
  });

  it("forwards stable references through the same-origin proxy without exposing the Engine token", async () => {
    const token = "r".repeat(43);
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:43123", token }) };
    let requestBody: unknown;
    const proxy = new RestrictedEngineProxy(config, provider, async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:43123/v1/references/resolve");
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        resolution: {
          referenceType: "sticker",
          logicalSessionId: "logical-session-1",
          logicalAnchorId: "logical-anchor-1",
          nativeSessionId: "session-alpha2",
          nativeAnchorId: "anchor-alpha2",
          runId: "run-alpha2",
          status: "resolved",
        },
      }), { status: 200 });
    });
    const result = await proxy.invoke({
      operation: "reference:resolve",
      referenceType: "sticker",
      logicalSessionId: "logical-session-1",
      logicalAnchorId: "logical-anchor-1",
      legacyNativeSessionId: "session-alpha1",
      legacyNativeAnchorId: "anchor-alpha1",
    });
    expect(requestBody).toEqual({
      referenceType: "sticker",
      logicalSessionId: "logical-session-1",
      logicalAnchorId: "logical-anchor-1",
      legacyNativeSessionId: "session-alpha1",
      legacyNativeAnchorId: "anchor-alpha1",
    });
    expect(result.referenceResolution).toMatchObject({ nativeSessionId: "session-alpha2", status: "resolved" });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("refreshes the host-only connection and never returns the rotating capability", async () => {
    let token = "a".repeat(43);
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:43123", token }) };
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ status: { ready: true, instanceCount: 2 } }), { status: 200 });
    };
    const proxy = new RestrictedEngineProxy(config, provider, fetchImpl);
    expect(JSON.stringify(await proxy.invoke({ operation: "status" }))).not.toContain(token);
    token = "b".repeat(43);
    expect(JSON.stringify(await proxy.invoke({ operation: "status" }))).not.toContain(token);
    expect(seen).toEqual([`Bearer ${"a".repeat(43)}`, `Bearer ${"b".repeat(43)}`]);
  });

  it("reloads an ACL descriptor after Engine rotates port and token", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-maintenance-connection-"));
    cleanups.push(root);
    const path = join(root, "connection.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port: 41001, token: "a".repeat(43) }));
    const provider = new FileConnectionProvider(path);
    expect(await provider.current()).toEqual({ origin: "http://127.0.0.1:41001", token: "a".repeat(43) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(path, JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port: 41002, token: "b".repeat(43) }));
    expect(await provider.current()).toEqual({ origin: "http://127.0.0.1:41002", token: "b".repeat(43) });
  });

  it("rejects path-shaped identifiers before contacting Engine", async () => {
    let called = false;
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:1", token: "x".repeat(43) }) };
    const proxy = new RestrictedEngineProxy(config, provider, async () => { called = true; return new Response("{}"); });
    await expect(proxy.invoke({ operation: "resolve", instanceId: "D:/escape", sessionId: "session" })).rejects.toThrow("不能是路径");
    expect(called).toBe(false);
  });

  it("bounds offline feedback without exposing a capability", async () => {
    const secret = "s".repeat(43);
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:1", token: secret }) };
    const proxy = new RestrictedEngineProxy(config, provider, async () => { throw new Error(secret); });
    await expect(proxy.invoke({ operation: "status" })).rejects.toThrow("维护引擎离线");
    await expect(proxy.invoke({ operation: "status" })).rejects.not.toThrow(secret);
  });
});
