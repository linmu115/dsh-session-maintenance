import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProxyHandler, FileConnectionProvider, RestrictedEngineProxy, type EngineConnectionProvider } from "../src/engine-proxy.js";

const config = { connectionId: "primary", dshInstanceId: "dsh-fixture", profileId: "web" };
const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("restricted Engine proxy", () => {
  it('starts a stopped Engine only for the global Dashboard and retries its launch', async () => {
    let online = false;
    const starter = vi.fn(async () => { online = true; });
    const provider: EngineConnectionProvider = { current: async () => {
      if (!online) throw new Error('stopped');
      return { origin: 'http://127.0.0.1:43123', token: 'x'.repeat(43) };
    } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ launch: { url: 'http://127.0.0.1:43123/ui/claim?code=x' } })));
    const proxy = new RestrictedEngineProxy(config, provider, fetcher, undefined, starter);
    await expect(proxy.invoke({ operation: 'workspace-folders' })).rejects.toThrow('stopped');
    expect(starter).not.toHaveBeenCalled();
    expect((await proxy.invoke({ operation: 'dashboard' })).url).toContain('/ui/claim');
    expect(starter).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    await proxy.invoke({ operation: 'dashboard' });
    expect(starter).toHaveBeenCalledOnce();
  });
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

  it("answers the session-less workspace-folders operation, which the instance asks on every boot", async () => {
    // The defect this pins: the branch sat *below* the `sessionId` requirement, so the call always
    // threw before reaching the Engine and the instance could never learn which folders to register.
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:43123", token: "x".repeat(43) }) };
    const requested: string[] = [];
    const proxy = new RestrictedEngineProxy(config, provider, async (input) => {
      requested.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ folders: { schemaVersion: 1, instanceId: "dsh-fixture", folders: [
        { name: "计算机四大", path: "D:\\DSHworkplace\\计算机四大", sessions: ["dsh-maintenance_one"] },
      ] } }));
    });
    const result = await proxy.invoke({ operation: "workspace-folders" });
    expect(requested).toEqual(["/v1/instances/dsh-fixture/workspace-folders"]);
    expect(result.folders).toEqual([{ name: "计算机四大", path: "D:\\DSHworkplace\\计算机四大", sessions: ["dsh-maintenance_one"] }]);
    // An operation that really does name a session still refuses to work without one.
    await expect(proxy.invoke({ operation: "session-mapped" })).rejects.toThrow("sessionId");
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
      targetInstanceId: "dsh-fixture", targetProfileId: "web",
      referenceType: "sticker",
      logicalSessionId: "logical-session-1",
      logicalAnchorId: "logical-anchor-1",
      legacyNativeSessionId: "session-alpha1",
      legacyNativeAnchorId: "anchor-alpha1",
    });
    expect(result.referenceResolution).toMatchObject({ nativeSessionId: "session-alpha2", status: "resolved" });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("forwards a workspace join and reports an idempotent repeat as already-joined", async () => {
    const bodies: unknown[] = [];
    let already = false;
    const provider: EngineConnectionProvider = { current: async () => ({ origin: "http://127.0.0.1:43123", token: "a".repeat(43) }) };
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:43123/v1/instances/workspace-joins");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ join: { workspaceId: "workspace-a", mapped: already ? [] : ["s1", "s2"],
        alreadyPresent: already ? ["s1", "s2"] : [], failures: [] } }), { status: 200 });
    };
    const proxy = new RestrictedEngineProxy(config, provider, fetchImpl);
    const join = { operation: "join-workspace", workspaceId: "workspace-a", workspaceName: "工作区 A", workspacePath: "D:\\合成\\工作区A" } as const;
    const first = await proxy.invoke(join);
    expect(first.code).toBe("joined");
    expect(first.message).toContain("映射 2 个会话");
    already = true;
    const second = await proxy.invoke(join);
    expect(second.code).toBe("already-joined");
    expect(second.message).toContain("已在维护范围内");
    // The Engine receives the workspace facts plus this instance's identity, and nothing else.
    expect(bodies[0]).toEqual({ instanceId: "dsh-fixture", profileId: "web", workspaceId: "workspace-a",
      workspaceName: "工作区 A", workspacePath: "D:\\合成\\工作区A" });
  });

  it("refuses a workspace join that carries fields the operation does not accept", async () => {
    const proxy = new RestrictedEngineProxy(config, { current: async () => ({ origin: "http://127.0.0.1:43123", token: "a".repeat(43) }) },
      async () => new Response("{}", { status: 200 }));
    await expect(proxy.invoke({ operation: "join-workspace", workspaceId: "workspace-a", workspaceName: "n", workspacePath: "p", settings: {} } as never))
      .rejects.toThrow("工作区加入只接受");
    await expect(proxy.invoke({ operation: "join-workspace", workspaceId: "D:/escape", workspaceName: "n", workspacePath: "p" }))
      .rejects.toThrow("不能是路径");
  });

  it("answers the declared instance identity for the browser half", async () => {
    const declared = new RestrictedEngineProxy(
      { connectionId: "primary", dshInstanceId: "i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5", profileId: "web-i27c4" },
      { current: async () => ({ origin: "http://127.0.0.1:43123", token: "a".repeat(43) }) }, async () => new Response("{}", { status: 200 }));
    expect(await declared.invoke({ operation: "identity" })).toMatchObject({ ok: true,
      identity: { apiVersion: 1, instanceId: "i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5", profileId: "web-i27c4", declared: true } });
    // The portable placeholders mean this machine declared nothing; the answer needs no Engine.
    let contacted = 0;
    const undeclared = new RestrictedEngineProxy(config, { current: async () => ({ origin: "http://127.0.0.1:43123", token: "a".repeat(43) }) },
      async () => { contacted += 1; return new Response("{}", { status: 200 }); });
    expect((await undeclared.invoke({ operation: "identity" })).identity).toMatchObject({ declared: false, instanceId: "dsh-fixture" });
    expect(contacted).toBe(0);
  });

  it("tells a stopped Engine apart from a refused request across the client boundary", async () => {
    const offline = new RestrictedEngineProxy(config, { current: async () => { throw new Error("维护引擎连接描述符不可用"); } },
      async () => new Response("{}", { status: 200 }));
    await expect(offline.invoke({ operation: "status" }))
      .rejects.toMatchObject({ name: "ProxyError", code: "engine-unreachable" });
    const refusing = new RestrictedEngineProxy(config, { current: async () => ({ origin: "http://127.0.0.1:43123", token: "a".repeat(43) }) },
      async () => new Response(JSON.stringify({ error: { message: "工作区目录不在登记范围内" } }), { status: 409 }));
    await expect(refusing.invoke({ operation: "status" }))
      .rejects.toMatchObject({ name: "ProxyError", code: "engine-error", message: "工作区目录不在登记范围内" });
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
