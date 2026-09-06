import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import {
  MaintenanceExternalLifecycleProvider,
  runExternalLifecycleStdio,
} from "../src/external-lifecycle-provider.js";
import { runCli } from "../src/cli.js";
import { EngineDescriptorDshGatewayConnections } from "../src/dsh-gateway-connection.js";
import { FileConnectionProvider } from "../../../plugins/dsh-session-maintenance/src/engine-proxy.js";
import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fixture(fetchImpl: typeof fetch) {
  const stateRoot = await mkdtemp(join(tmpdir(), "dsh-maint-external-lifecycle-"));
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
  const provider = new MaintenanceExternalLifecycleProvider(stateRoot, {
    fetch: fetchImpl,
    randomId: () => "0123456789abcdefghijklmnopqrstuv",
    clock: () => "2026-09-01T00:00:00.000Z",
    connection: async () => ({ origin: "http://127.0.0.1:41780", token: "t".repeat(32) }),
  });
  return { stateRoot, provider };
}

function prepareRequest() {
  return {
    schemaVersion: 1,
    phase: "prepare",
    instanceId: "alpha2-instance",
    profileId: "web",
    runtimeVersion: "0.1.2-alpha.2",
    web: true,
  };
}

function rc1PrepareRequest() {
  return {
    ...prepareRequest(),
    instanceId: "rc1-instance",
    runtimeVersion: "0.1.2-rc.1",
  };
}

