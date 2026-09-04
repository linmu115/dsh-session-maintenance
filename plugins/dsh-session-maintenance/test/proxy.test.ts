import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileConnectionProvider, RestrictedEngineProxy, type EngineConnectionProvider } from "../src/engine-proxy.js";

const config = { connectionId: "primary", dshInstanceId: "dsh-fixture", profileId: "web" };
const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("restricted Engine proxy", () => {
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