describe("Maintenance external lifecycle provider", () => {
  it.each(["owned", "legacy"] as const)("reuses a running Engine through its %s connection file for repeated lifecycle phases", async (format) => {
    const fixture = await createEngineFixture(`external-connection-${format}`);
    cleanups.push(fixture.cleanupAll);
    // This helper calls startMaintenanceServer, including the real connection.json writer.
    const server = await fixture.startServer();
    const path = join(fixture.stateRoot, "connection.json");
    const descriptor = JSON.parse(await readFile(path, "utf8"));
    expect(descriptor).toMatchObject({ pid: process.pid, ownerId: fixture.engine.writes!.captureEvidence().ownerId });
    if (format === "legacy") {
      const { schemaVersion, host, port, token } = descriptor;
      await writeFile(path, JSON.stringify({ schemaVersion, host, port, token }));
    }
    expect(await new FileConnectionProvider(path).current()).toEqual({ origin: server.origin, token: server.token });
    const gateway = new EngineDescriptorDshGatewayConnections(fixture.stateRoot, [{ instanceId: "fixture", origin: server.origin }]);
    expect(await gateway.current("fixture")).toEqual({ origin: server.origin, secret: Buffer.from(server.token) });
    const startEngine = vi.fn(async () => { throw new Error("Existing Engine must be reused"); });
    const healthRequests: string[] = [];
    const provider = new MaintenanceExternalLifecycleProvider(fixture.stateRoot, {
      startEngine,
      fetch: async (input, init) => {
        if (String(input).endsWith("/v1/health")) healthRequests.push(String(input));
        return fetch(input, init);
      },
    });
    // No connection() override: every prepare/finalize reads the server's file.
    for (const phase of ["abort", "afterExit"] as const) {
      const prepared = await provider.handle(prepareRequest());
      expect(prepared).toMatchObject({ enabled: true });
      if (!("enabled" in prepared) || !prepared.enabled || prepared.handle === null) throw new Error("prepare failed");
      const request = phase === "abort"
        ? { schemaVersion: 1, phase, handle: prepared.handle, reason: "spawn-failed" }
        : { schemaVersion: 1, phase, handle: prepared.handle, exitCode: 1, requestedStop: false, forced: false };
      expect(await provider.handle(request)).toEqual({ schemaVersion: 1, ok: true });
    }
    expect(healthRequests).toEqual(Array(4).fill(`${server.origin}/v1/health`));
    expect(startEngine).not.toHaveBeenCalled();
  });

  it("completes prepare and abort through the authenticated Engine routes", async () => {
    const engine = await createEngineFixture("external-lifecycle-http");
    cleanups.push(engine.cleanupAll);
    const server = await engine.startServer();
    const provider = new MaintenanceExternalLifecycleProvider(engine.stateRoot, {
      randomId: () => "http0123456789abcdefghijklmnopqrs",
      clock: () => "2026-09-01T00:00:00.000Z",
      connection: async () => ({ origin: server.origin, token: server.token }),
    });
    const prepared = await provider.handle(prepareRequest());
    expect(prepared).toMatchObject({ enabled: true });
    if (!("enabled" in prepared) || !prepared.enabled || prepared.handle === null) throw new Error("prepare failed");
    const aborted = await provider.handle({
      schemaVersion: 1,
      phase: "abort",
      handle: prepared.handle,
      reason: "spawn-failed",
    });
    expect(aborted).toEqual({ schemaVersion: 1, ok: true });
  });

  it("exposes one bounded JSON stdin/stdout command", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dsh-maint-external-cli-"));
    cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(["--state-root", stateRoot, "external-lifecycle"], {
      stdin: async () => "{",
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      code: "UNEXPECTED_ERROR",
      message: "External lifecycle request is not valid JSON",
    });
  });

  it("declines non-web and unsupported runtimes before Engine discovery or patch creation", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dsh-maint-external-disabled-"));
    cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
    let connectionAttempts = 0;
    const provider = new MaintenanceExternalLifecycleProvider(stateRoot, {
      connection: async () => {
        connectionAttempts += 1;
        throw new Error("Engine discovery must not run for unsupported launches");
      },
    });
    const disabled = { schemaVersion: 1, enabled: false, handle: null, launch: null };
    await expect(provider.handle({ ...prepareRequest(), web: false })).resolves.toEqual(disabled);
    await expect(provider.handle({ ...prepareRequest(), runtimeVersion: "0.1.1-rc.2" })).resolves.toEqual(disabled);
    expect(connectionAttempts).toBe(0);
  });

  it("pins an RC1 launch to the independent exact-version Adapter", async () => {
    const calls: unknown[] = [];
    let persistenceRoot = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return json({ run: {
        schemaVersion: 1,
        runId: "run-rc1",
        leaseId: "lease-rc1",
        adapterId: "dsh-rc1",
        persistenceRoot,
        temporaryPersistenceRootId: "projection:run-rc1",
        runtimeClientId: "plugin-0123456789abcdefghijklmnopqrstuv",
        state: "preparing",
      } }, 201);
    };
    const { stateRoot, provider } = await fixture(fetchImpl);
    persistenceRoot = join(stateRoot, "runtime", "run-rc1", "runtime-sessions");

    const response = await provider.handle(rc1PrepareRequest());
    expect(response).toMatchObject({ enabled: true });
    if (!("enabled" in response) || !response.enabled || response.launch === null) throw new Error("prepare failed");
    const metadata = JSON.parse(response.launch.env.DSH_SESSION_MAINTENANCE_LAUNCH_PROFILE!);
    expect(metadata).toMatchObject({
      adapterSelection: "pinned",
      pinnedAdapterId: "dsh-rc1",
      dshVersion: "0.1.2-rc.1",
    });
    expect(calls).toEqual([expect.objectContaining({
      dshVersion: "0.1.2-rc.1",
      pinnedAdapterId: "dsh-rc1",
      environment: expect.objectContaining({
        packageVersions: {
          "@deepseek-ai/dsh-session": "0.1.2-rc.1",
          "@deepseek-ai/dsh-session-persistence": "0.1.2-rc.1",
        },
      }),
    })]);
  });

  it("prepares an Alpha2 projection and returns only generic launch mutations", async () => {
    const calls: Array<{ readonly url: string; readonly body: unknown; readonly headers: Headers }> = [];
    let persistenceRoot = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return json({ run: {
        schemaVersion: 1,
        runId: "run-alpha2",
        leaseId: "lease-alpha2",
        adapterId: "dsh-alpha2",
        persistenceRoot,
        temporaryPersistenceRootId: "projection:run-alpha2",
        runtimeClientId: "plugin-0123456789abcdefghijklmnopqrstuv",
        state: "preparing",
      } }, 201);
    };
    const { stateRoot, provider } = await fixture(fetchImpl);
    persistenceRoot = join(stateRoot, "runtime", "run-alpha2", "runtime-sessions");

    const response = await provider.handle(prepareRequest());
    expect(response).toMatchObject({
      enabled: true,
      handle: "maintenance-0123456789abcdefghijklmnopqrstuv",
    });
    if (!("enabled" in response) || !response.enabled || response.launch === null) throw new Error("prepare failed");
    expect(Object.keys(response).sort()).toEqual(["enabled", "handle", "launch", "schemaVersion"]);
    expect(response.launch.launcherArgs?.[0]).toBe("--patch");
    expect(response.launch.launcherArgs).toHaveLength(2);
    expect(response.launch.args).toEqual([]);
    const patchPath = response.launch.launcherArgs?.[1];
    if (patchPath === undefined) throw new Error("launcher patch path is missing");
    expect(parse(await readFile(patchPath, "utf8"))).toEqual([{
      id: "session-persistence-jsonl",
      config: { root: persistenceRoot },
    }]);
    const metadata = JSON.parse(response.launch.env.DSH_SESSION_MAINTENANCE_LAUNCH_PROFILE!);
    expect(metadata).toMatchObject({
      sessionSource: "maintenance",
      maintenanceEndpoint: "http://127.0.0.1:41780",
      ownerClientId: "launcher-0123456789abcdefghijklmnopqrstuv",
      runtimeClientId: "plugin-0123456789abcdefghijklmnopqrstuv",
      runId: "run-alpha2",
      temporaryPersistenceRootId: "projection:run-alpha2",
    });
    expect(response.launch.env.DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY).toBe(join(stateRoot, "connection.json"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${"t".repeat(32)}`);
    expect(calls[0]?.body).toMatchObject({
      client: { kind: "launcher", id: "launcher-0123456789abcdefghijklmnopqrstuv" },
      environment: {
        packageVersions: {
          "@deepseek-ai/dsh-session": "0.1.2-alpha.2",
          "@deepseek-ai/dsh-session-persistence": "0.1.2-alpha.2",
        },
        runtimeCapabilities: ["sessionPersistence", "session/event", "session/flush"],
      },
      projectSelection: { kind: "all" },
    });
    const stored = await readFile(join(
      stateRoot,
      "external-lifecycle-handles",
      "maintenance-0123456789abcdefghijklmnopqrstuv.json",
    ), "utf8");
    expect(stored).not.toContain("t".repeat(32));
  });

  it("requests plugin drain before stop and closes normally only after process exit", async () => {
    const reasons: string[] = [];
    let persistenceRoot = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { readonly reason?: string };
      if (url.endsWith("/prepare")) return json({ run: {
        schemaVersion: 1, runId: "run-alpha2", leaseId: "lease-alpha2", adapterId: "dsh-alpha2",
        persistenceRoot, temporaryPersistenceRootId: "projection:run-alpha2",
        runtimeClientId: "plugin-0123456789abcdefghijklmnopqrstuv", state: "preparing",
      } }, 201);
      if (url.endsWith("/dsh-session-maintenance/runtime/shutdown")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"t".repeat(32)}`);
        expect(body).toEqual({
          schemaVersion: 1,
          runId: "run-alpha2",
          clientId: "launcher-0123456789abcdefghijklmnopqrstuv",
        });
        return json({ ok: true }, 202);
      }
      if (url.endsWith("/run-alpha2/close")) {
        reasons.push(body.reason!);
        return json({ run: { schemaVersion: 1, runId: "run-alpha2", state: "closed", removedProjection: true } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const { stateRoot, provider } = await fixture(fetchImpl);
    persistenceRoot = join(stateRoot, "runtime", "run-alpha2", "runtime-sessions");
    const prepared = await provider.handle(prepareRequest());
    if (!("enabled" in prepared) || !prepared.enabled || prepared.handle === null) throw new Error("prepare failed");

    const stopping = await provider.handle({
      schemaVersion: 1,
      phase: "beforeStop",
      handle: prepared.handle,
      runtimeUrl: "http://127.0.0.1:3080/?token=runtime-secret#launcher",
    });
    expect(stopping).toEqual({ schemaVersion: 1, action: "wait", timeoutMs: 15_000 });
    expect(reasons).toEqual([]);
    expect(await readFile(join(
      stateRoot,
      "external-lifecycle-handles",
      "maintenance-0123456789abcdefghijklmnopqrstuv.json",
    ), "utf8")).not.toContain("runtime-secret");

    const finalized = await provider.handle({
      schemaVersion: 1,
      phase: "afterExit",
      handle: prepared.handle,
      exitCode: 0,
      requestedStop: true,
      forced: false,
    });
    expect(finalized).toEqual({ schemaVersion: 1, ok: true });
    expect(reasons).toEqual(["normal"]);
    expect(await provider.handle({
      schemaVersion: 1,
      phase: "afterExit",
      handle: prepared.handle,
      exitCode: 0,
      requestedStop: true,
      forced: false,
    })).toEqual(finalized);
    expect(reasons).toEqual(["normal"]);
  });

  it("falls back to recovery when an authorized normal close lacks runtime drain", async () => {
    const reasons: string[] = [];
    let persistenceRoot = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { readonly reason?: string; readonly runtimeClientId?: string };
      if (url.endsWith("/prepare")) return json({ run: {
        schemaVersion: 1, runId: "run-drain-fallback", leaseId: "lease-drain-fallback", adapterId: "dsh-alpha2",
        persistenceRoot, temporaryPersistenceRootId: "projection:run-drain-fallback",
        runtimeClientId: body.runtimeClientId, state: "preparing",
      } }, 201);
      if (url.endsWith("/dsh-session-maintenance/runtime/shutdown")) return json({ ok: true }, 202);
      if (url.endsWith("/run-drain-fallback/close")) {
        reasons.push(body.reason!);
        if (body.reason === "normal") return json({ error: { message: "runtime drain is missing" } }, 500);
        return json({ run: { state: "recovered", removedProjection: true } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const { stateRoot, provider } = await fixture(fetchImpl);
    persistenceRoot = join(stateRoot, "runtime", "run-drain-fallback", "runtime-sessions");
    const prepared = await provider.handle(prepareRequest());
    if (!("enabled" in prepared) || !prepared.enabled || prepared.handle === null) throw new Error("prepare failed");
    await expect(provider.handle({
      schemaVersion: 1,
      phase: "beforeStop",
      handle: prepared.handle,
      runtimeUrl: "http://127.0.0.1:3080",
    })).resolves.toEqual({ schemaVersion: 1, action: "wait", timeoutMs: 15_000 });
    await expect(provider.handle({
      schemaVersion: 1,
      phase: "afterExit",
      handle: prepared.handle,
      exitCode: 0,
      requestedStop: true,
      forced: false,
    })).resolves.toEqual({ schemaVersion: 1, ok: true });
    expect(reasons).toEqual(["normal", "recovery"]);
  });

  it("owns recovery fallback for forced exits, aborts, and malformed stdio", async () => {
    const reasons: string[] = [];
    let persistenceRoot = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { readonly reason?: string };
      if (url.endsWith("/prepare")) return json({ run: {
        schemaVersion: 1, runId: `run-${reasons.length}`, leaseId: `lease-${reasons.length}`, adapterId: "dsh-alpha2",
        persistenceRoot, temporaryPersistenceRootId: `projection:run-${reasons.length}`,
        runtimeClientId: "plugin-0123456789abcdefghijklmnopqrstuv", state: "preparing",
      } }, 201);
      if (url.includes("/close")) {
        reasons.push(body.reason!);
        return json({ run: { state: "recovered", removedProjection: true } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const { stateRoot, provider } = await fixture(fetchImpl);
    persistenceRoot = join(stateRoot, "runtime", "run", "runtime-sessions");
    const prepared = await provider.handle(prepareRequest());
    if (!("enabled" in prepared) || !prepared.enabled || prepared.handle === null) throw new Error("prepare failed");
    expect(await provider.handle({
      schemaVersion: 1,
      phase: "afterExit",
      handle: prepared.handle,
      exitCode: null,
      requestedStop: true,
      forced: true,
    })).toEqual({ schemaVersion: 1, ok: true });
    expect(reasons).toEqual(["recovery"]);

    await expect(runExternalLifecycleStdio("{", provider)).rejects.toThrow("not valid JSON");
    await expect(runExternalLifecycleStdio(`"${"x".repeat(1024 * 1024)}"`, provider)).rejects.toThrow("exceeds 1 MiB");
  });

  it("recovers spontaneous exits, stops without shutdown acceptance, and aborted launches", async () => {
    const reasons: string[] = [];
    let persistenceRoot = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as {
        readonly reason?: string;
        readonly runtimeClientId?: string;
      };
      if (url.endsWith("/prepare")) return json({ run: {
        schemaVersion: 1, runId: "run-fallback", leaseId: "lease-fallback", adapterId: "dsh-alpha2",
        persistenceRoot, temporaryPersistenceRootId: "projection:run-fallback",
        runtimeClientId: body.runtimeClientId, state: "preparing",
      } }, 201);
      if (url.endsWith("/run-fallback/close")) {
        reasons.push(body.reason!);
        return json({ run: { state: "recovered", removedProjection: true } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const { stateRoot, provider } = await fixture(fetchImpl);
    persistenceRoot = join(stateRoot, "runtime", "run-fallback", "runtime-sessions");
    const prepared = await provider.handle(prepareRequest());
    if (!("enabled" in prepared) || !prepared.enabled || prepared.handle === null) throw new Error("prepare failed");
    expect(await provider.handle({
      schemaVersion: 1,
      phase: "afterExit",
      handle: prepared.handle,
      exitCode: 1,
      requestedStop: false,
      forced: false,
    })).toEqual({ schemaVersion: 1, ok: true });
    expect(reasons).toEqual(["recovery"]);

    const requestedStopProvider = new MaintenanceExternalLifecycleProvider(stateRoot, {
      fetch: fetchImpl,
      randomId: () => "requestedstop0123456789abcdefghijkl",
      clock: () => "2026-09-01T00:00:00.000Z",
      connection: async () => ({ origin: "http://127.0.0.1:41780", token: "t".repeat(32) }),
    });
    const requestedStopPrepared = await requestedStopProvider.handle(prepareRequest());
    if (!("enabled" in requestedStopPrepared) || !requestedStopPrepared.enabled || requestedStopPrepared.handle === null) {
      throw new Error("prepare failed");
    }
    expect(await requestedStopProvider.handle({
      schemaVersion: 1,
      phase: "afterExit",
      handle: requestedStopPrepared.handle,
      exitCode: 0,
      requestedStop: true,
      forced: false,
    })).toEqual({ schemaVersion: 1, ok: true });
    expect(reasons).toEqual(["recovery", "recovery"]);

    const abortFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { readonly reason?: string; readonly runtimeClientId?: string };
      if (url.endsWith("/prepare")) return json({ run: {
        schemaVersion: 1, runId: "run-abort", leaseId: "lease-abort", adapterId: "dsh-alpha2",
        persistenceRoot: join(stateRoot, "runtime", "run-abort", "runtime-sessions"),
        temporaryPersistenceRootId: "projection:run-abort", runtimeClientId: body.runtimeClientId, state: "preparing",
      } }, 201);
      expect(body.reason).toBe("recovery");
      return json({ run: { state: "recovered", removedProjection: true } });
    };
    const abortProvider = new MaintenanceExternalLifecycleProvider(stateRoot, {
      fetch: abortFetch,
      randomId: () => "zyxwvutsrqponmlkjihgfedcba987654",
      clock: () => "2026-09-01T00:00:00.000Z",
      connection: async () => ({ origin: "http://127.0.0.1:41780", token: "t".repeat(32) }),
    });
    const abortPrepared = await abortProvider.handle(prepareRequest());
    if (!("enabled" in abortPrepared) || !abortPrepared.enabled || abortPrepared.handle === null) throw new Error("prepare failed");
    expect(await abortProvider.handle({
      schemaVersion: 1,
      phase: "abort",
      handle: abortPrepared.handle,
      reason: "spawn-failed",
    })).toEqual({ schemaVersion: 1, ok: true });
  });
});
